// Chart candles for a symbol: GET /api/candles?symbol=BTC&res=60&limit=500
// From the indexer when one is configured (INDEXER_URL), else from public exchange history.
import { RESOLUTIONS, exchangeCandles } from "./_candles.js";

export default async function handler(req: any, res: any) {
  const symbol = String(req.query?.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const resolution = Number(req.query?.res ?? 60), limit = Math.min(Number(req.query?.limit ?? 500) || 500, 1000);
  if (!symbol || !RESOLUTIONS[resolution]) return res.status(400).json({ error: "symbol and res (60, 300, 900, 3600, 14400, 86400) are required" });
  res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=30");
  const indexer = process.env.INDEXER_URL;
  if (indexer) {
    try {
      const r = await fetch(`${indexer.replace(/\/$/, "")}/candles?symbol=${symbol}&res=${resolution}&limit=${limit}&network=${req.query?.network === "x1-testnet" ? "x1-testnet" : "devnet"}`, { signal: AbortSignal.timeout(4_000) });
      if (r.ok) return res.status(200).json(await r.json());
    } catch { /* fall back to exchange history */ }
  }
  return res.status(200).json({ source: "exchange", candles: await exchangeCandles(symbol, resolution, limit) });
}
