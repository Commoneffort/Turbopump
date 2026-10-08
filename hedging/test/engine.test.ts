import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "fs";
import * as path from "path";
import { SWITCH_FILE, readSwitchFile, writeSwitches } from "../src/engine";
import { readJournal } from "../src/journal";
import { defaultConfig } from "../src/config";
import { mockDefaults } from "../src/simulator";
import { tmpDir } from "./helpers";
import { adopt, resume } from "../src/reconcile";
import { World } from "../src/simulator";
import { USD } from "../src/units";
import { P, T, world } from "./helpers";

const hold = (r: Awaited<ReturnType<World["tick"]>>, symbol = "SOL") => {
  const d = r!.symbols.find(s => s.symbol === symbol)!.decision;
  return d.action === "hold" ? d.reason : `order ${d.side}`;
};
/** The ledger and the venue agree, and every order the venue got was journaled first. */
const consistent = (w: World) => {
  const L = w.journal.ledger;
  for (const s of ["SOL", "BTC"]) assert.equal(L.position(s), w.venue.position(s), `${s}: ledger = venue`);
  assert.ok(w.venue.received <= L.intents.size);
};

test("hedges a short vault with a long, in orders no larger than the cap", async () => {
  const w = world();
  w.set("SOL", P, T(-100)); // $15,000 short
  const r = await w.tick();
  assert.equal(r!.symbols[0].sent !== undefined, true);
  assert.equal(w.venue.position("SOL"), T(66.66)); // $10,000 order cap
  assert.equal(hold(await w.tick()), "waiting between orders");
  assert.ok(await w.settle());
  assert.equal(w.venue.position("SOL"), T(100));
  assert.equal(w.venue.received, 2);
  consistent(w);
  const types = readJournal(w.dir).entries.map(e => e.type);
  assert.deepEqual(types, ["open", "switch", "intent", "fill", "order", "baseline", "intent", "fill", "order"]);
});

test("follows the vault: shrinks, closes, and takes the other side", async () => {
  const w = world();
  w.set("SOL", P, T(-40));
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(40));
  w.set("SOL", P, T(-10));
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(10));
  w.set("SOL", P, T(25));
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(-25));
  w.set("SOL", P, 0n);
  await w.settle();
  assert.equal(w.venue.position("SOL"), 0n);
  consistent(w);
  assert.equal(w.journal.ledger.halts.size, 0);
});

test("reports what the hedge leaves open", async () => {
  const w = world();
  w.set("SOL", P, T(-100));
  const r = await w.tick();
  // 100 short against 66.66 long: $5,001 of the vault's short is not hedged yet.
  assert.equal(r!.symbols[0].residualE6, -(T(33.34) * P) / 1_000_000n);
  assert.equal((await w.settle())!.symbols[0].residualE6, 0n);
});

test("positions on symbols with no hedge market are reported, not hedged", async () => {
  const w = world();
  w.set("XAU", 2_000n * USD, T(3));
  const r = await w.tick();
  assert.deepEqual(r!.unhedged, [{ symbol: "XAU", notionalE6: 6_000n * USD }]);
  assert.equal(w.venue.received, 0);
});

test("it hedges what the vault holds, not what its matcher tracks", async () => {
  const w = world();
  w.set("SOL", P, T(-30));
  w.source.vaults.get("SOL")!.trackedQ = T(-50); // a close-out on the other side, not synced yet
  const r = await w.tick();
  assert.equal(w.venue.position("SOL"), T(30));
  assert.match(r!.symbols[0].exposure!.notes[0], /SyncInventory pending/);
});

test("a crash at any journal write never loses or repeats an order", async () => {
  // Reference run, to count the journal writes.
  const ref = world();
  ref.set("SOL", P, T(-100));
  await ref.settle();
  const writes = ref.writes;
  assert.ok(writes >= 8);
  // Writes 1 and 2 open the journal and switch hedging on; every later one is the engine's.
  for (let n = 3; n <= writes; n++) {
    for (const when of ["before", "after"] as const) {
      const w = world();
      w.crashOnWrite = { n, when };
      w.set("SOL", P, T(-100));
      assert.ok(await w.settle(), `settles after a crash ${when} write ${n}`);
      assert.equal(w.restarts, 1);
      assert.equal(w.venue.position("SOL"), T(100), `crash ${when} write ${n}`);
      assert.equal(w.journal.ledger.halts.size, 0);
      // Two orders reach the venue, as without a crash.
      assert.equal(w.venue.received, 2, `crash ${when} write ${n}`);
      consistent(w);
    }
  }
});

