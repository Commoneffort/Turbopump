// Shows where a hedger stands: its state and the risk the vaults still carry (from its latest
// pass), then its journal: positions, halts, unresolved orders, recent events. Safe to run while
// the hedger runs. `resume <scope>` lifts a halt, and `rebase` accepts the hedge account's value
// as it is (after money was moved in or out); the hedger must be stopped for those.
//
// Run: npm run status -- [--state dir] [resume <symbol or *> | rebase <dollars moved in>]
import { Journal, readJournal } from "../journal";
import { resume } from "../reconcile";
import { readReport, riskLines, riskRows } from "../report";
import { qty, systemClock, usd } from "../units";

const args = process.argv.slice(2);
const at = args.indexOf("--state");
const dir = at >= 0 ? args.splice(at, 2)[1] : new URL("../../state/shadow", import.meta.url).pathname;

if (args[0] === "resume") {
  if (!args[1]) throw new Error("resume what? a symbol, or * for a global halt");
  const j = Journal.open(dir, readJournal(dir).ledger.venue, systemClock);
  resume(j, args[1], process.env.USER ?? "operator");
  j.close();
  console.log(`resumed ${args[1]}`);
}

if (args[0] === "rebase") {
  const moved = Number(args[1]);
  if (!Number.isFinite(moved) || moved === 0) throw new Error("rebase by how much? the dollars moved into the hedge account (negative for out)");
  const j = Journal.open(dir, readJournal(dir).ledger.venue, systemClock);
  if (j.ledger.baselineE6 === undefined) { j.close(); throw new Error("the hedger has not valued the account yet"); }
  j.append({ type: "baseline", equityE6: j.ledger.baselineE6 + BigInt(Math.round(moved * 1e6)), by: process.env.USER ?? "operator" });
  j.close();
  console.log(`recorded ${usd(BigInt(Math.round(moved * 1e6)))} moved into the hedge account`);
}

const report = readReport(dir);
if (report) {
  for (const line of riskLines(report)) console.log(line);
  console.table(riskRows(report));
} else console.log("no pass has been reported yet (risk.json)");

const { ledger: L, entries } = readJournal(dir);
console.log(`journal ${dir}: venue "${L.venue}", ${L.seq} events, ${L.intents.size} orders, fees ${usd(L.feesE6)}`);
console.table([...L.positions].map(([symbol, q]) => ({ symbol, hedge: qty(q), "cash from fills": usd(L.cashE6.get(symbol) ?? 0n) })));
console.log("switches:", L.switches.size ? Object.fromEntries([...L.switches].map(([k, on]) => [k, on ? "on" : "off"])) : "none (hedging is off)");
for (const [scope, reason] of L.halts) console.log(`HALTED ${scope}: ${reason}`);
for (const i of L.unresolved()) console.log(`unresolved ${i.symbol} ${i.side} ${qty(i.sizeQ)} (${i.status}) ${i.id}`);
const show = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);
for (const e of entries.slice(-15)) {
  const { seq, ts, type, ...rest } = e as any;
  console.log(seq, new Date(ts).toISOString().slice(0, 19), type, JSON.stringify(rest, (_, v) => show(v)));
}
