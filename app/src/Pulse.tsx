// What makes the Trade page move: other traders' activity, read from the chain.
//
//   queue   trades waiting their few seconds for a price, with a countdown, then their fill
//   tape    every fill on the market, by anyone, newest first
//   whales  the chart's "Whales" box: large fills drawn on the candles (Chart.tsx)
//   liqs    a short notice when an account falls below its liquidation level, and when it is closed
//   crowd   how traders lean (long against short) and how much of the vault's limit is used
//
// Each can be switched off here on its own. Everything is read from public accounts (the shared
// copy, /api/state): the router's queue and every account's track record (its last 16 fills), so
// none of it costs the visitor a transaction-history request. Our own test bots are labelled.
import { useEffect, useMemo, useRef, useState } from "react";
import * as C from "./chain";
import * as S from "./social";
import { Badge, nameOf } from "./Traders";
import { Card, ago, fmt, num } from "./shared";
import { view } from "./view";
import { SEED_WALLETS } from "../api/_config";

export const PULSE = { queue: true, tape: true, whales: true, liqs: true, crowd: true };
/** How often the Trade page re-reads the board while any of the above is on (ms). */
export const PULSE_BOARD_MS = 8_000;

const isBot = (w: string) => !!SEED_WALLETS[w]?.startsWith("bot");
const money = (x: number) => (x >= 1e6 ? `$${fmt(x / 1e6, 2)}M` : x >= 10_000 ? `$${fmt(x / 1000, 1)}k` : `$${fmt(x, x >= 100 ? 0 : 2)}`);

// ---------------------------------------------------------------- fills (tape and whales)

export type Whale = { key: string; wallet: string; time: number; price: number; size: number; value: number; name: string; bot: boolean };
/** The smallest trade value the chart's "Whales" box can be set to show. */
export const WHALE_MINS = [1_000, 2_500, 10_000, 25_000];
/** A whale bubble's radius: from 6 px at the chosen minimum to 18 px at 20 times it. */
export const whaleRadius = (value: number, min: number) => 6 + 12 * Math.min(1, Math.sqrt(Math.max(0, value / min - 1) / 19));

/** Every fill on `asset` in the board's track records, newest first. */
export function marketFills(board: S.Board | undefined, asset: number): Whale[] {
  const out: Whale[] = [];
  for (const r of board?.rows ?? []) {
    for (const f of r.stats?.fills ?? []) {
      if (f.asset !== asset || f.size === 0) continue;
      out.push({ key: `${r.wallet}:${f.time}:${f.size}`, wallet: r.wallet, time: f.time, price: f.price, size: f.size, value: Math.abs(f.size * f.price), name: nameOf(r.wallet, r.profile), bot: isBot(r.wallet) });
    }
  }
  return out.sort((a, b) => b.time - a.time);
}

/** Who a wallet is, as the tape and the queue show it: badge, name, a tag for our test bots. */
function Who({ wallet, board, go }: { wallet: string; board?: S.Board; go: (to: string) => void }) {
  const profile = board?.profiles.get(wallet);
  return (
    <button className="who" title={wallet} onClick={() => go(`/trader/${wallet}`)}>
      <Badge wallet={wallet} profile={profile} size={14} />
      <span>{nameOf(wallet, profile)}</span>
      {isBot(wallet) && <em>bot</em>}
    </button>
  );
}

