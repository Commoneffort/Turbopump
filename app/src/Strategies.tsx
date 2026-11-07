// Strategies (2026-11-07): build a strategy out of the on-chain order kinds, backtest it on the last
// 30 days of hourly candles, publish it, and use anyone's published strategy on your own account.
// A strategy is a recipe relative to the price at the time (a grid of ±5%, a ladder 1% apart,
// "when BTC falls 3%", "when SOL/ETH is 2% under its 7-day average"), so it means the same to
// whoever uses it later. Using it places the matching standing orders (router: grid levels, limit
// orders, cross and ratio triggers) on your account; they run on chain with nothing to keep open.
// Published recipes are memos signed by their author (like market messages): nobody can publish
// in someone else's name, and nothing is stored by us.
import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import * as C from "./chain";
import { fetchCandles } from "./Chart";
import { Send, fmt, short } from "./shared";

type Kind = "grid" | "ladder" | "cross" | "pair";
export type Spec = {
  v: 1; name: string; note: string; sym: string; kind: Kind; side: 1 | -1;
  /** grid: rangePct, levels, usd · ladder: steps, apartPct, usd, tpPct · cross: watch, movePct, usd, tpPct, slPct · pair: other, gapPct, usd */
  p: Record<string, number | string>;
};
type Result = { pnl: number; ret: number; maxDd: number; trades: number; wins: number; curve: number[]; capital: number };
type Candle = { t: number; o: number; h: number; l: number; c: number };

const FEE = 0.0005;
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const PREFIX = "tps:";
const BOARD = PublicKey.findProgramAddressSync([Buffer.from("turbopump-strategies")], MEMO)[0];
const KIND_NAME: Record<Kind, string> = { grid: "Grid", ladder: "Ladder", cross: "Cross trigger", pair: "Pair trade" };
const DEFAULTS: Record<Kind, Spec["p"]> = {
  grid: { rangePct: 5, levels: 6, usd: 200 },
  ladder: { steps: 4, apartPct: 1.5, usd: 250, tpPct: 3 },
  cross: { watch: "BTC", movePct: -3, usd: 500, tpPct: 4, slPct: 3 },
  pair: { other: "ETH", gapPct: 2, usd: 500 },
};
const num = (x: number | string | undefined, d = 0) => { const v = Number(x); return Number.isFinite(v) ? v : d; };

async function candles(sym: string): Promise<Candle[]> {
  const h = await fetchCandles(sym, 3600, 720);
  return (h.candles as any[]).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4] }));
}

