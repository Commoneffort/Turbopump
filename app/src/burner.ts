// A test wallet that lives in this browser: a keypair that signs without popups, so anyone can try
// the app without installing a wallet. Test networks only; never use it for real funds.
//
// The key is stored encrypted (AES-GCM) under a key that only the user can produce (2026-11-07):
//   - a passkey: the browser's WebAuthn "PRF" extension gives 32 secret bytes for this site and
//     this credential once the user unlocks it (a security key, a phone, or the computer's own
//     lock: Windows Hello's PIN, Touch ID...); or
//   - a PIN or passphrase, stretched with PBKDF2 (600,000 rounds of SHA-256).
// It is unlocked once per tab and then kept in memory only. A key stored before, in plain text,
// is offered the same protection the next time it connects. A copy of the browser's storage alone
// no longer gives the key; a PIN is still only as strong as it is long (a passphrase or a passkey
// is better), since whoever copies the storage can try PINs at their leisure.
import {
  BaseSignerWalletAdapter,
  WalletName,
  WalletNotConnectedError,
  WalletReadyState,
} from "@solana/wallet-adapter-base";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

const PLAIN_KEY = "percolator-vaults:devnet-burner";
const LOCKED_KEY = "percolator-vaults:burner-locked";
const OLD_PREFIX = "percolator-vaults:burner-old:";
export const BurnerName = "Devnet Burner" as WalletName<"Devnet Burner">;
const ROUNDS = 600_000;

const ICON =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#E15A48"/><path d="M16 5c2 5 7 7 7 13a7 7 0 0 1-14 0c0-3 2-5 3-7 1 2 2 3 3 3-1-4 0-7 1-9z" fill="#fff"/></svg>`,
  );

type Locked = { v: 2; pub: string; kind: "pin" | "passkey"; salt: string; iv: string; ct: string; cred?: string; prf?: string };
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* none */ } }, del: (k: string) => { try { localStorage.removeItem(k); } catch { /* none */ } } };

async function pinKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ROUNDS }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function prfKey(secret: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("turbopump-test-wallet") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(kp: Keypair, key: CryptoKey, base: Omit<Locked, "iv" | "ct">): Promise<Locked> {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, kp.secretKey));
  return { ...base, iv: b64(iv), ct: b64(ct) } as Locked;
}
async function open(l: Locked, key: CryptoKey): Promise<Keypair> {
  const sk = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(l.iv) }, key, unb64(l.ct)));
  const kp = Keypair.fromSecretKey(sk);
  if (kp.publicKey.toBase58() !== l.pub) throw new Error("wrong key");
  return kp;
}

/** The passkey's PRF secret for `salt` (asks the user to unlock the passkey). */
async function passkeySecret(cred: Uint8Array | undefined, salt: Uint8Array): Promise<{ secret: ArrayBuffer; cred: Uint8Array }> {
  let id = cred;
  if (!id) {
    const made = await navigator.credentials.create({ publicKey: {
      rp: { name: "Turbopump" }, challenge: rand(32),
      user: { id: rand(16), name: "Turbopump test wallet", displayName: "Turbopump test wallet" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: { eval: { first: salt } } } as any,
    } }) as PublicKeyCredential | null;
    if (!made) throw new Error("no passkey made");
    const ext = made.getClientExtensionResults() as any;
    if (!ext?.prf?.enabled && !ext?.prf?.results?.first) throw new Error("this browser or passkey cannot protect a key (no PRF): use a PIN or passphrase");
    id = new Uint8Array(made.rawId);
    if (ext.prf.results?.first) return { secret: ext.prf.results.first, cred: id };
  }
  const got = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), allowCredentials: [{ type: "public-key", id }], userVerification: "required",
    extensions: { prf: { eval: { first: salt } } } as any,
  } }) as PublicKeyCredential | null;
  const first = (got?.getClientExtensionResults() as any)?.prf?.results?.first;
  if (!first) throw new Error("the passkey gave no secret: use a PIN or passphrase");
  return { secret: first, cred: id };
}

async function protectWithPasskey(kp: Keypair): Promise<Locked> {
  const salt = rand(32), prf = rand(32);
  const { secret, cred } = await passkeySecret(undefined, prf);
  return seal(kp, await prfKey(secret, salt), { v: 2, pub: kp.publicKey.toBase58(), kind: "passkey", salt: b64(salt), cred: b64(cred), prf: b64(prf) });
}
async function protectWithPin(kp: Keypair, pin: string): Promise<Locked> {
  const salt = rand(16);
  return seal(kp, await pinKey(pin, salt), { v: 2, pub: kp.publicKey.toBase58(), kind: "pin", salt: b64(salt) });
}
async function unlock(l: Locked, pin?: string): Promise<Keypair> {
  if (l.kind === "pin") return open(l, await pinKey(pin ?? "", unb64(l.salt)));
  const { secret } = await passkeySecret(unb64(l.cred!), unb64(l.prf!));
  return open(l, await prfKey(secret, unb64(l.salt)));
}

