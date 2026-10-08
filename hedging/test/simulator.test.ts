import assert from "node:assert/strict";
import { test } from "node:test";
import { SimResult, scenarios, simulate } from "../src/simulator";
import { USD, abs } from "../src/units";

const results = new Map<string, SimResult>();
const run = async (name: string) => {
  if (!results.has(name)) results.set(name, await simulate(scenarios.find(s => s.name === name)!));
  return results.get(name)!;
};
const BAND = 250n * USD;

test("in every scenario the books agree, nothing halts, and no order is sent twice", async () => {
  for (const s of scenarios) {
    const r = await run(s.name);
    assert.ok(r.ledgerMatchesVenue, `${s.name}: ledger = venue`);
    assert.deepEqual(r.halts, [], s.name);
    assert.ok(r.orders <= r.intents, `${s.name}: every order the venue got was journaled first`);
    assert.ok(r.orders > 100, s.name);
  }
});

test("once the vault stops moving, the hedge ends within its band", async () => {
  for (const name of ["calm", "adverse", "two-symbols", "costly", "gap", "half-hedge", "venue-outage", "chain-outage", "chaos"]) {
    const r = await run(name);
    for (const [symbol, open] of Object.entries(r.finalResidualE6)) assert.ok(abs(open) < BAND, `${name} ${symbol}: ${open}`);
  }
});

test("the hedge removes most of the vault's price risk", async () => {
  assert.ok((await run("calm")).riskRemoved > 0.85);
  assert.ok((await run("two-symbols")).riskRemoved > 0.85);
  assert.ok((await run("gap")).riskRemoved > 0.85);
  // Half a hedge removes about half.
  const half = (await run("half-hedge")).riskRemoved;
  assert.ok(half > 0.4 && half < 0.6, String(half));
});

test("against traders who are right, the hedge's gains cover the vault's loss", async () => {
  const r = await run("adverse");
  assert.ok(r.vaultPnlE6 < -2_000n * USD, "the unhedged vault loses");
  assert.ok(r.hedgePnlE6 > 0n);
  // Before its running costs, the hedge wins back at least 90% of what the vault lost.
  assert.ok((r.hedgePnlE6 + r.hedgeCostE6) * 100n > -r.vaultPnlE6 * 90n);
  assert.ok(abs(r.netPnlE6) * 2n < abs(r.vaultPnlE6));
});

test("fee income is counted as the programs pay it", async () => {
  const r = await run("calm");
  // 5 bps of what traders traded; depositors net 80% of it, the market's opener 20%.
  assert.equal(r.traderFeesE6, r.volumeE6 * 5n / 10_000n);
  assert.equal(r.depositorIncomeE6, r.traderFeesE6 * 8n / 10n);
  assert.equal(r.openerIncomeE6, r.traderFeesE6 * 2n / 10n);
  assert.ok(r.volumeE6 > 1_000_000n * USD);
  // Venue fees, plus the spread paid on fills.
  assert.ok(r.hedgeCostE6 > r.feesE6 && r.hedgeCostE6 < r.feesE6 * 2n);
});

test("the hedge costs what the venue charges, and the report shows it", async () => {
  const calm = await run("calm"), costly = await run("costly");
  assert.ok(calm.feesE6 > 0n && calm.hedgePnlE6 < 0n);
  assert.ok(costly.fundingE6 !== 0n);
  assert.ok(costly.hedgePnlE6 < calm.hedgePnlE6);
});

test("limits bind without the venue ever refusing an order", async () => {
  const thin = await run("thin-margin");
  assert.equal(thin.rejected, 0);
  assert.ok(thin.holds["not enough free margin at the venue"] > 100);
  assert.ok(thin.riskRemoved < (await run("calm")).riskRemoved);
  const gross = await run("gross-limit");
  assert.equal(gross.rejected, 0);
  assert.ok(gross.riskRemoved < (await run("two-symbols")).riskRemoved);
});

test("an outage leaves the hedge where it was, and it catches up after", async () => {
  for (const name of ["venue-outage", "chain-outage"]) {
    const r = await run(name);
    assert.ok(r.maxResidualE6 > (await run("calm")).maxResidualE6, name);
    assert.ok(r.riskRemoved > 0.8, name);
  }
  assert.ok((await run("chain-outage")).holds["vault reading is too old"] > 150);
});

test("faults and crashes cost hedge quality, not correctness", async () => {
  const r = await run("chaos");
  assert.ok(r.restarts > 20);
  assert.ok(r.rejected > 5);
  assert.ok(r.holds["order … is unresolved"] > 20);
  assert.ok(r.riskRemoved > 0.7);
});

test("a run is reproducible", async () => {
  const s = scenarios.find(x => x.name === "chaos")!;
  assert.deepEqual(await simulate({ ...s, steps: 400 }), await simulate({ ...s, steps: 400 }));
});

test("in every scenario the hedge account's value is what the ledger says it should be", async () => {
  for (const s of scenarios) assert.equal((await run(s.name)).unexplainedE6, 0n, s.name);
});

test("an untroubled run spends no time in a trouble state; an outage shows as one", async () => {
  const trouble = (r: SimResult) => ["DEGRADED", "STALE", "FAILED", "UNKNOWN", "EMERGENCY"].reduce((a, s) => a + (r.states[s] ?? 0), 0);
  for (const name of ["calm", "adverse", "two-symbols", "half-hedge"]) assert.equal(trouble(await run(name)), 0, name);
  assert.ok((await run("venue-outage")).states.UNKNOWN > 0.09);
  assert.ok((await run("chain-outage")).states.STALE > 0.09);
  assert.ok((await run("thin-margin")).states.DEGRADED > 0.3);
});

test("a venue that refuses every order is asked ever more rarely, and reported as failed", async () => {
  const r = await run("refused");
  // 300 passes of refusals: 20 s, 40 s, ... then one try every 10 minutes.
  assert.ok(r.rejected >= 8 && r.rejected <= 12, String(r.rejected));
  assert.ok(r.states.FAILED > 0.1);
  assert.ok(abs(r.finalResidualE6.SOL) < BAND);
  assert.ok(r.riskRemoved > 0.75);
});

test("a hedge account that is too small: the margin guard keeps it from being liquidated, and says so", async () => {
  const s = scenarios.find(x => x.name === "squeeze")!;
  const guarded = await run("squeeze");
  const bare = await simulate({ ...s, tune: c => { c.deleverageLiqDistanceBps = 0; } });
  assert.equal(guarded.liquidations, 0);
  assert.deepEqual(guarded.halts, []);
  assert.ok(guarded.minLiqDistanceBps! >= 400);
  assert.equal(bare.liquidations, 1);
  assert.equal(bare.halts.length, 1);
  assert.ok(guarded.riskRemoved > bare.riskRemoved);
  // It does not make a small account large: most of it is lost either way, and it is an emergency.
  assert.ok(guarded.states.EMERGENCY > 0.3);
  assert.ok(guarded.hedgePnlE6 < -2_000n * USD && bare.hedgePnlE6 < -2_000n * USD);
});
