// Measures whether hedging pays: the depositors' result with and without the hedge, over many
// simulated sessions, for different kinds of traders and different hedge settings.
//
// A session is 5.5 hours on one vault with $10,000 of deposits (so a $30,000 position cap).
// Depositors' result = their share of the trading fees + what the vault's position made or lost
// With the hedge: plus all of what the hedge made or lost, less the operator's pay (20% of the
// depositors' fee income unless the configuration says otherwise).
//
// Run: npm run measure -- [sessions]      (default 40 per row)
import { Config } from "../config";
import { MockOptions } from "../mock-venue";
import { Scenario, simulate } from "../simulator";
import { USD } from "../units";

const sessions = Number(process.argv[2] ?? 40);
const base: Scenario = {
  name: "measure", about: "", seed: 0, steps: 2_000, stepMs: 10_000, volBps: 12, trendBps: 1.5,
  flow: { tradeProb: 0.4, maxTradeUsd: 4_000, maxInventoryUsd: 30_000, feeBps: 5 },
};
const traders = [
  { name: "traders have no edge", skill: 0.5 },
  { name: "traders lose (wrong side of the trend 60% of the time)", skill: 0.4 },
  { name: "traders win (right side of the trend 60% of the time)", skill: 0.6 },
];
type Setting = { name: string; tune?: (c: Config) => void; venue?: Partial<MockOptions> };
const band = (usd: number, ratioBps = 10_000) => (c: Config) => {
  c.symbols.SOL.bandE6 = BigInt(usd) * USD;
  if (c.symbols.SOL.maxUnhedgedE6 < c.symbols.SOL.bandE6 * 2n) c.symbols.SOL.maxUnhedgedE6 = c.symbols.SOL.bandE6 * 2n;
  c.symbols.SOL.hedgeRatioBps = ratioBps;
};
const settings: Setting[] = [
  { name: "hedge all, act on $250", tune: band(250) },
  { name: "hedge all, act on $1,000", tune: band(1_000) },
  { name: "hedge all, act on $2,500", tune: band(2_500) },
  { name: "hedge all, act on $5,000", tune: band(5_000) },
  { name: "hedge all, act on $10,000", tune: band(10_000) },
  { name: "hedge half, act on $2,500", tune: band(2_500, 5_000) },
  // A venue charging 0.30% a trade, as a swap pool does, instead of 0.05%.
  { name: "hedge all, act on $5,000, venue fee 0.30%", tune: band(5_000), venue: { feeBps: 30 } },
];

const dollars = (e6: bigint) => Number(e6) / 1e6;
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
const fmt = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;

for (const t of traders) {
  const rows: Record<string, string>[] = [];
  let unhedged: number[] = [], volume = 0, income = 0;
  for (const s of settings) {
    const hedged: number[] = [], cost: number[] = [], turnover: number[] = [], pay: number[] = [];
    unhedged = [];
    volume = income = 0;
    for (let seed = 1; seed <= sessions; seed++) {
      const r = await simulate({ ...base, seed, flow: { ...base.flow, skill: t.skill }, tune: s.tune, venue: s.venue });
      if (r.halts.length || !r.ledgerMatchesVenue) throw new Error(`${s.name} seed ${seed}: halted or out of step`);
      const fees = dollars(r.depositorIncomeE6);
      unhedged.push(dollars(r.depositorsUnhedgedE6));
      hedged.push(dollars(r.depositorsHedgedE6));
      pay.push(dollars(r.operatorFeeE6));
      cost.push(dollars(r.hedgeCostE6));
      turnover.push(r.orders);
      volume += dollars(r.volumeE6) / sessions;
      income += fees / sessions;
    }
    if (!rows.length) rows.push({ setting: "no hedge", "average result": fmt(mean(unhedged)), "bad session (1 in 20)": fmt(pct(unhedged, 0.05)), "worst session": fmt(Math.min(...unhedged)), "hedge cost": "$0", "operator pay": "$0", "hedge orders": "0" });
    rows.push({ setting: s.name, "average result": fmt(mean(hedged)), "bad session (1 in 20)": fmt(pct(hedged, 0.05)), "worst session": fmt(Math.min(...hedged)), "hedge cost": fmt(mean(cost)), "operator pay": fmt(mean(pay)), "hedge orders": String(Math.round(mean(turnover))) });
  }
  console.log(`\n${t.name}: ${sessions} sessions. Traders trade ${fmt(volume)} a session and pay ${fmt(volume * 0.0005)} in fees; depositors' share is ${fmt(income)}, the opener's ${fmt(income / 4)}.`);
  console.table(rows);
}
