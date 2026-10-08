import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config";
import { HyperliquidVenue, addressOf, fromWire, msgpack, priceTick, signAction, signerOf, toWire } from "../src/hyperliquid";
import { MockVenue } from "../src/mock-venue";
import { World, mockDefaults, scenarios, simulate } from "../src/simulator";
import { Clock, USD } from "../src/units";
import { fakeHyperliquid } from "./fake-hyperliquid";
import { P, T, tmpDir } from "./helpers";

// The key of Hyperliquid's own SDK tests; never funded.
const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const USER = "0x14791697260e4c9a71f18484c9f997b308e59325";
const hx = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("signatures are the ones Hyperliquid's SDK produces", () => {
  assert.equal(addressOf(KEY), USER);
  // tests/signing_test.py, test_l1_action_signing_order_matches
  const action = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
  assert.deepEqual(signAction(action, 0, KEY, "a"), {
    r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28,
  });
  const testnet = signAction(action, 0, KEY, "b");
  assert.deepEqual(testnet, {
    r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27,
  });
  assert.equal(signerOf(action, 0, testnet, "b"), USER);
  // A test-network signature names someone else on the real exchange, and so is void there.
  assert.notEqual(signerOf(action, 0, testnet, "a"), USER);
  assert.notEqual(signerOf(action, 1, testnet, "b"), USER);
});

test("msgpack keeps key order and uses the shortest forms", () => {
  assert.equal(hx(msgpack({ a: 1, b: true, p: "100", r: false, c: null })), "85a16101a162c3a170a3313030a172c2a163c0");
  assert.equal(hx(msgpack([0, 127, 128, 255, 256, 65_535, 65_536])), "97007fcc80ccffcd0100cdffffce00010000");
  assert.equal(hx(msgpack("x".repeat(32))).slice(0, 4), "d920");
  assert.throws(() => msgpack(1.5));
  assert.throws(() => msgpack(-1));
});

test("numbers go over the wire exactly", () => {
  for (const s of ["0", "118.59", "84862.5", "0.095026", "-0.5", "1000000"]) assert.equal(toWire(fromWire(s)), s);
  assert.equal(fromWire("1451.041001"), 1_451_041_001n);
  assert.equal(fromWire("0.0"), 0n);
  assert.equal(fromWire("0.00012345678"), 123n); // finer than a millionth is cut off
  assert.throws(() => fromWire("1e5"));
  // 5 significant figures, at most 6 - szDecimals decimals.
  assert.equal(priceTick(fromWire("118.59"), 2), 10_000n); // 0.01
  assert.equal(priceTick(fromWire("84862.5"), 5), 1_000_000n); // whole dollars
  assert.equal(priceTick(fromWire("2697.65"), 4), 100_000n); // 0.1
  assert.equal(priceTick(fromWire("0.095026"), 0), 1n); // 0.000001
  assert.equal(priceTick(fromWire("9.5"), 2), 100n); // 0.0001 (the decimals limit binds)
  assert.equal(priceTick(fromWire("123456"), 2), 1_000_000n);
});

const clock = (): Clock & { t: number } => ({ t: 1_700_000_000_000, now() { return this.t; } });
const venue = (c = clock()) => {
  const mock = new MockVenue(c, mockDefaults);
  mock.setMid("SOL", fromWire("118.613"));
  mock.setMid("BTC", fromWire("84862.5"));
  const fake = fakeHyperliquid(mock, c, USER);
  return { c, mock, fake, hl: new HyperliquidVenue({ privateKey: KEY, clock: c, fetch: fake.fetch }) };
};

test("it reads markets, quotes, the account and positions", async () => {
  const { hl, mock } = venue();
  assert.equal(hl.name, "hyperliquid-testnet");
  assert.deepEqual(await hl.meta("SOL"), { lotQ: 10_000n, minNotionalE6: 10n * USD, tickE6: 10_000n });
  assert.equal((await hl.quote("SOL")).midE6, fromWire("118.613"));
  assert.deepEqual(await hl.account(), { equityE6: 50_000n * USD, freeMarginE6: 50_000n * USD, marginUsedE6: 0n, maintenanceE6: 0n });
  assert.deepEqual(await hl.positions(), new Map());
  mock.externalTrade("BTC", "sell", T(0.5));
  hl["state"] = undefined;
  assert.deepEqual(await hl.positions(), new Map([["BTC", T(-0.5)]]));
  await assert.rejects(hl.quote("XRP"), /no market XRP/);
});

