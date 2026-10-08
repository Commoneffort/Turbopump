// The coordinator as a state machine: what state each symbol is in as things go right and wrong,
// and what the engine does differently in each.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TickReport } from "../src/engine";
import { USD } from "../src/units";
import { P, T, world } from "./helpers";

const sol = (r: TickReport | null) => r!.symbols.find(s => s.symbol === "SOL")!;
const state = (r: TickReport | null) => sol(r).state;
const flatBtc = (w: ReturnType<typeof world>) => w.set("BTC", 60_000n * USD, 0n);

test("states: a hedge goes NORMAL -> HEDGE_REQUIRED -> HEDGED, and each change is reported once", async () => {
  const w = world();
  flatBtc(w);
  w.set("SOL", P, 0n);
  let r = await w.tick();
  assert.equal(state(r), "NORMAL");
  assert.deepEqual(r!.transitions.map(t => [t.scope, t.from, t.to]), [["SOL", undefined, "NORMAL"], ["BTC", undefined, "NORMAL"], ["*", undefined, "NORMAL"]]);
  assert.deepEqual((await w.tick())!.transitions, []);

  w.set("SOL", P, T(-100)); // $15,000: more than one order
  r = await w.tick();
  assert.equal(state(r), "HEDGE_REQUIRED");
  assert.match(sol(r).stateReason, /\$5001\.00 open/);
  assert.deepEqual(r!.transitions.map(t => [t.scope, t.from, t.to]), [["SOL", "NORMAL", "HEDGE_REQUIRED"], ["*", "NORMAL", "HEDGE_REQUIRED"]]);
  r = await w.settle();
  assert.equal(state(r), "HEDGED");
  assert.equal(r!.state, "HEDGED");
});

test("states: a thin book leaves PARTIALLY_FILLED, and the rest is sent on later passes", async () => {
  const w = world(undefined, { depthE6: 3_000n * USD });
  w.set("SOL", P, T(-50)); // $7,500 wanted, $3,000 fills per order
  const r = await w.tick();
  assert.equal(w.venue.position("SOL"), T(19.99)); // $3,000 at the price paid
  assert.equal(state(r), "PARTIALLY_FILLED");
  assert.match(sol(r).stateReason, /filled in part/);
  assert.equal(state(await w.settle()), "HEDGED");
  assert.equal(w.venue.position("SOL"), T(50));
  assert.equal(w.venue.received, 3);
});

test("states: an order whose fills are not visible yet is SUBMITTING, then UNKNOWN, and nothing else is sent", async () => {
  const w = world();
  w.set("SOL", P, T(-40));
  w.venue.faults.hideFillsMs = 10 * 60_000;
  let r = await w.tick();
  assert.equal(state(r), "SUBMITTING");
  w.venue.faults = {};
  w.clock.advance(30_000);
  assert.equal(state(await w.tick()), "SUBMITTING");
  w.clock.advance(60_000); // past lostAfterMs
  r = await w.tick();
  assert.equal(state(r), "EMERGENCY"); // the venue says filled, its history does not: halted
  assert.match(sol(r).stateReason, /halted/);
  assert.equal(w.venue.received, 1);
});

test("states: a lost reply is UNKNOWN until the venue's records settle it", async () => {
  const w = world();
  w.set("SOL", P, T(-40));
  w.venue.faults.drop = true; // never arrives; the engine cannot tell
  let r = await w.tick();
  assert.equal(state(r), "UNKNOWN");
  assert.match(sol(r).stateReason, /outcome of order .* is not known/);
  w.venue.faults = {};
  w.clock.advance(30_000);
  assert.equal(state(await w.tick()), "UNKNOWN");
  assert.equal(w.venue.received, 0);
  w.clock.advance(60_000); // given up on: sent anew, under a new id
  w.set("SOL", P, T(-40));
  r = await w.tick();
  assert.equal(w.venue.position("SOL"), T(40));
  assert.equal(state(r), "HEDGED");
});

