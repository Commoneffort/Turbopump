// Helpers, data hooks and small components shared by the trading desk and the other pages.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as C from "./chain";

export const num = (x: bigint, scale: number) => Number(x) / scale;
export const fmt = (x: number, dp = 2) => x.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const usd = (atoms: bigint, dp = 2) => `$${fmt(num(atoms, C.USDC), dp)}`;
export const priceDp = (p: number) => (p >= 1000 ? 2 : p >= 1 ? 3 : 5);
export const px = (e6: bigint) => { const p = num(e6, 1e6); return `$${fmt(p, priceDp(p))}`; };
export const units = (q: bigint) => fmt(num(q, Number(C.UNIT)), 4).replace(/\.?0+$/, "") || "0";
export const shares = (s: bigint) => fmt(num(s, 10 ** C.SHARE_DECIMALS), 2);
export const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
export const explorer = (what: "address" | "tx", id: string) =>
  C.X1 ? `https://explorer.testnet.x1.xyz/${what}/${id}` : `https://explorer.solana.com/${what}/${id}?cluster=devnet`;
/** Vault size cap in position units: `bps` of NAV in notional at the current price. */
export const capUnits = (nav: bigint, bps: number, priceE6: bigint) => (priceE6 > 0n ? (nav * BigInt(bps) / 10_000n) * C.UNIT / priceE6 : 0n);
export const ago = (sec: number) => (sec < 60 ? `${Math.max(1, Math.round(sec))}s ago` : sec < 3600 ? `${Math.round(sec / 60)}m ago` : `${Math.round(sec / 3600)}h ago`);

export type Toast = { ok: boolean; text: string; sig?: string };
/** `ixs` may be a function: it is called right before the wallet signs, so what it reads from the
 *  chain (a market's next request id) is as fresh as it can be. */
export type Send = (label: string, ixs: TransactionInstruction[] | ((conn: Connection) => Promise<TransactionInstruction[]>)) => Promise<string | undefined>;

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** A market's mark: its symbol's first letters on a quiet tile. */
export function Icon({ symbol }: { symbol: string }) {
  return <span className="coin">{symbol.slice(0, symbol.length > 4 ? 2 : 1)}</span>;
}

// ---------------------------------------------------------------- data

export type Card = { v: C.Vault; asset: C.Asset; nav: bigint };

export function useCards(tick: number) {
  const { connection } = useConnection();
  const [cards, setCards] = useState<Card[]>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [vaults, m] = await Promise.all([C.listVaults(connection), C.fetchMarket(connection)]);
        const lps = await connection.getMultipleAccountsInfo(vaults.flatMap(v => [v.lpPortfolio, v.buffer]), "confirmed");
        const out = vaults.map((v, i) => {
          const lp = lps[2 * i] ? C.decodePortfolio(new Uint8Array(lps[2 * i]!.data), v.assetIndex) : undefined;
          const b = lps[2 * i + 1];
          const buf = b ? new DataView(b.data.buffer, b.data.byteOffset).getBigUint64(64, true) : 0n;
          const nav = (lp ? lp.capital + (lp.pnl > 0n ? lp.pnl : 0n) : 0n) + buf - v.reserved - v.pendingDeposit;
          return { v, asset: v.status === 0 ? ({} as C.Asset) : C.decodeAsset(m.data, v.assetIndex), nav };
        });
        out.sort((a, b) => (b.nav > a.nav ? 1 : b.nav < a.nav ? -1 : 0));
        if (live) { setCards(out); setErr(undefined); }
      } catch (e: any) { if (live) setErr(e.message); }
    };
    load();
    const id = setInterval(load, 8000);
    return () => { live = false; clearInterval(id); };
  }, [connection, tick]);
  return { cards, err };
}

