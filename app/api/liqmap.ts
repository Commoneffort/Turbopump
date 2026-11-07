// GET /api/liqmap?symbol=SOL&range=0.1&bins=120
// An estimated liquidation map for the whole market (2026-11-07): where leveraged positions opened
// on the big exchanges would be liquidated, in price bins around the price, longs and shorts apart.
// Only Hyperliquid publishes positions, and only per account, so like every public liquidation map
// (liquidate.fun, CoinGlass) this is a model, not a count:
//   - each 15-minute candle of the last 7 days (Binance, public) opens positions at its typical
//     price: longs in proportion to its buyer-initiated volume, shorts to the rest;
//   - spread over common leverages (5x to 100x); each lands its liquidation at
//     entry x (1 - 1/L + 0.5%) for a long, entry x (1 + 1/L - 0.5%) for a short;
//   - a level the price has traded through since is gone (liquidated already); older positions
//     fade (closed over time: a 3-day half life);
//   - the total is scaled to the asset's open interest on Hyperliquid (public), as dollars.
// Our own exchange's positions are exact and come from chain on the page (Widgets.liqLevels).
import { EXCHANGE_SYMBOL } from "./_candles.js";

const TIERS: [lev: number, weight: number][] = [[5, 0.15], [10, 0.3], [25, 0.25], [50, 0.18], [100, 0.12]];
const MM = 0.005, HALF_LIFE = 3 * 86_400, HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

async function klines(market: string): Promise<any[]> {
  for (const host of HOSTS) {
    try {
      const r = await fetch(`${host}/api/v3/klines?symbol=${market}&interval=15m&limit=672`, { signal: AbortSignal.timeout(8_000) });
      if (r.ok) return await r.json();
    } catch { /* next host */ }
  }
  return [];
}
async function hyperliquidOi(symbol: string): Promise<{ oiUsd: number; mark: number } | null> {
  try {
    const r = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }), signal: AbortSignal.timeout(6_000) });
    const [meta, ctxs] = await r.json() as any;
    const i = meta.universe.findIndex((a: any) => a.name === symbol);
    if (i < 0) return null;
    const mark = Number(ctxs[i].markPx);
    return { oiUsd: Number(ctxs[i].openInterest) * mark, mark };
  } catch { return null; }
}

export default async function handler(req: any, res: any) {
  const symbol = String(req.query?.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const range = Math.min(0.3, Math.max(0.005, Number(req.query?.range ?? 0.1) || 0.1));
  const nbins = Math.min(400, Math.max(20, Number(req.query?.bins ?? 120) || 120));
  const market = EXCHANGE_SYMBOL[symbol];
  if (!market) return res.status(404).json({ error: `no exchange history for ${symbol}` });
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
  const [rows, oi] = await Promise.all([klines(market), hyperliquidOi(symbol)]);
  if (!rows.length) return res.status(502).json({ error: "no candles" });
  const c = rows.map(k => ({ t: Math.floor(k[0] / 1000), h: +k[2], l: +k[3], close: +k[4], q: +k[7], buy: +k[10] }));
  const price = c[c.length - 1].close, now = c[c.length - 1].t;
  // The lowest low and highest high after each candle: a level beyond them was hit already.
  const lowAfter = new Array(c.length).fill(Infinity), highAfter = new Array(c.length).fill(-Infinity);
  for (let i = c.length - 2; i >= 0; i--) { lowAfter[i] = Math.min(lowAfter[i + 1], c[i + 1].l); highAfter[i] = Math.max(highAfter[i + 1], c[i + 1].h); }
  const lo = price * (1 - range), hi = price * (1 + range), width = (hi - lo) / nbins;
  const longs = new Array(nbins).fill(0), shorts = new Array(nbins).fill(0);
  let live = 0;
  c.forEach((x, i) => {
    const entry = (x.h + x.l + x.close) / 3, fade = Math.pow(0.5, (now - x.t) / HALF_LIFE);
    const buy = x.buy * fade, sell = Math.max(0, x.q - x.buy) * fade;
    for (const [lev, w] of TIERS) {
      const lp = entry * (1 - 1 / lev + MM), sp = entry * (1 + 1 / lev - MM);
      if (lowAfter[i] > lp) { live += buy * w; const b = Math.floor((lp - lo) / width); if (b >= 0 && b < nbins && lp < price) longs[b] += buy * w; }
      if (highAfter[i] < sp) { live += sell * w; const b = Math.floor((sp - lo) / width); if (b >= 0 && b < nbins && sp > price) shorts[b] += sell * w; }
    }
  });
  // Dollars: the model's live positions scaled to the open interest on Hyperliquid.
  const scale = oi && live > 0 ? oi.oiUsd / live : 1;
  const bins = longs.map((l, b) => ({ lo: lo + b * width, hi: lo + (b + 1) * width, long: Math.round(l * scale), short: Math.round(shorts[b] * scale) }));
  return res.status(200).json({
    symbol, price, range, at: now, bins,
    scaledTo: oi ? { exchange: "Hyperliquid", oiUsd: Math.round(oi.oiUsd) } : null,
    model: "15m candles of the last 7 days (Binance), longs from buyer-initiated volume and shorts from the rest, 5x to 100x leverage, levels already traded through removed, 3-day half life",
  });
}
