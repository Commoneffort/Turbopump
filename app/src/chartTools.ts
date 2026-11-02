// Drawing tools the chart library does not ship: a Fibonacci retracement with a colour per level,
// a measure tool, and a text note. Registered once, then started by name like the built-in ones.
import { KLineData, registerFigure, registerIndicator, registerOverlay } from "klinecharts";
import { T, rgbOf } from "./theme";

const FONT = 'Inter, system-ui, sans-serif';
const GREEN = rgbOf(T.green), CORAL = rgbOf(T.red), WHITE = rgbOf(T.textPrimary), GREY = rgbOf(T.textSecondary);
const rgba = (c: string, a: number) => `rgba(${c},${a})`;
const label = (color: string) => ({ color, size: 10.5, family: FONT, backgroundColor: "transparent", borderColor: "transparent", paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 });
/** Splits a text into lines of at most `n` characters, at spaces where it can. */
const wrap = (text: string, n: number): string[] => {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const parts = word.length > n ? word.match(new RegExp(`.{1,${n}}`, "g"))! : [word];
    for (const p of parts) {
      if (line && (line + " " + p).length > n) { out.push(line); line = p; } else line = line ? `${line} ${p}` : p;
    }
  }
  if (line) out.push(line);
  return out.slice(0, 5);
};
/** A hover card beside a mark at `x`, `gap` pixels clear of its centre: the first line bold, the
 *  rest plain (lines from `quietFrom` on are a note's words). It goes to the left of the mark when
 *  there is no room on the right. */
const card = (x: number, gap: number, y: number, lines: string[], side: string, width: number, quietFrom = lines.length): any[] => {
  const lh = 18, pad = 9;
  const w = Math.max(...lines.map(l => [...l].length)) * 7.3 + pad * 2, h = lines.length * lh + pad * 2 - 4;
  const left = x + gap + w > width - 4 ? Math.max(4, x - gap - w) : x + gap;
  const top = y - h / 2;
  const figs: any[] = [{ type: "rect", ignoreEvent: true, attrs: { x: left, y: top, width: w, height: h }, styles: { style: "stroke_fill", color: `rgba(${rgbOf(T.bgElevated)},0.97)`, borderColor: rgba(side, 0.9), borderSize: 1, borderRadius: 5 } }];
  lines.forEach((t, i) => figs.push({ type: "text", ignoreEvent: true, attrs: { x: left + pad, y: top + pad - 2 + i * lh + lh / 2, text: t, baseline: "middle" }, styles: { ...label(rgba(WHITE, i === 0 ? 1 : i >= quietFrom ? 0.95 : 0.7)), size: i === 0 ? 13 : 12, weight: i === 0 ? 600 : 400, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 } }));
  return figs;
};

/** Retracement levels from the second point (0) back to the first (1), each in its own colour,
 *  with the band between two levels tinted. */
const FIB: [level: number, colour: string][] = [[0, GREY], [0.236, CORAL], [0.382, GREEN], [0.5, WHITE], [0.618, GREEN], [0.786, CORAL], [1, GREY]];

/** Badge pictures the chart may draw, by their address (a data URL the page made itself). The
 *  chart library copies what a figure is given, and a copied picture is no picture: a figure
 *  carries the address and the picture is looked up here. */
const pictures = new Map<string, HTMLImageElement>();
export const rememberPicture = (img: HTMLImageElement) => { pictures.set(img.src, img); return img.src; };

let done = false;
/** Colours of the compared markets' lines (none of them is a position, order or liquidation colour). */
export const COMPARE_COLORS = ["#4FD1C5", "#F6E05E", "#F687B3", "#9AE6B4", "#90CDF4", "#FBD38D"];
/** Another market's prices, for the "COMPARE" indicator: seconds -> close, sorted by time. */
export type CompareSeries = { sym: string; long: boolean; points: [number, number][] };

