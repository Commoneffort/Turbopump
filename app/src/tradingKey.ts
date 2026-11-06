// The page's trading key (router `session`): a random Ed25519 key that signs the wallet's trades
// once the wallet has approved it on chain (C.openSession), so a trade needs no wallet popup.
//
// Never derived from a wallet signature: a signature over a known text can be obtained by any
// site that asks for it, and with it the key. Where the browser can (WebCrypto Ed25519), the key
// is made non-extractable and kept in IndexedDB: the page can ask it to sign, but no script,
// extension or copy of the page can read the key out. Elsewhere it is a key in this tab's
// sessionStorage, gone when the tab closes. Either way the router lets it trade only, within the
// limits the wallet set, and never withdraw.
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

export type TradingKey = { publicKey: PublicKey; sign: (message: Uint8Array) => Promise<Uint8Array>; protected: boolean };

const DB = "turbopump-trading-keys", STORE = "keys";
const slot = (network: string, market: PublicKey, wallet: PublicKey) => `${network}:${market.toBase58()}:${wallet.toBase58()}`;

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction(STORE, mode);
    const r = f(t.objectStore(STORE));
    r.onsuccess = () => ok(r.result as T);
    r.onerror = () => fail(r.error);
  });
}

/** Whether this browser makes non-extractable Ed25519 keys. */
async function webCryptoEd25519(): Promise<boolean> {
  try {
    const k = await crypto.subtle.generateKey({ name: "Ed25519" } as any, false, ["sign", "verify"]) as CryptoKeyPair;
    return !!k.privateKey;
  } catch { return false; }
}

function fromCrypto(pair: CryptoKeyPair, raw: Uint8Array): TradingKey {
  return { publicKey: new PublicKey(raw), protected: true, sign: async m => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" } as any, pair.privateKey, m)) };
}
function fromKeypair(kp: Keypair): TradingKey {
  return {
    publicKey: kp.publicKey, protected: false,
    sign: async m => ed25519.sign(m, kp.secretKey.slice(0, 32)),
  };
}

/** A new key for `wallet` on `market` (replacing any kept before). */
export async function createTradingKey(network: string, market: PublicKey, wallet: PublicKey): Promise<TradingKey> {
  const k = slot(network, market, wallet);
  await forgetTradingKey(network, market, wallet);
  if (await webCryptoEd25519()) {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, false, ["sign", "verify"]) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    await idb("readwrite", s => s.put({ pair, raw }, k));
    return fromCrypto(pair, raw);
  }
  const kp = Keypair.generate();
  try { sessionStorage.setItem(`tp-key:${k}`, JSON.stringify(Array.from(kp.secretKey))); } catch { /* this tab only, then */ }
  return fromKeypair(kp);
}

/** The key kept for `wallet` on `market`, if any. */
export async function loadTradingKey(network: string, market: PublicKey, wallet: PublicKey): Promise<TradingKey | null> {
  const k = slot(network, market, wallet);
  try {
    const got = await idb<{ pair: CryptoKeyPair; raw: Uint8Array } | undefined>("readonly", s => s.get(k));
    if (got?.pair?.privateKey) return fromCrypto(got.pair, new Uint8Array(got.raw));
  } catch { /* no IndexedDB here */ }
  try {
    const s = sessionStorage.getItem(`tp-key:${k}`);
    if (s) return fromKeypair(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s))));
  } catch { /* none */ }
  return null;
}

export async function forgetTradingKey(network: string, market: PublicKey, wallet: PublicKey): Promise<void> {
  const k = slot(network, market, wallet);
  try { await idb("readwrite", s => s.delete(k)); } catch { /* none */ }
  try { sessionStorage.removeItem(`tp-key:${k}`); } catch { /* none */ }
}

/** Signs `tx` (its fee payer and only signer the key) with the key. */
export async function signWithKey(key: TradingKey, tx: Transaction): Promise<Transaction> {
  const sig = await key.sign(tx.serializeMessage());
  tx.addSignature(key.publicKey, Buffer.from(sig));
  return tx;
}
