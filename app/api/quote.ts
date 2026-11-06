// GET /api/quote?network=x1-testnet&vault=<vault>&trader=<trading account>&size=<e6 units, + = buy>[&life=<slots>]
// Our maker's signed quote (api/_maker.ts), good for a few slots. MAKER_SECRET_X1 holds the
// maker's keypair (JSON byte array) and MAKER_PORTFOLIO_X1 its Percolator portfolio (set up with
// scripts/maker.ts setup). 404 when no quote is offered: the trade then goes through the queue.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { networkOf } from "./_config.js";
import { makeQuote } from "./_maker.js";

let conns: Record<string, Connection> = {};

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  const x1 = req?.query?.network === "x1-testnet";
  const net = networkOf(req);
  const secret = process.env[x1 ? "MAKER_SECRET_X1" : "MAKER_SECRET"], portfolio = process.env[x1 ? "MAKER_PORTFOLIO_X1" : "MAKER_PORTFOLIO"];
  if (!secret || !portfolio) return res.status(404).json({ error: "no maker on this network" });
  let vault: PublicKey, trader: PublicKey, size: bigint;
  try {
    vault = new PublicKey(String(req.query.vault));
    trader = new PublicKey(String(req.query.trader));
    size = BigInt(String(req.query.size));
  } catch {
    return res.status(400).json({ error: "vault, trader and size are needed" });
  }
  try {
    const conn = (conns[net.rpc] ??= new Connection(net.rpc, "processed"));
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
    const life = req.query.life ? Number(req.query.life) : undefined;
    const q = await makeQuote(conn, { kp, portfolio: new PublicKey(portfolio), market: new PublicKey(net.market) }, vault, trader, size, life);
    return res.status(200).json(q);
  } catch (e: any) {
    return res.status(404).json({ error: String(e?.message ?? e).replace(/https?:\/\/\S+/g, "the RPC") });
  }
}
