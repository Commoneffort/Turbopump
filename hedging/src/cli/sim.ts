// Runs the simulator's scenarios and prints what the hedge did in each.
// Run: npm run sim            (all scenarios)
//      npm run sim -- chaos   (one, with its hold reasons)
import { scenarios, simulate } from "../simulator";
import { HedgeState, isTrouble } from "../state";
import { usd } from "../units";

const only = process.argv[2];
const picked = scenarios.filter(s => !only || s.name === only);
if (!picked.length) {
  console.error(`no scenario "${only}". Known: ${scenarios.map(s => s.name).join(", ")}`);
  process.exit(1);
}
const rows = [];
for (const s of picked) {
  const r = await simulate(s);
  rows.push({
    scenario: r.name,
    orders: r.orders,
    "fee income": usd(r.depositorIncomeE6),
    "vault P&L": usd(r.vaultPnlE6),
    "hedge P&L": usd(r.hedgePnlE6),
    "hedge cost": usd(r.hedgeCostE6),
    "operator pay": usd(r.operatorFeeE6),
    "no hedge": usd(r.depositorsUnhedgedE6),
    hedged: usd(r.depositorsHedgedE6),
    "risk removed": `${(r.riskRemoved * 100).toFixed(0)}%`,
    "mean open": usd(r.meanResidualE6),
    "max open": usd(r.maxResidualE6),
    "outside band": `${(r.outsideBandShare * 100).toFixed(1)}%`,
    restarts: r.restarts,
    halts: r.halts.length,
    "in trouble": `${(Object.entries(r.states).filter(([s]) => isTrouble(s as HedgeState)).reduce((a, [, x]) => a + x, 0) * 100).toFixed(1)}%`,
    liquidated: r.liquidations,
    "ledger = venue": r.ledgerMatchesVenue ? "yes" : "NO",
  });
  if (only) {
    console.log(s.about);
    console.log("held because:", r.holds);
    console.log("halts:", r.halts);
    console.log("share of passes in each state:", Object.fromEntries(Object.entries(r.states).map(([k, v]) => [k, `${(v * 100).toFixed(1)}%`])));
    console.log("closest to liquidation:", r.minLiqDistanceBps === undefined ? "no hedge held" : `${(r.minLiqDistanceBps / 100).toFixed(1)}% of price`);
    console.log("open at the end:", Object.fromEntries(Object.entries(r.finalResidualE6).map(([k, v]) => [k, usd(v)])));
  }
}
console.table(rows);
