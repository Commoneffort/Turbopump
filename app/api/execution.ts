// GET /api/execution?network=… : execution quality over each market's recent transactions
// (api/_execution.ts). Read from the chain and an exchange's public prices, kept by the CDN for a
// few minutes and shared by everyone, so the page costs the RPC one scan per few minutes.
import { measure } from "./_execution.js";
import { networkOf } from "./_config.js";

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any) {
  const net = networkOf(req), x1 = req?.query?.network === "x1-testnet";
  try {
    const report = await measure({ rpc: net.rpc, market: net.market, network: x1 ? "x1-testnet" : "devnet", x1 });
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=1800");
    return res.status(200).json(report);
  } catch (e: any) {
    res.setHeader("Cache-Control", "public, s-maxage=30");
    return res.status(502).json({ error: String(e?.message ?? e).replace(/https?:\/\/\S+/g, "the RPC").replace(/api-key=[^&\s"]+/g, "api-key=***") });
  }
}