// ---- a small dialog of its own (the adapter runs outside the app's React tree) ----

function dialog(build: (box: HTMLDivElement, done: (v: unknown) => void, fail: (e: Error) => void) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const back = document.createElement("div");
    back.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px";
    const box = document.createElement("div");
    box.style.cssText = "max-width:380px;width:100%;background:var(--panel,#16181d);color:var(--text,#e8e8ea);border:1px solid var(--line,#2a2d34);border-radius:12px;padding:18px;font:14px/1.45 system-ui,sans-serif;display:flex;flex-direction:column;gap:10px";
    back.appendChild(box);
    document.body.appendChild(back);
    const end = () => back.remove();
    build(box, v => { end(); resolve(v); }, e => { end(); reject(e); });
  });
}
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  const { style, ...rest } = props as any;
  Object.assign(e, rest);
  if (style) e.setAttribute("style", style);
  if (text) e.textContent = text;
  return e;
};
const BTN = "padding:9px 12px;border-radius:8px;border:1px solid var(--line,#2a2d34);background:var(--panel2,#1f2228);color:inherit;cursor:pointer;font:inherit";
const MAIN = BTN + ";background:#e8e8ea;color:#111;border-color:#e8e8ea";
const INPUT = "padding:9px 10px;border-radius:8px;border:1px solid var(--line,#2a2d34);background:var(--bg,#0e0f12);color:inherit;font:inherit";

/** Asks how to protect `kp`: a passkey, a PIN or passphrase, or (for a key kept before) not now. */
function askProtect(kp: Keypair, existing: boolean): Promise<Locked | null> {
  return dialog((box, done) => {
    box.append(el("b", {}, existing ? "Protect your test wallet" : "Lock your new test wallet"));
    box.append(el("div", { style: "opacity:.8;font-size:13px" }, "Its key is kept in this browser. Lock it so that only you can use it: with a passkey (a security key, your phone, or this computer's own lock), or with a PIN or passphrase you type each time you open the site. Test funds only."));
    const msg = el("div", { style: "font-size:12px;color:#e15a48;min-height:1em" });
    const pk = el("button", { style: MAIN }, "Use a passkey");
    pk.onclick = async () => { msg.textContent = ""; try { done(await protectWithPasskey(kp)); } catch (e: any) { msg.textContent = String(e?.message ?? e); } };
    const pin = el("input", { type: "password", placeholder: "PIN or passphrase (at least 6 characters)", style: INPUT, autocomplete: "new-password" });
    const pin2 = el("input", { type: "password", placeholder: "The same again", style: INPUT, autocomplete: "new-password" });
    const set = el("button", { style: BTN }, "Lock with this PIN");
    set.onclick = async () => {
      if (pin.value.length < 6) { msg.textContent = "At least 6 characters (a passphrase is safer than a PIN)."; return; }
      if (pin.value !== pin2.value) { msg.textContent = "The two do not match."; return; }
      set.disabled = true; set.textContent = "Locking…";
      done(await protectWithPin(kp, pin.value));
    };
    box.append(pk, el("div", { style: "opacity:.6;font-size:12px;text-align:center" }, "or"), pin, pin2, set, msg);
    if (existing) { const later = el("button", { style: BTN + ";opacity:.75" }, "Not now (keep it unlocked)"); later.onclick = () => done(null); box.append(later); }
  });
}

/** Unlocks a protected key; "start over" makes a new, empty test wallet (the old one is kept aside, still locked). */
function askUnlock(l: Locked): Promise<Keypair | "new"> {
  return dialog((box, done) => {
    box.append(el("b", {}, "Unlock your test wallet"));
    box.append(el("div", { style: "opacity:.8;font-size:13px;word-break:break-all" }, l.pub));
    const msg = el("div", { style: "font-size:12px;color:#e15a48;min-height:1em" });
    if (l.kind === "passkey") {
      const go = el("button", { style: MAIN }, "Unlock with your passkey");
      go.onclick = async () => { msg.textContent = ""; try { done(await unlock(l)); } catch (e: any) { msg.textContent = String(e?.message ?? e).includes("wrong") ? "That passkey does not open this wallet." : String(e?.message ?? e); } };
      box.append(go);
      setTimeout(() => go.click(), 50);
    } else {
      const pin = el("input", { type: "password", placeholder: "PIN or passphrase", style: INPUT, autocomplete: "current-password" });
      const go = el("button", { style: MAIN }, "Unlock");
      const try_ = async () => { go.disabled = true; go.textContent = "Unlocking…"; msg.textContent = ""; try { done(await unlock(l, pin.value)); } catch { msg.textContent = "That is not the PIN of this wallet."; go.disabled = false; go.textContent = "Unlock"; } };
      go.onclick = try_;
      pin.onkeydown = e => { if (e.key === "Enter") try_(); };
      box.append(pin, go);
      setTimeout(() => pin.focus(), 50);
    }
    const anew = el("button", { style: BTN + ";opacity:.75;font-size:12px" }, "Start a new test wallet (this one is put aside)");
    anew.onclick = () => { if (window.confirm("Make a new, empty test wallet? This one stays locked in this browser, set aside: the site will not open it again by itself.")) done("new"); };
    box.append(msg, anew);
  });
}

