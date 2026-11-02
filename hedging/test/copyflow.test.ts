import assert from "node:assert/strict";
import { test } from "node:test";
import { Market, Scenario, makeFlow, minutePrices, runStrategy } from "../src/copyflow";

// A small market: a slow sine wave plus a trend, 6 days of 5-minute candles.
const market = (coin: "BTC" | "ETH" | "SOL", base: number): Market => {
  const candles: Market["candles"] = [];
  let p = base;
  for (let i = 0; i < 1_728; i++) {
    const o = p;
    p = base * (1 + 0.03 * Math.sin(i / 40) + i * 0.00002);
    candles.push([1_700_000_000_000 + i * 300_000, o, Math.max(o, p) * 1.0005, Math.min(o, p) * 0.9995, p]);
  }
  return { coin, candles, funding: candles.filter((_, i) => i % 12 === 0).map(c => [c[0], 0.00001]) };
};
const markets = [market("BTC", 80_000), market("ETH", 2_400), market("SOL", 100)];
const scenario: Scenario = { name: "t", about: "", feeBps: 5, leaders: [{ name: "good", skill: 0.9, copyUsd: 30_000 }, { name: "bad", skill: 0.1, copyUsd: 30_000 }] };

test("minute prices keep each candle's open, extremes and close", () => {
  const { t, px } = minutePrices({ coin: "BTC", candles: [[0, 10, 12, 9, 11]], funding: [] });
  assert.deepEqual(t, [0, 60_000, 120_000, 180_000, 240_000]);
  assert.deepEqual(px, [10, 9, 10.5, 12, 11]);
});

test("the trades are the same for the same seed, and the vault never passes its limit", () => {
  // Copies bigger than the vault's limit, so the limit is tested.
  const big = { ...scenario, leaders: scenario.leaders.map(l => ({ ...l, copyUsd: 100_000 })) };
  const a = makeFlow(markets, big, 3), b = makeFlow(markets, big, 3);
  assert.deepEqual(a.vaultPnl, b.vaultPnl);
  assert.ok(a.trades.leaders.every(n => n > 3), "leaders traded");
  // New trades stop at $75,000 (closing trades always go through, and prices move after).
  assert.ok(a.maxAfterOpenUsd <= 75_000 + 1e-6 && a.maxAfterOpenUsd > 70_000, `${a.maxAfterOpenUsd}`);
  assert.ok(a.refusedUsd > 0, "the limit was reached at least once");
  assert.ok(a.traderPnl.leaders[0] > 0 && a.traderPnl.leaders[1] < 0, "skill decides who wins");
  // Depositors keep 80% of a 5 bps fee on every dollar traded.
  const last = a.steps - 1;
  assert.ok(Math.abs(a.feeIncome[last] - (a.volume.crowd + a.volume.copy) * 0.0005 * 0.8) < 1e-6);
});

test("only a winning record is hedged by the smart strategy", () => {
  const f = makeFlow(markets, scenario, 3);
  const last = f.winning[f.steps - 1];
  assert.equal(last[0], 1, "the good leader is recognised");
  assert.equal(last[1], 0, "the bad one is not");
  assert.equal(f.winning[0][0], 0, "nobody is trusted before they have a record");
});

test("hedging the good leader's copiers pays when their edge beats the hedge's cost", async () => {
  const f = makeFlow(markets, { ...scenario, leaders: [scenario.leaders[0]] }, 5);
  const none = await runStrategy(markets, f, "none");
  const copy = await runStrategy(markets, f, "copy", { operatorFeeBps: 0 });
  assert.ok(copy.ledgerMatchesVenue && copy.liquidations === 0);
  assert.equal(none.hedgePnlUsd, 0);
  assert.ok(copy.hedgePnlUsd > 0, `hedge made ${copy.hedgePnlUsd}`);
  assert.ok(copy.depositorsUsd > none.depositorsUsd);
  // Without a hedge nothing the vault holds is offset.
  assert.ok(copy.maxOpenUsd < none.maxOpenUsd);
});