export function useVault(vaultKey: PublicKey, tick: number) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [state, setState] = useState<C.State>();
  const [err, setErr] = useState<string>();
  const [history, setHistory] = useState<{ t: number; p: number }[]>([]);
  const load = useCallback(async () => {
    try {
      const s = await C.fetchVault(connection, vaultKey, publicKey ?? undefined);
      setState(s);
      setErr(undefined);
      const p = num(s.asset.price, 1e6);
      setHistory(h => (h.length && h[h.length - 1].p === p && Date.now() - h[h.length - 1].t < 30_000 ? h : [...h.slice(-240), { t: Date.now(), p }]));
    } catch (e: any) { setErr(e.message); }
  }, [connection, vaultKey.toString(), publicKey?.toString()]);
  useEffect(() => { setHistory([]); }, [vaultKey.toString()]);
  // Poll faster while a trade of this wallet is queued, so its fill shows up promptly.
  const waiting = !!state?.trader?.hasPending;
  useEffect(() => { load(); const id = setInterval(load, waiting ? 2000 : 6000); return () => clearInterval(id); }, [load, tick, waiting]);
  return { state, err, history, reload: load };
}

export function OpenerPanel({ state, send, busy }: { state: C.State; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const v = state.vault;
  if (!v.canonical || !publicKey || !publicKey.equals(v.creator)) return null;
  return (
    <section className="card span2 opener">
      <div className="card-head">
        <div>
          <h3>You opened this market</h3>
          <p className="muted small">You earn {C.OPENER_FEE_BPS / 100}% of every fee this market harvests, forever. You have no other powers over it.</p>
          <p className="muted small">
            {state.asset.insurance <= v.insuranceFloor
              ? `Trading fees first fill this market's insurance buffer of ${usd(v.insuranceFloor)} (it covers bad debt): ${usd(state.asset.insurance)} collected so far. Fees beyond that are harvested, and your share starts then.`
              : `${usd(state.asset.insurance - v.insuranceFloor)} of fees are waiting to be harvested.`}
          </p>
        </div>
        <div className="opener-num">
          <div className="stat-value">{usd(v.openerFeesOwed)}</div>
          <div className="muted small">claimable · {usd(v.openerFeesTotal)} earned in total</div>
        </div>
      </div>
      <button className="btn primary" disabled={!!busy || v.openerFeesOwed === 0n} onClick={() => send("Claim opener fees", [
        createAssociatedTokenAccountIdempotentInstruction(publicKey, C.ata(publicKey, C.MINT), publicKey, C.MINT),
        C.claimOpenerFees(v, publicKey),
      ])}>Claim opener fees</button>
    </section>
  );
}

// ---------------------------------------------------------------- activity

export type ActivityRow = { sig: string; when: number; what: string };

/** What happened on a vault lately, from its transaction history (a few new transactions per
 *  pass: public RPCs refuse batches). Price updates are left out. */
export function useActivity(vault: C.Vault, tick: number): ActivityRow[] | undefined {
  const { connection } = useConnection();
  const [rows, setRows] = useState<ActivityRow[]>();
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    let live = true;
    setRows(undefined);
    const load = async () => {
      try {
        const sigs = (await connection.getSignaturesForAddress(vault.key, { limit: 25 }, "confirmed")).filter(s => !s.err);
        for (const s of sigs.filter(s => !seen.current.has(s.signature)).slice(0, 4)) {
          const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          seen.current.set(s.signature, describe(tx, vault));
        }
        const shown = sigs.filter(s => seen.current.has(s.signature) && seen.current.get(s.signature) !== "").slice(0, 14);
        if (live) setRows(shown.map(s => ({ sig: s.signature, when: s.blockTime ?? 0, what: seen.current.get(s.signature)! })));
      } catch { /* public RPC may rate-limit history; keep the last list */ }
    };
    load();
    const id = setInterval(load, 15000);
    return () => { live = false; clearInterval(id); };
  }, [connection, vault.key.toString(), tick]);
  return rows;
}