async function loadKeypair(): Promise<Keypair> {
  const raw = store.get(LOCKED_KEY);
  if (raw) {
    const got = await askUnlock(JSON.parse(raw) as Locked);
    if (got !== "new") return got;
    // Kept, not deleted: the old wallet (still locked) stays in this browser under its address,
    // so remembering its PIN or finding its passkey later can still open it.
    const old = JSON.parse(raw) as Locked;
    store.set(`${OLD_PREFIX}${old.pub}`, raw);
    store.del(LOCKED_KEY);
  }
  const plain = store.get(PLAIN_KEY);
  const kp = plain ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(plain))) : Keypair.generate();
  const locked = await askProtect(kp, !!plain);
  if (locked) { store.set(LOCKED_KEY, JSON.stringify(locked)); store.del(PLAIN_KEY); }
  else store.set(PLAIN_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export class DevnetBurnerAdapter extends BaseSignerWalletAdapter {
  name = BurnerName;
  url = "https://turbopumpx.vercel.app";
  icon = ICON;
  supportedTransactionVersions = new Set(["legacy", 0] as const);
  private keypair: Keypair | null = null;
  private opening: Promise<Keypair> | null = null;

  get connecting() { return !!this.opening; }
  get publicKey(): PublicKey | null { return this.keypair?.publicKey ?? null; }
  get readyState() { return WalletReadyState.Loadable; }

  async connect() {
    // (Kept in memory once unlocked, until the tab closes or the wallet is disconnected.)
    if (!this.keypair) {
      this.opening ??= loadKeypair();
      try { this.keypair = await this.opening; } finally { this.opening = null; }
    }
    this.emit("connect", this.keypair.publicKey);
  }

  async disconnect() {
    this.keypair = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (!this.keypair) throw new WalletNotConnectedError();
    if (tx instanceof VersionedTransaction) tx.sign([this.keypair]);
    else tx.partialSign(this.keypair);
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map(t => this.signTransaction(t)));
  }
}

/** Shows the test wallet's private key, on request only (2026-11-07): it asks for the wallet's
 *  passkey or PIN again first, even while the wallet is unlocked, so a page left open cannot be
 *  read by someone passing by. The key is shown in a box with a copy button and never stored
 *  anywhere else. Anyone who has it controls the wallet. */
export async function revealTestWalletKey(): Promise<void> {
  const raw = store.get(LOCKED_KEY), plain = store.get(PLAIN_KEY);
  let kp: Keypair;
  if (raw) {
    const got = await askUnlock(JSON.parse(raw) as Locked);
    if (got === "new") return;
    kp = got;
  } else if (plain) {
    if (!window.confirm("Show this test wallet's private key? Anyone who has it controls the wallet.")) return;
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(plain)));
  } else return;
  const secret = bs58.encode(kp.secretKey);
  await dialog((box, done) => {
    box.append(el("b", {}, "Your test wallet's private key"));
    box.append(el("div", { style: "font-size:13px;color:#e15a48" }, "Anyone who has this key controls the wallet and everything in it. Paste it only into a wallet app you trust (Backpack, or an X1 wallet: \"import private key\"). Never into a website."));
    box.append(el("div", { style: "opacity:.8;font-size:12px;word-break:break-all" }, `Address: ${kp.publicKey.toBase58()}`));
    const t = el("textarea", { readOnly: true, value: secret, style: INPUT + ";height:84px;font:12px ui-monospace,monospace;word-break:break-all;resize:none" });
    const copy = el("button", { style: MAIN }, "Copy");
    copy.onclick = async () => { try { await navigator.clipboard.writeText(secret); copy.textContent = "Copied"; } catch { t.select(); } };
    const close = el("button", { style: BTN }, "Close");
    close.onclick = () => done(null);
    box.append(t, copy, close);
  });
}
