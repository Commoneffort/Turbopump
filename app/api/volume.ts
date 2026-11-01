// GET /api/volume?network=… : each market's trading volume over the last 24 hours
// (api/_volume.ts), kept by the CDN for ten minutes and shared by everyone.
import { volume24h } from "./_volume.js";
import { networkOf } from "./_config.js";

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any) {
  const net = networkOf(req), x1 = req?.query?.network === "x1-testnet";
  try {
    const v = await volume24h({ rpc: net.rpc, market: net.market, network: x1 ? "x1-testnet" : "devnet", x1 });
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    return res.status(200).json(v);
  } catch (e: any) {
    res.setHeader("Cache-Control", "public, s-maxage=30");
    return res.status(502).json({ error: String(e?.message ?? e).replace(/https?:\/\/\S+/g, "the RPC").replace(/api-key=[^&\s"]+/g, "api-key=***") });
  }
}