const VAULT_TAGS: Record<number, string> = {
  16: "Vault created", 17: "Deposit requested", 18: "Withdrawal requested", 19: "Epoch settled", 20: "Claimed",
  34: "Vault position re-read", 35: "Vault closing-only until flat", 21: "Matcher renewed", 22: "Profit converted", 23: "Market settled", 24: "Redeemed", 25: "Swept", 26: "Market listed", 27: "Fees harvested", 28: "Position unwound",
};

function describe(tx: any, v: C.Vault): string {
  if (!tx) return "Transaction";
  const msg = tx.transaction.message;
  const keys: PublicKey[] = (msg.staticAccountKeys ?? msg.accountKeys) as PublicKey[];
  const ixs: any[] = msg.compiledInstructions ?? msg.instructions;
  let crank = false;
  for (const ix of ixs) {
    const program = keys[ix.programIdIndex];
    const data: Uint8Array = ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data);
    if (program.equals(C.VAULT_PROGRAM) && VAULT_TAGS[data[0]]) {
      if (data[0] === 17) return `Deposit requested · ${usd(new DataView(data.buffer, data.byteOffset).getBigUint64(1, true))}`;
      return VAULT_TAGS[data[0]];
    }
    if (program.equals(C.PERCOLATOR) && data[0] === 10) {
      const dv = new DataView(data.buffer, data.byteOffset);
      const lo = dv.getBigUint64(51, true), hi = dv.getBigInt64(59, true); // size_q follows ids, epochs, sequence, asset and market id
      const size = (hi << 64n) + lo;
      return `${size > 0n ? "Long" : "Short"} ${units(size < 0n ? -size : size)} ${v.feed?.symbol ?? ""} vs vault`;
    }
    if (program.equals(C.ROUTER)) {
      if (data[0] === 4) {
        const size = new DataView(data.buffer, data.byteOffset).getBigInt64(1, true); // low 64 bits of the i128 size
        return `${size > 0n ? "Long" : "Short"} ${units(size < 0n ? -size : size)} ${v.feed?.symbol ?? ""} queued`;
      }
      if (data[0] === 5) return ""; // mark moved to a new Pyth price: not shown
      if (data[0] === 6) return "Queued trade filled at its target price";
      if (data[0] === 7) return "Queued trade expired unfilled";
      if (data[0] === 8) return "Forced close queued (liquidation or close-out)";
      if (data[0] === 9) return "Epoch settlement queued";
      if (data[0] === 10) return "Epoch settled at the Pyth price";
    }
    if (program.equals(C.PERCOLATOR) && data[0] === 5) crank = true; // a fill carries cranks in front: keep looking
  }
  return crank ? "Keeper crank" : "Transaction";
}

// ---------------------------------------------------------------- fills

export type Fill = { sig: string; slot: number; vault: string; size: number; price: number };

/** This wallet's fills on a vault, read from the router's fill logs ("fill <id> <size> <price>")
 *  in the trading account's transaction history and cached in this browser. Only a few new
 *  transactions are fetched per refresh (the public RPC is rate-limited). */