/** The market's trades, newest first; ones that arrived since the last read flash once. */
export function Trades({ fills, board, sym, go }: { fills: Whale[]; board?: S.Board; sym: string; go: (to: string) => void }) {
  const seen = useRef<Set<string>>();
  const fresh = useMemo(() => {
    const had = seen.current;
    seen.current = new Set(fills.map(f => f.key));
    return had ? new Set(fills.filter(f => !had.has(f.key)).map(f => f.key)) : new Set<string>();
  }, [fills]);
  const [, redraw] = useState(0);
  useEffect(() => { const id = setInterval(() => document.hidden || redraw(x => x + 1), 5_000); return () => clearInterval(id); }, []);
  if (!board) return <div className="quiet">Loading…</div>;
  if (!fills.length) return <div className="quiet">No trades on {sym} yet.</div>;
  const now = Date.now() / 1000;
  return (
    <div className="trades">
      <div className="trades-head"><span>Trader</span><span>{sym}</span><span>Price</span><span>Time</span></div>
      {fills.slice(0, 40).map(f => (
        <div key={f.key} className={`trades-row${fresh.has(f.key) ? (f.size > 0 ? " flash-up" : " flash-down") : ""}${f.value >= WHALE_MINS[1] ? " big" : ""}`}>
          <Who wallet={f.wallet} board={board} go={go} />
          <span className={`mono ${f.size > 0 ? "up" : "down"}`} title={money(f.value)}>{f.size > 0 ? "+" : "−"}{fmt(Math.abs(f.size), Math.abs(f.size) >= 100 ? 1 : 3)}</span>
          <span className="mono">{fmt(f.price, f.price >= 1000 ? 1 : f.price >= 1 ? 3 : 5)}</span>
          <span className="mono muted">{ago(now - f.time).replace(" ago", "")}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the queue

type Queued = { r: C.RouterRequest; seen: number; gone?: number; fill?: Whale };
const KIND = ["Stop loss", "Take profit", "Trailing stop", "Limit", "TWAP slice"];

/** Trades waiting for their price: each shows a countdown to its target time, then its fill (found
 *  in the trader's track record), then leaves. */
export function Queue({ state, fills, board, go }: { state: C.State; fills: Whale[]; board?: S.Board; go: (to: string) => void }) {
  const vault = state.vault.key, sym = state.vault.feed?.symbol ?? "";
  const price = num(state.asset.price, 1e6);
  const [rows, setRows] = useState<Map<string, Queued>>(new Map());
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const id = setInterval(() => document.hidden || setNow(Date.now() / 1000), 500); return () => clearInterval(id); }, []);
  useEffect(() => {
    let live = true;
    setRows(new Map());
    const load = async () => {
      try {
        const reqs = await C.pendingRequests(view, vault);
        if (!live) return;
        const t = Date.now() / 1000;
        setRows(old => {
          const next = new Map<string, Queued>();
          for (const r of reqs) { const k = r.id.toString(); next.set(k, old.get(k) && !old.get(k)!.gone ? old.get(k)! : { r, seen: t }); }
          // A request that left the queue stays a few seconds, to show its fill.
          for (const [k, q] of old) if (!next.has(k) && t - (q.gone ?? t) < 12) next.set(k, q.gone ? q : { ...q, gone: t });
          return next;
        });
      } catch { /* the RPC may refuse a scan now and then: keep what is shown */ }
    };
    load();
    const id = setInterval(() => document.hidden || load(), 2_500);
    return () => { live = false; clearInterval(id); };
  }, [vault.toBase58()]);
  // Match each request that left with its fill in the trader's record.
  const shown = [...rows.values()].map(q => {
    if (!q.gone || q.fill || q.r.settle) return q;
    const w = q.r.wallet.toBase58(), want = num(q.r.size, 1e6);
    const fill = fills.find(f => f.wallet === w && Math.abs(f.time - q.r.target) <= C.ROUTER_GRACE_SECS + 5 && Math.sign(f.size) === Math.sign(want));
    return fill ? { ...q, fill } : q;
  }).filter(q => !q.gone || q.fill || now - q.gone < 3).sort((a, b) => a.r.target - b.r.target);
  const waiting = shown.filter(q => !q.gone).length;
  return (
    <div className="queue">
      <div className="ph queue-h">
        <h3>Queue{waiting > 0 && <em>{waiting}</em>}</h3>
        <span className="hint" title={`Every trade waits ${C.ROUTER_DELAY_SECS} seconds and then fills at the first oracle price after that: a price nobody, the trader included, could know when it was sent.`}>{shown.length ? "fills at the next price" : "no trade waiting"}</span>
      </div>
      {shown.slice(0, 4).map(q => {
        const n = num(q.r.size, 1e6), w = q.r.wallet.toBase58();
        const what = q.r.settle ? "Vault settlement" : `${q.r.order !== undefined ? `${KIND[q.r.order] ?? "Order"} · ` : ""}${n > 0 ? "Long" : "Short"} ${fmt(Math.abs(n), Math.abs(n) >= 100 ? 1 : 3)} ${sym}`;
        const left = Math.ceil(q.r.target - now);
        const status = q.fill ? `filled ${fmt(q.fill.price, q.fill.price >= 1000 ? 1 : 3)}` : q.gone ? "done" : left > 0 ? `in ${left}s` : "filling…";
        return (
          <div key={q.r.id.toString()} className={`queue-row${q.fill ? (n > 0 ? " done-up" : " done-down") : ""}${!q.gone && left <= 0 ? " busy" : ""}`}>
            {q.r.settle ? <span className="who muted">Vault</span> : <Who wallet={w} board={board} go={go} />}
            <span className={q.r.settle ? "" : n > 0 ? "up" : "down"} title={q.r.settle ? "" : money(Math.abs(n) * price)}>{what}</span>
            <span className="mono">{status}</span>
            {!q.gone && left > 0 && <i style={{ width: `${Math.max(0, Math.min(100, (left / C.ROUTER_DELAY_SECS) * 100))}%` }} />}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- how the crowd leans

/** Traders' longs against their shorts on this market: Percolator's open interest less the
 *  vault's own side. (How much of the vault's limit is used shows under its position.) */
export function Crowd({ state, board }: { state: C.State; board?: S.Board }) {
  const v = state.vault, asset = v.assetIndex;
  const price = num(state.asset.price, 1e6);
  const inv = v.inventory;
  const longQ = state.asset.oiLong - (inv > 0n ? inv : 0n), shortQ = state.asset.oiShort - (inv < 0n ? -inv : 0n);
  const L = Math.max(0, num(longQ, 1e6)) * price, Sh = Math.max(0, num(shortQ, 1e6)) * price;
  const total = L + Sh;
  const longPct = total > 0 ? (L / total) * 100 : 50;
  let longs = 0, shorts = 0;
  for (const r of board?.rows ?? []) for (const p of r.positions) if (p.asset === asset && p.size !== 0) p.size > 0 ? longs++ : shorts++;
  return (
    <div className="crowd">
      <div className="crowd-l"><span>Traders</span><b className="mono"><span className="up">{fmt(longPct, 0)}% long</span> · <span className="down">{fmt(100 - longPct, 0)}% short</span></b></div>
      <div className="crowd-bar" title={`Longs ${money(L)} (${longs} traders) · shorts ${money(Sh)} (${shorts} traders)`}><i className="crowd-long" style={{ width: `${longPct}%` }} /><i className="crowd-short" style={{ width: `${100 - longPct}%` }} /></div>
      <div className="crowd-ends mono"><span>{money(L)}{board ? ` · ${longs} trader${longs === 1 ? "" : "s"}` : ""}</span><span>{board ? `${shorts} trader${shorts === 1 ? "" : "s"} · ` : ""}{money(Sh)}</span></div>
    </div>
  );
}

// ---------------------------------------------------------------- liquidations

type Notice = { id: number; wallet: string; text: string; done: boolean; at: number };
let noticeId = 0;

/** Short notices, bottom left, when any account on the market falls below its liquidation level
 *  and when it is then closed. The first read only records who is where: no notice for what was
 *  already so before the page opened. */
export function Liquidations({ board, markets, go }: { board?: S.Board; markets: Card[]; go: (to: string) => void }) {
  const before = useRef<Map<string, { liq: boolean; text: string }>>();
  const [notes, setNotes] = useState<Notice[]>([]);
  const symOf = useMemo(() => new Map(markets.map(c => [c.v.assetIndex, c.v.feed?.symbol ?? "?"] as const)), [markets]);
  useEffect(() => {
    if (!board) return;
    const now = new Map<string, { liq: boolean; text: string }>();
    const add: Notice[] = [];
    for (const r of board.rows) {
      const big = [...r.positions].sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional))[0];
      const text = big ? `${big.size > 0 ? "long" : "short"} ${fmt(Math.abs(big.size), 3)} ${symOf.get(big.asset) ?? "?"} (${money(Math.abs(big.notional))})` : "";
      now.set(r.wallet, { liq: r.liquidatable, text });
      const was = before.current?.get(r.wallet);
      if (!before.current || !was) continue;
      if (r.liquidatable && !was.liq) add.push({ id: ++noticeId, wallet: r.wallet, text: `is being liquidated: ${text}`, done: false, at: Date.now() });
      else if (was.liq && !r.liquidatable && !r.positions.length) add.push({ id: ++noticeId, wallet: r.wallet, text: `was liquidated${was.text ? `: ${was.text} closed` : ""}`, done: true, at: Date.now() });
    }
    before.current = now;
    if (add.length) setNotes(n => [...add, ...n].slice(0, 3));
  }, [board]);
  useEffect(() => {
    if (!notes.length) return;
    const id = setTimeout(() => setNotes(n => n.filter(x => Date.now() - x.at < 9_000)), 1_000);
    return () => clearTimeout(id);
  }, [notes]);
  if (!notes.length) return null;
  return (
    <div className="liq-notes" role="status">
      {notes.map(n => (
        <div key={n.id} className={`liq-note${n.done ? " done" : ""}`}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M8 1.5 15 14H1zM8 6v4M8 11.6v.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span><Who wallet={n.wallet} board={board} go={go} /> {n.text}</span>
          <button aria-label="Dismiss" onClick={() => setNotes(x => x.filter(y => y.id !== n.id))}>×</button>
        </div>
      ))}
    </div>
  );
}