test("an order is signed, on the tick, immediate-or-cancel, and found again by our id", async () => {
  const { hl, mock, fake } = venue();
  const id = "0x000000000000000000000000000000a1";
  // A buy limit of 118.96885 is rounded down to the tick, toward the mid.
  const st = await hl.place({ clientId: id, symbol: "SOL", side: "buy", sizeQ: T(2), limitE6: 118_968_850n, reduceOnly: false });
  assert.deepEqual(st, { clientId: id, status: "filled", filledQ: T(2) });
  assert.equal(mock.position("SOL"), T(2));
  assert.equal(fake.stats.requests.at(-1), "exchange");
  assert.deepEqual(await hl.order(id), { clientId: id, status: "filled", filledQ: T(2), reason: undefined });
  assert.equal(await hl.order("0x000000000000000000000000000000ff"), null);
  // Its fill comes back under our id, though the exchange reports it under its own.
  const fills = await hl.fills(null);
  assert.equal(fills.length, 1);
  assert.deepEqual([fills[0].clientId, fills[0].symbol, fills[0].side, fills[0].sizeQ, fills[0].fillId], [id, "SOL", "buy", T(2), "1"]);
  assert.ok(fills[0].feeE6 > 0n);
  // A sell's limit is rounded up.
  const sell = await hl.place({ clientId: "0x000000000000000000000000000000a2", symbol: "SOL", side: "sell", sizeQ: T(1), limitE6: 118_301_111n, reduceOnly: true });
  assert.equal(sell.status, "filled");
  await assert.rejects(hl.place({ clientId: "0x000000000000000000000000000000a3", symbol: "SOL", side: "buy", sizeQ: 15_000n, limitE6: 119_000_000n, reduceOnly: false }), /whole number of lots/);
});

test("a fresh process maps fills to our orders by looking the orders up", async () => {
  const { c, mock, fake, hl } = venue();
  await hl.place({ clientId: "0x000000000000000000000000000000b1", symbol: "SOL", side: "buy", sizeQ: T(2), limitE6: 119_000_000n, reduceOnly: false });
  mock.externalTrade("SOL", "sell", T(1));
  const again = new HyperliquidVenue({ privateKey: KEY, clock: c, fetch: fake.fetch });
  assert.deepEqual((await again.fills(null)).map(f => f.clientId), ["0x000000000000000000000000000000b1", null]);
  // Reading on from a cursor returns that moment's fills again and nothing older.
  c.t += 5_000;
  mock.externalTrade("SOL", "buy", T(1));
  const first = (await again.fills(null))[0];
  assert.deepEqual((await again.fills(String(c.t))).map(f => f.fillId), ["3"]);
  assert.equal((await again.fills(first.cursor)).length, 3);
  // A journal started later does not take the account's older fills for its own business.
  const later = new HyperliquidVenue({ privateKey: KEY, clock: c, fetch: fake.fetch, historyFrom: c.t });
  assert.deepEqual((await later.fills(null)).map(f => f.fillId), ["3"]);
});

test("refusals are final and remembered; an unanswered order is unknown", async () => {
  const { hl, mock } = venue();
  mock.faults.reject = "Insufficient margin to place order.";
  const a = "0x000000000000000000000000000000c1";
  const st = await hl.place({ clientId: a, symbol: "SOL", side: "buy", sizeQ: T(2), limitE6: 119_000_000n, reduceOnly: false });
  assert.deepEqual([st.status, st.reason], ["rejected", "Insufficient margin to place order."]);
  assert.equal((await hl.order(a))!.status, "rejected");
  mock.faults = {};
  // A limit the book cannot meet: nothing trades, and the exchange keeps no record.
  const b = "0x000000000000000000000000000000c2";
  const miss = await hl.place({ clientId: b, symbol: "SOL", side: "buy", sizeQ: T(2), limitE6: 100_000_000n, reduceOnly: false });
  assert.deepEqual([miss.status, miss.filledQ], ["rejected", 0n]);
  assert.match(miss.reason!, /could not immediately match/);
  // The reply is lost: the call fails, and the order is found afterwards.
  mock.faults.loseReply = true;
  const d = "0x000000000000000000000000000000c3";
  await assert.rejects(hl.place({ clientId: d, symbol: "SOL", side: "buy", sizeQ: T(2), limitE6: 119_000_000n, reduceOnly: false }));
  mock.faults = {};
  assert.equal((await hl.order(d))!.status, "filled");
  // The exchange is down: every call fails, nothing is assumed.
  mock.faults.down = true;
  await assert.rejects(hl.order(d));
  await assert.rejects(hl.fills(null));
});

