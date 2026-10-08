import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";
import L from "../../app/src/layout.json";
import M from "../../app/src/devnet.json";
import { ChainSource, FEED_SYMBOLS, base58, decodeVault, readVault } from "../src/chain-source";
import { ExposureMonitor } from "../src/exposure";

type Fixture = { slot: number; market: string; vaults: { key: string; portfolio: string; vaultData: string; portfolioData: string | null }[] };
const fixture: Fixture = JSON.parse(fs.readFileSync(new URL("fixtures/devnet.json", import.meta.url), "utf8"));
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const market = bytes(fixture.market);

test("base58 matches known addresses", () => {
  assert.equal(base58(new Uint8Array(32)), "11111111111111111111111111111111");
  const v = fixture.vaults[0];
  const d = bytes(v.vaultData);
  assert.equal(base58(d.subarray(L.vault.lp_portfolio, L.vault.lp_portfolio + 32)), v.portfolio);
  assert.equal(base58(d.subarray(L.vault.market, L.vault.market + 32)).length >= 32, true);
});

// The app's decoder is the reference: it is what the executor and the UI run on. It needs the
// app's dependencies installed.
const app = fs.existsSync(new URL("../../app/node_modules/@solana/web3.js", import.meta.url));
test("decodes live vaults exactly as the app does", { skip: !app && "app dependencies not installed" }, async () => {
  const C = await import("../../app/src/chain");
  let withPosition = 0, checked = 0;
  for (const f of fixture.vaults) {
    const data = bytes(f.vaultData);
    const mine = decodeVault(data), theirs = C.decodeVault(C.MARKET, data); // the key is not decoded
    assert.equal(mine.market, theirs.market.toBase58());
    assert.equal(mine.lpPortfolio, theirs.lpPortfolio.toBase58());
    assert.equal(mine.status, theirs.status);
    assert.equal(mine.assetIndex, theirs.assetIndex);
    assert.equal(mine.feedHex, theirs.feedHex);
    assert.equal(mine.inventory, theirs.inventory);
    assert.equal(mine.lastNav, theirs.lastNav);
    assert.equal(mine.needsFlat, theirs.needsFlat);
    assert.equal(FEED_SYMBOLS[mine.feedHex], theirs.feed?.symbol);
    if (mine.market !== M.market || !f.portfolioData || mine.status === 0) continue;
    const r = readVault(f.key, data, bytes(f.portfolioData), market, "X");
    assert.equal(r.positionQ, C.decodePortfolio(bytes(f.portfolioData), mine.assetIndex, market).position);
    assert.equal(r.priceE6, C.decodeAsset(market, mine.assetIndex).price);
    assert.equal(r.closeOnly, C.closeOnly(market, mine.assetIndex));
    checked++;
    if (r.positionQ !== 0n) withPosition++;
  }
  assert.ok(checked >= 3, "the fixture has live vaults on the market");
  assert.ok(withPosition >= 1, "and at least one holds a position");
  assert.deepEqual(Object.entries(FEED_SYMBOLS).sort(), C.KNOWN_FEEDS.map(f => [f.id, f.symbol]).sort());
});

test("a deleveraged position is scaled, and a reset side counts for nothing", () => {
  const f = fixture.vaults.find(v => v.portfolioData && decodeVault(bytes(v.vaultData)).market === M.market
    && readVault(v.key, bytes(v.vaultData), bytes(v.portfolioData), market, "X").positionQ !== 0n)!;
  const vault = bytes(f.vaultData), pf = bytes(f.portfolioData!);
  const asset = decodeVault(vault).assetIndex;
  const full = readVault(f.key, vault, pf, market, "X").positionQ;
  const leg = [...Array(16).keys()].map(i => L.portfolio.legs + i * L.portfolio.leg_len)
    .find(o => pf[o + L.leg.active] === 1 && new DataView(pf.buffer).getUint32(o + L.leg.asset_index, true) === asset)!;
  const long = pf[leg + L.leg.side] === 0;
  const eng = L.market.slots + asset * L.market.slot_len + L.market.engine;
  // Halve the side's scale in the market account: the position counts for half.
  const m2 = new Uint8Array(market);
  const aOff = eng + (long ? L.market.a_long : L.market.a_short);
  const dv = new DataView(m2.buffer);
  const a = dv.getBigUint64(aOff, true);
  dv.setBigUint64(aOff, a / 2n, true);
  const halved = readVault(f.key, vault, pf, m2, "X");
  const abs = (x: bigint) => (x < 0n ? -x : x);
  assert.ok(abs(halved.positionQ * 2n - full) <= 2n);
  assert.equal(halved.closeOnly, true);
  // Bump the side's epoch: the stored position belongs to a side that was reset.
  const m3 = new Uint8Array(market);
  const eOff = eng + (long ? L.market.epoch_long : L.market.epoch_short);
  new DataView(m3.buffer).setBigUint64(eOff, new DataView(m3.buffer).getBigUint64(eOff, true) + 1n, true);
  assert.equal(readVault(f.key, vault, pf, m3, "X").positionQ, 0n);
});