export function useFills(wallet: PublicKey | null, vault: PublicKey, tick: bigint): Fill[] {
  const { connection } = useConnection();
  const key = wallet ? `pv:fills:${C.ROUTER.toBase58().slice(0, 8)}:${wallet.toBase58()}` : "";
  const [fills, setFills] = useState<Fill[]>([]);
  useEffect(() => {
    if (!wallet) { setFills([]); return; }
    let live = true;
    (async () => {
      let cache: { seen: string[]; fills: Fill[] } = { seen: [], fills: [] };
      try { cache = JSON.parse(localStorage.getItem(key) ?? "") ?? cache; } catch { /* first visit */ }
      setFills(cache.fills);
      try {
        const sigs = await connection.getSignaturesForAddress(C.traderAddress(wallet), { limit: 40 }, "confirmed");
        const fresh = sigs.filter(x => !x.err && !cache.seen.includes(x.signature)).reverse().slice(0, 5);
        for (const x of fresh) {
          const tx = await connection.getTransaction(x.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          if (!tx) continue;
          cache.seen.push(x.signature);
          const line = (tx.meta?.logMessages ?? []).find(l => /^Program log: fill \d+ -?\d+ \d+$/.test(l));
          if (!line) continue;
          const [, , , , size, price] = line.split(" ");
          const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])].map(k => k.toString());
          // The vault is the account whose router book is also in the transaction.
          const v = keys.find(k => keys.includes(C.bookAddress(new PublicKey(k)).toString()));
          if (v && Number(size) !== 0) cache.fills.push({ sig: x.signature, slot: x.slot, vault: v, size: Number(size) / 1e6, price: Number(price) / 1e6 });
        }
        cache.seen = cache.seen.slice(-200);
        cache.fills = cache.fills.sort((a, b) => a.slot - b.slot).slice(-200);
        try { localStorage.setItem(key, JSON.stringify(cache)); } catch { /* storage unavailable */ }
        if (live) setFills(cache.fills);
      } catch { /* rate-limited: try again on the next refresh */ }
    })();
    return () => { live = false; };
  }, [key, tick]);
  return useMemo(() => fills.filter(f => f.vault === vault.toBase58()), [fills, vault.toBase58()]);
}

/** Average entry price of the open position implied by a wallet's fills on one market, or
 *  undefined when the fills on record do not add up to the position (older fills are missing,
 *  or it was changed by a liquidation or a close-out). */
export function entryPrice(fills: Fill[], position: number): number | undefined {
  let pos = 0, avg = 0;
  for (const f of fills) {
    const next = pos + f.size;
    if (pos === 0 || Math.sign(next) !== Math.sign(pos)) avg = f.price;                  // opened, or flipped
    else if (Math.abs(next) > Math.abs(pos)) avg = (avg * Math.abs(pos) + f.price * Math.abs(f.size)) / Math.abs(next);
    pos = Math.abs(next) < 1e-9 ? 0 : next;
  }
  return position !== 0 && Math.abs(pos - position) < 1e-6 ? avg : undefined;
}

// ---------------------------------------------------------------- liquidity

