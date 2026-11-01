// GET /api/fills?network=…&wallet=…&need=<vault>:<position e6>,… : the wallet's fills back to the
// opening of each position named (api/_fills.ts). Kept by the CDN briefly: the URL changes with
// the positions, so a new fill asks again.
import { walletFills } from "./_fills.js";
import { networkOf } from "./_config.js";

export const config = { maxDuration: 60 };

export default async function handler(req: any, res: any) {
  const net = networkOf(req), x1 = req?.query?.network === "x1-testnet";
  try {
    const wallet = String(req?.query?.wallet ?? "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return res.status(400).json({ error: "wallet" });
    const need = new Map<string, number>();
    for (const part of String(req?.query?.need ?? "").split(",").filter(Boolean).slice(0, 8)) {
      const [v, q] = part.split(":");
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) && /^-?\d+$/.test(q ?? "")) need.set(v, Number(q));
    }
    const r = await walletFills({ rpc: net.rpc, market: net.market, x1, wallet, need });
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=120");
    return res.status(200).json(r);
  } catch (e: any) {
    res.setHeader("Cache-Control", "public, s-maxage=10");
    return res.status(502).json({ error: String(e?.message ?? e).replace(/https?:\/\/\S+/g, "the RPC").replace(/api-key=[^&\s"]+/g, "api-key=***") });
  }
}
