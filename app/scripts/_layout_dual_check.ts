// Local check (not shipped): the app's market readers give the same answers on a v1-layout
// market and on the same market migrated to the current layout (Percolator tag 73).
import * as fs from "fs";
import * as C from "../src/chain";
import L from "../src/layout.json";
const dir = process.argv[2];
const SLOTS = L.market.slots, NEW = L.market.slot_len, OLD = NEW - 64, RAW = L.market.engine + L.market.stored_pos_count_long - 32;
const migrate = (old: Uint8Array) => {
  const cap = (old.length - SLOTS) / OLD;
  const out = new Uint8Array(SLOTS + cap * NEW);
  out.set(old.subarray(0, SLOTS));
  for (let i = 0; i < cap; i++) {
    const o = old.subarray(SLOTS + i * OLD, SLOTS + (i + 1) * OLD), n = SLOTS + i * NEW;
    out.set(o.subarray(0, RAW), n);
    out.set(o.subarray(L.market.engine + L.market.oi_long, L.market.engine + L.market.oi_long + 32), n + RAW); // raw sums = effective OI
    out.set(o.subarray(RAW), n + RAW + 32);
  }
  return out;
};
const j = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const pfAll = fs.readFileSync(`${dir}/x1_portfolios.bin`);
const pfs: Uint8Array[] = [];
for (let i = 0; i < pfAll.length; i += 9563) pfs.push(new Uint8Array(pfAll.subarray(i, i + 9563)));
let checks = 0, bad = 0;
const same = (what: string, a: unknown, b: unknown) => { checks++; if (j(a) !== j(b)) { bad++; console.log("DIFF", what, j(a), j(b)); } };
for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".bin") && !f.includes("portfolios"))) {
  const old = new Uint8Array(fs.readFileSync(`${dir}/${f}`)), neu = migrate(old);
  if ((neu.length - SLOTS) % NEW !== 0 || C.marketLayout(neu) !== (L.market as any) || C.marketLayout(old) === (L.market as any)) throw new Error("layout pick");
  same(`${f} header`, C.marketHeader(old), C.marketHeader(neu));
  const cap = (old.length - SLOTS) / OLD;
  for (let a = 0; a < cap; a++) {
    for (const [name, fn] of Object.entries({ decodeAsset: C.decodeAsset, fundingOf: C.fundingOf, closeOnly: C.closeOnly, assetPositionCount: C.assetPositionCount, controlSequences: C.controlSequences }))
      same(`${f} ${name}(${a})`, (fn as any)(old, a), (fn as any)(neu, a));
    same(`${f} finalizeResets(${a})`, C.finalizeResets(old, a).map(i => i.data.toString("hex")), C.finalizeResets(neu, a).map(i => i.data.toString("hex")));
  }
  for (const p of pfs) {
    same(`${f} accountHealth`, C.accountHealth(old, p), C.accountHealth(neu, p));
    for (let i = 0; i < 16; i++) same(`${f} legPosition`, C.legPosition(old, p, L.portfolio.legs + i * L.portfolio.leg_len), C.legPosition(neu, p, L.portfolio.legs + i * L.portfolio.leg_len));
  }
}
console.log(`checks ${checks}, differences ${bad}`);
process.exit(bad ? 1 : 0);
