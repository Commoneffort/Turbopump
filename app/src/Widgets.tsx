// The Trade page's middle column: widgets the trader picks, orders and removes. The choice is kept
// in this browser (localStorage "pv:widgets"). Everything here reads public accounts from the
// shared copy (/api/state) or the site's execution report, so adding a widget costs no wallet
// request.
import { ReactNode, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import * as C from "./chain";
import * as S from "./social";
import { Crowd, Queue, Trades, Who, Whale, useExecReport, useMarketOrders } from "./Pulse";
import { Card, ago, explorer, fmt, num, useActivity } from "./shared";

type Ctx = { state: C.State; tick: number; board?: S.Board; fills: Whale[]; markets: Card[]; go: (to: string) => void };
/** `big`: drawn in the full-screen view (more rows, more detail). */
type Widget = { id: string; title: string; about: string; render: (c: Ctx, big?: boolean) => ReactNode };

const money = (x: number, dp?: number) => {
  const a = Math.abs(x), s = x < 0 ? "−" : "";
  return a >= 1e6 ? `${s}$${fmt(a / 1e6, 2)}M` : a >= 10_000 ? `${s}$${fmt(a / 1000, 1)}k` : `${s}$${fmt(a, dp ?? (a >= 100 ? 0 : 2))}`;
};
const money0 = (x: number) => money(x, 0);
const qty = (x: number) => fmt(Math.abs(x), Math.abs(x) >= 100 ? 1 : Math.abs(x) >= 1 ? 3 : 4);

const WIDGETS: Widget[] = [
  { id: "crowd", title: "Long / short", about: "How traders lean on this market", render: c => <Crowd state={c.state} board={c.board} /> },
  { id: "queue", title: "Queue", about: "Trades waiting a few seconds for their price", render: c => <Queue state={c.state} fills={c.fills} board={c.board} go={c.go} bare /> },
  { id: "trades", title: "Trades", about: "Every fill on this market, newest first", render: (c, big) => <Trades fills={c.fills} board={c.board} sym={c.state.vault.feed?.symbol ?? ""} go={c.go} limit={big ? 300 : 40} /> },
  { id: "liqs", title: "Liquidations", about: "Where open positions would be liquidated, by price, and the liquidations so far", render: (c, big) => <Liquidations state={c.state} board={c.board} big={big} /> },
  { id: "twaps", title: "TWAPs", about: "Large orders being traded in slices, by anyone", render: c => <Twaps state={c.state} tick={c.tick} board={c.board} go={c.go} /> },
  { id: "positions", title: "Open positions", about: "The largest positions on this market, with their liquidation prices", render: (c, big) => <Positions state={c.state} board={c.board} go={c.go} big={big} /> },
  { id: "top", title: "Top traders", about: "Most profit across all markets", render: (c, big) => <TopTraders board={c.board} go={c.go} big={big} /> },
  { id: "calc", title: "Position size calculator", about: "How big a trade to make for the risk you choose", render: c => <SizeCalc state={c.state} /> },
  { id: "vault", title: "Vault events", about: "Deposits, withdrawals and the vault's own trades", render: c => <VaultEvents state={c.state} tick={c.tick} /> },
];
const DEFAULT = ["crowd", "queue", "trades"];
const KEY = "pv:widgets";

function loadIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(v)) return v.filter(x => WIDGETS.some(w => w.id === x));
  } catch { /* storage unavailable */ }
  return DEFAULT;
}

