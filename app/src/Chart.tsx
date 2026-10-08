// The price chart: candles, indicators and drawing tools, drawn with KLineChart (open source,
// free). History comes from /api/candles (the indexer's recorded oracle prices where it runs,
// public exchange history otherwise); the last candle follows the market's own price as the
// page reads it.
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Chart as KChart, KLineData, dispose, init } from "klinecharts";
import { Candle, exchangeCandles, hasHistory } from "../api/_candles";
import * as C from "./chain";
import { registerChartTools } from "./chartTools";
import { priceDp } from "./shared";
import { BADGES, Mark } from "./Traders";

const UP = "#48E160", DOWN = "#E15A48";
export const TIMEFRAMES: [label: string, res: number][] = [["1m", 60], ["5m", 300], ["15m", 900], ["1H", 3600], ["4H", 14400], ["1D", 86400]];

export async function fetchCandles(symbol: string, res: number, limit = 600): Promise<{ source: string; candles: Candle[] }> {
  try {
    const r = await fetch(`/api/candles?symbol=${symbol}&res=${res}&limit=${limit}&network=${C.NETWORK}`);
    const j = await r.json();
    if (r.ok && Array.isArray(j.candles)) return j;
  } catch { /* no API here (local development): ask the exchange directly */ }
  return { source: "exchange", candles: await exchangeCandles(symbol, res, limit) };
}

export type DayStats = { last: number; change: number; high: number; low: number };

/** Last price, and the change, high and low over the past 24 hours, per symbol. */
export function useDayStats(symbols: string[]): Record<string, DayStats> {
  const [stats, setStats] = useState<Record<string, DayStats>>({});
  const key = symbols.join(",");
  useEffect(() => {
    let live = true;
    const load = async () => {
      const out: Record<string, DayStats> = {};
      await Promise.all(symbols.map(async s => {
        const { candles } = await fetchCandles(s, 3600, 25).catch(() => ({ candles: [] as Candle[] }));
        const day = candles.slice(-24);
        if (day.length < 2) return;
        const first = day[0][1], last = day[day.length - 1][4];
        out[s] = { last, change: first > 0 ? last / first - 1 : 0, high: Math.max(...day.map(c => c[2])), low: Math.min(...day.map(c => c[3])) };
      }));
      if (live) setStats(out);
    };
    if (symbols.length) load();
    const id = setInterval(load, 60_000);
    return () => { live = false; clearInterval(id); };
  }, [key]);
  return stats;
}

/** Candles this page drew itself from a market's own price, kept in the browser. For a market
 *  with no history to borrow they are the whole chart, so they must outlive a refresh. */
const builtKey = (symbol: string, res: number) => `pv:candles:${C.NETWORK}:${symbol}:${res}`;
function loadBuilt(symbol: string, res: number): Map<number, Candle> {
  try {
    const rows: Candle[] = JSON.parse(localStorage.getItem(builtKey(symbol, res)) ?? "[]");
    return new Map(rows.filter(c => Array.isArray(c) && c.length === 6).map(c => [c[0], c]));
  } catch { return new Map(); }
}
function saveBuilt(symbol: string, res: number, built: Map<number, Candle>) {
  try { localStorage.setItem(builtKey(symbol, res), JSON.stringify([...built.values()].sort((a, b) => a[0] - b[0]).slice(-600))); } catch { /* storage unavailable */ }
}

type Line = { price: number; title: string; color: string };

