import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";
import { TRANSITIONS_FILE, readReport, riskLines, riskRows, writeReport } from "../src/report";
import { P, T, tmpDir, world } from "./helpers";

test("the report a hedger leaves behind reads back as it was written", async () => {
  const w = world(c => { c.symbols.SOL.hedgeRatioBps = 8_000; });
  const dir = tmpDir();
  w.set("SOL", P, T(-100));
  for (let i = 0; i < 4; i++) {
    const r = await w.tick();
    writeReport(dir, r!, w.config.stressBps);
    w.clock.advance(30_000);
    w.set("SOL", P, T(-100));
  }
  const f = readReport(dir)!;
  assert.equal(f.symbols[0].state, "HEDGED");
  assert.equal(f.risk.symbols[0].hedgeQ, T(80));
  const rows = riskRows(f);
  assert.deepEqual([rows[0]["vault holds"], rows[0]["meant to keep"], rows[0]["hedge held"], rows[0].hedged, rows[0]["still open"], rows[0]["vault keeps"]],
    ["-$15000.00", "-$3000.00", "80", "80.0%", "$0.00", "-$3000.00"]);
  const text = riskLines(f).join("\n");
  assert.match(text, /the vaults still carry \$3000\.00 \(20\.0% of what they hold\)/);
  assert.match(text, /a 10\.0% move against what is left would cost \$300\.00/);
  assert.match(text, /^state HEDGED, as of /);
  assert.match(text, /room for \$\d+\.\d\d more hedge, 0\.24x; liquidated if every hedged price moves more than 100% against it/);
  const changes = fs.readFileSync(path.join(dir, TRANSITIONS_FILE), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(changes.filter(c => c.scope === "SOL").map(c => c.to), ["HEDGE_REQUIRED", "HEDGED"]);
  assert.equal(readReport(tmpDir()), undefined);
});
