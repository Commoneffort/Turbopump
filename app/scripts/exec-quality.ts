// Execution quality from the chain, the same numbers as the site's Execution page, for anyone to
// check with their own RPC address. Reads only.
//   NETWORK=x1-testnet npx tsx scripts/exec-quality.ts          summary per market
//   NETWORK=devnet RPC=https://... npx tsx scripts/exec-quality.ts json   the full report
import { measure } from "../api/_execution";
import { NETWORKS } from "../api/_config";

const network = process.env.NETWORK === "x1-testnet" ? "x1-testnet" : "devnet";
const net = NETWORKS[network];
const r = await measure({ rpc: process.env.RPC ?? net.rpc, market: net.market, network, x1: network === "x1-testnet" });
if (process.argv[2] === "json") { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
const f = (x: number | undefined, dp = 1) => (x === undefined || Number.isNaN(x) ? "—" : x.toFixed(dp));
for (const m of [...r.markets, { symbol: "ALL", vault: "", from: 0, to: 0, stats: r.total }]) {
  const s = m.stats;
  console.log(`${m.symbol.padEnd(5)} ${m.from ? `${((m.to - m.from) / 3600).toFixed(1)} h` : ""}  requests ${s.requests} filled ${s.filled} refused ${s.refused} expired ${s.expired} | latency med ${f(s.latency?.median)} s p90 ${f(s.latency?.p90)} s | dev vs exchange med ${f(s.deviation?.median, 2)} (mean ${f(s.deviation?.mean, 2)}) bps p90 ${f(s.deviation?.p90, 2)} | slippage mean ${f(s.slippage?.mean, 2)} bps worse ${f((s.slippage?.worse ?? NaN) * 100, 0)}% | markout 60s ${f(s.markout?.s60, 2)} 300s ${f(s.markout?.s300, 2)} bps | liq ${s.liquidations.n} | triggers ${s.triggers.n} delay ${f(s.triggers.medianDelay)} s | failed tx ${s.failedTxs}/${s.txs} | executors ${s.executors.length}`);
}
if (r.total.oracleMatch) console.log(`fill price = posted oracle price: ${r.total.oracleMatch.n - r.total.oracleMatch.mismatches}/${r.total.oracleMatch.n}`);