const GREY = "#8A8A8A", LINE = "#2A2A2A", TEXT = "#F4F4F4";
const period = (res: number) => (res >= 86400 ? { type: "day" as const, span: res / 86400 } : res >= 3600 ? { type: "hour" as const, span: res / 3600 } : { type: "minute" as const, span: res / 60 });
const bar = (c: Candle): KLineData => ({ timestamp: c[0] * 1000, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] });
const FONT = '"JetBrains Mono", ui-monospace, monospace';
const txt = (color: string, size = 11) => ({ color, size, family: FONT });
const STYLES = {
  grid: { horizontal: { color: "#222222" }, vertical: { color: "#222222" } },
  candle: {
    bar: { upColor: UP, downColor: DOWN, noChangeColor: GREY, upBorderColor: UP, downBorderColor: DOWN, noChangeBorderColor: GREY, upWickColor: UP, downWickColor: DOWN, noChangeWickColor: GREY },
    priceMark: {
      high: { color: GREY, textSize: 10, textFamily: FONT }, low: { color: GREY, textSize: 10, textFamily: FONT },
      last: { upColor: UP, downColor: DOWN, noChangeColor: GREY, text: { ...txt("#121212"), paddingLeft: 4, paddingRight: 4 } },
    },
    tooltip: { title: txt(TEXT), legend: txt(GREY) },
  },
  indicator: {
    // Studies are drawn in the palette's greys, with coral and green for the lines that need telling apart.
    lines: [TEXT, GREY, DOWN, UP, "#4A4A4A"].map(color => ({ color, size: 1, style: "solid", smooth: false, dashedValue: [2, 2] })),
    bars: [{ style: "fill", borderStyle: "solid", borderSize: 1, borderDashedValue: [2, 2], upColor: "rgba(72,225,96,0.45)", downColor: "rgba(225,90,72,0.45)", noChangeColor: "#4A4A4A" }],
    circles: [{ style: "fill", borderStyle: "solid", borderSize: 1, borderDashedValue: [2, 2], upColor: UP, downColor: DOWN, noChangeColor: GREY }],
    tooltip: { title: txt(GREY), legend: txt(GREY) },
    lastValueMark: { show: false },
  },
  xAxis: { axisLine: { color: LINE }, tickLine: { color: LINE }, tickText: txt(GREY, 10.5) },
  yAxis: { axisLine: { color: LINE }, tickLine: { color: LINE }, tickText: txt(GREY, 10.5) },
  separator: { color: LINE },
  crosshair: {
    horizontal: { line: { color: "#4A4A4A" }, text: { ...txt(TEXT), backgroundColor: "#2A2A2A", borderColor: "#2A2A2A" } },
    vertical: { line: { color: "#4A4A4A" }, text: { ...txt(TEXT), backgroundColor: "#2A2A2A", borderColor: "#2A2A2A" } },
  },
  overlay: {
    line: { color: TEXT }, point: { color: TEXT, borderColor: "rgba(244,244,244,0.3)", activeColor: TEXT, activeBorderColor: "rgba(244,244,244,0.3)" },
    text: { ...txt(TEXT), backgroundColor: "#2A2A2A", borderColor: "#4A4A4A" }, rect: { color: "rgba(244,244,244,0.06)", borderColor: TEXT },
    polygon: { color: "rgba(244,244,244,0.06)" }, circle: { color: "rgba(244,244,244,0.06)", borderColor: TEXT }, arc: { color: TEXT },
  },
};

/** Studies drawn over the candles, and studies in a pane of their own under them. */
const ON_PRICE = [["MA", "Moving average"], ["EMA", "Exponential moving average"], ["BOLL", "Bollinger bands"], ["SAR", "Parabolic SAR"], ["BBI", "Bull and bear index"]];
const BELOW = [["VOL", "Volume"], ["MACD", "MACD"], ["RSI", "Relative strength index"], ["KDJ", "Stochastic (KDJ)"], ["CCI", "Commodity channel index"], ["DMI", "Directional movement"], ["OBV", "On-balance volume"], ["WR", "Williams %R"], ["ROC", "Rate of change"], ["MTM", "Momentum"], ["TRIX", "TRIX"], ["AO", "Awesome oscillator"]];
/** Drawing tools: the overlay each one starts, and its icon (a 16 x 16 path). */
const TOOLS: [name: string, label: string, icon: string][] = [
  ["segment", "Trend line", "M2.5 12.5 13.5 3.5M2.5 12.5h.01M13.5 3.5h.01"],
  ["rayLine", "Ray", "M2.5 11 14 5M2.5 11h.01"],
  ["straightLine", "Extended line", "M1 12 15 4"],
  ["horizontalStraightLine", "Horizontal line", "M1 8h14"],
  ["horizontalRayLine", "Horizontal ray", "M3 8h12M3 8h.01"],
  ["verticalStraightLine", "Vertical line", "M8 1v14"],
  ["priceLine", "Price line", "M1 8h9M12 5.5h3v5h-3z"],
  ["parallelStraightLine", "Parallel channel", "M1 10 15 3M1 14 15 7"],
  ["priceChannelLine", "Price channel", "M1 9 15 2M1 12 15 5M1 15 15 8"],
  ["fib", "Fibonacci retracement", "M1 3h14M1 6.5h14M1 9.5h14M1 13h14"],
  ["rect", "Rectangle", "M2.5 4h11v8h-11z"],
  ["circle", "Circle", "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"],
  ["brush", "Brush (free drawing)", "M2 13c2 0 2.5-1.5 2.5-2.5L12 3l1.5 1.5L6 12c-1 0-2 .5-4 1z"],
  ["measure", "Measure: price change, percent, bars and time between two points", "M2 11.5 11.5 2l2.5 2.5L4.5 14zM5 8.5l1.2 1.2M7 6.5l1.2 1.2M9 4.5l1.2 1.2"],
];
/** How the price itself is drawn. */
const KINDS: [type: string, label: string, icon: string][] = [
  ["candle_solid", "Candles", "M5 2v2M5 11v3M3.5 4h3v7h-3zM11 3v3M11 12v2M9.5 6h3v6h-3z"],
  ["candle_stroke", "Hollow candles", "M5 2v2M5 11v3M3.5 4h3v7h-3zM11 3v3M11 12v2M9.5 6h3v6h-3z"],
  ["ohlc", "Bars", "M5 2v12M3 5h2M5 11h2M11 3v11M9 6h2M11 12h2"],
  ["area", "Line", "M1 12l4-5 3 3 6-7"],
];
const saved = (key: string, fallback: string[]): string[] => { try { const v = JSON.parse(localStorage.getItem(key) ?? "null"); return Array.isArray(v) ? v : fallback; } catch { return fallback; } };