export function WidgetPanel(ctx: Ctx) {
  const [ids, setIds] = useState<string[]>(loadIds);
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(undefined); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);
  const shown = open ? WIDGETS.find(w => w.id === open) : undefined;
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const save = (next: string[]) => { setIds(next); try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ } };
  const toggle = (id: string) => save(ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const move = (i: number, d: number) => { const n = [...ids]; [n[i], n[i + d]] = [n[i + d], n[i]]; save(n); };
  return (
    <div className="wgs">
      <div className="wg-bar" ref={box}>
        <h3>Widgets</h3>
        <button className={`wg-add${menu ? " on" : ""}`} onClick={() => setMenu(m => !m)} aria-expanded={menu} title="Add or remove widgets">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          Add
        </button>
        {menu && (
          <div className="wg-menu" role="menu">
            {WIDGETS.map(w => (
              <button key={w.id} role="menuitemcheckbox" aria-checked={ids.includes(w.id)} className={ids.includes(w.id) ? "on" : ""} onClick={() => toggle(w.id)}>
                <i aria-hidden>{ids.includes(w.id)
                  ? <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.5 5 9.5 10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  : <svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}</i>
                <span><b>{w.title}</b><em>{w.about}</em></span>
              </button>
            ))}
            <button className="wg-reset" onClick={() => save(DEFAULT)}>Back to the default set</button>
          </div>
        )}
      </div>
      {ids.length === 0 && <div className="quiet">No widgets shown. Use “Add” to pick some.</div>}
      {ids.map((id, i) => {
        const w = WIDGETS.find(x => x.id === id)!;
        return (
          <section key={id} className={`wg wg-${id}`}>
            <div className="wg-h">
              <h4 title={w.about}>{w.title}</h4>
              <span className="wg-tools">
                <button onClick={() => setOpen(id)} aria-label={`Open ${w.title} full screen`} title="Open full screen">
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden><path d="M7 1.5h3.5V5M5 10.5H1.5V7M10.5 1.5 7 5M1.5 10.5 5 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                </button>
                <button disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${w.title} up`} title="Move up">↑</button>
                <button disabled={i === ids.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${w.title} down`} title="Move down">↓</button>
                <button onClick={() => toggle(id)} aria-label={`Remove ${w.title}`} title="Remove">×</button>
              </span>
            </div>
            <div className="wg-b">{w.render(ctx)}</div>
          </section>
        );
      })}
      {shown && (
        <div className="wmodal-back" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(undefined); }}>
          <div className="wmodal" role="dialog" aria-modal="true" aria-label={shown.title}>
            <div className="wmodal-h">
              <h3>{shown.title} <em>{ctx.state.vault.feed?.symbol}</em></h3>
              <span className="muted small">{shown.about}</span>
              <button onClick={() => setOpen(undefined)} aria-label="Close" title="Close (Esc)">×</button>
            </div>
            <div className="wmodal-b">{shown.render(ctx, true)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- liquidations

/** One open position on this market and the price at which its account would be liquidated:
 *  where its equity, moved by this position alone (its others held where they are), falls to the
 *  liquidation level of everything it holds. Cross margin: the same account's other positions
 *  count in its equity and in what it must keep. */
export type LiqLevel = { wallet: string; size: number; value: number; liq: number; dist: number; equity: number; leverage: number; now: boolean };
export function liqLevels(state: C.State, board?: S.Board): LiqLevel[] {
  if (!board) return [];
  const asset = state.vault.assetIndex, md = state.marketData;
  const p0 = num(state.asset.price, 1e6), l = Number(state.levels.liq) / 10_000;
  const out: LiqLevel[] = [];
  for (const r of board.rows) {
    const pos = r.positions.find(p => p.asset === asset && p.size !== 0);
    if (!pos) continue;
    const otherFloor = r.positions.filter(p => p.asset !== asset).reduce((t, p) => t + Math.abs(p.notional) * Number(C.levels(md, p.asset).liq) / 10_000, 0);
    const q = pos.size;
    const x = (otherFloor - r.equity + q * p0) / (q - l * Math.abs(q));
    if (!Number.isFinite(x) || x <= 0) continue;
    out.push({ wallet: r.wallet, size: q, value: Math.abs(q) * p0, liq: x, dist: q > 0 ? (p0 - x) / p0 : (x - p0) / p0, equity: r.equity, leverage: r.leverage, now: r.liquidatable });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

const RANGES = [0.05, 0.1, 0.2, 0.5];

/** Where the open positions on this market would be liquidated, in price ranges around the price
 *  (longs below it in red, shorts above in green), how much is close, and the liquidations that
 *  happened. The full-screen view adds wider ranges, the running totals, the accounts nearest to
 *  their level and every liquidation in the report's window. */
function Liquidations({ state, board, big }: { state: C.State; board?: S.Board; big?: boolean }) {
  const sym = state.vault.feed?.symbol ?? "";
  const [tab, setTab] = useState<"map" | "history">("map");
  const [range, setRange] = useState(big ? 0.2 : 0.1);
  const levels = liqLevels(state, board);
  if (!board) return <div className="quiet">Loading…</div>;
  const p0 = num(state.asset.price, 1e6), dp = p0 >= 1000 ? 0 : p0 >= 1 ? 2 : 4;
  const within = (d: number) => levels.filter(x => x.dist <= d);
  const sum = (xs: LiqLevel[], long: boolean) => xs.filter(x => (x.size > 0) === long).reduce((t, x) => t + x.value, 0);
  const nearL = levels.find(x => x.size > 0), nearS = levels.find(x => x.size < 0);
  const head = (
    <div className="liqw-kpis">
      <div title="Value of long positions liquidated if the price fell 2%, 5% or 10%"><span>{big ? "Longs liquidated within 2% / 5% / 10%" : "Longs at −2 / 5 / 10%"}</span><b className="mono down">{money0(sum(within(0.02), true))} · {money0(sum(within(0.05), true))} · {money0(sum(within(0.1), true))}</b></div>
      <div title="Value of short positions liquidated if the price rose 2%, 5% or 10%"><span>{big ? "Shorts liquidated within 2% / 5% / 10%" : "Shorts at +2 / 5 / 10%"}</span><b className="mono up">{money0(sum(within(0.02), false))} · {money0(sum(within(0.05), false))} · {money0(sum(within(0.1), false))}</b></div>
      <div><span>{big ? "Nearest long level" : "Nearest long"}</span><b className="mono">{nearL ? `${fmt(nearL.liq, dp)} (−${fmt(nearL.dist * 100, 1)}%)` : "none"}</b></div>
      <div><span>{big ? "Nearest short level" : "Nearest short"}</span><b className="mono">{nearS ? `${fmt(nearS.liq, dp)} (+${fmt(nearS.dist * 100, 1)}%)` : "none"}</b></div>
    </div>
  );
  return (
    <div className={`liqw${big ? " big" : ""}`}>
      {!big && (
        <div className="liqw-tabs">
          <button className={tab === "map" ? "on" : ""} onClick={() => setTab("map")}>Levels</button>
          <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>Happened</button>
        </div>
      )}
      {(big || tab === "map") && <>
        {head}
        <div className="liqw-range">
          <span className="muted">Range</span>
          {RANGES.map(r => <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>±{r * 100}%</button>)}
        </div>
        <LiqMap levels={levels} price={p0} range={range} big={!!big} dp={dp} sym={sym} />
        {big && <p className="liqw-note muted">
          {levels.length} open position{levels.length === 1 ? "" : "s"} on {sym}. Each bar is how much would be liquidated if the price reached that range
          (estimated from each account's equity and positions now; profit, fees and other markets moving change it). Hover a bar for details.
        </p>}
      </>}
      {big && <h4 className="liqw-sub">Nearest to their liquidation price</h4>}
      {big && <LiqTable levels={levels} board={board} dp={dp} sym={sym} />}
      {(big || tab === "history") && <>
        {big && <h4 className="liqw-sub">Liquidations that happened</h4>}
        <LiqHistory state={state} big={!!big} />
      </>}
    </div>
  );
}

/** The liquidation map: price ranges across the chosen band around the price, each bar the value
 *  liquidated if the price reached it; in the full view, the running total from the price outward. */
function LiqMap({ levels, price, range, big, dp, sym }: { levels: LiqLevel[]; price: number; range: number; big: boolean; dp: number; sym: string }) {
  const N = big ? 60 : 30;
  const lo = price * (1 - range), hi = price * (1 + range), step = (hi - lo) / N;
  const bars = Array.from({ length: N }, (_, i) => ({ from: lo + i * step, to: lo + (i + 1) * step, long: 0, short: 0, n: 0 }));
  let outside = 0;
  for (const x of levels) {
    if (x.liq < lo || x.liq >= hi) { outside++; continue; }
    const b = bars[Math.min(N - 1, Math.floor((x.liq - lo) / step))];
    if (x.size > 0) b.long += x.value; else b.short += x.value;
    b.n++;
  }
  const top = Math.max(1, ...bars.map(b => b.long + b.short));
  const W = big ? 900 : 300, H = big ? 260 : 110, padB = 2;
  const xAt = (p: number) => ((p - lo) / (hi - lo)) * W;
  const yAt = (v: number) => (H - padB) - (v / top) * (H - padB - 8);
  // Running totals outward from the price: longs below it, shorts above it.
  const cumL: [number, number][] = [], cumS: [number, number][] = [];
  if (big) {
    let t = 0;
    for (let i = N - 1; i >= 0; i--) { if (bars[i].to > price) continue; t += bars[i].long; cumL.push([xAt(bars[i].from), t]); }
    t = 0;
    for (let i = 0; i < N; i++) { if (bars[i].from < price) continue; t += bars[i].short; cumS.push([xAt(bars[i].to), t]); }
  }
  const cumTop = Math.max(1, ...cumL.map(c => c[1]), ...cumS.map(c => c[1]));
  const cy = (v: number) => (H - padB) - (v / cumTop) * (H - padB - 8);
  const line = (pts: [number, number][]) => pts.length ? `M${xAt(price)},${H - padB} ` + pts.map(([x, v]) => `L${x},${cy(v)}`).join(" ") : "";
  const ticks = big ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  return (
    <div className="liqmap">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Liquidation levels on ${sym} within ±${range * 100}% of the price`}>
        {[0.25, 0.5, 0.75].map(f => <line key={f} x1="0" x2={W} y1={(H - padB) * f} y2={(H - padB) * f} className="liqmap-grid" />)}
        {bars.map((b, i) => {
          const x = xAt(b.from) + 0.5, w = Math.max(1, xAt(b.to) - xAt(b.from) - 1);
          const yl = yAt(b.long), ys = yAt(b.long + b.short);
          return (
            <g key={i}>
              <title>{`${fmt(b.from, dp)} – ${fmt(b.to, dp)}: ${b.long ? `longs ${money(b.long)}` : ""}${b.long && b.short ? ", " : ""}${b.short ? `shorts ${money(b.short)}` : ""}${!b.long && !b.short ? "nothing" : ` (${b.n} account${b.n === 1 ? "" : "s"})`}`}</title>
              <rect x={x} y={0} width={w} height={H - padB} className="liqmap-hit" />
              {b.long > 0 && <rect x={x} y={yl} width={w} height={(H - padB) - yl} className="liqmap-long" />}
              {b.short > 0 && <rect x={x} y={ys} width={w} height={yl - ys} className="liqmap-short" />}
            </g>
          );
        })}
        {big && <path d={line(cumL)} className="liqmap-cum long" />}
        {big && <path d={line(cumS)} className="liqmap-cum short" />}
        <line x1={xAt(price)} x2={xAt(price)} y1="0" y2={H - padB} className="liqmap-now" />
      </svg>
      <div className="liqmap-ticks mono">{ticks.map(f => <span key={f} style={{ left: `${f * 100}%` }} className={f === 0 ? "first" : f === 1 ? "last" : ""}>{fmt(lo + (hi - lo) * f, dp)}</span>)}</div>
      {big && <div className="liqmap-legend mono">
        <span><i className="sw long" />longs liquidated</span>
        <span><i className="sw now" />price {fmt(price, dp)}</span>
        <span><i className="sw short" />shorts liquidated</span>
        {big && <span className="muted">lines: running total from the price · largest bar {money(top)}</span>}
        {outside > 0 && <span className="muted">{outside} level{outside === 1 ? "" : "s"} outside ±{range * 100}%</span>}
      </div>}
    </div>
  );
}

function LiqTable({ levels, board, dp, sym }: { levels: LiqLevel[]; board: S.Board; dp: number; sym: string }) {
  if (!levels.length) return <div className="quiet">No open position on {sym}.</div>;
  return (
    <div className="wtable liq-t">
      <div className="wtable-h"><span>Trader</span><span>Side</span><span>{sym}</span><span>Value</span><span>Liq. price</span><span>Distance</span><span>Equity</span><span>Lev.</span></div>
      {levels.slice(0, 40).map(x => (
        <div key={x.wallet} className={`wtable-r${x.now ? " risk" : ""}`}>
          <Who wallet={x.wallet} board={board} />
          <span className={x.size > 0 ? "up" : "down"}>{x.size > 0 ? "Long" : "Short"}</span>
          <span className="mono">{qty(x.size)}</span>
          <span className="mono">{money(x.value)}</span>
          <span className="mono">{fmt(x.liq, dp)}</span>
          <span className={`mono ${x.dist < 0.02 ? "down" : ""}`}>{x.now ? "now" : `${fmt(x.dist * 100, 1)}%`}</span>
          <span className="mono">{money(x.equity)}</span>
          <span className="mono muted">{x.leverage > 0 ? `${fmt(x.leverage, 1)}×` : "—"}</span>
        </div>
      ))}
    </div>
  );
}

/** Forced closes on this market in the execution report's window: what longs lost (red) and what
 *  shorts lost (green) per period, and the latest ones. */
function LiqHistory({ state, big }: { state: C.State; big: boolean }) {
  const sym = state.vault.feed?.symbol ?? "";
  const { report, err } = useExecReport();
  if (!report) return <div className="quiet">{err ? "The report could not be read." : "Loading…"}</div>;
  const m = report.markets.find(x => x.symbol === sym);
  if (!m) return <div className="quiet">No report for {sym} yet.</div>;
  const liqs = (report.liqFills ?? []).filter(l => l.market === sym && l.at >= m.from);
  const all = (report.liqFills ?? []).filter(l => l.at >= Math.min(...report.markets.map(x => x.from)));
  const hours = (m.to - m.from) / 3600;
  const longs = liqs.filter(l => l.size < 0).reduce((t, l) => t + Math.abs(l.size) * l.price, 0), shorts = liqs.filter(l => l.size > 0).reduce((t, l) => t + Math.abs(l.size) * l.price, 0);
  const N = big ? 24 : 12, span = Math.max(1, m.to - m.from), stepT = span / N;
  const bars = Array.from({ length: N }, () => ({ long: 0, short: 0 }));
  for (const l of liqs) { const b = bars[Math.min(N - 1, Math.floor((l.at - m.from) / stepT))]; if (l.size < 0) b.long += Math.abs(l.size) * l.price; else b.short += Math.abs(l.size) * l.price; }
  const top = Math.max(1, ...bars.map(b => Math.max(b.long, b.short)));
  const W = big ? 900 : 300, H = big ? 120 : 64, slot = W / N, bw = (slot - 4) / 2;
  return (
    <div className="liqh">
      <div className="liqw-tot mono"><span className="down">Longs {money(longs)}</span><span className="muted">{liqs.length} on {sym} in {fmt(hours, hours < 10 ? 1 : 0)} h · {all.length} on all markets</span><span className="up">Shorts {money(shorts)}</span></div>
      {liqs.length > 0 && (
        <svg viewBox={`0 0 ${W} ${H + 2}`} className="liqw-svg" preserveAspectRatio="none">
          <line x1="0" x2={W} y1={H + 1} y2={H + 1} className="liqw-axis" />
          {bars.map((b, i) => {
            const hl = (b.long / top) * H, hs = (b.short / top) * H;
            return (
              <g key={i}>
                <title>{`${new Date((m.from + i * stepT) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: longs ${money(b.long)}, shorts ${money(b.short)}`}</title>
                <rect x={i * slot + 2} y={H - hl} width={bw} height={Math.max(hl, b.long ? 1.5 : 0)} rx="1" className="liqw-long" />
                <rect x={i * slot + 2 + bw} y={H - hs} width={bw} height={Math.max(hs, b.short ? 1.5 : 0)} rx="1" className="liqw-short" />
              </g>
            );
          })}
        </svg>
      )}
      {liqs.length === 0
        ? <div className="quiet">None on {sym} in the last {fmt(hours, 1)} h. That is normal while prices are calm: the levels above show where they would start.</div>
        : <div className="liqw-list">{[...liqs].reverse().slice(0, big ? 50 : 5).map((l, i) => (
            <div key={i} className="liqw-row mono">
              <span className={l.size < 0 ? "down" : "up"}>{l.size < 0 ? "Long" : "Short"} {qty(l.size)} {sym}</span>
              <span>at {fmt(l.price, l.price >= 1000 ? 0 : 3)}</span>
              <span>{money(Math.abs(l.size) * l.price)}</span>
              <span className="muted">{ago(Date.now() / 1000 - l.at)}</span>
            </div>
          ))}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- TWAPs

/** Every TWAP running on this market: what is left, how many slices, and when the next one is due. */
function Twaps({ state, tick, board, go }: { state: C.State; tick: number; board?: S.Board; go: (to: string) => void }) {
  const sym = state.vault.feed?.symbol ?? "";
  const orders = useMarketOrders(state.vault.key, tick);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const id = setInterval(() => document.hidden || setNow(Date.now() / 1000), 1000); return () => clearInterval(id); }, []);
  if (!orders) return <div className="quiet">Loading…</div>;
  const twaps = orders.filter(o => o.kind === C.ORDER.TWAP && o.size !== 0n).sort((a, b) => a.nextTime - b.nextTime);
  if (!twaps.length) return <div className="quiet">No TWAP running on {sym}.</div>;
  const price = num(state.asset.price, 1e6);
  return (
    <div className="wtable">
      <div className="wtable-h"><span>Trader</span><span>Left</span><span>Slices</span><span>Next</span></div>
      {twaps.map(o => {
        const left = num(o.size, 1e6), slice = num(o.slice, 1e6);
        const slices = slice > 0 ? Math.ceil(Math.abs(left) / slice - 1e-9) : 1;
        const next = o.nextTime - now;
        return (
          <div key={o.key.toBase58()} className="wtable-r" title={`${left > 0 ? "Buying" : "Selling"} ${qty(left)} ${sym} (${money(Math.abs(left) * price)}) in slices of ${qty(slice)} every ${o.interval} s`}>
            <Who wallet={o.wallet.toBase58()} board={board} go={go} />
            <span className={`mono ${left > 0 ? "up" : "down"}`}>{left > 0 ? "+" : "−"}{qty(left)}</span>
            <span className="mono">{slices} × {o.interval}s</span>
            <span className="mono muted">{o.queued ? "filling" : next > 0 ? `${Math.ceil(next)}s` : "due"}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- open positions

function Positions({ state, board, go, big }: { state: C.State; board?: S.Board; go: (to: string) => void; big?: boolean }) {
  const { publicKey } = useWallet();
  const asset = state.vault.assetIndex, sym = state.vault.feed?.symbol ?? "";
  if (!board) return <div className="quiet">Loading…</div>;
  const liq = new Map(liqLevels(state, board).map(x => [x.wallet, x]));
  const rows = board.rows.flatMap(r => r.positions.filter(p => p.asset === asset && p.size !== 0).map(p => ({ r, p })))
    .sort((a, b) => Math.abs(b.p.notional) - Math.abs(a.p.notional));
  if (!rows.length) return <div className="quiet">Nobody holds a position on {sym}.</div>;
  const me = publicKey?.toBase58();
  const dp = num(state.asset.price, 1e6) >= 1000 ? 0 : 2;
  const longV = rows.filter(x => x.p.size > 0).reduce((t, x) => t + Math.abs(x.p.notional), 0), shortV = rows.filter(x => x.p.size < 0).reduce((t, x) => t + Math.abs(x.p.notional), 0);
  return (
    <div className={`wtable${big ? " pos-big" : ""}`}>
      {big && <div className="liqw-tot mono"><span className="up">{rows.filter(x => x.p.size > 0).length} longs · {money(longV)}</span><span className="muted">{rows.length} positions</span><span className="down">{money(shortV)} · {rows.filter(x => x.p.size < 0).length} shorts</span></div>}
      <div className="wtable-h"><span>Trader</span><span>{sym}</span><span>Value</span>{big && <><span>Liq. price</span><span>Distance</span><span>Equity</span></>}<span>Lev.</span></div>
      {rows.slice(0, big ? 200 : 20).map(({ r, p }) => {
        const l = liq.get(r.wallet);
        return (
          <div key={r.wallet} className={`wtable-r${r.wallet === me ? " mine" : ""}${r.liquidatable ? " risk" : ""}`} title={r.liquidatable ? "Below its liquidation level" : l ? `Liquidated at about ${fmt(l.liq, dp)} (${fmt(l.dist * 100, 1)}% away)` : undefined}>
            <Who wallet={r.wallet} board={board} go={go} />
            <span className={`mono ${p.size > 0 ? "up" : "down"}`}>{p.size > 0 ? "+" : "−"}{qty(p.size)}</span>
            <span className="mono">{money(Math.abs(p.notional))}</span>
            {big && <><span className="mono">{l ? fmt(l.liq, dp) : "—"}</span><span className={`mono ${l && l.dist < 0.02 ? "down" : ""}`}>{r.liquidatable ? "now" : l ? `${fmt(l.dist * 100, 1)}%` : "—"}</span><span className="mono">{money(r.equity)}</span></>}
            <span className="mono muted">{r.leverage > 0 ? `${fmt(r.leverage, 1)}×` : "—"}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- top traders

function TopTraders({ board, go, big }: { board?: S.Board; go: (to: string) => void; big?: boolean }) {
  if (!board) return <div className="quiet">Loading…</div>;
  const rows = board.rows.filter(r => r.stats).sort((a, b) => b.pnl - a.pnl).slice(0, big ? 50 : 10);
  if (!rows.length) return <div className="quiet">No track records yet.</div>;
  return (
    <div className={`wtable${big ? " top-big" : ""}`}>
      <div className="wtable-h"><span>Trader</span><span>Profit</span><span>Return</span>{big && <><span>Equity</span><span>Volume</span><span>Win days</span><span>Lev.</span></>}<span>Copiers</span></div>
      {rows.map(r => (
        <div key={r.wallet} className="wtable-r">
          <Who wallet={r.wallet} board={board} go={go} />
          <span className={`mono ${r.pnl >= 0 ? "up" : "down"}`}>{r.pnl >= 0 ? "+" : ""}{money(r.pnl)}</span>
          <span className={`mono ${r.roi >= 0 ? "up" : "down"}`}>{r.roi >= 0 ? "+" : "−"}{fmt(Math.abs(r.roi) * 100, 1)}%</span>
          {big && <><span className="mono">{money(r.equity)}</span><span className="mono">{money(r.stats!.volume)}</span><span className="mono">{r.daysUp + r.daysDown ? `${fmt(r.daysUp / (r.daysUp + r.daysDown) * 100, 0)}%` : "—"}</span><span className="mono muted">{r.leverage > 0 ? `${fmt(r.leverage, 1)}×` : "—"}</span></>}
          <span className="mono muted">{r.copiers}</span>
        </div>
      ))}
      <button className="wg-more" onClick={() => go("/leaderboard")}>Leaderboard →</button>
    </div>
  );
}

// ---------------------------------------------------------------- position size calculator

/** How big a position to open so that, if the stop-loss is hit, the loss is the share of the
 *  account chosen. Loss = size × |entry − stop| (+ the fee each way). */
function SizeCalc({ state }: { state: C.State }) {
  const sym = state.vault.feed?.symbol ?? "";
  const mark = num(state.asset.price, 1e6);
  const dp = mark >= 1000 ? 2 : mark >= 1 ? 3 : 5;
  const equity = state.health ? num(state.health.equity, 1e6) : undefined;
  const [account, setAccount] = useState(() => (equity && equity > 0 ? equity.toFixed(2) : "1000"));
  const [risk, setRisk] = useState("1");
  const [entry, setEntry] = useState(mark.toFixed(dp));
  const [stop, setStop] = useState((mark * 0.98).toFixed(dp));
  const A = Number(account), R = Number(risk) / 100, E = Number(entry), Sl = Number(stop);
  const fee = C.TRADE_FEE_BPS / 10_000;
  const ok = A > 0 && R > 0 && E > 0 && Sl > 0 && Sl !== E;
  const long = Sl < E;
  const atRisk = A * R;
  // Each unit loses |E − S| at the stop, plus the fee on the way in and on the way out.
  const perUnit = Math.abs(E - Sl) + fee * (E + Sl);
  const size = ok ? atRisk / perUnit : 0;
  const value = size * E, lev = A > 0 ? value / A : 0;
  const maxLev = 10_000 / Number(state.levels.open);
  // Where an account holding only this position would be liquidated (its equity at the tier's level).
  const liqLevel = Number(state.levels.liq) / 10_000;
  // Equity A + size × (P − E) (long) falls to liqLevel × size × P at this P; a long backed
  // by more than its own value never gets there.
  const liqRaw = ok && size > 0 ? (long ? (size * E - A) / (size * (1 - liqLevel)) : (A + size * E) / (size * (1 + liqLevel))) : undefined;
  const liq = liqRaw !== undefined && liqRaw > 0 ? liqRaw : undefined;
  const liqFirst = liq !== undefined && (long ? liq >= Sl : liq <= Sl);
  return (
    <div className="calc">
      <div className="calc-in">
        <label><span>Account size, $</span><input inputMode="decimal" value={account} onChange={e => setAccount(e.target.value)} /></label>
        <label><span>Risk, %</span><input inputMode="decimal" value={risk} onChange={e => setRisk(e.target.value)} /></label>
        <label><span>Entry price<button type="button" onClick={() => setEntry(mark.toFixed(dp))}>now</button></span><input inputMode="decimal" value={entry} onChange={e => setEntry(e.target.value)} /></label>
        <label><span>Stop-loss price</span><input inputMode="decimal" value={stop} onChange={e => setStop(e.target.value)} /></label>
      </div>
      {ok ? (
        <div className="calc-out">
          <div><span>Direction</span><b className={long ? "up" : "down"}>{long ? "Long" : "Short"} (stop {long ? "below" : "above"} entry)</b></div>
          <div><span>Money at risk</span><b className="mono">{money(atRisk, 2)}</b></div>
          <div><span>Stop distance</span><b className="mono">{fmt(Math.abs(E - Sl) / E * 100, 2)}%</b></div>
          <div><span>Position size</span><b className="mono">{qty(size)} {sym}</b></div>
          <div><span>Position value</span><b className="mono">{money(value, 2)}</b></div>
          <div><span>Leverage</span><b className={`mono ${lev > maxLev ? "down" : ""}`}>{fmt(lev, 2)}×{lev > maxLev ? ` (max ${fmt(maxLev, 0)}×)` : ""}</b></div>
          <div><span>Liquidation, about</span><b className={`mono ${liqFirst ? "down" : ""}`}>{liq !== undefined ? fmt(liq, dp) : "none (under 1×)"}</b></div>
          {liqFirst && <p className="calc-warn">The position would be liquidated before the stop is reached. Use a closer stop or a smaller risk.</p>}
          {lev > maxLev && !liqFirst && <p className="calc-warn">This needs more leverage than {sym} allows.</p>}
          <p className="muted small">Includes the {C.TRADE_FEE_PCT} fee each way. The liquidation price assumes this is the account's only position.</p>
        </div>
      ) : <div className="quiet">Enter an account size, a risk, and a stop that differs from the entry.</div>}
    </div>
  );
}

// ---------------------------------------------------------------- vault events

function VaultEvents({ state, tick }: { state: C.State; tick: number }) {
  const rows = useActivity(state.vault, tick);
  if (!rows) return <div className="quiet">Loading…</div>;
  if (!rows.length) return <div className="quiet">No activity yet.</div>;
  return (
    <div className="tape">
      {rows.map(r => (
        <a key={r.sig} className="tape-row" href={explorer("tx", r.sig)} target="_blank" rel="noreferrer">
          <span className={/^Long/.test(r.what) ? "up" : /^Short/.test(r.what) ? "down" : ""}>{r.what.replace(" vs vault", "")}</span>
          <span className="mono">{r.when ? ago(Date.now() / 1000 - r.when) : ""}</span>
        </a>
      ))}
    </div>
  );
}
