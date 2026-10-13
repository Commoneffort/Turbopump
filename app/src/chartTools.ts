// Drawing tools the chart library does not ship: a Fibonacci retracement with a colour per level,
// a measure tool, and a text note. Registered once, then started by name like the built-in ones.
import { registerFigure, registerOverlay } from "klinecharts";

const FONT = '"JetBrains Mono", ui-monospace, monospace';
const GREEN = "72,225,96", CORAL = "225,90,72", WHITE = "244,244,244", GREY = "138,138,138";
const rgba = (c: string, a: number) => `rgba(${c},${a})`;
const label = (color: string) => ({ color, size: 10.5, family: FONT, backgroundColor: "transparent", borderColor: "transparent", paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2 });

/** Retracement levels from the second point (0) back to the first (1), each in its own colour,
 *  with the band between two levels tinted. */
const FIB: [level: number, colour: string][] = [[0, GREY], [0.236, CORAL], [0.382, GREEN], [0.5, WHITE], [0.618, GREEN], [0.786, CORAL], [1, GREY]];

/** Badge pictures the chart may draw, by their address (a data URL the page made itself). The
 *  chart library copies what a figure is given, and a copied picture is no picture: a figure
 *  carries the address and the picture is looked up here. */
const pictures = new Map<string, HTMLImageElement>();
export const rememberPicture = (img: HTMLImageElement) => { pictures.set(img.src, img); return img.src; };

let done = false;
export function registerChartTools() {
  if (done) return;
  done = true;

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

  // A badge picture on the chart: the picture the page has already checked and drawn itself
  // (see `safePicture`), with a rim in the side's colour.
  registerFigure<{ x: number; y: number; size: number; src: string }, { borderColor: string }>({
    name: "badgePicture",
    checkEventOn: ({ x, y }, a) => x >= a.x && x <= a.x + a.size && y >= a.y && y <= a.y + a.size,
    draw: (ctx, a, styles) => {
      const image = pictures.get(a.src);
      if (!image || !image.complete || !image.naturalWidth) return;
      ctx.save();
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(image, a.x, a.y, a.size, a.size);
      ctx.strokeStyle = styles.borderColor;
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, a.size - 1, a.size - 1);
      ctx.restore();
    },
  });

  // Another trader's fill: their badge, tied to the price it filled at. A buy hangs under the
  // price, a sell stands over it; the stem and the small arrow take the side's colour.
  registerOverlay({
    name: "traderMark",
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      const m = overlay.extendData as { points: [number, number][]; color: string; picture?: string; buy: boolean; label: string } | undefined;
      if (!coordinates.length || !m) return [];
      const { x, y } = coordinates[0];
      // A trader's own picture is drawn a little larger than a shape, or nothing of it can be made out.
      const side = m.buy ? GREEN : CORAL, dir = m.buy ? 1 : -1, s = m.picture ? 20 : 15;
      const top = m.buy ? y + 13 : y - 13 - s;
      return [
        { type: "line", ignoreEvent: true, attrs: { coordinates: [{ x, y: y + dir * 4 }, { x, y: y + dir * 13 }] }, styles: { color: rgba(side, 0.9), size: 1 } },
        { type: "polygon", ignoreEvent: true, attrs: { coordinates: [{ x, y: y + dir * 1 }, { x: x - 4, y: y + dir * 7 }, { x: x + 4, y: y + dir * 7 }] }, styles: { style: "fill", color: rgba(side, 1) } },
        m.picture
          ? { type: "badgePicture", attrs: { x: x - s / 2, y: top, size: s, src: m.picture }, styles: { borderColor: rgba(side, 1) } }
          : { type: "polygon", attrs: { coordinates: m.points.map(([px, py]) => ({ x: x - s / 2 + px * s, y: top + py * s })) }, styles: { style: "stroke_fill", color: m.color, borderColor: rgba(side, 1), borderSize: 1 } },
        { type: "text", ignoreEvent: true, attrs: { x: x + s / 2 + 3, y: top + s / 2, text: m.label, baseline: "middle" }, styles: { ...label(rgba(WHITE, 0.85)), size: 9.5 } },
      ];
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
        { type: "text", ignoreEvent: true, attrs: { x: midX, y: up ? y - 6 : y + h + 6, text, align: "center", baseline: up ? "bottom" : "top" }, styles: { ...label("#121212"), backgroundColor: rgba(c, 1), borderRadius: 3 } },
      ];
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
      return [{ type: "text", attrs: { x: coordinates[0].x + 8, y: coordinates[0].y, text: String(overlay.extendData ?? "Note"), baseline: "middle" }, styles: { color: rgba(WHITE, 1), size: 12, family: "Inter, system-ui, sans-serif", backgroundColor: "rgba(42,42,42,0.9)", borderColor: "#4A4A4A", borderSize: 1, borderRadius: 3, paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4 } }];
    },
  });
}