/** One chart window. `slot` tells windows apart (each keeps its own timeframe and studies);
 *  `compact` is a secondary window: no drawing toolbar. `dense` is any window that shares the
 *  screen with others: the candle's figures show under the crosshair only. `head` is shown first in the window's bar
 *  (the layout buttons, or a secondary window's market). `marks` are other traders' fills. */
export default function Chart({ symbol, price, lines, marks = [], slot = 0, compact = false, dense = false, head }: { symbol: string; price: number; lines: Line[]; marks?: Mark[]; slot?: number; compact?: boolean; dense?: boolean; head?: ReactNode }) {
  const own = slot ? `:${slot}` : "";
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<KChart | null>(null);
  const last = useRef<Candle>();
  const built = useRef(new Map<number, Candle>());
  const push = useRef<((b: KLineData) => void) | null>(null);
  const [res, setRes] = useState(() => Number(localStorage.getItem(`pv:chart-res${own}`)) || (slot ? 3600 : 900));
  const [source, setSource] = useState<string>();
  const [empty, setEmpty] = useState(false);
  const [studies, setStudies] = useState(() => saved(`pv:chart-studies${own}`, slot ? ["MA"] : ["MA", "VOL"]));
  const [menu, setMenu] = useState(false);
  const [kind, setKind] = useState(() => localStorage.getItem("pv:chart-kind") ?? "candle_solid");
  const [magnet, setMagnet] = useState(() => localStorage.getItem("pv:chart-magnet") === "1");
  const [cross, setCross] = useState(() => localStorage.getItem("pv:chart-cross") !== "0");
  const [note, setNote] = useState<string>();
  const [full, setFull] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [locked, setLocked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const drawn = useRef<string[]>([]);
  const menuBox = useRef<HTMLDivElement>(null);
  const dp = priceDp(price || 1);

  useEffect(() => {
    registerChartTools();
    const c = init(el.current!, { styles: STYLES as any });
    chart.current = c;
    const ro = new ResizeObserver(() => c?.resize());
    ro.observe(el.current!);
    const close = (e: MouseEvent) => { if (!menuBox.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", close);
    return () => { ro.disconnect(); document.removeEventListener("mousedown", close); dispose(el.current!); chart.current = null; };
  }, []);

  // History for a market and timeframe; after that the chart is fed bar by bar.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    let live = true;
    last.current = undefined;
    built.current = loadBuilt(symbol, res);
    c.setSymbol({ ticker: symbol, pricePrecision: dp, volumePrecision: 2 });
    c.setPeriod(period(res));
    c.setDataLoader({
      getBars: async ({ type, callback }) => {
        if (type !== "init") return callback([], false);
        const r = await fetchCandles(symbol, res).catch(() => undefined);
        if (!live) return;
        setSource(r?.source);
        // History first; where this page drew a candle itself and history has none (or it is
        // the candle in progress), its own stands.
        const history = r?.candles ?? [];
        const merged = new Map(history.map(k => [k[0], k]));
        const newest = history.length ? history[history.length - 1][0] : -1;
        for (const [t, k] of built.current) {
          const h = merged.get(t);
          if (!h) merged.set(t, k);
          else if (t >= newest) merged.set(t, [t, h[1], Math.max(h[2], k[2]), Math.min(h[3], k[3]), k[4], h[5]]);
        }
        const rows = [...merged.values()].sort((x, y) => x[0] - y[0]);
        last.current = rows[rows.length - 1] ?? last.current;
        setEmpty(rows.length === 0 && !last.current);
        callback(rows.map(bar), false);
      },
      subscribeBar: ({ callback }) => { push.current = callback; },
      unsubscribeBar: () => { push.current = null; },
    });
    return () => { live = false; };
  }, [symbol, res]);

  useEffect(() => { chart.current?.setSymbol({ ticker: symbol, pricePrecision: dp, volumePrecision: 2 }); }, [dp]);

  // The candle in progress follows the market's own price.
  useEffect(() => {
    if (!(price > 0)) return;
    const now = Math.floor(Date.now() / 1000), t = now - (now % res);
    const prev = last.current;
    if (prev && t < prev[0]) return;
    // A history that is far from the market's price is another instrument's: leave it alone.
    if (prev && Math.abs(price / prev[4] - 1) > 0.2) return;
    const open = prev?.[4] ?? price;
    const next: Candle = prev && prev[0] === t ? [t, prev[1], Math.max(prev[2], price), Math.min(prev[3], price), price, prev[5]] : [t, open, Math.max(open, price), Math.min(open, price), price, 0];
    last.current = next;
    built.current.set(t, next);
    saveBuilt(symbol, res, built.current);
    push.current?.(bar(next));
    setEmpty(false);
  }, [price, res, symbol]);

  // Studies: the ones over the candles share their pane; each of the others gets its own.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    for (const [name] of [...ON_PRICE, ...BELOW]) c.removeIndicator({ name });
    for (const name of studies) {
      if (ON_PRICE.some(([n]) => n === name)) c.createIndicator({ name, paneId: "candle_pane" } as any, true);
      else if (BELOW.some(([n]) => n === name)) c.createIndicator(name);
    }
    try { localStorage.setItem(`pv:chart-studies${own}`, JSON.stringify(studies)); } catch { /* storage unavailable */ }
  }, [studies.join(",")]);

  // Candles, hollow candles, bars or a line; the crosshair; and whether drawings snap to prices.
  useEffect(() => {
    chart.current?.setStyles({
      candle: { type: kind, area: { lineColor: TEXT, lineSize: 1.5, backgroundColor: [{ offset: 0, color: "rgba(244,244,244,0.10)" }, { offset: 1, color: "rgba(244,244,244,0)" }], point: { show: false } } },
      crosshair: { show: cross },
    } as any);
    try { localStorage.setItem("pv:chart-kind", kind); localStorage.setItem("pv:chart-cross", cross ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [kind, cross]);
  // A window that shares the screen has no room for the standing legend: it follows the crosshair.
  useEffect(() => {
    const showRule = dense && !full ? "follow_cross" : "always";
    chart.current?.setStyles({ candle: { tooltip: { showRule } }, indicator: { tooltip: { showRule } } } as any);
  }, [dense, full]);
  const mode = magnet ? "strong_magnet" : "normal";
  useEffect(() => {
    chart.current?.overrideOverlay({ groupId: "drawing", mode } as any);
    try { localStorage.setItem("pv:chart-magnet", magnet ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [magnet]);
  const draw = (name: string, extendData?: unknown) => {
    if (hidden) setHidden(false);
    const id = chart.current?.createOverlay({ name, groupId: "drawing", mode, extendData, lock: locked } as any);
    if (typeof id === "string") drawn.current.push(id);
  };
  const undo = () => { const id = drawn.current.pop(); if (id) chart.current?.removeOverlay({ id }); };
  const clear = () => { drawn.current = []; chart.current?.removeOverlay({ groupId: "drawing" }); };
  useEffect(() => { chart.current?.overrideOverlay({ groupId: "drawing", visible: !hidden, lock: locked } as any); }, [hidden, locked]);
  /** Saves the chart as it is drawn (studies and drawings included) as a picture. */
  const snapshot = () => {
    const url = chart.current?.getConvertPictureUrl(true, "png", "#121212");
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${symbol}-${TIMEFRAMES.find(([, r]) => r === res)?.[0] ?? res}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.png`;
    a.click();
  };

  // Full screen: the chart with all its tools takes the whole screen (the browser's own full
  // screen where it has one, the whole window otherwise). Esc, or the button again, leaves it.
  const leave = () => { setFull(false); if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined); };
  const enter = () => { setFull(true); root.current?.requestFullscreen?.().catch(() => undefined); };
  useEffect(() => {
    if (!full) return;
    const gone = () => { if (!document.fullscreenElement) setFull(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.fullscreenElement && note === undefined && !menu) setFull(false); };
    document.addEventListener("fullscreenchange", gone);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("fullscreenchange", gone); document.removeEventListener("keydown", key); };
  }, [full, note, menu]);

  // The wallet's entry and liquidation prices, as locked lines.
  const lineKey = useMemo(() => lines.map(l => `${l.title}:${l.price.toFixed(dp)}`).join("|"), [lines, dp]);
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.removeOverlay({ groupId: "position" });
    for (const l of lines.filter(x => x.price > 0)) {
      c.createOverlay({ name: "simpleTag", groupId: "position", lock: true, extendData: l.title, points: [{ value: l.price }], styles: { line: { color: l.color, style: "dashed" }, text: { ...txt("#121212"), backgroundColor: l.color, borderColor: l.color } } } as any);
    }
  }, [lineKey, symbol, res]);

  // Trades of the traders this wallet follows or copies: their badge at the candle and price of
  // each fill, under the candle for a buy and over it for a sell.
  const markKey = useMemo(() => marks.map(m => m.key).join("|"), [marks]);
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.removeOverlay({ groupId: "social" });
    // The name goes with each trader's latest fill only: a badge is enough for the others.
    const latest = new Map(marks.map(m => [m.name, m.key]));
    for (const m of marks) {
      const t = m.time - (m.time % res);
      c.createOverlay({ name: "traderMark", groupId: "social", lock: true, points: [{ timestamp: t * 1000, value: m.price }], extendData: { points: BADGES[m.shape % BADGES.length].points, color: m.color, buy: m.size > 0, label: latest.get(m.name) === m.key ? m.name : "" } } as any);
    }
  }, [markKey, symbol, res]);

  const toggle = (name: string) => setStudies(s => (s.includes(name) ? s.filter(x => x !== name) : [...s, name]));
  return (
    <div className={`chart${full ? " full" : ""}${compact && !full ? " compact" : ""}`} ref={root}>
      <div className="chart-bar">
        {!full && head}
        {full && <div className="chart-sym"><b>{symbol}-PERP</b><span>{price > 0 ? price.toFixed(dp) : ""}</span></div>}
        <div className="seg-tf">
          {TIMEFRAMES.map(([label, r]) => (
            <button key={r} className={r === res ? "on" : ""} onClick={() => { setRes(r); try { localStorage.setItem(`pv:chart-res${own}`, String(r)); } catch { /* storage unavailable */ } }}>{label}</button>
          ))}
        </div>
        <div className="kinds">
          {KINDS.map(([type, label, icon]) => (
            <button key={type} title={label} aria-label={label} className={type === kind ? "on" : ""} onClick={() => setKind(type)}>
              <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d={icon} fill={type === "candle_solid" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            </button>
          ))}
        </div>
        <div className="studies" ref={menuBox}>
          <button className={menu ? "on" : ""} onClick={() => setMenu(m => !m)}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M1 12l4-5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
            Indicators{studies.length ? <em>{studies.length}</em> : null}
          </button>
          {menu && (
            <div className="studies-menu">
              <div className="studies-h">On the price</div>
              {ON_PRICE.map(([n, label]) => <button key={n} className={studies.includes(n) ? "on" : ""} onClick={() => toggle(n)}><b>{n}</b>{label}<i /></button>)}
              <div className="studies-h">Below the chart</div>
              {BELOW.map(([n, label]) => <button key={n} className={studies.includes(n) ? "on" : ""} onClick={() => toggle(n)}><b>{n}</b>{label}<i /></button>)}
            </div>
          )}
        </div>
        <div className="chart-src" title="Where the candles come from. The last one always follows this market's own oracle price.">
          {source === "oracle" || source === "oracle+exchange" ? "Oracle price" : hasHistory(symbol) ? "Exchange history · live oracle price" : "Live oracle price"}
        </div>
        <div className="chart-acts">
          <button title="Zoom out" aria-label="Zoom out" onClick={() => chart.current?.zoomAtCoordinate(0.8, undefined, 150)}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5 14 14M5 7h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          <button title="Zoom in" aria-label="Zoom in" onClick={() => chart.current?.zoomAtCoordinate(1.25, undefined, 150)}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5 14 14M5 7h4M7 5v4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          <button title="Go to the latest candle" aria-label="Go to the latest candle" onClick={() => chart.current?.scrollToRealTime(200)}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d="M2 4l5 4-5 4M8 4l5 4-5 4M14 3v10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button title="Save the chart as a picture" aria-label="Save the chart as a picture" onClick={snapshot}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d="M2 5h3l1-1.5h4L11 5h3v8H2zM8 7a2.2 2.2 0 1 0 0 4.4A2.2 2.2 0 0 0 8 7z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          </button>
          <button title={full ? "Leave full screen (Esc)" : "Full screen"} aria-label={full ? "Leave full screen" : "Full screen"} className={full ? "on" : ""} onClick={full ? leave : enter}>
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d={full ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
      <div className="chart-main">
        <div className="tools" hidden={compact && !full}>
          <button title={cross ? "Crosshair: on" : "Crosshair: off"} aria-label="Crosshair" className={cross ? "on" : ""} onClick={() => setCross(x => !x)}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M8 1v14M1 8h14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          <button title={magnet ? "Magnet: drawings snap to the candles' prices" : "Magnet: off"} aria-label="Magnet" className={magnet ? "on" : ""} onClick={() => setMagnet(m => !m)}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M3 2v6a5 5 0 0 0 10 0V2h-3v6a2 2 0 0 1-4 0V2zM3 5h3M10 5h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </button>
          <hr />
          {TOOLS.map(([name, label, icon]) => (
            <button key={name} title={label} aria-label={label} onClick={() => draw(name)}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d={icon} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
            </button>
          ))}
          <button title="Text note" aria-label="Text note" className={note !== undefined ? "on" : ""} onClick={() => setNote(n => (n === undefined ? "" : undefined))}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M3 4V3h10v1M8 3v10M6 13h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
          {note !== undefined && (
            <form className="note-box" onSubmit={e => { e.preventDefault(); if (note.trim()) draw("note", note.trim()); setNote(undefined); }}>
              <input autoFocus value={note} onChange={e => setNote(e.target.value)} placeholder="Type the note, press Enter, then click the chart" maxLength={80} onKeyDown={e => e.key === "Escape" && setNote(undefined)} />
            </form>
          )}
          <span />
          <button title={hidden ? "Drawings are hidden: show them" : "Hide the drawings"} aria-label="Hide or show the drawings" className={hidden ? "on" : ""} onClick={() => setHidden(h => !h)}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d={hidden ? "M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4zM2.5 13.5l11-11" : "M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4zM8 6.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z"} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </button>
          <button title={locked ? "Drawings are locked: unlock them" : "Lock the drawings in place"} aria-label="Lock or unlock the drawings" className={locked ? "on" : ""} onClick={() => setLocked(l => !l)}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d={locked ? "M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" : "M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 4.8-1"} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button title="Undo the last drawing" aria-label="Undo the last drawing" onClick={undo}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M5.5 3 2.5 6l3 3M2.5 6H10a3.5 3.5 0 0 1 0 7H6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button title="Remove all drawings" aria-label="Remove all drawings" onClick={clear}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.7 9h5.6l.7-9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="chart-body">
          <div ref={el} className="chart-canvas" />
          {empty && <div className="chart-empty">No price for {symbol} yet. The chart draws from this market's own price as it arrives.</div>}
        </div>
      </div>
    </div>
  );
}
