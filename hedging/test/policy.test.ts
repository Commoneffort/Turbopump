import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config";
import { Exposure } from "../src/exposure";
import { PolicyInput, decide, targetHedge } from "../src/policy";
import { USD, abs, notional, sgn, signed } from "../src/units";
import { P, T } from "./helpers";

const NOW = 1_000_000;
const exposure = (positionQ: bigint, over: Partial<Exposure> = {}): Exposure =>
  ({ symbol: "SOL", positionQ, priceE6: P, slot: 1, observedAtMs: NOW, issues: [], notes: [], vaults: [], ...over });
const input = (positionQ: bigint, hedgeQ = 0n, over: Partial<PolicyInput> = {}): PolicyInput => {
  const limits = defaultConfig(["SOL"]);
  return {
    nowMs: NOW, cfg: limits.symbols.SOL, limits, exposure: exposure(positionQ), hedgeQ, grossOtherE6: 0n, enabled: true,
    quote: { midE6: P, atMs: NOW }, meta: { lotQ: 10_000n, minNotionalE6: 10n * USD, tickE6: 1_000n },
    freeMarginE6: 1_000_000n * USD, ordersLastHour: 0, ...over,
  };
};
const order = (i: PolicyInput) => {
  const d = decide(i);
  assert.equal(d.action, "order", d.action === "hold" ? d.reason : "");
  return d as Extract<typeof d, { action: "order" }>;
};
const reason = (i: PolicyInput) => {
  const d = decide(i);
  assert.equal(d.action, "hold");
  return (d as Extract<typeof d, { action: "hold" }>).reason;
};

test("a short vault is hedged with a buy, a long vault with a sell", () => {
  const buy = order(input(T(-20)));
  assert.deepEqual([buy.side, buy.sizeQ, buy.reduceOnly, buy.targetQ], ["buy", T(20), false, T(20)]);
  const sell = order(input(T(20)));
  assert.deepEqual([sell.side, sell.sizeQ, sell.targetQ], ["sell", T(20), T(-20)]);
});

test("the target is rounded toward zero to the venue's lot", () => {
  assert.equal(order(input(T(-20.019))).sizeQ, T(20.01));
  assert.equal(order(input(T(20.019))).targetQ, T(-20.01));
});

test("nothing is sent while the hedge is within its band", () => {
  // band $250 = 1.66 SOL at $150
  assert.equal(reason(input(T(-20), T(19))), "within band");
  assert.equal(reason(input(T(-20), T(20))), "on target");
  assert.equal(order(input(T(-20), T(18))).sizeQ, T(2));
});

test("the hedge ratio scales the target", () => {
  const i = input(T(-20));
  i.cfg = { ...i.cfg, hedgeRatioBps: 5_000 };
  assert.equal(order(i).targetQ, T(10));
  i.cfg = { ...i.cfg, hedgeRatioBps: 0 };
  assert.equal(reason(i), "on target");
});

test("limits make the hedge smaller, never larger", () => {
  // $50k position cap = 333.33 SOL; $10k order cap = 66.66 SOL
  const big = order(input(T(-1_000)));
  assert.equal(big.targetQ, T(333.33));
  assert.equal(big.sizeQ, T(66.66));
  // The gross limit leaves $20k of room next to $80k held elsewhere.
  assert.equal(order(input(T(-1_000), 0n, { grossOtherE6: 80_000n * USD })).targetQ, T(133.33));
  assert.equal(reason(input(T(-1_000), 0n, { grossOtherE6: 200_000n * USD })), "on target");
  // A hedge above a cap is brought back under it.
  const over = order(input(T(-1_000), T(400)));
  assert.deepEqual([over.side, over.sizeQ, over.reduceOnly], ["sell", T(66.66), true]);
});

test("a shrinking hedge is sent reduce-only", () => {
  const d = order(input(T(-5), T(20)));
  assert.deepEqual([d.side, d.sizeQ, d.reduceOnly], ["sell", T(15), true]);
  const flat = order(input(0n, T(20)));
  assert.deepEqual([flat.side, flat.sizeQ, flat.reduceOnly, flat.targetQ], ["sell", T(20), true, 0n]);
});

test("the hedge never changes side in one order", () => {
  // The vault went from short to long: the long hedge is closed first, nothing is opened.
  const d = order(input(T(30), T(20)));
  assert.deepEqual([d.side, d.sizeQ, d.reduceOnly, d.targetQ], ["sell", T(20), true, T(-30)]);
});

test("new exposure is cut to the venue's free margin; closing needs none", () => {
  // $1,500 free - $500 reserve = $1,000 at 20% margin = $5,000 = 33.33 SOL
  assert.equal(order(input(T(-60), 0n, { freeMarginE6: 1_500n * USD })).sizeQ, T(33.33));
  assert.equal(reason(input(T(-60), 0n, { freeMarginE6: 400n * USD })), "not enough free margin at the venue");
  assert.equal(order(input(0n, T(60), { freeMarginE6: -100n * USD })).sizeQ, T(60));
});

