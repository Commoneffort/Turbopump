// Builds the Hedge Lab page (demo/hedge-lab.html) from the demo's results.
// Run after `npm run demo` (both passes): npx tsx demo/make-page.ts
import * as fs from "fs";
import { minutePrices, SYMBOLS } from "../src/copyflow";

const dir = new URL("./", import.meta.url).pathname;
const read = (f: string) => JSON.parse(fs.readFileSync(dir + f, "utf8"));
const R = { taker: read("results-taker.json"), maker: read("results-maker.json") };
const markets = SYMBOLS.map(coin => ({ coin, ...read(`data/${coin}.json`) }));
const minutes = markets.map(m => minutePrices(m));
const r0 = (x: number) => Math.round(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const avg = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);
const LABELS: Record<string, string> = {
  "crowd-only": "No copy trading", "coin-flip": "Coin-flip leaders", "one-star": "One star",
  mixed: "Mixed leaders", "all-sharp": "All sharp", "big-star": "Popular star", "one-star-10bps": "One star, 10 bps fee",
};

const scenarios = R.taker.scenarios.map((s: any, si: number) => {
  const fl = s.flows;
  const leaders = s.leaders.map((l: any, i: number) => ({
    name: l.name, skill: l.skill, copyUsd: l.copyUsd,
    vol: r0(avg(fl.map((f: any) => f.volume.leaders[i]))), pnl: r0(avg(fl.map((f: any) => f.traderPnl.leaders[i]))),
    trades: r2(avg(fl.map((f: any) => f.trades.leaders[i]))),
  }));
  const res: any = {};
  for (const p of ["taker", "maker"] as const) {
    res[p] = {};
    for (const [k, x] of Object.entries<any>(R[p].scenarios[si].strategies)) {
      res[p][k] = {
        avg: r0(x.depositorsAvg), worst: r0(x.depositorsWorst), best: r0(x.depositorsBest), lossRuns: x.lossRuns, perSeed: x.perSeed.map(r0),
        feeIncome: r0(x.feeIncome), vaultPnl: r0(x.vaultPnl), hedgePnl: r0(x.hedgePnl), hedgeFees: r0(x.hedgeFees),
        hedgeSpread: r0(x.hedgeSpread), hedgeFunding: r0(x.hedgeFunding), operatorPay: r0(x.operatorPay), orders: r0(x.orders),
        hedgeVolume: r0(x.hedgeVolume), maxDrawdown: r0(x.maxDrawdown), worstDay: r0(x.worstDay), ledgerOk: x.ledgerOk, liquidations: x.liquidations,
        hourly: x.hourlySeed1.map(r0),
      };
    }
  }
  // Seed 1's trade log: copier trades (open/close paired per leader) and hedge orders.
  const f1 = fl[0], t0 = f1.t0;
  const openBy: Record<number, any> = {};
  const copy = f1.copyEvents.map((e: any) => {
    const usd = e.q * e.px;
    const row: any = { t: t0 + e.i * 60_000, who: e.leader, sym: SYMBOLS[e.sym], kind: e.kind, usd: r0(usd), px: r2(e.px), fee: r2(Math.abs(usd) * s.feeBps / 10_000) };
    if (e.kind === "open") openBy[e.leader] = e;
    else { const o = openBy[e.leader]; if (o) row.pnl = r0(o.q * (e.px - o.px)); }
    return row;
  });
  const hedge: any = {};
  for (const p of ["taker", "maker"] as const) {
    hedge[p] = {};
    for (const k of ["copy", "smart"]) {
      const x = R[p].scenarios[si].strategies[k];
      if (x) hedge[p][k] = x.hedgeFillsSeed1.map((h: any) => [h.t, h.sym, r0(h.usd), r2(h.px), r2(h.fee)]);
    }
  }
  return {
    name: s.name, label: LABELS[s.name] ?? s.name, about: s.about, feeBps: s.feeBps, leaders,
    crowd: { vol: r0(avg(fl.map((f: any) => f.volume.crowd))), pnl: r0(avg(fl.map((f: any) => f.traderPnl.crowd))) },
    res, log: { copy, hedge },
  };
});