test("a reply lost after the order executed: the fill is found, nothing is re-sent", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  w.venue.faults.loseReply = true;
  await w.tick();
  w.venue.faults = {};
  assert.equal(w.venue.position("SOL"), T(20));
  const [it] = w.journal.ledger.intents.values();
  assert.equal(it.status, "filled");
  assert.ok(readJournal(w.dir).entries.some(e => e.type === "in_doubt"));
  await w.settle();
  assert.equal(w.venue.received, 1);
  consistent(w);
});

test("an order that never arrived blocks the symbol, then is given up on and replaced", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  w.venue.faults.drop = true;
  await w.tick();
  w.venue.faults = {};
  assert.equal(w.venue.received, 0);
  w.clock.advance(30_000);
  w.source.slot += 75;
  w.venue.setMid("SOL", P);
  assert.match(hold(await w.tick()), /is unresolved/);
  assert.equal(w.venue.received, 0);
  await w.settle();
  assert.deepEqual([...w.journal.ledger.intents.values()].map(i => i.status), ["lost", "filled"]);
  assert.equal(w.venue.position("SOL"), T(20));
  consistent(w);
});

test("an order that arrives after it was given up on is still accounted for", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  w.venue.faults.delayMs = 150_000; // longer than lostAfterMs
  await w.tick();
  w.venue.faults = {};
  for (let i = 0; i < 4; i++) { w.clock.advance(30_000); w.source.slot += 75; w.venue.setMid("SOL", P); await w.tick(); }
  // Given up on and replaced; the hedge is on target.
  assert.equal(w.venue.position("SOL"), T(20));
  w.clock.advance(60_000);
  w.source.slot += 150;
  w.venue.setMid("SOL", P);
  // The late order lands: 40 long against 20 short. Its fill is read into the ledger, and the
  // excess is sold on the same pass.
  await w.tick();
  assert.equal(w.venue.received, 3);
  assert.deepEqual([...w.journal.ledger.intents.values()].map(i => [i.side, i.status, i.filledQ, i.reduceOnly]),
    [["buy", "lost", T(20), false], ["buy", "filled", T(20), false], ["sell", "filled", T(20), true]]);
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(20));
  assert.equal(w.journal.ledger.halts.size, 0);
  consistent(w);
});

test("fills that show up late hold the symbol until they are seen", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  w.venue.faults.hideFillsMs = 45_000;
  const r = await w.tick();
  w.venue.faults = {};
  assert.equal(w.venue.position("SOL"), T(20));
  assert.equal(w.journal.ledger.position("SOL"), 0n);
  assert.equal(r!.symbols[0].hedgeQ, 0n);
  w.clock.advance(30_000);
  w.source.slot += 75;
  w.venue.setMid("SOL", P);
  assert.match(hold(await w.tick()), /is unresolved/);
  await w.settle();
  assert.equal(w.venue.received, 1);
  assert.equal(w.journal.ledger.halts.size, 0);
  consistent(w);
});

test("a refused order changes nothing and is retried later", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  w.venue.faults.reject = "rate limited";
  await w.tick();
  w.venue.faults = {};
  assert.equal(w.venue.position("SOL"), 0n);
  assert.equal([...w.journal.ledger.intents.values()][0].status, "rejected");
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(20));
  consistent(w);
});

test("a thin book fills part of an order; the rest follows", async () => {
  const w = world(undefined, { depthE6: 2_000n * USD });
  w.set("SOL", P, T(-40)); // $6,000
  await w.tick();
  assert.ok(w.venue.position("SOL") > 0n && w.venue.position("SOL") < T(40));
  assert.equal([...w.journal.ledger.intents.values()][0].status, "cancelled");
  const r = await w.settle();
  // Whole lots of what the book offers: the last cent's worth stays inside the band.
  assert.equal(w.venue.position("SOL"), T(39.99));
  assert.equal(hold(r), "within band");
  assert.ok(w.venue.received >= 3);
  consistent(w);
});

test("no order while the venue cannot be reached", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  w.venue.faults.down = true;
  const r = await w.tick();
  assert.equal(r!.venueError, "venue unreachable");
  assert.equal(w.journal.ledger.intents.size, 0);
  w.venue.faults = {};
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(20));
});

