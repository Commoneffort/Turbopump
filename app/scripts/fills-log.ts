// Keeps every fill of every trading account, for the weekly payouts. A track record on chain holds
// only an account's last 16 fills, so this reads all of them every two minutes and appends the new
// ones to deploy/logs/fills-<network>.jsonl, one JSON object a line:
//   {"wallet": "...", "time": unix, "asset": n, "size": signed units, "price": dollars}
// It also notes each account's total trade count at each read ({"wallet", "trades", "at"} lines
// with "count": true), so a payout can tell when fills went by unlogged (more than 16 between two
// reads) and treat those as not refundable.
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/fills-log.ts          runs until stopped
//   NETWORK=...               npx tsx scripts/fills-log.ts once     one read
//
// Run by deploy/x1-services.sh and deploy/devnet-services.sh.
import { Connection } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";

export const FILLS_FILE = `../deploy/logs/fills-${C.X1 ? "x1" : "devnet"}.jsonl`;
export type LoggedFill = { wallet: string; time: number; asset: number; size: number; price: number };
export type CountLine = { count: true; wallet: string; trades: number; at: number };
const EVERY_MS = 120_000;
const key = (f: LoggedFill) => `${f.wallet}:${f.time}:${f.asset}:${f.size}:${f.price}`;

/** Everything logged so far: fills (oldest first) and trade-count readings. */
export function readLog(file = FILLS_FILE): { fills: LoggedFill[]; counts: CountLine[] } {
  const fills: LoggedFill[] = [], counts: CountLine[] = [];
  if (!fs.existsSync(file)) return { fills, counts };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.count) counts.push(o); else fills.push(o);
    } catch { /* a line cut short by a crash */ }
  }
  fills.sort((a, b) => a.time - b.time);
  return { fills, counts };
}

async function readOnce(conn: Connection, seen: Set<string>) {
  const accs = await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: S.STATS_LEN }, { memcmp: { offset: 40, bytes: C.MARKET.toBase58() } }] });
  const out: string[] = [];
  const at = Math.floor(Date.now() / 1000);
  let added = 0;
  for (const a of accs) {
    const s = S.decodeStats(new Uint8Array(a.account.data));
    const wallet = s.wallet.toBase58();
    for (const f of s.fills) {
      const row: LoggedFill = { wallet, time: f.time, asset: f.asset, size: f.size, price: f.price };
      const k = key(row);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(JSON.stringify(row));
      added++;
    }
    out.push(JSON.stringify({ count: true, wallet, trades: s.trades, at } satisfies CountLine));
  }
  if (out.length) fs.appendFileSync(FILLS_FILE, out.join("\n") + "\n");
  return { accounts: accs.length, added };
}

if (process.argv[1]?.endsWith("fills-log.ts")) (async () => {
  const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
  const seen = new Set(readLog().fills.map(key));
  const once = process.argv[2] === "once";
  for (;;) {
    try {
      const r = await readOnce(conn, seen);
      console.log(`${new Date().toISOString()} ${r.accounts} track records, ${r.added} new fills (${seen.size} logged)`);
    } catch (e: any) { console.log(`${new Date().toISOString()} read failed: ${e?.message ?? e}`); }
    if (once) return;
    await new Promise(ok => setTimeout(ok, EVERY_MS));
  }
})();