test("orders below the venue's minimum are not sent", () => {
  const i = input(T(-20), T(18));
  i.meta = { ...i.meta!, minNotionalE6: 1_000n * USD };
  assert.equal(reason(i), "order would be below the venue's minimum");
});

test("it holds when it should not act", () => {
  assert.equal(reason(input(T(-20), 0n, { blocked: "halted: x" })), "halted: x");
  assert.equal(reason(input(T(-20), 0n, { exposure: undefined })), "no reading of the vault yet");
  assert.match(reason(input(T(-20), 0n, { exposure: exposure(T(-20), { issues: ["vault v is missing from the read"] }) })), /not usable/);
  assert.equal(reason(input(T(-20), 0n, { exposure: exposure(T(-20), { observedAtMs: NOW - 61_000 }) })), "vault reading is too old");
  assert.equal(reason(input(T(-20), 0n, { quote: undefined })), "no venue quote");
  assert.equal(reason(input(T(-20), 0n, { quote: { midE6: P, atMs: NOW - 16_000 } })), "venue quote is too old");
  assert.equal(reason(input(T(-20), 0n, { quote: { midE6: P * 102n / 100n, atMs: NOW } })), "venue price is too far from Percolator's");
  assert.equal(reason(input(T(-20), 0n, { lastOrderMs: NOW - 19_000 })), "waiting between orders");
  assert.equal(order(input(T(-20), 0n, { lastOrderMs: NOW - 20_000 })).side, "buy");
  assert.equal(reason(input(T(-20), 0n, { ordersLastHour: 600 })), "hourly order limit reached");
});

test("switched off, the hedge is closed and nothing is opened", () => {
  assert.equal(reason(input(T(-20), 0n, { enabled: false })), "switched off");
  // Whatever the vault holds, the target is zero, and the close is reduce-only.
  const d = order(input(T(-20), T(20), { enabled: false }));
  assert.deepEqual([d.side, d.sizeQ, d.reduceOnly, d.targetQ], ["sell", T(20), true, 0n]);
  // The band does not keep a small hedge open.
  assert.equal(order(input(T(-20), T(1), { enabled: false })).sizeQ, T(1));
  // In pieces no larger than the order cap.
  assert.equal(order(input(T(-200), T(-200), { enabled: false })).sizeQ, T(66.66));
  // It needs no reading of the vault, and no margin.
  assert.equal(order(input(0n, T(20), { enabled: false, exposure: undefined, freeMarginE6: 0n })).sizeQ, T(20));
  assert.equal(order(input(0n, T(20), { enabled: false, exposure: exposure(T(5), { observedAtMs: NOW - 600_000 }) })).sizeQ, T(20));
  assert.equal(order(input(0n, T(20), { enabled: false, exposure: exposure(T(5), { issues: ["vault v is missing from the read"] }) })).sizeQ, T(20));
  // A halt and an unresolved order still stop it; so does a missing venue price.
  assert.equal(reason(input(0n, T(20), { enabled: false, blocked: "halted: x" })), "halted: x");
  assert.equal(reason(input(0n, T(20), { enabled: false, quote: undefined })), "no venue quote");
  assert.match(reason(input(0n, 5_000n, { enabled: false })), /^switched off \(what is left is below/);
});

test("the limit price is within the allowed slippage and on the tick", () => {
  const i = input(T(-20), 0n, { quote: { midE6: 150_123_456n, atMs: NOW } });
  i.exposure = exposure(T(-20), { priceE6: 150_123_456n });
  const buy = order(i);
  assert.ok(buy.limitE6 > 150_123_456n && buy.limitE6 <= 150_123_456n * 10_030n / 10_000n && buy.limitE6 % 1_000n === 0n);
  i.exposure = exposure(T(20), { priceE6: 150_123_456n });
  const sell = order(i);
  assert.ok(sell.limitE6 < 150_123_456n && sell.limitE6 * 10_000n >= 150_123_456n * 9_970n && sell.limitE6 % 1_000n === 0n);
});

test("a flat vault with no price is sized at the venue's price", () => {
  const d = order(input(0n, T(20), { exposure: exposure(0n, { priceE6: 0n }) }));
  assert.deepEqual([d.side, d.sizeQ, d.reduceOnly], ["sell", T(20), true]);
});

test("any order moves the hedge toward its target and never past it", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const span = (n: number) => T((rand() * 2 - 1) * n);
  let orders = 0;
  for (let n = 0; n < 20_000; n++) {
    const i = input(span(600), rand() < 0.2 ? 0n : span(600), {
      grossOtherE6: BigInt(Math.floor(rand() * 120_000)) * USD,
      freeMarginE6: BigInt(Math.floor(rand() * 30_000)) * USD,
    });
    i.hedgeQ -= i.hedgeQ % 10_000n;
    i.cfg = { ...i.cfg, hedgeRatioBps: Math.floor(rand() * 10_001), bandE6: BigInt(1 + Math.floor(rand() * 500)) * USD };
    const px = BigInt(Math.floor(P_NUM * (0.995 + rand() * 0.01)));
    i.quote = { midE6: px, atMs: NOW };
    i.enabled = rand() < 0.85;
    const d = decide(i);
    const e = i.exposure!.positionQ;
    const want = targetHedge(e, P, i.cfg, i.limits, i.grossOtherE6, 10_000n);
    // The target is on the other side of the vault's position and no larger than it.
    assert.ok(want === 0n || sgn(want) === -sgn(e));
    assert.ok(abs(want) <= abs(e) * BigInt(i.cfg.hedgeRatioBps) / 10_000n);
    assert.ok(notional(want, P) <= i.cfg.maxHedgeE6);
    if (d.action !== "order") continue;
    orders++;
    assert.equal(d.targetQ, i.enabled ? want : 0n);
    if (!i.enabled) assert.ok(d.reduceOnly, "switched off: reduce-only");
    const after = i.hedgeQ + signed(d.side, d.sizeQ);
    assert.ok(d.sizeQ > 0n && d.sizeQ % 10_000n === 0n, "whole lots");
    assert.ok(notional(d.sizeQ, P) <= i.cfg.maxOrderE6, "within the order cap");
    const aim = d.targetQ;
    assert.ok(abs(aim - after) < abs(aim - i.hedgeQ), "closer to the target");
    assert.ok(sgn(aim - after) === 0 || sgn(aim - after) === sgn(aim - i.hedgeQ), "not past the target");
    assert.ok(i.hedgeQ === 0n || after === 0n || sgn(after) === sgn(i.hedgeQ), "no change of side");
    assert.equal(d.reduceOnly, abs(after) < abs(i.hedgeQ));
    if (!d.reduceOnly) {
      assert.ok(notional(d.sizeQ, px) * 2_000n / 10_000n <= i.freeMarginE6 - i.limits.marginReserveE6, "within free margin");
    }
  }
  assert.ok(orders > 5_000);
});
const P_NUM = Number(P);