/** Runs `s` over hourly candles; positions are marked to the close, fees at FEE a side. */
async function backtest(s: Spec): Promise<Result> {
  const a = await candles(s.sym);
  if (a.length < 50) throw new Error(`not enough history for ${s.sym}`);
  let cash = 0, pos = 0, trades = 0, wins = 0;
  const curve: number[] = [];
  const trade = (q: number, price: number) => { cash -= q * price + Math.abs(q * price) * FEE; pos += q; trades++; };
  const mark = (c: Candle) => curve.push(cash + pos * c.c);
  let capital = 0;
  if (s.kind === "grid") {
    const r = num(s.p.rangePct, 5) / 100, L = Math.max(2, Math.round(num(s.p.levels, 6))), usd = num(s.p.usd, 200);
    const mid = a[0].o, lo = mid * (1 - r), hi = mid * (1 + r), step = (hi - lo) / (L - 1);
    capital = usd * L;
    const lv = Array.from({ length: L }, (_, i) => ({ q: usd / (lo + i * step), buy: lo + i * step < mid, at: lo + i * step, entry: 0 }));
    for (const c of a) {
      for (const x of lv) {
        if (x.buy && c.l <= x.at) { trade(x.q, x.at); x.entry = x.at; x.buy = false; x.at += step; }
        else if (!x.buy && c.h >= x.at) { trade(-x.q, x.at); if (x.entry && x.at > x.entry) wins++; x.entry = 0; x.buy = true; x.at -= step; }
      }
      mark(c);
    }
  } else if (s.kind === "ladder") {
    const n = Math.max(1, Math.round(num(s.p.steps, 4))), apart = num(s.p.apartPct, 1.5) / 100, usd = num(s.p.usd, 250), tp = num(s.p.tpPct, 3) / 100, side = s.side;
    capital = usd * n;
    let start = a[0].o, filled: { q: number; p: number }[] = [];
    for (const c of a) {
      for (let i = filled.length; i < n; i++) {
        const p = start * (side > 0 ? 1 - apart * i : 1 + apart * i);
        if (side > 0 ? c.l <= p : c.h >= p) { const q = (usd / p) * side; trade(q, p); filled.push({ q, p }); } else break;
      }
      if (filled.length) {
        const qty = filled.reduce((t, f) => t + f.q, 0), avg = filled.reduce((t, f) => t + f.q * f.p, 0) / qty;
        const exit = avg * (1 + tp * side);
        if (side > 0 ? c.h >= exit : c.l <= exit) { trade(-qty, exit); wins++; filled = []; start = exit; }
      }
      mark(c);
    }
  } else if (s.kind === "cross") {
    const b = await candles(String(s.p.watch ?? "BTC"));
    const at = new Map(b.map(x => [x.t, x]));
    const move = num(s.p.movePct, -3) / 100, usd = num(s.p.usd, 500), tp = num(s.p.tpPct, 4) / 100, sl = num(s.p.slPct, 3) / 100, side = s.side;
    capital = usd;
    let open: { q: number; p: number; t: number } | null = null;
    for (let i = 24; i < a.length; i++) {
      const c = a[i], w = at.get(c.t), w0 = at.get(a[i - 24].t);
      if (!open && w && w0) {
        const ch = w.c / w0.c - 1;
        if (move < 0 ? ch <= move : ch >= move) { const q = (usd / c.c) * side; trade(q, c.c); open = { q, p: c.c, t: c.t }; }
      } else if (open) {
        const up = side > 0 ? c.h >= open.p * (1 + tp) : c.l <= open.p * (1 - tp), down = side > 0 ? c.l <= open.p * (1 - sl) : c.h >= open.p * (1 + sl);
        const old = c.t - open.t >= 48 * 3600;
        if (up || down || old) {
          const px = up ? open.p * (1 + tp * side) : down ? open.p * (1 - sl * side) : c.c;
          trade(-open.q, px); if ((px - open.p) * side > 0) wins++; open = null;
        }
      }
      mark(c);
    }
  } else {
    const b = await candles(String(s.p.other ?? "ETH"));
    const at = new Map(b.map(x => [x.t, x]));
    const gap = num(s.p.gapPct, 2) / 100, usd = num(s.p.usd, 500), side = s.side;
    capital = usd * 2;
    let posB = 0, open = false, entryRatio = 0;
    const ratios: number[] = [];
    for (const c of a) {
      const o = at.get(c.t);
      if (!o) continue;
      const r = c.c / o.c;
      ratios.push(r);
      const win = ratios.slice(-168), mean = win.reduce((t, x) => t + x, 0) / win.length;
      if (!open && ratios.length >= 48 && (side > 0 ? r <= mean * (1 - gap) : r >= mean * (1 + gap))) {
        trade((usd / c.c) * side, c.c); posB = (-usd / o.c) * side; cash -= posB * o.c + Math.abs(posB * o.c) * FEE; trades++; open = true; entryRatio = r;
      } else if (open && (side > 0 ? r >= mean : r <= mean)) {
        trade(-pos, c.c); cash += posB * o.c - Math.abs(posB * o.c) * FEE; trades++; if ((r - entryRatio) * side > 0) wins++; posB = 0; open = false;
      }
      curve.push(cash + pos * c.c + posB * o.c);
    }
  }
  const pnl = curve[curve.length - 1] ?? 0;
  let peak = 0, maxDd = 0;
  for (const e of curve) { peak = Math.max(peak, e); maxDd = Math.max(maxDd, peak - e); }
  return { pnl, ret: capital ? pnl / capital : 0, maxDd, trades, wins, curve, capital };
}