export function LiquidityPanel({ state, send, busy }: { state: C.State; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const [amount, setAmount] = useState("100");
  const [out, setOut] = useState("");
  const v = state.vault, t = state.ticket;
  const nav = C.navOf(state);
  const price = state.shareSupply > 0n ? num(nav, C.USDC) / num(state.shareSupply, 10 ** C.SHARE_DECIMALS) : 1;
  const claimable = !!t && (t.deposit > 0n || t.withdraw > 0n) && t.epoch < v.epoch;
  const pending = !!t && (t.deposit > 0n || t.withdraw > 0n) && t.epoch === v.epoch;
  const atoms = BigInt(Math.floor(Number(amount || 0) * C.USDC));
  const tooMuch = atoms > state.userCollateral;
  const frozen = v.frozenUntil * 1000 >= Date.now();
  const claimIxs = (u: PublicKey) => [
    createAssociatedTokenAccountIdempotentInstruction(u, C.ata(u, v.shareMint), u, v.shareMint),
    createAssociatedTokenAccountIdempotentInstruction(u, C.ata(u, C.MINT), u, C.MINT),
    C.claim(v, u, t!.epoch),
  ];
  return (
    <>
      <section className="card">
        <h3>Your liquidity</h3>
        {!publicKey ? <p className="muted">Connect a wallet to provide liquidity.</p> : (
          <>
            <div className="row"><span>Shares</span><b>{shares(state.userShares)}</b></div>
            <div className="row"><span>Value</span><b>${fmt(num(state.userShares, 10 ** C.SHARE_DECIMALS) * price)}</b></div>
            <div className="row"><span>Share price</span><b>${fmt(price, 4)}</b></div>
            <div className="row"><span>Wallet test USDC</span><b>{usd(state.userCollateral)}</b></div>
            {pending && <div className="note">Queued for epoch {String(t!.epoch)}: {t!.deposit > 0n && `${usd(t!.deposit)} deposit`} {t!.withdraw > 0n && `${shares(t!.withdraw)} shares out`}. It settles at one price when the epoch ends{state.slot < v.epochStart + v.epochLen ? ` (about ${Math.max(1, Math.ceil(Number(v.epochStart + v.epochLen - state.slot) * C.slotSeconds() / 60))} min from now)` : v.needsFlat ? " (this epoch's withdrawals exceed the vault's cash reserve, so the vault has to close its position first: it now only takes trades that reduce it)" : " (being settled now, usually within half a minute)"}; then come back here to claim.</div>}
            {claimable && <button className="btn primary wide" disabled={!!busy} onClick={() => send("Claim", claimIxs(publicKey))}>Claim epoch {String(t!.epoch)} result</button>}
            <Faucet />
          </>
        )}
      </section>
      <section className="card">
        <h3>Deposit or withdraw</h3>
        <label className="field"><span>Deposit USDC</span><input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" /></label>
        {frozen && <p className="small">This epoch is being settled at a price that is already fixed, so new requests wait until it has rolled (a minute or two at most).</p>}
        <button className="btn primary wide" disabled={!publicKey || !!busy || v.status !== 1 || atoms <= 0n || tooMuch || frozen}
          onClick={() => publicKey && send("Deposit request", [
            ...(claimable ? claimIxs(publicKey) : []),
            createAssociatedTokenAccountIdempotentInstruction(publicKey, C.ata(publicKey, C.MINT), publicKey, C.MINT),
            C.requestDeposit(v, publicKey, atoms),
          ])}>Request deposit</button>
        {publicKey && tooMuch && <p className="small down">You have {usd(state.userCollateral)} test USDC. Use "Get test USDC" first.</p>}
        <label className="field"><span>Withdraw shares</span><input value={out} placeholder={shares(state.userShares)} onChange={e => setOut(e.target.value)} inputMode="decimal" /></label>
        <button className="btn wide" disabled={!publicKey || !!busy || state.userShares === 0n || v.status !== 1 || frozen}
          onClick={() => publicKey && send("Withdraw request", [
            ...(claimable ? claimIxs(publicKey) : []),
            C.requestWithdraw(v, publicKey, out ? BigInt(Math.floor(Number(out) * 10 ** C.SHARE_DECIMALS)) : state.userShares),
          ])}>Request withdrawal</button>
        <p className="muted small">Requests settle together at one price when the epoch ends, so nobody trades against a stale share price. Withdrawals can't be blocked: if a trader holds a position to stop the vault going flat, anyone can make the vault close it six epoch lengths after it was told to.</p>
      </section>
    </>
  );
}

export function Faucet({ compact }: { compact?: boolean }) {
  const { publicKey } = useWallet();
  const [msg, setMsg] = useState<string>();
  const drip = async () => {
    if (!publicKey) return;
    setMsg("Requesting…");
    try {
      const r = await fetch(`/api/faucet?network=${C.NETWORK}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: publicKey.toString() }) });
      const j = await r.json();
      setMsg(r.ok ? `Sent ${j.usdc} test USDC${j.sol ? ` and ${j.sol} ${j.coin ?? C.COIN}` : ""}` : j.error);
    } catch (e: any) { setMsg(e.message); }
  };
  if (compact) return <button className="btn tiny ghost" disabled={!publicKey} title={msg} onClick={drip}>{msg && msg.length < 40 ? msg : "Get test USDC"}</button>;
  return (
    <div className="faucet">
      <button className="btn ghost wide" onClick={drip}>Get test USDC</button>
      {msg && <div className="muted small">{msg}</div>}
    </div>
  );
}
