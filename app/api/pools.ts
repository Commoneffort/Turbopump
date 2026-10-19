// xDEX pools of a network: GET /api/pools?network=x1-testnet|devnet
// From xDEX's own pool list (its API does not answer other sites' pages directly). Only plain
// fields are passed on; token pictures are not (the page never shows a picture from a URL), and
// the page reads each pool's accounts on chain itself before quoting or swapping.
const NAMES: Record<string, string> = { "x1-testnet": "X1 Testnet", devnet: "Solana Devnet" };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const text = (s: unknown) => String(s ?? "").replace(/[^\p{L}\p{N} ._$-]/gu, "").slice(0, 16);

export default async function handler(req: any, res: any) {
  const network = NAMES[String(req.query?.network ?? "")] ?? NAMES.devnet;
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
  try {
    const r = await fetch(`https://api.xdex.xyz/api/xendex/pool/list?network=${encodeURIComponent(network)}&limit=500`, { signal: AbortSignal.timeout(6_000) });
    const j: any = await r.json();
    const pools = (Array.isArray(j?.data) ? j.data : [])
      .filter((p: any) => p?.network === network && B58.test(p.pool_address) && B58.test(p.token1_address) && B58.test(p.token2_address))
      .map((p: any) => ({
        pool: p.pool_address,
        a: { mint: p.token1_address, symbol: text(p.token1_symbol) },
        b: { mint: p.token2_address, symbol: text(p.token2_symbol) },
        tvl: Number(p.tvl) || 0,
        volume: (Number(p.token1_volume_usd_24h) || 0) + (Number(p.token2_volume_usd_24h) || 0),
      }))
      .sort((x: any, y: any) => y.tvl - x.tvl);
    return res.status(200).json({ network, pools });
  } catch (e: any) {
    return res.status(502).json({ error: `xDEX pool list: ${e?.message ?? e}`, pools: [] });
  }
}
