// Hedge demo: replays real prices with simulated crowd and copy traders, and compares what the
// vaults' depositors end with under each hedge strategy. See src/copyflow.ts.
// Run: npx tsx demo/fetch-hl.ts          (once: downloads public prices and funding)
//      npm run demo [-- seeds=8] [-- only=<scenario>] [-- out=demo/results.json]
import * as fs from "fs";
import { HedgeOptions, Leader, Scenario, STRATEGIES, loadMarkets, makeFlow, runStrategy } from "../copyflow";

const arg = (k: string, d: string) => process.argv.slice(2).find(a => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? d;
const seeds = Number(arg("seeds", "8"));
const only = arg("only", "");
const out = arg("out", new URL("../../demo/results.json", import.meta.url).pathname);

const L = (name: string, skill: number, copyUsd = 20_000): Leader => ({ name, skill, copyUsd });
export const scenarios: Scenario[] = [
  { name: "crowd-only", about: "no copy trading: only the crowd trades", leaders: [], feeBps: 5 },
  { name: "coin-flip", about: "three copied leaders, none better than a coin flip", leaders: [L("A", 0.5), L("B", 0.5), L("C", 0.5)], feeBps: 5 },
  { name: "one-star", about: "two coin-flip leaders and one who is right 65% of the time", leaders: [L("A", 0.5), L("B", 0.5), L("Star", 0.65)], feeBps: 5 },
  { name: "mixed", about: "a losing leader (40%), a coin flip, and a good one (62%)", leaders: [L("Loser", 0.4), L("Flip", 0.5), L("Good", 0.62)], feeBps: 5 },
  { name: "all-sharp", about: "three leaders, each right 60% of the time", leaders: [L("A", 0.6), L("B", 0.6), L("C", 0.6)], feeBps: 5 },
  { name: "big-star", about: "one-star, but the star is popular: $60,000 copies each trade", leaders: [L("A", 0.5), L("B", 0.5), L("Star", 0.65, 60_000)], feeBps: 5 },
  { name: "one-star-10bps", about: "one-star, with a 10 bps trading fee (X1's current fee)", leaders: [L("A", 0.5), L("B", 0.5), L("Star", 0.65)], feeBps: 10 },
];

const opts: HedgeOptions = { venueFeeBps: Number(arg("venueFee", "5")), venueSpreadBps: Number(arg("spread", "1")), hedgeEquityUsd: 60_000, bandUsd: 1_500, operatorFeeBps: 2_000 };
const markets = loadMarkets(new URL("../../demo/data/", import.meta.url).pathname);
const $ = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);

const report: any = { generatedAt: new Date().toISOString(), seeds, options: opts, markets: markets.map(m => ({ coin: m.coin, from: m.candles[0][0], to: m.candles[m.candles.length - 1][0], first: m.candles[0][4], last: m.candles[m.candles.length - 1][4] })), scenarios: [] };
const started = Date.now();
for (const s of scenarios.filter(x => !only || x.name === only)) {
  const runs: Record<string, any[]> = Object.fromEntries(STRATEGIES.map(k => [k, []]));
  const flows: any[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const flow = makeFlow(markets, s, seed);
    flows.push({ volume: flow.volume, traderPnl: flow.traderPnl, trades: flow.trades, refusedUsd: flow.refusedUsd,
      ...(seed === 1 ? { copyEvents: flow.copyEvents, t0: flow.t[0] } : {}) });
    for (const k of STRATEGIES) {
      // Strategies that hedge nothing different from "copy" when there is no copy flow are skipped.
      if (!s.leaders.length && (k === "copy" || k === "smart")) continue;
      const r = await runStrategy(markets, flow, k, opts);
      if (seed !== 1) { r.hourly = []; r.hedgeFills = []; }
      runs[k].push(r);
    }
  }
  const rows: any[] = [];
  const summary: any = { name: s.name, about: s.about, feeBps: s.feeBps, leaders: s.leaders, flows, strategies: {} };
  for (const k of STRATEGIES) {
    const rs = runs[k];
    if (!rs.length) continue;
    const d = rs.map(r => r.depositorsUsd);
    summary.strategies[k] = {
      depositorsAvg: avg(d), depositorsWorst: Math.min(...d), depositorsBest: Math.max(...d), lossRuns: d.filter(x => x < 0).length,
      feeIncome: avg(rs.map(r => r.feeIncomeUsd)), vaultPnl: avg(rs.map(r => r.vaultPnlUsd)), hedgePnl: avg(rs.map(r => r.hedgePnlUsd)),
      hedgeFees: avg(rs.map(r => r.hedgeFeesUsd)), hedgeSpread: avg(rs.map(r => r.hedgeSpreadUsd)), hedgeFunding: avg(rs.map(r => r.hedgeFundingUsd)),
      operatorPay: avg(rs.map(r => r.operatorPayUsd)), orders: avg(rs.map(r => r.hedgeOrders)),
      maxDrawdown: avg(rs.map(r => r.maxDrawdownUsd)), worstDay: Math.min(...rs.map(r => r.worstDayUsd)), dailyStd: avg(rs.map(r => r.dailyStdUsd)),
      maxOpen: avg(rs.map(r => r.maxOpenUsd)), hedgeVolume: avg(rs.map(r => r.hedgeVolumeUsd)), hedgeFillsSeed1: rs[0].hedgeFills, ledgerOk: rs.every(r => r.ledgerMatchesVenue), liquidations: rs.reduce((a, r) => a + r.liquidations, 0),
      hourlySeed1: rs[0].hourly, perSeed: d,
    };
    const x = summary.strategies[k];
    rows.push({
      strategy: k, "depositors avg": $(x.depositorsAvg), worst: $(x.depositorsWorst), best: $(x.depositorsBest), "losing runs": `${x.lossRuns}/${rs.length}`,
      "fee income": $(x.feeIncome), "vault P&L": $(x.vaultPnl), "hedge P&L": $(x.hedgePnl), "hedge costs": $(x.hedgeFees + x.hedgeSpread + x.hedgeFunding),
      "operator pay": $(x.operatorPay), "max drawdown": $(x.maxDrawdown), "worst day": $(x.worstDay), ok: x.ledgerOk && !x.liquidations ? "yes" : "NO",
    });
  }
  report.scenarios.push(summary);
  const lp = s.leaders.map((l, i) => `${l.name} ${$(avg(flows.map(f => f.traderPnl.leaders[i])))}`).join(", ");
  console.log(`\n== ${s.name}: ${s.about}  (fee ${s.feeBps} bps, ${seeds} runs)`);
  console.log(`   avg volume: crowd ${$(avg(flows.map(f => f.volume.crowd)))}, copy ${$(avg(flows.map(f => f.volume.copy)))}; trader P&L before fees: crowd ${$(avg(flows.map(f => f.traderPnl.crowd)))}${lp ? ", copiers of " + lp : ""}`);
  console.table(rows);
}
fs.writeFileSync(out, JSON.stringify(report));
console.log(`\n${((Date.now() - started) / 1000).toFixed(0)} s; written ${out}`);