test("no order on a vault reading that is old, stuck, or incomplete", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  await w.settle();
  const step = async () => { w.clock.advance(35_000); w.venue.setMid("SOL", P); return w.tick(); };
  // Reads fail: the last reading is used until it is too old.
  w.source.vaults.set("SOL", { positionQ: T(-80), priceE6: P });
  w.source.fail = true;
  let r = await step();
  assert.match(r!.readError!, /read failed/);
  assert.equal(hold(r), "on target");
  assert.equal(hold(await step()), "vault reading is too old");
  // The RPC node answers but has stopped following the chain.
  w.source.fail = false;
  w.source.stuck = true;
  assert.equal(hold(await step()), "vault reading is too old");
  assert.equal(w.venue.position("SOL"), T(20));
  // A read older than one already seen is ignored.
  w.source.stuck = false;
  w.source.slot -= 10;
  r = await step();
  assert.match(r!.readError!, /older than the previous one/);
  // Back to normal.
  w.source.slot += 500;
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(80));
  // A vault that disappears from the reads is not taken to be flat.
  w.source.vaults.delete("SOL");
  w.source.slot += 25;
  assert.match(hold(await step()), /vault-SOL is missing from the read/);
  assert.equal(w.venue.position("SOL"), T(80));
});

test("no order when the venue's price is far from Percolator's", async () => {
  const w = world();
  w.set("SOL", P, T(-20), P * 103n / 100n);
  assert.equal(hold(await w.tick()), "venue price is too far from Percolator's");
});

test("a trade the engine did not place halts that symbol only", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  w.set("BTC", 60_000n * USD, T(-0.2));
  await w.settle();
  w.venue.externalTrade("SOL", "sell", T(5));
  w.set("BTC", 60_000n * USD, T(-0.3));
  w.set("SOL", P, T(-40));
  await w.settle();
  const L = w.journal.ledger;
  assert.match(L.halted("SOL")!, /was not placed by this engine/);
  assert.equal(L.position("SOL"), T(15)); // the ledger still follows the venue
  assert.equal(w.venue.position("SOL"), T(15));
  assert.equal(w.venue.position("BTC"), T(0.3));
  // The halt survives a restart, and lifts only when an operator says so.
  w.restart();
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(15));
  resume(w.journal, "SOL", "test");
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(40));
  consistent(w);
});

test("a position the fill history does not explain halts the symbol until adopted", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  await w.settle();
  w.venue.forcePosition("SOL", T(12));
  await w.settle();
  const L = w.journal.ledger;
  assert.match(L.halted("SOL")!, /position mismatch: the venue holds 12000000, the ledger 20000000/);
  assert.equal(w.venue.position("SOL"), T(12)); // nothing traded to "fix" it
  assert.equal(await adopt(w.journal, w.venue, w.config, "SOL", "test"), T(12));
  resume(w.journal, "SOL", "test");
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(20));
  consistent(w);
});

test("an account that already holds a position is not traded until adopted", async () => {
  const w = world();
  w.venue.setMid("SOL", P);
  w.venue.forcePosition("SOL", T(-7));
  w.set("SOL", P, T(-20));
  await w.settle();
  assert.match(w.journal.ledger.halted("SOL")!, /position mismatch/);
  assert.equal(w.venue.received, 0);
});

test("a position in a market the engine does not manage halts everything", async () => {
  const w = world();
  w.venue.setMid("DOGE", 100_000n);
  w.venue.forcePosition("DOGE", T(1_000));
  w.set("SOL", P, T(-20));
  await w.settle();
  assert.match(w.journal.ledger.halted("SOL")!, /holds DOGE, which this engine does not manage/);
  assert.match(w.journal.ledger.halted("BTC")!, /holds DOGE/);
  assert.equal(w.venue.received, 0);
});

test("the hedge stops at what the venue's margin allows, without being refused", async () => {
  const w = world(undefined, { equityE6: 1_500n * USD });
  w.set("SOL", P, T(-100));
  const r = await w.settle();
  assert.equal(hold(r), "not enough free margin at the venue");
  assert.ok(w.venue.position("SOL") > 0n && w.venue.position("SOL") < T(100));
  assert.ok([...w.journal.ledger.intents.values()].every(i => i.status === "filled"));
  assert.ok((await w.venue.account()).freeMarginE6 >= 0n);
});

test("how long the hedge has been outside its band is reported", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  w.venue.faults.reject = "account restricted";
  await w.tick();
  for (let i = 0; i < 10; i++) { w.clock.advance(30_000); w.source.slot += 75; w.venue.setMid("SOL", P); await w.tick(); }
  w.clock.advance(30_000);
  w.source.slot += 75;
  w.venue.setMid("SOL", P);
  const r = await w.tick();
  assert.equal(r!.symbols[0].outsideBandMs, 330_000);
  assert.ok(r!.symbols[0].outsideBandMs >= w.config.unhedgedAlarmMs);
});