test("states: an unreachable venue is UNKNOWN for every symbol, and the risk is still reported", async () => {
  const w = world();
  flatBtc(w);
  w.set("SOL", P, T(-40));
  await w.settle();
  w.set("SOL", P, T(-90));
  w.venue.faults.down = true;
  const r = await w.tick();
  assert.deepEqual(r!.symbols.map(s => s.state), ["UNKNOWN", "UNKNOWN"]);
  assert.equal(r!.state, "UNKNOWN");
  assert.equal(r!.risk.account, undefined);
  const s = r!.risk.symbols[0];
  assert.equal(s.vaultQ, T(-90));
  assert.equal(s.hedgeQ, T(40)); // what the ledger last confirmed
  assert.equal(s.residualE6, -7_500n * USD);
  w.venue.faults = {};
  assert.equal(state(await w.settle()), "HEDGED");
});

test("states: failed vault reads are STALE; the hedge is kept, not closed", async () => {
  const w = world();
  w.set("SOL", P, T(-40));
  await w.settle();
  w.source.fail = true;
  w.clock.advance(120_000);
  const r = await w.tick();
  assert.equal(state(r), "STALE");
  assert.equal(w.venue.position("SOL"), T(40));
});

test("states: a symbol no vault trades stays NORMAL through a failed read", async () => {
  const w = world();
  w.set("SOL", P, T(-40)); // BTC is configured, and has no vault
  await w.settle();
  const btc = (r: any) => r.symbols.find((x: any) => x.symbol === "BTC").state;
  assert.equal(btc(await w.tick()), "NORMAL");
  w.source.fail = true;
  w.clock.advance(120_000);
  const r = await w.tick();
  assert.equal(state(r), "STALE");   // SOL has a vault, and its reading is old
  assert.equal(btc(r), "NORMAL");    // nothing to read for BTC: not an alert
});

test("states: refused orders back off, then FAILED; one fill clears it", async () => {
  const w = world();
  w.set("SOL", P, T(-40));
  w.venue.faults.reject = "rate limited";
  const sent: number[] = [];
  let r: TickReport | null = null;
  const t0 = w.clock.now();
  for (let i = 0; i < 60; i++) { // 20 minutes of passes
    r = await w.tick();
    if (sol(r).sent) sent.push((w.clock.now() - t0) / 1000);
    if (sent.length === 1) assert.equal(state(r), sol(r).sent ? "HEDGE_REQUIRED" : "DEGRADED");
    w.clock.advance(20_000);
    w.venue.setMid("SOL", P); w.source.slot += 25;
  }
  // Waits of 20 s doubled each time (40, 80, 160, 320), then the 10-minute ceiling.
  assert.deepEqual(sent, [0, 40, 120, 280, 600]);
  assert.equal(state(r), "FAILED");
  assert.match(sol(r).stateReason, /5 orders in a row traded nothing \(the last: rejected\)/);
  assert.equal(r!.state, "FAILED");
  assert.equal(w.journal.ledger.halts.size, 0);

  w.restart(); // the count is in the journal
  assert.equal(w.journal.ledger.failures.get("SOL"), 5);
  w.venue.faults = {};
  w.clock.advance(600_000);
  r = await w.settle();
  assert.equal(state(r), "HEDGED");
  assert.equal(w.journal.ledger.failures.get("SOL"), undefined);
});

test("states: limits that keep the hedge short are DEGRADED, and say which", async () => {
  const w = world(c => { c.symbols.SOL.maxHedgeE6 = 3_000n * USD; });
  w.set("SOL", P, T(-100));
  let r = await w.settle();
  assert.equal(w.venue.position("SOL"), T(20));
  assert.equal(state(r), "DEGRADED");
  assert.match(sol(r).stateReason, /past the limit of \$10000\.00/); // $12,000 open

  const thin = world(undefined, { equityE6: 900n * USD });
  thin.set("SOL", P, T(-40));
  r = await thin.settle();
  assert.equal(state(r), "DEGRADED");
  assert.match(sol(r).stateReason, /not enough free margin/);
});

test("states: too much open for too long is an EMERGENCY; hedging goes on", async () => {
  const w = world(c => { c.symbols.SOL.maxHedgeE6 = 3_000n * USD; c.unhedgedAlarmMs = 120_000; });
  w.set("SOL", P, T(-100));
  assert.equal(state(await w.settle()), "DEGRADED");
  w.clock.advance(120_000);
  const r = await w.tick();
  assert.equal(state(r), "EMERGENCY");
  assert.match(sol(r).stateReason, /\$12000\.00 has been open for \d+ s, past the limit of \$10000\.00/);
  assert.equal(w.journal.ledger.halts.size, 0);
  w.set("SOL", P, T(-20));
  assert.equal(state(await w.settle()), "HEDGED");
});