export function registerChartTools() {
  if (done) return;
  done = true;

  // Other markets drawn over this one's candles, the way a "compare" works elsewhere: each line is
  // that market's price rescaled so it meets this market's price at the last candle, so the
  // lines show how each moved against this one over the time on screen. The tooltip gives the
  // real prices.
  registerIndicator({
    name: "COMPARE",
    shortName: "Compare",
    series: "price" as any,
    figures: COMPARE_COLORS.map((color, i) => ({ key: `c${i}`, title: "", type: "line", styles: () => ({ color }) })),
    calc: (list: KLineData[], ind: any) => {
      const series: CompareSeries[] = ind.extendData?.series ?? [];
      // Each market's latest close at or before each candle (its last candle may be a little older).
      const at = series.map(s => {
        const out: (number | undefined)[] = [];
        let j = 0, last: number | undefined;
        for (const k of list) {
          const t = k.timestamp / 1000;
          while (j < s.points.length && s.points[j][0] <= t) last = s.points[j++][1];
          out.push(last);
        }
        return out;
      });
      const n = list.length, mainLast = list[n - 1]?.close ?? 0;
      return list.map((_: KLineData, i: number) => {
        const row: Record<string, number> = {};
        at.forEach((vals, m) => {
          const v = vals[i], end = vals[n - 1];
          if (v === undefined || !end) return;
          row[`c${m}`] = v * mainLast / end;
          row[`r${m}`] = v;
          row[`p${m}`] = v / end - 1;
        });
        return row;
      });
    },
    createTooltipDataSource: ({ indicator, crosshair }: any) => {
      const series = (indicator.extendData?.series ?? []) as CompareSeries[];
      const row = (indicator.result as Record<string, number>[])[crosshair.dataIndex ?? indicator.result.length - 1] ?? {};
      return {
        name: "", calcParamsText: "", features: [],
        legends: series.map((s, m) => ({
          title: { text: `${s.sym} `, color: COMPARE_COLORS[m % COMPARE_COLORS.length] },
          value: { text: row[`r${m}`] === undefined ? "—" : `${row[`r${m}`].toLocaleString(undefined, { maximumFractionDigits: row[`r${m}`] >= 100 ? 2 : 4 })} (${row[`p${m}`] >= 0 ? "+" : ""}${(row[`p${m}`] * 100).toFixed(2)}% to now)`, color: T.textSecondary },
        })),
      };
    },
  } as any);

  registerOverlay({
    name: "fib",
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ chart, coordinates, bounding, overlay }) => {
      const p = overlay.points;
      if (coordinates.length < 2 || typeof p[0].value !== "number" || typeof p[1].value !== "number") return [];
      const dp = chart.getSymbol()?.pricePrecision ?? 2;
      const left = Math.min(coordinates[0].x, coordinates[1].x), right = bounding.width;
      const y = (l: number) => coordinates[1].y + (coordinates[0].y - coordinates[1].y) * l;
      const value = (l: number) => p[1].value! + (p[0].value! - p[1].value!) * l;
      const figures: any[] = [];
      FIB.forEach(([l, c], i) => {
        if (i > 0) {
          const [prev] = FIB[i - 1];
          figures.push({ type: "polygon", ignoreEvent: true, attrs: { coordinates: [{ x: left, y: y(prev) }, { x: right, y: y(prev) }, { x: right, y: y(l) }, { x: left, y: y(l) }] }, styles: { style: "fill", color: rgba(c, 0.07) } });
        }
        figures.push({ type: "line", attrs: { coordinates: [{ x: left, y: y(l) }, { x: right, y: y(l) }] }, styles: { color: rgba(c, 0.95), size: 1 } });
        figures.push({ type: "text", ignoreEvent: true, attrs: { x: left, y: y(l), text: `${l} · ${value(l).toFixed(dp)}`, baseline: "bottom" }, styles: label(rgba(c, 1)) });
      });
      return figures;
    },
  });

  // A trader's badge on the chart: a disc with a rim in the side's colour, holding the trader's
  // picture (the one the page has already checked and drawn itself, see `safePicture`) or, for a
  // trader without one, their shape.
  registerFigure<{ x: number; y: number; r: number; src?: string; points?: [number, number][]; color?: string }, { borderColor: string }>({
    name: "traderBadge",
    checkEventOn: ({ x, y }, a) => (x - a.x) ** 2 + (y - a.y) ** 2 <= a.r ** 2,
    draw: (ctx, a, styles) => {
      const image = a.src ? pictures.get(a.src) : undefined;
      ctx.save();
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fillStyle = T.bgElevated;
      ctx.fill();
      if (image && image.complete && image.naturalWidth) {
        ctx.save();
        ctx.clip();
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, a.x - a.r, a.y - a.r, 2 * a.r, 2 * a.r);
        ctx.restore();
      } else if (a.points?.length) {
        // The shape, a little smaller than the disc it sits in.
        const side = a.r * 1.15;
        ctx.beginPath();
        a.points.forEach(([px, py], i) => { const X = a.x - side / 2 + px * side, Y = a.y - side / 2 + py * side; if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        ctx.closePath();
        ctx.fillStyle = a.color ?? T.textSecondary;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r - 0.75, 0, Math.PI * 2);
      ctx.strokeStyle = styles.borderColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    },
  });

  // Another trader's fill: their badge, tied to the price it filled at. A buy hangs under the
  // price, a sell stands over it; the stem and the small arrow take the side's colour. The
  // trader's name shows while the pointer is on the badge (`hover`, set by the chart).
  registerOverlay({
    name: "traderMark",
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay, bounding }) => {
      const m = overlay.extendData as { points: [number, number][]; color: string; picture?: string; buy: boolean; label: string; what?: string; note?: string; hover?: boolean } | undefined;
      if (!coordinates.length || !m) return [];
      const { x, y } = coordinates[0];
      const side = m.buy ? GREEN : CORAL, dir = m.buy ? 1 : -1, r = 15;
      const cy = y + dir * (13 + r);
      const figures: any[] = [
        { type: "line", ignoreEvent: true, attrs: { coordinates: [{ x, y: y + dir * 4 }, { x, y: y + dir * 13 }] }, styles: { color: rgba(side, 0.9), size: 1 } },
        { type: "polygon", ignoreEvent: true, attrs: { coordinates: [{ x, y: y + dir * 1 }, { x: x - 4, y: y + dir * 7 }, { x: x + 4, y: y + dir * 7 }] }, styles: { style: "fill", color: rgba(side, 1) } },
        { type: "traderBadge", attrs: { x, y: cy, r, src: m.picture, points: m.points, color: m.color }, styles: { borderColor: rgba(side, 1) } },
      ];
      // A trade with a note carries a small speech mark on its badge.
      if (m.note) figures.push(
        { type: "circle", ignoreEvent: true, attrs: { x: x + r * 0.78, y: cy - r * 0.78, r: 6 }, styles: { style: "stroke_fill", color: rgba(WHITE, 1), borderColor: `rgba(${rgbOf(T.bgPanel)},1)`, borderSize: 1.5 } },
        { type: "polygon", ignoreEvent: true, attrs: { coordinates: [{ x: x + r * 0.78 - 2.5, y: cy - r * 0.78 + 4 }, { x: x + r * 0.78 - 5, y: cy - r * 0.78 + 8 }, { x: x + r * 0.78 + 1, y: cy - r * 0.78 + 5 }] }, styles: { style: "fill", color: rgba(WHITE, 1) } },
      );
      if (m.hover && m.label) {
        const head = [m.label, ...(m.what ? [m.what] : [])];
        figures.push(...card(x, r + 8, cy, [...head, ...(m.note ? wrap(`“${m.note}”`, 44) : [])], side, bounding.width, head.length));
      }
      return figures;
    },
  });

  // One of this wallet's own fills: a green triangle pointing up under the candle for a buy, a
  // red one pointing down over it for a sell, clear of the candle's wick so it never covers it.
  // What it was, and at what price, shows on hover.
  registerOverlay({
    name: "tradeDot",
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ chart, coordinates, overlay, bounding, yAxis }) => {
      const m = overlay.extendData as { buy: boolean; label: string; hover?: boolean } | undefined;
      if (!coordinates.length || !m) return [];
      const { x, y } = coordinates[0];
      const side = m.buy ? GREEN : CORAL, dir = m.buy ? 1 : -1, w = m.hover ? 11 : 9.5, h = m.hover ? 18 : 16;
      // The candle the fill is in: the triangle goes past its low (buy) or high (sell).
      const p = overlay.points[0], list = chart.getDataList();
      let k = p?.dataIndex !== undefined ? list[p.dataIndex] : undefined;
      if (!k || k.timestamp !== p?.timestamp) k = list.find(d => d.timestamp === p?.timestamp);
      const edge = k && yAxis ? yAxis.convertToPixel(m.buy ? k.low : k.high) : y;
      const tip = (m.buy ? Math.max(y, edge) : Math.min(y, edge)) + dir * 9;
      const figures: any[] = [
        { type: "polygon", attrs: { coordinates: [{ x, y: tip }, { x: x - w, y: tip + dir * h }, { x: x + w, y: tip + dir * h }] }, styles: { style: "stroke_fill", color: rgba(side, 1), borderColor: `rgba(${rgbOf(T.bgPanel)},1)`, borderSize: 1.2 } },
      ];
      if (m.hover && m.label) figures.push(...card(x, w + 6, tip + dir * h / 2, [m.label], side, bounding.width));
      return figures;
    },
  });

  // A large fill by anyone (the chart's "Whales" box): a bubble sized by the trade's value, under
  // the price for a buy and over it for a sell. Who and how much show while the pointer is on it.
  registerOverlay({
    name: "whaleMark",
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay, bounding }) => {
      const m = overlay.extendData as { r: number; buy: boolean; label: string; hover?: boolean } | undefined;
      if (!coordinates.length || !m) return [];
      const { x, y } = coordinates[0];
      const side = m.buy ? GREEN : CORAL, dir = m.buy ? 1 : -1, r = m.r;
      const cy = y + dir * (6 + r);
      const figures: any[] = [
        { type: "line", ignoreEvent: true, attrs: { coordinates: [{ x, y }, { x, y: y + dir * 6 }] }, styles: { color: rgba(side, 0.8), size: 1 } },
        { type: "circle", attrs: { x, y: cy, r }, styles: { style: "stroke_fill", color: rgba(side, m.hover ? 0.5 : 0.28), borderColor: rgba(side, 0.95), borderSize: 1.5 } },
      ];
      // The label goes left of the bubble when there is no room for it on the right.
      const left = x + r + 20 + m.label.length * 7.6 > bounding.width;
      if (m.hover && m.label) figures.push({ type: "text", ignoreEvent: true, attrs: { x: left ? x - r - 6 : x + r + 6, y: cy, text: m.label, baseline: "middle", align: left ? "right" : "left" }, styles: { ...label(rgba(WHITE, 1)), size: 13, weight: 600, backgroundColor: `rgba(${rgbOf(T.bgElevated)},0.95)`, borderColor: rgba(side, 0.9), borderSize: 1, borderRadius: 3, paddingLeft: 7, paddingRight: 7, paddingTop: 4, paddingBottom: 4 } });
      return figures;
    },
  });

  registerOverlay({
    name: "measure",
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ chart, coordinates, overlay }) => {
      const p = overlay.points;
      if (coordinates.length < 2 || typeof p[0].value !== "number" || typeof p[1].value !== "number") return [];
      const [a, b] = coordinates;
      const dp = chart.getSymbol()?.pricePrecision ?? 2;
      const change = p[1].value - p[0].value, up = change >= 0, c = up ? GREEN : CORAL;
      const bars = Math.abs((p[1].dataIndex ?? 0) - (p[0].dataIndex ?? 0));
      const secs = Math.abs((p[1].timestamp ?? 0) - (p[0].timestamp ?? 0)) / 1000;
      const span = secs >= 86400 ? `${(secs / 86400).toFixed(1)}d` : secs >= 3600 ? `${(secs / 3600).toFixed(1)}h` : `${Math.round(secs / 60)}m`;
      const text = `${up ? "+" : "−"}${Math.abs(change).toFixed(dp)} (${up ? "+" : "−"}${Math.abs(p[0].value ? change / p[0].value * 100 : 0).toFixed(2)}%) · ${bars} bars · ${span}`;
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      const midX = x + w / 2;
      return [
        { type: "polygon", attrs: { coordinates: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }, styles: { style: "fill", color: rgba(c, 0.12) } },
        { type: "line", ignoreEvent: true, attrs: { coordinates: [{ x: midX, y: a.y }, { x: midX, y: b.y }] }, styles: { color: rgba(c, 1), size: 1 } },
        { type: "line", ignoreEvent: true, attrs: { coordinates: [{ x: a.x, y: y + h / 2 }, { x: b.x, y: y + h / 2 }] }, styles: { color: rgba(c, 1), size: 1 } },
        { type: "text", ignoreEvent: true, attrs: { x: midX, y: up ? y - 6 : y + h + 6, text, align: "center", baseline: up ? "bottom" : "top" }, styles: { ...label(T.bgPrimary), backgroundColor: rgba(c, 1), borderRadius: 3 } },
      ];
    },
  });

  // A position, or one of its levels (liquidation, TP, SL): a dashed line across the chart with its
  // label in a badge at the plot's left edge, clear of the newest candles (all of it readable: "▲ ETH LONG 0.42 · +$1.20 (+0.1%)"), and
  // the price in the axis. extendData: { text, color }.
  // Liquidation heatmap: where open positions would be liquidated, as glowing bands across the
  // price pane (dim purple for a little, bright yellow for the most). Levels are bucketed into
  // rows of a few pixels and softened a little, so close levels read as one band.
  registerOverlay({
    name: "liqHeat",
    totalStep: 1,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ bounding, overlay, yAxis }) => {
      const levels = ((overlay.extendData ?? {}) as { levels?: { price: number; value: number }[] }).levels ?? [];
      if (!yAxis || !levels.length) return [];
      const ROW = 4, n = Math.ceil(bounding.height / ROW);
      const rows = new Array<number>(n + 2).fill(0);
      let above = 0, below = 0, nearUp = Infinity, nearDown = -Infinity;
      for (const l of levels) {
        const y = yAxis.convertToPixel(l.price);
        if (y < 0) { above += l.value; nearUp = Math.min(nearUp, l.price); continue; }
        if (!(y < bounding.height)) { below += l.value; nearDown = Math.max(nearDown, l.price); continue; }
        rows[Math.floor(y / ROW)] += l.value;
      }
      const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`);
      const px = (p: number) => (p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toPrecision(4));
      const tag = (y: number, text: string, base: "top" | "bottom") => ({ type: "text", ignoreEvent: true, attrs: { x: bounding.width / 2, y, text, align: "center", baseline: base }, styles: { color: "#000", size: 11, weight: 600, family: FONT, backgroundColor: "#FFD614", borderColor: "#FFD614", borderRadius: 4, paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3 } });
      const out: any[] = [];
      // Levels outside the visible prices: say where they are, so the heatmap never looks empty.
      if (above > 0) out.push(tag(6, `▲ ${usd(above)} liquidated above, nearest ${px(nearUp)}: zoom out to see`, "top"));
      if (below > 0) out.push(tag(bounding.height - 6, `▼ ${usd(below)} liquidated below, nearest ${px(nearDown)}: zoom out to see`, "bottom"));
      const soft = rows.map((v, i) => v + 0.45 * ((rows[i - 1] ?? 0) + (rows[i + 1] ?? 0)) + 0.15 * ((rows[i - 2] ?? 0) + (rows[i + 2] ?? 0)));
      const top = Math.max(...soft);
      if (!(top > 0)) return out;
      soft.forEach((v, i) => {
        if (v <= top * 0.02) return;
        const f = Math.sqrt(v / top);
        // purple (little) -> orange -> yellow (most)
        const r = Math.round(110 + 145 * f), g = Math.round(40 + 174 * f * f), b = Math.round(170 * (1 - f) + 20 * f);
        out.unshift({ type: "rect", ignoreEvent: true, attrs: { x: 0, y: i * ROW, width: bounding.width, height: ROW }, styles: { style: "fill", color: `rgba(${r},${g},${b},${(0.16 + 0.55 * f).toFixed(3)})` } });
      });
      // Dollar labels on the strongest bands (at most four, kept apart).
      const picked: number[] = [];
      for (const i of soft.map((v, i) => i).filter(i => rows[i] > 0).sort((a, b) => soft[b] - soft[a])) {
        if (picked.length >= 4) break;
        if (picked.some(j => Math.abs(j - i) < 5)) continue;
        picked.push(i);
        const yy = i * ROW + ROW / 2, v = rows.slice(Math.max(0, i - 2), i + 3).reduce((t, x) => t + x, 0);
        out.push({ type: "text", ignoreEvent: true, attrs: { x: bounding.width - 8, y: yy, text: `${usd(v)} liq.`, align: "right", baseline: "middle" }, styles: { color: "#FFFFFF", size: 10.5, weight: 600, family: FONT, backgroundColor: "rgba(0,0,0,0.65)", borderColor: "rgba(0,0,0,0)", borderRadius: 3, paddingLeft: 5, paddingRight: 5, paddingTop: 2, paddingBottom: 2 } });
      }
      return out;
    },
  });

  registerOverlay({
    name: "positionLine",
    totalStep: 1,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      if (!coordinates.length) return [];
      const { text, color } = (overlay.extendData ?? {}) as { text: string; color: string };
      const y = coordinates[0].y;
      return [
        { type: "line", ignoreEvent: true, attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] }, styles: { color, size: 1, style: "dashed", dashedValue: [4, 3] } },
        { type: "text", ignoreEvent: true, attrs: { x: 10, y, text, align: "left", baseline: "middle" }, styles: { color: T.bgPrimary, size: 11.5, weight: 600, family: FONT, backgroundColor: color, borderColor: color, borderRadius: 3, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3 } },
      ];
    },
    createYAxisFigures: ({ coordinates, bounding, overlay, yAxis }) => {
      if (!coordinates.length) return [];
      const { color } = (overlay.extendData ?? {}) as { text: string; color: string };
      const value = overlay.points[0]?.value ?? 0;
      const text = (yAxis as any)?.convertFromPixel ? value.toFixed(value >= 100 ? 2 : value >= 1 ? 4 : 6) : String(value);
      return [{ type: "text", ignoreEvent: true, attrs: { x: 0, y: coordinates[0].y, text, align: "left", baseline: "middle" }, styles: { color: T.bgPrimary, size: 11, family: FONT, backgroundColor: color, borderColor: color, borderRadius: 2, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 } }];
    },
  });

  registerOverlay({
    name: "note",
    totalStep: 2,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (!coordinates.length) return [];
      return [{ type: "text", attrs: { x: coordinates[0].x + 8, y: coordinates[0].y, text: String(overlay.extendData ?? "Note"), baseline: "middle" }, styles: { color: rgba(WHITE, 1), size: 12, family: "Inter, system-ui, sans-serif", backgroundColor: `rgba(${rgbOf(T.bgElevated)},0.92)`, borderColor: T.borderPrimary, borderSize: 1, borderRadius: 3, paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4 } }];
    },
  });
}