/** The standing orders that put `s` on `wallet`'s account at today's prices (free order slots
 *  `free` on the strategy's vault, and on the other asset's for a pair). */
async function ordersFor(conn: Connection, s: Spec, wallet: PublicKey, vaults: C.Vault[], market: Uint8Array): Promise<TransactionInstruction[]> {
  const v = vaults.find(x => x.canonical && x.feed?.symbol === s.sym);
  if (!v) throw new Error(`${s.sym} is not listed on this market`);
  const price = Number(C.decodeAsset(market, v.assetIndex).price) / 1e6;
  const owner = C.accountOwner(wallet, 0, v.market);
  const slots = async (vk: PublicKey) => (await conn.getMultipleAccountsInfo(Array.from({ length: C.MAX_ORDERS }, (_, i) => C.orderAddress(vk, owner, i)))).map((x, i) => (x ? -1 : i)).filter(i => i >= 0);
  const free = await slots(v.key);
  const e6 = (x: number) => BigInt(Math.round(x * 1e6));
  if (s.kind === "grid") {
    const r = num(s.p.rangePct, 5) / 100, L = Math.min(Math.max(2, Math.round(num(s.p.levels, 6))), free.length), usd = num(s.p.usd, 200);
    if (L < 2) throw new Error(`free at least two order slots on ${s.sym} first`);
    const lo = price * (1 - r), hi = price * (1 + r), step = (hi - lo) / (L - 1);
    return Array.from({ length: L }, (_, i) => lo + i * step).map((p, i) => C.placeOrder(wallet, v.key, { index: free[i], kind: C.ORDER.GRID, size: e6(usd / p) * (p < price ? 1n : -1n), trigger: e6(p), interval: Number(e6(step)), slices: 0 }));
  }
  if (s.kind === "ladder") {
    const n = Math.min(Math.max(1, Math.round(num(s.p.steps, 4))), free.length), apart = num(s.p.apartPct, 1.5) / 100, usd = num(s.p.usd, 250);
    if (!n) throw new Error(`all order slots on ${s.sym} are in use`);
    return Array.from({ length: n }, (_, i) => price * (s.side > 0 ? 1 - apart * i : 1 + apart * i)).map((p, i) => C.placeOrder(wallet, v.key, { index: free[i], kind: C.ORDER.LIMIT, size: e6(usd / p) * BigInt(s.side), trigger: e6(p) }));
  }
  if (!free.length) throw new Error(`all order slots on ${s.sym} are in use`);
  if (s.kind === "cross") {
    const w = vaults.find(x => x.canonical && x.feed?.symbol === String(s.p.watch));
    if (!w) throw new Error(`${s.p.watch} is not listed on this market`);
    const wp = Number(C.decodeAsset(market, w.assetIndex).price) / 1e6, move = num(s.p.movePct, -3) / 100, usd = num(s.p.usd, 500);
    return [C.placeOrder(wallet, v.key, { index: free[0], kind: C.ORDER.CROSS, size: e6(usd / price) * BigInt(s.side), trigger: e6(wp * (1 + move)), interval: w.assetIndex, slices: move < 0 ? 2 : 1 })];
  }
  const o = vaults.find(x => x.canonical && x.feed?.symbol === String(s.p.other));
  if (!o) throw new Error(`${s.p.other} is not listed on this market`);
  const op = Number(C.decodeAsset(market, o.assetIndex).price) / 1e6, gap = num(s.p.gapPct, 2) / 100, usd = num(s.p.usd, 500);
  const level = (price / op) * (1 - gap * s.side);
  const there = await slots(o.key);
  if (!there.length) throw new Error(`all order slots on ${s.p.other} are in use`);
  const below = s.side > 0;
  return [
    C.placeOrder(wallet, v.key, { index: free[0], kind: C.ORDER.RATIO, size: e6(usd / price) * BigInt(s.side), trigger: e6(level), interval: o.assetIndex, slices: below ? 2 : 1 }),
    C.placeOrder(wallet, o.key, { index: there[0], kind: C.ORDER.RATIO, size: e6(usd / op) * BigInt(-s.side), trigger: BigInt(Math.round(1e12 / level)), interval: v.assetIndex, slices: below ? 1 : 2 }),
  ];
}