test("a key the exchange does not know is refused, not traded", async () => {
  const c = clock(), mock = new MockVenue(c, mockDefaults);
  mock.setMid("SOL", P);
  const hl = new HyperliquidVenue({ privateKey: "0x" + "11".repeat(32), clock: c, fetch: fakeHyperliquid(mock, c, USER).fetch });
  const st = await hl.place({ clientId: "0x000000000000000000000000000000d1", symbol: "SOL", side: "buy", sizeQ: T(2), limitE6: 151_000_000n, reduceOnly: false });
  assert.equal(st.status, "rejected");
  assert.match(st.reason!, new RegExp(`User or API Wallet ${hl.signer} does not exist`));
  assert.equal(mock.received, 0);
});

test("an API wallet trades for the account that approved it", async () => {
  const c = clock(), mock = new MockVenue(c, mockDefaults);
  mock.setMid("SOL", P);
  const fake = fakeHyperliquid(mock, c, USER);
  const hl = new HyperliquidVenue({ privateKey: KEY, account: "0x00000000000000000000000000000000000000AA", clock: c, fetch: fake.fetch });
  assert.equal(hl.user, "0x00000000000000000000000000000000000000aa");
  assert.equal(hl.signer, USER);
});

// ---- the engine through the adapter ----
// The exchange outlives the hedger: one fake per mock, a new adapter for each (re)start.
const exchanges = new WeakMap<MockVenue, typeof fetch>();
const wrap = (mock: MockVenue, c: Clock) => {
  if (!exchanges.has(mock)) exchanges.set(mock, fakeHyperliquid(mock, c, USER).fetch);
  return new HyperliquidVenue({ privateKey: KEY, clock: c, fetch: exchanges.get(mock)! });
};
const hlWorld = () => new World(defaultConfig(["SOL", "BTC"]), mockDefaults, tmpDir(), true, wrap);
const agree = (w: World) => { for (const s of ["SOL", "BTC"]) assert.equal(w.journal.ledger.position(s), w.venue.position(s), s); };

test("the engine hedges through the adapter, and its journal is tied to the test network", async () => {
  const w = hlWorld();
  w.set("SOL", P, T(-100));
  w.set("BTC", 60_000n * USD, T(0.3));
  await w.settle();
  assert.deepEqual([w.venue.position("SOL"), w.venue.position("BTC")], [T(100), T(-0.3)]);
  assert.equal(w.journal.ledger.venue, "hyperliquid-testnet");
  assert.equal(w.journal.ledger.halts.size, 0);
  agree(w);
});

test("a crash at any journal write, through the adapter, loses and repeats nothing", async () => {
  const ref = hlWorld();
  ref.set("SOL", P, T(-100));
  await ref.settle();
  for (let n = 3; n <= ref.writes; n++) {
    for (const when of ["before", "after"] as const) {
      const w = hlWorld();
      w.crashOnWrite = { n, when };
      w.set("SOL", P, T(-100));
      assert.ok(await w.settle(), `crash ${when} write ${n}`);
      assert.equal(w.venue.position("SOL"), T(100), `crash ${when} write ${n}`);
      assert.equal(w.venue.received, 2);
      assert.equal(w.journal.ledger.halts.size, 0);
      agree(w);
    }
  }
});

test("a trade on the account that is not ours halts the symbol, through the adapter", async () => {
  const w = hlWorld();
  w.set("SOL", P, T(-20));
  await w.settle();
  w.venue.externalTrade("SOL", "sell", T(5));
  await w.settle();
  assert.match(w.journal.ledger.halted("SOL")!, /was not placed by this engine/);
  agree(w);
});

test("the simulator's scenarios hold through the adapter, faults and crashes included", async () => {
  for (const name of ["calm", "chaos"]) {
    const s = scenarios.find(x => x.name === name)!;
    const r = await simulate({ ...s, steps: 800 }, undefined, wrap);
    assert.ok(r.ledgerMatchesVenue, name);
    assert.deepEqual(r.halts, [], name);
    assert.ok(r.orders <= r.intents && r.orders > 100, name);
    assert.ok(r.riskRemoved > 0.7, `${name}: ${r.riskRemoved}`);
    for (const open of Object.values(r.finalResidualE6)) assert.ok((open < 0n ? -open : open) < 250n * USD, name);
  }
});