test("accounts that are not what they should be are refused", () => {
  const f = fixture.vaults[0];
  const d = bytes(f.vaultData);
  assert.throws(() => decodeVault(d.subarray(1)), /bytes, expected/);
  const bad = new Uint8Array(d);
  bad[L.vault.magic] ^= 1;
  assert.throws(() => decodeVault(bad), /not a vault account/);
  const live = fixture.vaults.find(v => v.portfolioData && decodeVault(bytes(v.vaultData)).status !== 0 && decodeVault(bytes(v.vaultData)).market === M.market)!;
  assert.throws(() => readVault(live.key, bytes(live.vaultData), bytes(live.portfolioData!).subarray(8), market, "X"), /portfolio account is/);
  assert.throws(() => readVault(live.key, bytes(live.vaultData), null, market, "X"), /has no portfolio account/);
  assert.throws(() => readVault(live.key, bytes(live.vaultData), bytes(live.portfolioData!), market.subarray(0, 2_000), "X"), /has no asset/);
});

/** An RPC that serves the fixture and records what it was asked. */
const fakeRpc = (calls: string[], slot = () => fixture.slot) => (async (_url: any, init: any) => {
  const { method, params } = JSON.parse(init.body);
  calls.push(method);
  const acc = (b64: string | null) => (b64 ? { data: [b64, "base64"] } : null);
  const result = method === "getProgramAccounts"
    ? fixture.vaults.map(v => ({ pubkey: v.key, account: acc(v.vaultData) }))
    : { context: { slot: slot() }, value: (params[0] as string[]).map(k => acc(k === M.market ? fixture.market
        : fixture.vaults.find(v => v.key === k)?.vaultData ?? fixture.vaults.find(v => v.portfolio === k)?.portfolioData ?? null)) };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
}) as typeof fetch;

test("a read is one call, at one slot, of the vaults on our market", async () => {
  const calls: string[] = [];
  let now = 0;
  const src = new ChainSource({ rpc: "http://x", fetch: fakeRpc(calls), clock: { now: () => now } });
  const r = await src.read();
  assert.deepEqual(calls, ["getProgramAccounts", "getMultipleAccounts"]);
  assert.equal(r.slot, fixture.slot);
  const onMarket = fixture.vaults.filter(v => decodeVault(bytes(v.vaultData)).market === M.market && FEED_SYMBOLS[decodeVault(bytes(v.vaultData)).feedHex]);
  assert.equal(r.vaults.length, onMarket.length);
  now += 10_000;
  await src.read();
  assert.deepEqual(calls.slice(2), ["getMultipleAccounts"]); // the vault list is refreshed every 5 minutes
  now += 300_000;
  await src.read();
  assert.deepEqual(calls.slice(3), ["getProgramAccounts", "getMultipleAccounts"]);

  const seen = await new ExposureMonitor(src).observe();
  const total = [...seen.values()].reduce((a, e) => a + (e.positionQ < 0n ? -e.positionQ : e.positionQ), 0n);
  assert.ok(total > 0n);
  for (const e of seen.values()) assert.deepEqual(e.issues, []);
});

test("RPC failures are errors, never empty readings", async () => {
  const fail = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  await assert.rejects(new ChainSource({ rpc: "http://x", fetch: fail(500, {}) }).read(), /HTTP 500/);
  await assert.rejects(new ChainSource({ rpc: "http://x", fetch: fail(200, { error: { message: "node is behind" } }) }).read(), /node is behind/);
});

test("nothing that touches the chain can sign or send", () => {
  // No source file loads a Solana key, builds a transaction, or calls an RPC method that changes
  // state. Only the Hyperliquid adapter signs anything, and what it signs is orders on the test
  // network of that venue.
  const dir = new URL("../src/", import.meta.url).pathname;
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith(".ts"));
  assert.ok(files.length >= 10);
  const methods = new Set<string>();
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(text, /@solana\/web3|Keypair|sendTransaction|sendRawTransaction|TransactionInstruction|keypair\.json|id\.json/, f);
    assert.doesNotMatch(text, /app\/src\/chain/, `${f} must not load the app's instruction builders`);
    if (f !== "hyperliquid.ts") assert.doesNotMatch(text, /secretKey|(?<!Math)\.sign\(|@noble/, f);
    for (const m of text.matchAll(/rpc\("(\w+)"/g)) methods.add(m[1]);
    for (const m of text.matchAll(/method: "(\w+)" \| "(\w+)"/g)) { methods.add(m[1]); methods.add(m[2]); }
  }
  assert.deepEqual([...methods].sort(), ["getMultipleAccounts", "getProgramAccounts"]);
  const venues = files.filter(f => /implements HedgeVenue/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(venues.sort(), ["hyperliquid.ts", "mock-venue.ts"]);
  // The real exchange's address appears nowhere; the adapter has no way to be pointed at it.
  const hl = fs.readFileSync(path.join(dir, "hyperliquid.ts"), "utf8");
  assert.deepEqual([...hl.matchAll(/https?:\/\/[^"\s]+/g)].map(m => m[0]), ["https://api.hyperliquid-testnet.xyz"]);
  assert.doesNotMatch(hl, /signAction\([^)]*"a"\)/);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), "utf8"), /api\.hyperliquid\.xyz/, f);
  // Signing needs two libraries; nothing else is depended on.
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies ?? {}).sort(), ["@noble/curves", "@noble/hashes"]);
});