type Published = { sig: string; author: string; time: number; spec: Spec };
const seen = new Map<string, Published | null>();
async function readPublished(conn: Connection): Promise<Published[]> {
  const sigs = (await conn.getSignaturesForAddress(BOARD, { limit: 100 }, "confirmed")).filter(s => !s.err && s.memo?.includes(PREFIX));
  const missing = sigs.filter(s => !seen.has(s.signature)).map(s => s.signature);
  for (let i = 0; i < missing.length; i += 20) {
    const part = missing.slice(i, i + 20);
    const txs = await conn.getTransactions(part, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    txs.forEach((tx, k) => seen.set(part[k], tx ? { sig: part[k], author: tx.transaction.message.staticAccountKeys[0].toBase58(), time: tx.blockTime ?? 0, spec: undefined as any } : null));
  }
  const out: Published[] = [];
  for (const s of sigs) {
    const k = seen.get(s.signature);
    if (!k) continue;
    try {
      const spec = JSON.parse(s.memo!.slice(s.memo!.indexOf(PREFIX) + PREFIX.length)) as Spec;
      if (spec?.v === 1 && DEFAULTS[spec.kind] && typeof spec.sym === "string") out.push({ ...k, spec: { ...spec, name: String(spec.name ?? "").slice(0, 60), note: String(spec.note ?? "").slice(0, 200) } });
    } catch { /* not a strategy */ }
  }
  return out;
}

function Curve({ r }: { r: Result }) {
  const W = 320, H = 70, xs = r.curve;
  if (xs.length < 2) return null;
  const lo = Math.min(0, ...xs), hi = Math.max(0, ...xs), y = (v: number) => H - ((v - lo) / (hi - lo || 1)) * H;
  const d = xs.map((v, i) => `${i ? "L" : "M"}${(i / (xs.length - 1)) * W},${y(v).toFixed(1)}`).join("");
  return <svg className="strat-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"><line x1="0" x2={W} y1={y(0)} y2={y(0)} className="zero" /><path d={d} className={r.pnl >= 0 ? "up" : "down"} /></svg>;
}
function ResultView({ r }: { r: Result }) {
  const money = (x: number) => `${x < 0 ? "−" : ""}$${fmt(Math.abs(x), 2)}`;
  return (
    <div className="strat-result">
      <div><span>Profit, 30 days</span><b className={`mono ${r.pnl >= 0 ? "up" : "down"}`}>{money(r.pnl)} ({(r.ret * 100).toFixed(1)}%)</b></div>
      <div><span>Largest fall</span><b className="mono down">{money(-r.maxDd)}</b></div>
      <div><span>Trades · won</span><b className="mono">{r.trades} · {r.wins}</b></div>
      <div><span>Money used</span><b className="mono">{money(r.capital)}</b></div>
      <Curve r={r} />
    </div>
  );
}

export default function StrategiesPage({ send, busy, go }: { send: Send; busy?: string; go: (to: string) => void }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [vaults, setVaults] = useState<C.Vault[]>([]);
  const [spec, setSpec] = useState<Spec>({ v: 1, name: "", note: "", sym: "SOL", kind: "grid", side: 1, p: { ...DEFAULTS.grid } });
  const [res, setRes] = useState<Result | string>();
  const [list, setList] = useState<Published[]>();
  const [tests, setTests] = useState<Record<string, Result | string>>({});
  const [n, setN] = useState(0);
  useEffect(() => { C.listVaults(connection).then(setVaults).catch(() => {}); }, [connection]);
  useEffect(() => { readPublished(connection).then(setList).catch(() => setList([])); }, [connection, n]);
  const syms = useMemo(() => [...new Set(vaults.filter(v => v.canonical && v.feed).map(v => v.feed!.symbol))], [vaults]);
  const setP = (k: string, v: string) => setSpec(s => ({ ...s, p: { ...s.p, [k]: /^[A-Z]+$/.test(v) ? v : Number(v) } }));
  const field = (k: string, label: string, unit = "") => <label className="inp small" key={k}><span>{label}</span><input value={String(spec.p[k] ?? "")} onChange={e => setP(k, e.target.value.replace(/[^0-9.\-]/g, ""))} inputMode="decimal" />{unit && <em>{unit}</em>}</label>;
  const pick = (k: string, label: string) => <label className="inp small" key={k}><span>{label}</span><select value={String(spec.p[k])} onChange={e => setP(k, e.target.value)}>{syms.filter(x => x !== spec.sym).map(x => <option key={x}>{x}</option>)}</select></label>;
  const apply = async (s: Spec) => {
    if (!publicKey) return;
    const m = await connection.getAccountInfo(C.activeMarket());
    try {
      const ixs = await ordersFor(connection, s, publicKey, vaults, new Uint8Array(m!.data));
      await send(`Use "${s.name || KIND_NAME[s.kind]}" on ${s.sym}`, ixs);
    } catch (e: any) { window.alert(String(e?.message ?? e)); }
  };
  const publish = async () => {
    if (!publicKey || !spec.name.trim()) return;
    const text = PREFIX + JSON.stringify({ ...spec, name: spec.name.trim().slice(0, 60), note: spec.note.trim().slice(0, 200) });
    const sig = await send(`Publish "${spec.name.trim()}"`, [SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: BOARD, lamports: 0 }), new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: publicKey, isSigner: true, isWritable: false }], data: Buffer.from(text, "utf8") })]);
    if (sig) setTimeout(() => setN(x => x + 1), 1500);
  };
  const k = spec.kind;
  return (
    <div className="strategies">
      <section className="card strat-build">
        <h3>Build a strategy</h3>
        <p className="muted small">Made of orders that run on chain: nothing to keep open, and every fill is at the oracle price like any order. Backtested on the last 30 days of hourly candles, at our 0.05% fee a side.</p>
        <div className="seg">{(Object.keys(KIND_NAME) as Kind[]).map(x => <button key={x} className={k === x ? "on" : ""} onClick={() => { setSpec(s => ({ ...s, kind: x, p: { ...DEFAULTS[x] } })); setRes(undefined); }}>{KIND_NAME[x]}</button>)}</div>
        <div className="strat-fields">
          <label className="inp small"><span>Market</span><select value={spec.sym} onChange={e => setSpec(s => ({ ...s, sym: e.target.value }))}>{(syms.length ? syms : ["SOL"]).map(x => <option key={x}>{x}</option>)}</select></label>
          {k !== "grid" && <label className="inp small"><span>Side</span><select value={spec.side} onChange={e => setSpec(s => ({ ...s, side: Number(e.target.value) as 1 | -1 }))}><option value={1}>Long</option><option value={-1}>Short</option></select></label>}
          {k === "grid" && [field("rangePct", "Range ±", "%"), field("levels", "Levels"), field("usd", "A level", "$")]}
          {k === "ladder" && [field("steps", "Steps"), field("apartPct", "Apart", "%"), field("usd", "A step", "$"), field("tpPct", "Take profit", "%")]}
          {k === "cross" && [pick("watch", "When"), field("movePct", "moves (24 h)", "%"), field("usd", "Trade", "$"), field("tpPct", "Take profit", "%"), field("slPct", "Stop", "%")]}
          {k === "pair" && [pick("other", "Against"), field("gapPct", "Ratio off its 7-day mean by", "%"), field("usd", "Each leg", "$")]}
        </div>
        <div className="fine">{k === "grid" ? "Levels across the range around today's price: buys below, sells above, each turning around after it fills."
          : k === "ladder" ? `Scales ${spec.side > 0 ? "into a long as the price falls" : "into a short as it rises"}; the backtest takes profit at the set distance from the average entry.`
          : k === "cross" ? `Trades ${spec.sym} once ${String(spec.p.watch)} has moved by the set amount; the backtest exits at the take-profit, the stop, or after 48 hours. Live, it is one order on chain at today's ${String(spec.p.watch)} level.`
          : `${spec.side > 0 ? "Long" : "Short"} ${spec.sym} and ${spec.side > 0 ? "short" : "long"} ${String(spec.p.other)} once their price ratio is off its average by the set amount; the backtest closes both when it is back. Live, two orders on chain at today's ratio.`}</div>
        <button className="btn white" onClick={() => { setRes("Running…"); backtest(spec).then(setRes).catch(e => setRes(String(e?.message ?? e))); }}>Backtest</button>
        {typeof res === "string" ? <div className="fine">{res}</div> : res && <ResultView r={res} />}
        <div className="strat-actions">
          <button className="btn" disabled={!publicKey || !!busy} onClick={() => apply(spec)} title="Place the orders on your account, at today's prices">Use it on my account</button>
        </div>
        <h4>Publish it</h4>
        <label className="inp small"><span>Name</span><input value={spec.name} maxLength={60} onChange={e => setSpec(s => ({ ...s, name: e.target.value }))} placeholder="e.g. SOL range grid" /></label>
        <label className="inp small"><span>Note</span><input value={spec.note} maxLength={200} onChange={e => setSpec(s => ({ ...s, note: e.target.value }))} placeholder="What it is for" /></label>
        <button className="btn" disabled={!publicKey || !!busy || !spec.name.trim()} onClick={publish}>Publish (signed by your wallet, public)</button>
      </section>
      <section className="card strat-list">
        <h3>Published strategies</h3>
        {!list ? <div className="quiet">Loading…</div> : list.length === 0 ? <div className="quiet">None yet: build one and publish it.</div> : list.map(x => {
          const t = tests[x.sig];
          return (
            <div key={x.sig} className="strat-item">
              <div className="strat-head"><b>{x.spec.name || KIND_NAME[x.spec.kind]}</b><span className="muted small">{KIND_NAME[x.spec.kind]} · {x.spec.sym}{x.spec.kind !== "grid" ? (x.spec.side > 0 ? " · long" : " · short") : ""}</span></div>
              {x.spec.note && <p className="small">{x.spec.note}</p>}
              <div className="muted small">by <a href={`#/trader/${x.author}`} onClick={e => { e.preventDefault(); go(`/trader/${x.author}`); }}>{short(x.author)}</a> · {new Date(x.time * 1000).toLocaleDateString()}</div>
              {typeof t === "string" ? <div className="fine">{t}</div> : t && <ResultView r={t} />}
              <div className="strat-actions">
                <button className="btn tiny" onClick={() => { setTests(m => ({ ...m, [x.sig]: "Running…" })); backtest(x.spec).then(r => setTests(m => ({ ...m, [x.sig]: r }))).catch(e => setTests(m => ({ ...m, [x.sig]: String(e?.message ?? e) }))); }}>Backtest</button>
                <button className="btn tiny" disabled={!publicKey || !!busy} onClick={() => apply(x.spec)}>Use it</button>
                <button className="btn tiny" onClick={() => { setSpec({ ...x.spec, name: "", note: "" }); setRes(undefined); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit a copy</button>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
