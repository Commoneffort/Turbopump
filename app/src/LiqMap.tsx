// The liquidation map (2026-11-07): how much would be liquidated at each price around the current
// one. Price runs along the bottom in fine bins; long liquidations (below the price) are green bars
// on the left, short liquidations (above it) red bars on the right; a line at the current price;
// and from it, a cumulative line on each side: everything liquidated if the price gets that far.
// A button turns it on its side (price up the left, bars across). Two sources:
//   - the market, estimated (api/liqmap: a model over the big exchanges' volume, scaled to
//     Hyperliquid's open interest), like every public liquidation map;
//   - Turbopump, exact: each open position on this exchange at its own liquidation price.
import { useEffect, useMemo, useRef, useState } from "react";
import * as C from "./chain";

export type ExactLevel = { price: number; value: number };
type Bin = { lo: number; hi: number; long: number; short: number };
const RANGES = [0.02, 0.05, 0.1, 0.15] as const;
const BINS = 120;
const GREEN = "var(--accent-green, #35E58B)", RED = "var(--accent-red, #F0616D)";

const money = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(0)}`);
const priceText = (p: number) => (p >= 1000 ? p.toFixed(0) : p >= 10 ? p.toFixed(2) : p.toFixed(4));

/** Bins exact levels (each a position's notional at its liquidation price) like the market map. */
function binExact(levels: ExactLevel[], price: number, range: number): Bin[] {
  const lo = price * (1 - range), hi = price * (1 + range), w = (hi - lo) / BINS;
  const bins: Bin[] = Array.from({ length: BINS }, (_, b) => ({ lo: lo + b * w, hi: lo + (b + 1) * w, long: 0, short: 0 }));
  for (const l of levels) {
    const b = Math.floor((l.price - lo) / w);
    if (b < 0 || b >= BINS) continue;
    if (l.price < price) bins[b].long += l.value; else bins[b].short += l.value;
  }
  return bins;
}

/** `back`: the button back to the price chart (left out in a widget, which also shows no title). */
export default function LiqMap({ symbol, price, exact, back }: { symbol: string; price: number; exact?: ExactLevel[]; back?: () => void }) {
  const [range, setRange] = useState<number>(() => { const r = Number(localStorage.getItem("pv:liqmap-range")); return RANGES.includes(r as any) ? r : 0.1; });
  const [source, setSource] = useState<"market" | "exact">(() => (localStorage.getItem("pv:liqmap-source") === "exact" ? "exact" : "market"));
  const [vertical, setVertical] = useState(() => localStorage.getItem("pv:liqmap-vertical") === "1");
  const [market, setMarket] = useState<{ bins: Bin[]; price: number; scaledTo?: { exchange: string; oiUsd: number } | null; error?: string }>();
  const [hover, setHover] = useState<number>();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* none */ } };

  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (source !== "market") return;
    let live = true;
    const load = () => fetch(`/api/liqmap?symbol=${symbol}&range=${range}&bins=${BINS}&network=${C.NETWORK}`).then(r => r.json())
      .then(j => { if (live) setMarket(j.error ? { bins: [], price, error: j.error } : j); }).catch(e => live && setMarket({ bins: [], price, error: String(e?.message ?? e) }));
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [symbol, range, source]);

  // The map is drawn around our own price; the market's bins are moved onto it (their price can
  // differ from ours by a little), so the line at the price is the price you trade at.
  const bins: Bin[] = useMemo(() => {
    if (source === "exact") return binExact(exact ?? [], price, range);
    if (!market?.bins.length) return [];
    const k = price / market.price;
    return market.bins.map(b => ({ ...b, lo: b.lo * k, hi: b.hi * k }));
  }, [source, market, exact, price, range]);

  // Cumulative from the price outward: longs going down (left), shorts going up (right).
  const at = bins.findIndex(b => b.hi > price);
  const cumLong = new Array(bins.length).fill(0), cumShort = new Array(bins.length).fill(0);
  for (let i = at - 1, s = 0; i >= 0; i--) { s += bins[i].long; cumLong[i] = s; }
  for (let i = Math.max(0, at), s = 0; i < bins.length; i++) { s += bins[i].short; cumShort[i] = s; }
  const barMax = Math.max(1, ...bins.map(b => Math.max(b.long, b.short)));
  const cumMax = Math.max(1, cumLong[0] ?? 0, cumShort[bins.length - 1] ?? 0);

  const { w: W, h: H } = size;
  const m = { l: 58, r: 58, t: 30, b: 30 };
  const lo = bins[0]?.lo ?? price * (1 - range), hi = bins[bins.length - 1]?.hi ?? price * (1 + range);
  // Price position along the price axis, and size along the value axis, in either orientation.
  const pAxis = vertical ? [H - m.b, m.t] : [m.l, W - m.r];
  const pos = (p: number) => pAxis[0] + ((p - lo) / (hi - lo)) * (pAxis[1] - pAxis[0]);
  const vLen = vertical ? W - m.l - m.r : H - m.t - m.b;
  const bar = (v: number) => (v / barMax) * vLen;
  const cum = (v: number) => (v / cumMax) * vLen;
  // As many price labels as fit (about one per 90 pixels; one per 40 up the side).
  const nTicks = Math.max(2, Math.min(7, Math.floor((vertical ? H : W) / (vertical ? 40 : 90))));
  const ticks = Array.from({ length: nTicks }, (_, i) => lo + ((hi - lo) * i) / (nTicks - 1));
  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = vertical ? (pAxis[0] - (e.clientY - r.top)) / (pAxis[0] - pAxis[1]) : (e.clientX - r.left - pAxis[0]) / (pAxis[1] - pAxis[0]);
    const i = Math.floor(t * bins.length);
    setHover(i >= 0 && i < bins.length ? i : undefined);
  };
  const h = hover !== undefined ? bins[hover] : undefined;
  const hLong = h ? h.hi <= price : false;

  return (
    <div className="lmap">
      <div className="chart-bar lmap-bar">
        {back && <button className="btn tiny" onClick={back} title="Back to the price chart">Chart</button>}
        {back && <b className="lmap-title">{symbol} liquidation map</b>}
        <div className="seg-tf">{(["market", "exact"] as const).map(s => <button key={s} className={source === s ? "on" : ""} onClick={() => { setSource(s); keep("pv:liqmap-source", s); }} title={s === "market" ? "Estimated across the big exchanges (Binance volume, scaled to Hyperliquid's open interest)" : "Every open position on Turbopump at its own liquidation price, read from chain"}>{s === "market" ? "Market (est.)" : "Turbopump (exact)"}</button>)}</div>
        <div className="seg-tf">{RANGES.map(r => <button key={r} className={range === r ? "on" : ""} onClick={() => { setRange(r); keep("pv:liqmap-range", String(r)); }}>±{r * 100}%</button>)}</div>
        <button className={`btn tiny${vertical ? " on" : ""}`} onClick={() => { setVertical(v => !v); keep("pv:liqmap-vertical", vertical ? "0" : "1"); }} title="Turn the map on its side">{vertical ? "Horizontal" : "Vertical"}</button>
      </div>
      <div className="lmap-body" ref={box}>
        {source === "market" && market?.error ? <div className="quiet">No estimate for {symbol}: {market.error}</div>
          : !bins.length ? <div className="quiet">{source === "market" ? "Loading…" : "No open positions on this market."}</div> : (
          <svg width={W} height={H} onMouseMove={pick} onMouseLeave={() => setHover(undefined)} role="img" aria-label={`${symbol} liquidation map`}>
            {/* price ticks */}
            {ticks.map((p, i) => vertical
              ? <g key={i}><line x1={m.l} x2={W - m.r} y1={pos(p)} y2={pos(p)} className="lm-grid" /><text x={m.l - 6} y={pos(p) + 4} textAnchor="end" className="lm-tick">{priceText(p)}</text></g>
              : <g key={i}><line x1={pos(p)} x2={pos(p)} y1={m.t} y2={H - m.b} className="lm-grid" /><text x={pos(p)} y={H - m.b + 16} textAnchor="middle" className="lm-tick">{priceText(p)}</text></g>)}
            {/* bars */}
            {bins.map((b, i) => {
              const isLong = b.hi <= price, v = isLong ? b.long : b.short;
              if (v <= 0) return null;
              const a = pos(b.lo), z = pos(b.hi), len = bar(v), on = i === hover;
              return vertical
                ? <rect key={i} x={m.l} y={Math.min(a, z) + 0.5} width={len} height={Math.max(1, Math.abs(z - a) - 1)} fill={isLong ? GREEN : RED} opacity={on ? 1 : 0.75} />
                : <rect key={i} x={Math.min(a, z) + 0.5} y={H - m.b - len} width={Math.max(1, Math.abs(z - a) - 1)} height={len} fill={isLong ? GREEN : RED} opacity={on ? 1 : 0.75} />;
            })}
            {/* cumulative lines, from the price outward */}
            {(() => {
              const pts = (side: "long" | "short") => bins.map((b, i) => ({ i, b })).filter(({ b }) => (side === "long" ? b.hi <= price : b.lo >= price))
                .map(({ i, b }) => { const p = pos((b.lo + b.hi) / 2), v = cum(side === "long" ? cumLong[i] : cumShort[i]); return vertical ? `${m.l + v},${p}` : `${p},${H - m.b - v}`; }).join(" ");
              return <>
                <polyline points={pts("long")} fill="none" stroke={GREEN} strokeWidth={2} className="lm-cum" />
                <polyline points={pts("short")} fill="none" stroke={RED} strokeWidth={2} className="lm-cum" />
              </>;
            })()}
            {/* the current price */}
            {vertical
              ? <g><line x1={m.l} x2={W - m.r} y1={pos(price)} y2={pos(price)} className="lm-now" /><rect x={W - m.r + 2} y={pos(price) - 10} width={m.r - 4} height={20} rx={4} className="lm-now-box" /><text x={W - m.r / 2} y={pos(price) + 4} textAnchor="middle" className="lm-now-t">{priceText(price)}</text></g>
              : <g><line x1={pos(price)} x2={pos(price)} y1={m.t} y2={H - m.b} className="lm-now" /><rect x={pos(price) - 34} y={4} width={68} height={20} rx={4} className="lm-now-box" /><text x={pos(price)} y={18} textAnchor="middle" className="lm-now-t">{priceText(price)}</text></g>}
            {/* value scales: bars on one side, cumulative on the other */}
            {vertical
              ? <><text x={m.l} y={H - 8} className="lm-tick">bars: up to {money(barMax)}</text><text x={W - m.r} y={H - 8} textAnchor="end" className="lm-tick">cumulative: up to {money(cumMax)}</text></>
              : <><text x={8} y={m.t + 4} className="lm-tick">{money(barMax)}</text><text x={8} y={m.t + 16} className="lm-tick lm-sub">a bar</text><text x={W - 8} y={m.t + 4} textAnchor="end" className="lm-tick">{money(cumMax)}</text><text x={W - 8} y={m.t + 16} textAnchor="end" className="lm-tick lm-sub">cumulative</text></>}
            {/* hover */}
            {h && (() => {
              const lines = [`${priceText(h.lo)} – ${priceText(h.hi)}`, `${hLong ? "Longs" : "Shorts"} liquidated here: ${money(hLong ? h.long : h.short)}`, `Cumulative from ${priceText(price)}: ${money(hLong ? cumLong[hover!] : cumShort[hover!])}`];
              const p = pos((h.lo + h.hi) / 2), bw = 250, bh = 62;
              const x = vertical ? Math.min(W - bw - 6, m.l + 10) : Math.max(6, Math.min(W - bw - 6, p + (hLong ? 10 : -bw - 10)));
              const y = vertical ? Math.max(6, Math.min(H - bh - 6, p - bh / 2)) : m.t + 24;
              return <g pointerEvents="none"><rect x={x} y={y} width={bw} height={bh} rx={6} className="lm-tip" />{lines.map((t, k) => <text key={k} x={x + 10} y={y + 18 + k * 16} className={k ? "lm-tip-t" : "lm-tip-h"}>{t}</text>)}</g>;
            })()}
          </svg>
        )}
      </div>
      <div className="lmap-foot">
        {source === "market"
          ? <>Estimated, like every public liquidation map: positions opened in the last 7 days of exchange volume (Binance) at 5× to 100×, minus levels already traded through{market?.scaledTo ? `, scaled to ${market.scaledTo.exchange}'s ${money(market.scaledTo.oiUsd)} open interest` : ""}.</>
          : <>Exact: every open position on Turbopump at its liquidation price, from chain.</>}
      </div>
    </div>
  );
}