test("margin guard: a hedge the account can no longer carry is cut before the venue liquidates it", async () => {
  const run = async (guard: boolean) => {
    const w = world(c => { if (!guard) c.deleverageLiqDistanceBps = 0; }, { equityE6: 4_000n * USD });
    w.set("SOL", P, T(100)); // the vault is long $15,000; the hedge is short
    await w.settle();
    assert.equal(w.venue.position("SOL"), T(-100));
    const states: string[] = [];
    // The price climbs 2% a pass against the short hedge.
    let px = P;
    for (let i = 0; i < 12; i++) {
      px = px * 102n / 100n;
      w.clock.advance(30_000);
      w.set("SOL", px, T(100));
      const r = await w.tick();
      if (!states.includes(sol(r).state)) states.push(sol(r).state);
    }
    return { w, states };
  };

  const off = await run(false);
  assert.equal(off.w.venue.liquidations, 1);
  assert.equal(off.w.venue.position("SOL"), 0n);
  assert.match(off.w.journal.ledger.halted("SOL")!, /was not placed by this engine/);
  assert.deepEqual(off.states, ["HEDGED", "DEGRADED", "EMERGENCY"]);

  const on = await run(true);
  assert.equal(on.w.venue.liquidations, 0);
  assert.equal(on.w.journal.ledger.halts.size, 0);
  assert.ok(on.w.venue.position("SOL") < 0n && on.w.venue.position("SOL") > T(-100));
  assert.ok(on.states.includes("EMERGENCY"));
  // Every cut was a reduce-only order, and the account kept more of its money.
  const cuts = [...on.w.journal.ledger.intents.values()].filter(i => i.side === "buy");
  assert.ok(cuts.length > 0 && cuts.every(i => i.reduceOnly));
  assert.ok(on.w.venue.equity() > off.w.venue.equity());
  const a = (await on.w.tick())!.risk.account!;
  assert.ok(a.liqDistanceBps! >= 500);
});

test("margin guard: the hedge is cut even when the vault cannot be read", async () => {
  const w = world(undefined, { equityE6: 4_000n * USD });
  w.set("SOL", P, T(100));
  await w.settle();
  w.source.fail = true;
  w.clock.advance(120_000);
  w.venue.setMid("SOL", P * 117n / 100n);
  const r = await w.tick();
  assert.equal(state(r), "EMERGENCY");
  assert.ok(sol(r).sent);
  assert.ok(w.venue.position("SOL") > T(-100));
  assert.equal(w.venue.liquidations, 0);
});

test("a crash at any journal write leaves the same states as no crash", async () => {
  const script = async (crashOn?: number) => {
    const w = world(undefined, { depthE6: 4_000n * USD });
    flatBtc(w);
    if (crashOn) w.crashOnWrite = { n: crashOn, when: crashOn % 2 ? "before" : "after" };
    w.set("SOL", P, T(-60));
    await w.settle();
    w.venue.fund("SOL", 500_000n);
    w.set("SOL", P, T(25));
    const r = await w.settle();
    return { w, r };
  };
  const clean = await script();
  const writes = clean.w.writes;
  assert.ok(writes > 10);
  for (let n = 1; n <= writes; n++) {
    const { w, r } = await script(n);
    assert.equal(w.venue.position("SOL"), T(-25), `crash at write ${n}`);
    assert.equal(w.journal.ledger.position("SOL"), T(-25));
    assert.equal(r!.state, "HEDGED", `crash at write ${n}`);
    assert.equal(w.journal.ledger.halts.size, 0);
    assert.equal(r!.risk.account!.unexplainedE6, 0n, `crash at write ${n}`);
    assert.equal(r!.risk.totals.hedgePnlE6, clean.r!.risk.totals.hedgePnlE6 , `crash at write ${n}`);
    assert.equal(w.venue.received, clean.w.venue.received);
  }
});