test("after orders that traded nothing the wait doubles, up to the ceiling", () => {
  const at = (failures: number, sinceMs: number) => decide(input(T(-20), 0n, { failures, lastOrderMs: NOW - sinceMs }));
  assert.equal(at(0, 20_000).action, "order");
  assert.equal(reason(input(T(-20), 0n, { failures: 2, lastOrderMs: NOW - 10_000 })), "waiting between orders");
  assert.equal(reason(input(T(-20), 0n, { failures: 2, lastOrderMs: NOW - 79_000 })), "waiting longer after 2 orders that traded nothing");
  assert.equal(at(2, 80_000).action, "order");
  assert.equal(at(12, 599_000).action, "hold");
  assert.equal(at(12, 600_000).action, "order"); // never more than maxBackoffMs
  assert.equal(at(40, 600_000).action, "order");
});

test("near liquidation the hedge may shrink but not grow", () => {
  const near = "the hedge account is 8.0% from liquidation";
  assert.equal(reason(input(T(-20), T(5), { noIncrease: near })), near);
  assert.equal(reason(input(T(-20), 0n, { noIncrease: near })), near);
  const d = order(input(T(-5), T(20), { noIncrease: near }));
  assert.deepEqual([d.side, d.sizeQ, d.reduceOnly], ["sell", T(15), true]);
});

test("a hedge the account cannot carry is cut to its cap, with or without a vault reading", () => {
  // $3,000 held, capped at $1,800: 8 of the 20 are sold, though the vault would want all 20.
  const cut = order(input(T(-20), T(20), { hedgeCapE6: 1_800n * USD, noIncrease: "x" }));
  assert.deepEqual([cut.side, cut.sizeQ, cut.reduceOnly, cut.targetQ], ["sell", T(8), true, T(12)]);
  for (const exposure of [undefined, { ...input(0n).exposure!, observedAtMs: NOW - 10 * 60_000 }, { ...input(0n).exposure!, issues: ["vault x is missing from the read"] }]) {
    const blind = order(input(0n, T(-20), { exposure, hedgeCapE6: 1_800n * USD, noIncrease: "x" }));
    assert.deepEqual([blind.side, blind.sizeQ, blind.reduceOnly, blind.targetQ], ["buy", T(8), true, T(-12)]);
  }
  // Under the cap and blind: nothing to do, and the reason is the reading, not "on target".
  assert.equal(reason(input(0n, T(-10), { exposure: undefined, hedgeCapE6: 1_800n * USD })), "no reading of the vault yet");
  // The cap never opens or enlarges a hedge.
  assert.equal(decide(input(0n, 0n, { exposure: undefined, hedgeCapE6: 1_800n * USD })).action, "hold");
});
