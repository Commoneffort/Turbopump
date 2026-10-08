import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config";
import { marginState } from "../src/risk";
import { classify, StateInput } from "../src/state";
import { USD } from "../src/units";
import { P, T, world } from "./helpers";

const sol = (r: any) => r.risk.symbols.find((s: any) => s.symbol === "SOL");
const D = (n: number) => BigInt(Math.round(n * 1e6));

test("risk: the chain from the vault's position to what is left open", async () => {
  const w = world(c => { c.symbols.SOL.hedgeRatioBps = 8_000; });
  w.set("SOL", P, T(-100)); // $15,000 short; 80% of it is to be hedged
  const first = sol(await w.tick());
  assert.equal(first.vaultNotionalE6, -15_000n * USD);
  assert.equal(first.targetExposureE6, -3_000n * USD);   // the 20% the vault keeps
  assert.equal(first.requiredHedgeQ, T(80));
  assert.equal(first.hedgeQ, T(66.66));                  // one order, capped at $10,000
  assert.equal(first.retainedE6, -(T(33.34) * P) / 1_000_000n);
  assert.equal(first.residualE6, -(T(13.34) * P) / 1_000_000n);
  assert.equal(first.hedgeRatioBps, 6_666);

  const r = (await w.settle())!;
  const s = sol(r);
  assert.equal(s.hedgeQ, T(80));
  assert.equal(s.residualE6, 0n);
  assert.equal(s.retainedE6, s.targetExposureE6);
  assert.equal(s.hedgeRatioBps, 8_000);
  assert.equal(s.stressLossE6, 300n * USD);              // 10% against the $3,000 kept
  assert.equal(r.risk.totals.retainedShareBps, 2_000);
  assert.equal(r.risk.totals.stressLossE6, 300n * USD);
});

test("risk: the hedge's result splits into open, closed, fees, funding and slippage, and adds up to the account", async () => {
  const w = world();
  const equity0 = w.venue.equity();
  w.set("SOL", P, T(-40));
  await w.settle();
  w.set("SOL", 165_000_000n, T(-40)); // +10%: the long hedge gains
  w.venue.fund("SOL", 1_000_000n);    // longs pay 0.1%
  let r = (await w.settle())!;
  let s = sol(r);
  // Bought 40 at $150 plus half the 2 bps spread; now worth $165.
  assert.equal(s.slippageE6, D(40 * 150 * 0.0001));
  assert.equal(s.unrealizedE6, D(40 * 15 - 0.6));
  assert.equal(s.realizedE6, 0n);
  assert.equal(s.feesE6, D(40 * 150.015 * 0.0005));
  assert.equal(s.fundingE6, D(40 * 165 * 0.001));
  assert.equal(s.pnlE6, w.venue.equity() - equity0);
  assert.equal(r.risk.account!.unexplainedE6, 0n);

  w.set("SOL", 165_000_000n, T(-10)); // the vault shrinks: 30 of the hedge is sold
  r = (await w.settle())!;
  s = sol(r);
  assert.equal(s.hedgeQ, T(10));
  assert.equal(s.realizedE6 + s.unrealizedE6 - s.feesE6 - s.fundingE6, w.venue.equity() - equity0);
  assert.ok(s.realizedE6 > 440n * USD && s.realizedE6 < 450n * USD); // 30 x ~$15
  assert.equal(r.risk.totals.hedgePnlE6, w.venue.equity() - equity0);
});

test("risk: the ledger's result survives a restart", async () => {
  const w = world();
  w.set("SOL", P, T(-40));
  await w.settle();
  w.venue.fund("SOL", 1_000_000n);
  w.set("SOL", 140_000_000n, T(-15));
  const before = sol((await w.settle())!);
  w.restart();
  const after = sol((await w.settle())!);
  for (const k of ["unrealizedE6", "realizedE6", "feesE6", "fundingE6", "slippageE6", "pnlE6", "hedgeQ"]) assert.equal(after[k], before[k], k);
});

