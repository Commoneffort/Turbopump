// xDEX data for the Spot page (xDEX's API does not answer other sites' pages directly):
//   GET /api/pools?network=x1-testnet|devnet                      the network's pools
//   GET /api/pools?network=…&candles=1&from=<mint>&to=<mint>&res=<s>&limit=<n>   price history of `from` in `to`
//   GET /api/pools?network=…&trades=<pool>[&signer=<wallet>]      a pool's latest swaps
// Only plain fields are passed on; token pictures are not (the page never shows a picture from a
// URL), and the page reads each pool's accounts on chain itself before quoting or swapping.
const NAMES: Record<string, string> = { "x1-testnet": "X1 Testnet", devnet: "Solana Devnet" };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const RESOLUTIONS = new Set([60, 300, 900, 3600, 14400, 86400]);
const API = "https://api.xdex.xyz/api";
const text = (s: unknown) => String(s ?? "").replace(/[^\p{L}\p{N} ._$-]/gu, "").slice(0, 16);
const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const get = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(6_000) })).json() as Promise<any>;

export default async function handler(req: any, res: any) {
  const q = req.query ?? {};
  const network = NAMES[String(q.network ?? "")] ?? NAMES.devnet;
  const net = encodeURIComponent(network);
  try {
    if (q.candles) {
      const from = String(q.from ?? ""), to = String(q.to ?? ""), resolution = Number(q.res), limit = Math.min(Number(q.limit) || 300, 1000);
      if (!B58.test(from) || !B58.test(to) || !RESOLUTIONS.has(resolution)) return res.status(400).json({ error: "from, to and res are required" });
      res.setHeader("Cache-Control", "public, s-maxage=8, stale-while-revalidate=300");
      const now = Math.floor(Date.now() / 1000);
      const j = await get(`${API}/xdex/chart/history?from_token=${from}&to_token=${to}&resolution=${resolution / 60}&time_from=${now - resolution * limit}&time_to=${now}&network=${net}`);
      const candles = (Array.isArray(j?.bars) ? j.bars : [])
        .map((b: any) => [n(b.t), n(b.o), n(b.h), n(b.l), n(b.c), n(b.v)])
        .filter((c: number[]) => c[0] > 0 && c[1] > 0 && c[4] > 0)
        .sort((a: number[], b: number[]) => a[0] - b[0]);
      return res.status(200).json({ source: "xdex", candles });
    }
    if (q.trades) {
      const pool = String(q.trades), signer = q.signer ? String(q.signer) : "";
      if (!B58.test(pool) || (signer && !B58.test(signer))) return res.status(400).json({ error: "bad pool or signer" });
      res.setHeader("Cache-Control", "public, s-maxage=4, stale-while-revalidate=60");
      const j = await get(`${API}/xdex/alpha/swap-txs?network=${net}&pool_address=${pool}&skip=0&limit=${Math.min(Number(q.limit) || 40, 100)}${signer ? `&signer=${signer}` : ""}`);
      const trades = (Array.isArray(j?.data?.items) ? j.data.items : [])
        .filter((t: any) => SIG.test(t?.signature) && B58.test(t?.input_token) && B58.test(t?.output_token) && B58.test(t?.signer))
        .map((t: any) => ({ sig: t.signature, time: n(t.block_time), signer: t.signer, inMint: t.input_token, outMint: t.output_token, inAmount: n(t.input_amount), outAmount: n(t.output_amount) }));
      return res.status(200).json({ trades });
    }
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
    const j = await get(`${API}/xendex/pool/list?network=${net}&limit=500`);
    const pools = (Array.isArray(j?.data) ? j.data : [])
      .filter((p: any) => p?.network === network && B58.test(p.pool_address) && B58.test(p.token1_address) && B58.test(p.token2_address))
      .map((p: any) => ({
        pool: p.pool_address,
        // Prices and value are xDEX's, in a unit of its own per network (the page only divides
        // them by each other, to list pools).
        // `volume` is the token's own amount swapped in 24 hours.
        a: { mint: p.token1_address, symbol: text(p.token1_symbol), price: n(p.token1_price), volume: n(p.token1_volume_24h) },
        b: { mint: p.token2_address, symbol: text(p.token2_symbol), price: n(p.token2_price), volume: n(p.token2_volume_24h) },
        tvl: n(p.tvl),
        volume: n(p.token1_volume_usd_24h) + n(p.token2_volume_usd_24h),
        txns: n(p.txns_24h),
      }))
      .sort((x: any, y: any) => y.tvl - x.tvl);
    return res.status(200).json({ network, pools });
  } catch (e: any) {
    return res.status(502).json({ error: `xDEX: ${e?.message ?? e}`, pools: [], candles: [], trades: [] });
  }
}