// The walkthrough: the popular star's trades in run 1, hedged by "smart" with resting orders.
// Pick a winning trade the hedge covered fully, with nobody else's copies on that market then.
const bs = scenarios.find((s: any) => s.name === "big-star");
const starIdx = bs.leaders.findIndex((l: any) => l.name === "Star");
const fills = bs.log.hedge.maker.smart as [number, string, number, number, number][];
const opens = bs.log.copy.filter((e: any) => e.who === starIdx && e.kind === "open");
let story: any = null, bestScore = -Infinity;
for (const o of opens) {
  const c = bs.log.copy.find((e: any) => e.who === starIdx && e.kind === "close" && e.t > o.t);
  if (!c || !(c.pnl > 0)) continue;
  const others = bs.log.copy.some((e: any) => e.who !== starIdx && e.sym === o.sym && e.t >= o.t - 600_000 && e.t <= c.t + 600_000);
  if (others) continue;
  const near = (t: number) => fills.filter(h => h[1] === o.sym && h[0] >= t && h[0] <= t + 10 * 60_000);
  const hOpen = near(o.t), hClose = near(c.t);
  const inOpen = hOpen.reduce((a, h) => a + h[2], 0), inClose = hClose.reduce((a, h) => a + h[2], 0);
  // Copiers buy -> vault short -> the hedge buys the same amount.
  if (Math.abs(inOpen - o.usd) > 0.15 * Math.abs(o.usd) || Math.abs(inClose + inOpen) > 0.25 * Math.abs(inOpen)) continue;
  const hours = (c.t - o.t) / 3_600_000;
  const score = c.pnl - (hours > 8 ? 1e9 : 0);
  if (score > bestScore) { bestScore = score; story = { o, c, hOpen, hClose }; }
}
if (story) {
  const k = SYMBOLS.indexOf(story.o.sym);
  const mt = minutes[k];
  const from = story.o.t - 30 * 60_000, to = story.c.t + 30 * 60_000;
  const series: [number, number][] = [];
  for (let i = 0; i < mt.t.length; i++) if (mt.t[i] >= from && mt.t[i] <= to) series.push([mt.t[i], r2(mt.px[i])]);
  story = { ...story, series, feeBps: bs.feeBps, copyUsd: bs.leaders[starIdx].copyUsd, skill: bs.leaders[starIdx].skill };
}

const data = {
  generatedAt: R.taker.generatedAt, runs: R.taker.seeds,
  period: { from: R.taker.markets[0].from, to: R.taker.markets[0].to, prices: Object.fromEntries(R.taker.markets.map((m: any) => [m.coin, [m.first, m.last]])) },
  pricing: { taker: { fee: R.taker.options.venueFeeBps, spread: R.taker.options.venueSpreadBps }, maker: { fee: R.maker.options.venueFeeBps, spread: R.maker.options.venueSpreadBps } },
  hedge: { equity: R.taker.options.hedgeEquityUsd, band: R.taker.options.bandUsd, operatorFeeBps: R.taker.options.operatorFeeBps },
  scenarios, story,
  income: (() => {
    const I = read("income.json");
    return { runs: I.seeds, cases: I.cases.map((c: any) => ({ name: c.name, about: c.about, drift: c.driftPct,
      v: Object.fromEntries(Object.entries<any>(c.variants).map(([k, x]) => [k, { avg: r0(x.avg), worst: r0(x.worst), best: r0(x.best), loss: x.lossRuns,
        fees: r0(x.fees), positions: r0(x.positions), hold: r0(x.hold), side: r0(x.side), share: r0(x.share), perSeed: x.perSeed.map(r0) }])) })) };
  })(),
};
const tpl = fs.readFileSync(dir + "page.html", "utf8");
const json = JSON.stringify(data).replace(/</g, "\\u003c");
fs.writeFileSync(dir + "hedge-lab.html", tpl.replace("/*DATA*/null", json));
console.log(`hedge-lab.html: ${(fs.statSync(dir + "hedge-lab.html").size / 1024).toFixed(0)} KB, story ${story ? `${story.o.sym} ${new Date(story.o.t).toISOString()} pnl ${story.c.pnl}` : "none found"}`);
