// Income demo: what each income idea adds for the depositors, on the same trades.
// No hedge here: the vault keeps every position. Trades are the copy-flow model's (copyflow.ts),
// on real prices, optionally tilted up or down to make a rising or falling market.
// Run: npm run income [-- seeds=8] [-- out=demo/income.json]
import * as fs from "fs";
import { Leader, Market, Mechanisms, Scenario, loadMarkets, makeFlow } from "../copyflow";

const arg = (k: string, d: string) => process.argv.slice(2).find(a => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d;
const seeds = Number(arg("seeds", "8"));
const out = arg("out", new URL("../../demo/income.json", import.meta.url).pathname);

/** The real prices, multiplied by a steady drift that adds `pct` percent by the end. */
export function tilt(markets: Market[], pct: number): Market[] {
  return markets.map(m => {
    const n = m.candles.length, g = Math.log(1 + pct / 100);
    return { ...m, candles: m.candles.map(([t, o, h, l, c], j) => {
      const a = Math.exp(g * j / n), b = Math.exp(g * (j + 1) / n);
      return [t, o * a, h * b, l * a, c * b] as [number, number, number, number, number];
    }) };
  });
}

const L = (name: string, skill: number, copyUsd = 20_000): Leader => ({ name, skill, copyUsd });
const star = [L("A", 0.5), L("B", 0.5), L("Star", 0.65, 60_000)];
// Traders who buy and hold for days, three in four of them long.
const holders = { opensPerMin: 0.004, medianUsd: 3_000, holdMin: 4 * 1_440, longShare: 0.75 };
type Case = { name: string; about: string; driftPct: number; s: Omit<Scenario, "name" | "about" | "mech"> };
export const cases: Case[] = [
  { name: "popular-star", about: "flat prices; a star right 65% of the time, $60,000 copied per trade", driftPct: 0, s: { leaders: star, feeBps: 5 } },
  { name: "holders-flat", about: "flat prices; long-term holders, 3 in 4 long", driftPct: 0, s: { leaders: [], feeBps: 5, holders } },
  { name: "holders-rise", about: "prices rise 10% in two weeks; long-term holders, 3 in 4 long", driftPct: 10, s: { leaders: [], feeBps: 5, holders } },
  { name: "rise-and-star", about: "prices rise 10%; holders and the popular star", driftPct: 10, s: { leaders: star, feeBps: 5, holders } },
  { name: "holders-fall", about: "prices fall 10%; long-term holders, 3 in 4 long", driftPct: -10, s: { leaders: [], feeBps: 5, holders } },
];

// The proposed settings.
const HOLD: Mechanisms = { holdPerHour: 0.0001 };           // up to 0.01%/hour (~88%/year) at the limit
const SIDE: Mechanisms = { sideFeeBps: 5 };                 // +5 bps on what grows the vault's position
const SHARE: Mechanisms = { profitShare: 0.1, shareToDepositors: 0.4 };
export const variants: [string, Mechanisms][] = [
  ["today", {}], ["holding fee", HOLD], ["side fee", SIDE], ["profit share", SHARE], ["all three", { ...HOLD, ...SIDE, ...SHARE }],
];

const markets0 = loadMarkets(new URL("../../demo/data/", import.meta.url).pathname);
const $ = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);

const report: any = { generatedAt: new Date().toISOString(), seeds, variants, cases: [] };
for (const c of cases) {
  const markets = c.driftPct ? tilt(markets0, c.driftPct) : markets0;
  const rows: any[] = [];
  const res: any = { name: c.name, about: c.about, driftPct: c.driftPct, variants: {} };
  for (const [vn, mech] of variants) {
    const runs = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const f = makeFlow(markets, { ...c.s, name: c.name, about: c.about, mech }, seed);
      const z = f.steps - 1;
      runs.push({
        depositors: f.feeIncome[z] + f.vaultPnl[z] + f.hold[z] + f.side[z] + f.share[z],
        fees: f.feeIncome[z], positions: f.vaultPnl[z], hold: f.hold[z], side: f.side[z], share: f.share[z],
        holdPaid: f.holdPaid, shareAll: f.shareTotal.all, holdersPnl: f.holdersPnl,
        copiers: f.traderPnl.leaders.reduce((a, x) => a + x, 0), volume: f.volume.crowd + f.volume.copy,
      });
    }
    const d = runs.map(r => r.depositors);
    const x = {
      avg: avg(d), worst: Math.min(...d), best: Math.max(...d), lossRuns: d.filter(v => v < 0).length,
      fees: avg(runs.map(r => r.fees)), positions: avg(runs.map(r => r.positions)), hold: avg(runs.map(r => r.hold)),
      side: avg(runs.map(r => r.side)), share: avg(runs.map(r => r.share)), shareAll: avg(runs.map(r => r.shareAll)),
      holdByCopiers: avg(runs.map(r => r.holdPaid.copy)), holdersPnl: avg(runs.map(r => r.holdersPnl)), volume: avg(runs.map(r => r.volume)), perSeed: d,
    };
    res.variants[vn] = x;
    rows.push({ variant: vn, "depositors avg": $(x.avg), worst: $(x.worst), "losing runs": `${x.lossRuns}/${seeds}`,
      "trade fees": $(x.fees), positions: $(x.positions), "holding fee": $(x.hold), "side fee": $(x.side), "profit share": $(x.share) });
  }
  report.cases.push(res);
  console.log(`\n== ${c.name}: ${c.about}  (3 vaults x $100,000, 14 days, ${seeds} runs)`);
  console.table(rows);
}
fs.writeFileSync(out, JSON.stringify(report));
console.log(`written ${out}`);