test("risk: money moved into the hedge account is reported, not mistaken for a gain", async () => {
  const w = world();
  w.set("SOL", P, T(-40));
  w.set("BTC", 60_000n * USD, 0n);
  let r = (await w.settle())!;
  assert.equal(r.risk.account!.unexplainedE6, 0n);
  assert.equal(r.state, "HEDGED");
  w.venue.seed(new Map([["SOL", T(40)]]), 70_000n * USD, null); // a deposit behind the engine's back
  r = (await w.settle())!;
  assert.ok(r.risk.account!.unexplainedE6! > 19_000n * USD);
  assert.equal(sol(r).pnlE6 < 0n, true); // the hedge's own result is unchanged: just its costs
  // One pass may be a price that moved between two readings; a difference that is still there
  // on the next pass is reported.
  w.clock.advance(10_000);
  r = (await w.tick())!;
  assert.equal(r.state, "DEGRADED");
  assert.match(r.stateReason, /more than the ledger explains/);
});

test("risk: margin, room for more hedge, and the distance to liquidation", async () => {
  const w = world(undefined, { equityE6: 5_000n * USD });
  w.set("SOL", P, T(-100));
  const r = (await w.settle())!;
  const a = r.risk.account!;
  // The mock asks 10% margin and liquidates at 5%; the policy only opens what 20% covers.
  assert.equal(a.grossE6, sol(r).hedgeNotionalE6);
  assert.equal(a.marginUsedE6, a.grossE6 / 10n);
  assert.equal(a.maintenanceE6, a.grossE6 / 20n);
  assert.equal(a.liqDistanceBps, Number((a.equityE6 - a.maintenanceE6) * 10_000n / a.grossE6));
  assert.ok(a.liqDistanceBps! > 1_500);
  assert.equal(a.mode, "ok");
  assert.equal(a.availableHedgeE6, (a.freeMarginE6 - 500n * USD) * 5n);
  // A long hedge is closed out if the price falls by that distance.
  const s = sol(r);
  assert.equal(s.liqPriceE6, P - (a.equityE6 - a.maintenanceE6) * 1_000_000n / s.hedgeQ);
});

test("margin: between the two thresholds the hedge may shrink but not grow", async () => {
  const cfg = defaultConfig(["SOL"]);
  const acct = (equity: number, gross: number) => ({ equityE6: D(equity), freeMarginE6: 0n, marginUsedE6: D(gross / 10), maintenanceE6: D(gross / 20) });
  assert.deepEqual(marginState(acct(5_000, 0), 0n, cfg, false), { grossE6: 0n, mode: "ok" });
  assert.equal(marginState(acct(2_000, 10_000), D(10_000), cfg, false).mode, "ok");          // 15% away
  assert.equal(marginState(acct(1_400, 10_000), D(10_000), cfg, false).mode, "no_increase"); // 9%
  const cut = marginState(acct(900, 10_000), D(10_000), cfg, false);                         // 4%
  assert.equal(cut.mode, "deleverage");
  // Kept: equity / (10% + 5%) = $6,000 of the $10,000.
  assert.equal(cut.keepBps, 6_000);
  // Cutting, once begun, goes on until the minimum is restored.
  assert.equal(marginState(acct(1_200, 8_500), D(8_500), cfg, true).mode, "deleverage");   // 9.1%
  assert.equal(marginState(acct(1_200, 8_500), D(8_500), cfg, false).mode, "no_increase");
  assert.equal(marginState(acct(1_240, 8_500), D(8_500), cfg, true).mode, "no_increase");  // 9.6%: restored
  cfg.deleverageLiqDistanceBps = 0;
  assert.equal(marginState(acct(900, 10_000), D(10_000), cfg, false).mode, "no_increase");
});

const base: StateInput = {
  nowMs: 1_000_000, enabled: true, hedgeQ: 0n, decision: { action: "hold", code: "on_target", reason: "on target" },
  failures: 0, maxFailures: 3, lostAfterMs: 60_000, margin: "ok", residualE6: 0n, bandE6: 250n * USD, maxUnhedgedE6: 10_000n * USD,
  outsideBandMs: 0, overLimitMs: 0, alarmMs: 300_000,
};
const intent = (o: object) => ({ id: "0xabc", symbol: "SOL", side: "buy" as const, sizeQ: T(10), limitE6: P, reduceOnly: false, ts: 990_000, status: "pending" as const, filledQ: 0n, ...o });
const st = (o: Partial<StateInput>) => classify({ ...base, ...o }).state;

