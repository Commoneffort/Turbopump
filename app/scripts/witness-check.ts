// How fresh the X1 witness's on-chain prices are: one line per traded feed.
//   NETWORK=x1-testnet npx tsx scripts/witness-check.ts
import { Connection } from "@solana/web3.js";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, "confirmed");
const now = Math.floor(Date.now() / 1000);
for (const f of C.FEEDS) {
  const a = await conn.getAccountInfo(C.witnessAddress(f.id));
  if (!a) { console.log(`${f.symbol}: no witness price yet`); continue; }
  const r = C.decodeReport(new Uint8Array(a.data));
  console.log(`${f.symbol}: ${Number(r.e6) / 1e6} posted ${now - Number(r.publish)} s ago${now - Number(r.publish) > 30 ? "  (STALE: marks wait)" : ""}`);
}
