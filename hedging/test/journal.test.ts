import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";
import { Journal, clientId, readJournal } from "../src/journal";
import { tmpDir } from "./helpers";

const clock = { now: () => 1_000 };
const fill = (n: number, id: string | null = null) =>
  ({ type: "fill", fillId: `f${n}`, id, symbol: "SOL", side: "buy", sizeQ: 1_000_000n, priceE6: 150_000_000n, feeE6: 75_000n, cursor: String(n) }) as const;
const intent = (id: string) =>
  ({ type: "intent", id, symbol: "SOL", side: "buy", sizeQ: 2_000_000n, limitE6: 151_000_000n, reduceOnly: false, targetQ: 2_000_000n, exposureQ: -2_000_000n, priceE6: 150_000_000n }) as const;

test("the ledger after a restart is the ledger before it", () => {
  const dir = tmpDir();
  let j = Journal.open(dir, "mock", clock);
  j.append(intent("a"));
  j.append(fill(1, "a"));
  j.append(fill(2, "a"));
  j.append({ type: "order", id: "a", status: "filled", filledQ: 2_000_000n });
  j.append(intent("b"));
  j.append({ type: "in_doubt", id: "b", error: "timeout" });
  j.append({ type: "halt", scope: "SOL", reason: "test" });
  j.append({ type: "adopt", symbol: "BTC", positionQ: -5n, by: "me" });
  const before = j.ledger;
  j.close();
  j = Journal.open(dir, "mock", clock);
  assert.deepEqual(j.ledger, before);
  assert.equal(j.ledger.position("SOL"), 2_000_000n);
  assert.equal(j.ledger.position("BTC"), -5n);
  assert.equal(j.ledger.cashE6.get("SOL"), -300_000_000n);
  assert.equal(j.ledger.feesE6, 150_000n);
  assert.equal(j.ledger.cursor, "2");
  assert.equal(j.ledger.intents.get("a")!.status, "filled");
  assert.deepEqual(j.ledger.unresolved().map(i => [i.id, i.status]), [["b", "in_doubt"]]);
  assert.equal(j.ledger.halted("SOL"), "test");
  j.append({ type: "resume", scope: "SOL", by: "me" });
  assert.equal(j.ledger.halted("SOL"), undefined);
  j.close();
});

test("a fill is counted once however often it is recorded", () => {
  const j = Journal.open(tmpDir(), "mock", clock);
  j.append(fill(1));
  j.append(fill(1));
  assert.equal(j.ledger.position("SOL"), 1_000_000n);
  j.close();
});

test("a write cut short by a crash is dropped; the rest survives", () => {
  const dir = tmpDir(), file = path.join(dir, "journal.jsonl");
  let j = Journal.open(dir, "mock", clock);
  j.append(fill(1));
  j.close();
  fs.appendFileSync(file, '{"type":"fill","fillId":"f2","id":null,"symb');
  j = Journal.open(dir, "mock", clock);
  assert.equal(j.ledger.seq, 2);
  assert.equal(j.ledger.position("SOL"), 1_000_000n);
  j.append(fill(2));
  j.close();
  assert.equal(readJournal(dir).ledger.position("SOL"), 2_000_000n);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
});

test("a damaged or incomplete journal is refused, and its lock released", () => {
  const dir = tmpDir(), file = path.join(dir, "journal.jsonl");
  const j = Journal.open(dir, "mock", clock);
  j.append(fill(1));
  j.append(fill(2));
  j.close();
  const lines = fs.readFileSync(file, "utf8").split("\n");
  fs.writeFileSync(file, [lines[0], "garbage", lines[2], ""].join("\n"));
  assert.throws(() => Journal.open(dir, "mock", clock), /damaged at line 2/);
  fs.writeFileSync(file, [lines[0], lines[2], ""].join("\n"));
  assert.throws(() => Journal.open(dir, "mock", clock), /skips from event 1 to 3/);
  assert.ok(!fs.existsSync(path.join(dir, "lock")));
});

test("one process at a time", () => {
  const dir = tmpDir();
  const j = Journal.open(dir, "mock", clock);
  assert.throws(() => Journal.open(dir, "mock", clock), /in use by process/);
  j.close();
  // A lock left by a process that died is taken over.
  fs.writeFileSync(path.join(dir, "lock"), "999999999");
  Journal.open(dir, "mock", clock).close();
});

test("a journal stays with the venue it was opened for", () => {
  const dir = tmpDir();
  Journal.open(dir, "mock", clock).close();
  assert.throws(() => Journal.open(dir, "hyperliquid", clock), /belongs to venue "mock"/);
  Journal.open(dir, "mock", clock).close();
});

test("order ids are fixed by the journal and the event number", () => {
  assert.equal(clientId("abc", 5), clientId("abc", 5));
  assert.notEqual(clientId("abc", 5), clientId("abc", 6));
  assert.notEqual(clientId("abc", 5), clientId("abd", 5));
  assert.match(clientId("abc", 5), /^0x[0-9a-f]{32}$/);
});

test("funding, cost and failed-order counts are in the ledger, and each event counts once", () => {
  const dir = tmpDir();
  let j = Journal.open(dir, "mock", clock);
  const L = j.ledger;
  j.append({ ...intent("a"), midE6: 149_900_000n });
  j.append(fill(1, "a"));                                      // bought 1 at $150, 10 cents over the mid
  j.append({ type: "order", id: "a", status: "cancelled", filledQ: 1_000_000n });
  assert.equal(L.basisE6.get("SOL"), 150_000_000n);
  assert.equal(L.slippageE6.get("SOL"), 100_000n);
  assert.equal(L.failures.get("SOL"), undefined);              // it traded: not a failure
  j.append({ type: "fill", fillId: "f2", id: null, symbol: "SOL", side: "sell", sizeQ: 3_000_000n, priceE6: 160_000_000n, feeE6: 0n, cursor: "2" });
  assert.equal(L.position("SOL"), -2_000_000n);                // closed the 1 at +$10, short 2 at $160
  assert.equal(L.realizedE6("SOL"), 10_000_000n);
  assert.equal(L.basisE6.get("SOL"), -320_000_000n);
  for (const id of ["b", "c"]) {
    j.append(intent(id));
    j.append({ type: "order", id, status: id === "b" ? "rejected" : "lost", filledQ: 0n });
  }
  assert.equal(L.failures.get("SOL"), 2);
  j.append({ type: "funding", fundingId: "u1", symbol: "SOL", amountE6: 250_000n, cursor: "1" });
  j.append({ type: "funding", fundingId: "u1", symbol: "SOL", amountE6: 250_000n, cursor: "1" }); // the same payment again
  j.append({ type: "funding", fundingId: "u2", symbol: "SOL", amountE6: -100_000n, cursor: "2" });
  assert.equal(L.totalFundingE6(), 150_000n);
  assert.equal(L.fundingCursor, "2");
  j.append({ type: "adopt", symbol: "SOL", positionQ: 0n, by: "me", priceE6: 155_000_000n }); // as if 2 were bought at $155
  assert.equal(L.realizedE6("SOL"), 20_000_000n);
  j.append({ type: "baseline", equityE6: 5_000_000_000n, by: "engine" });
  j.close();
  j = Journal.open(dir, "mock", clock);
  assert.deepEqual(j.ledger, L);
  j.close();
});