// ---- the on/off switch ----

/** A hedger on a new journal, as a deployment starts: nothing switched on. */
const fresh = () => new World(defaultConfig(["SOL", "BTC"]), mockDefaults, tmpDir(), false);

test("hedging is off until it is switched on", async () => {
  const w = fresh();
  w.set("SOL", P, T(-20));
  const r = await w.settle();
  assert.equal(hold(r), "switched off");
  assert.equal(r!.symbols[0].enabled, false);
  assert.equal(r!.symbols[0].outsideBandMs, 0); // an open vault is not an alarm while off
  assert.equal(w.journal.ledger.intents.size, 0);

  // Switched on while it runs: the next pass hedges.
  writeSwitches(w.dir, { "*": "on" }, "test");
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(20));
  assert.deepEqual(readJournal(w.dir).entries.filter(e => e.type === "switch").map(e => [(e as any).scope, (e as any).on, (e as any).by]), [["*", true, "test"]]);
});

test("switched off, the hedge is closed and stays closed", async () => {
  const w = world();
  w.set("SOL", P, T(-100));
  await w.settle();
  assert.equal(w.venue.position("SOL"), T(100));
  writeSwitches(w.dir, { "*": "off" }, "test");
  await w.tick();
  assert.equal(w.venue.position("SOL"), T(33.34)); // closed in orders no larger than the cap
  const r = await w.settle();
  assert.equal(w.venue.position("SOL"), 0n);
  assert.equal(hold(r), "switched off");
  assert.ok([...w.journal.ledger.intents.values()].slice(-2).every(i => i.reduceOnly && i.side === "sell"));
  // The vault moves; the hedge does not.
  w.set("SOL", P, T(-150));
  await w.settle();
  assert.equal(w.venue.position("SOL"), 0n);
  // The switch survives a restart, and a deleted file.
  fs.rmSync(path.join(w.dir, SWITCH_FILE));
  w.restart();
  await w.settle();
  assert.equal(w.venue.position("SOL"), 0n);
  assert.equal(w.journal.ledger.enabled("SOL"), false);
  consistent(w);
});

test("a hedge that is switched off is closed even when the vaults cannot be read", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  await w.settle();
  w.source.fail = true;
  w.clock.advance(120_000);
  w.venue.setMid("SOL", P);
  assert.equal(hold(await w.tick()), "vault reading is too old");
  assert.equal(w.venue.position("SOL"), T(20));
  writeSwitches(w.dir, { "*": "off" }, "test");
  await w.tick();
  assert.equal(w.venue.position("SOL"), 0n);
});

test("one symbol can be switched apart from the rest", async () => {
  const w = fresh();
  w.set("SOL", P, T(-20));
  w.set("BTC", 60_000n * USD, T(-0.2));
  writeSwitches(w.dir, { "*": "off", BTC: "on" }, "test");
  await w.settle();
  assert.deepEqual([w.venue.position("SOL"), w.venue.position("BTC")], [0n, T(0.2)]);
  writeSwitches(w.dir, { "*": "on", BTC: "off" }, "test");
  await w.settle();
  assert.deepEqual([w.venue.position("SOL"), w.venue.position("BTC")], [T(20), 0n]);
  // Removing a symbol's own setting puts it back under the general one.
  writeSwitches(w.dir, { "*": "on" }, "test");
  await w.settle();
  assert.deepEqual([w.venue.position("SOL"), w.venue.position("BTC")], [T(20), T(0.2)]);
  assert.deepEqual(readSwitchFile(w.dir), { "*": "on" });
});

test("a halt outranks the switch: a halted hedge is not closed either", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  await w.settle();
  w.venue.externalTrade("SOL", "buy", T(3));
  writeSwitches(w.dir, { "*": "off" }, "test");
  await w.settle();
  assert.match(hold(await w.tick()), /^halted:/);
  assert.equal(w.venue.position("SOL"), T(23));
});

test("a switch file that makes no sense changes nothing", async () => {
  const w = world();
  w.set("SOL", P, T(-20));
  await w.settle();
  for (const bad of ["{not json", '{"*":"maybe"}', '{"XRP":"on"}']) {
    fs.writeFileSync(path.join(w.dir, SWITCH_FILE), bad);
    const r = await w.tick();
    assert.ok(r!.switchError, bad);
    assert.equal(w.journal.ledger.enabled("SOL"), true);
  }
  assert.equal(w.venue.position("SOL"), T(20));
});