test("states: every state is reached from the facts that define it", () => {
  assert.equal(st({}), "NORMAL");
  assert.equal(st({ hedgeQ: T(5) }), "HEDGED");
  assert.equal(st({ enabled: false }), "OFF");
  assert.equal(st({ enabled: false, hedgeQ: T(5), residualE6: 9_999n * USD }), "CLOSING");
  assert.equal(st({ residualE6: 900n * USD, decision: { action: "hold", code: "gap", reason: "waiting between orders" } }), "HEDGE_REQUIRED");
  assert.equal(st({ residualE6: -900n * USD, decision: { action: "order", side: "buy", sizeQ: T(1), limitE6: P, reduceOnly: false, targetQ: T(6) }, last: intent({ status: "cancelled", filledQ: T(4) }) }), "PARTIALLY_FILLED");
  assert.equal(st({ pending: intent({}) }), "SUBMITTING");
  assert.equal(st({ pending: intent({ status: "in_doubt" }) }), "UNKNOWN");
  assert.equal(st({ pending: intent({ ts: 900_000 }) }), "UNKNOWN");
  assert.equal(st({ venueError: "venue unreachable" }), "UNKNOWN");
  assert.equal(st({ decision: { action: "hold", code: "old_reading", reason: "vault reading is too old" } }), "STALE");
  assert.equal(st({ hedgeQ: T(5), decision: { action: "hold", code: "no_quote", reason: "no venue quote" } }), "STALE");
  assert.equal(st({ decision: { action: "hold", code: "margin", reason: "not enough free margin at the venue" } }), "DEGRADED");
  assert.equal(st({ hedgeQ: T(5), margin: "no_increase" }), "DEGRADED");
  assert.equal(st({ residualE6: 900n * USD }), "DEGRADED"); // on target by the limits, yet open
  assert.equal(st({ residualE6: 900n * USD, outsideBandMs: 300_000, decision: { action: "hold", code: "gap", reason: "" } }), "DEGRADED");
  assert.equal(st({ residualE6: 12_000n * USD, decision: { action: "hold", code: "gap", reason: "" } }), "DEGRADED");
  assert.equal(st({ failures: 3 }), "FAILED");
  assert.equal(st({ residualE6: 12_000n * USD, overLimitMs: 300_000 }), "EMERGENCY");
  assert.equal(st({ margin: "deleverage" }), "EMERGENCY");
  assert.equal(st({ halt: "position mismatch" }), "EMERGENCY");
  // A configured symbol that no vault trades is not a stale reading.
  const none = { action: "hold" as const, code: "no_reading" as const, reason: "no reading of the vault yet" };
  assert.equal(st({ decision: none, residualE6: undefined }), "STALE");
  assert.equal(st({ decision: none, residualE6: undefined, noVault: true }), "NORMAL");
  assert.equal(st({ decision: none, residualE6: undefined, noVault: true, hedgeQ: T(1) }), "STALE");
  // Nor is a flat vault with no hedge whose venue market has no price.
  const quote = { action: "hold" as const, code: "no_quote" as const, reason: "no venue quote" };
  assert.equal(st({ decision: quote }), "NORMAL");
  assert.equal(st({ decision: quote, residualE6: 900n * USD }), "STALE");
  assert.equal(st({ decision: quote, hedgeQ: T(1) }), "STALE");
});

test("states: the worse condition wins", () => {
  assert.equal(st({ halt: "x", venueError: "y", failures: 9 }), "EMERGENCY");
  assert.equal(st({ venueError: "y", failures: 9, margin: "deleverage" }), "UNKNOWN");
  assert.equal(st({ failures: 9, decision: { action: "hold", code: "old_reading", reason: "" } }), "FAILED");
  assert.equal(st({ enabled: false, failures: 3, hedgeQ: T(1) }), "FAILED");
  // A switched-off symbol is not stale, and not alarmed about what it leaves open.
  assert.equal(st({ enabled: false, residualE6: 50_000n * USD, overLimitMs: 900_000 }), "OFF");
});
