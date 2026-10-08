// End-to-end check of standing orders against a running executor: a wallet opens a position and
// places one order of each kind, set so that each one's condition holds (or soon will), and the
// script watches the executor carry them out. Meant for a local rehearsal chain or a test network.
// Run: NETWORK=... RPC=... npx tsx scripts/orders-smoke.ts [keypair file] [SYMBOL]
import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2] ?? "../keys/seed/seed-trader-2.json", "utf8"))));
const symbol = process.argv[3] ?? "SOL";
const vault = C.canonicalVaultAddress(C.FEEDS.find(f => f.symbol === symbol)!.id);
const me = kp.publicKey;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const say = (...a: unknown[]) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`, ...a);
let failed = 0;
const check = (ok: boolean, what: string) => { say(ok ? "ok  " : "FAIL", what); if (!ok) failed++; };

async function send(label: string, ixs: TransactionInstruction[]) {
  const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, me, ixs), ...ixs), [kp]);
  for (let n = 0; n < 40; n++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`${label}: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
  }
  throw new Error(`${label}: not confirmed`);
}
const state = () => C.fetchVault(conn, vault, me);
const pos = (s: C.State) => Number(s.portfolio?.position ?? 0n) / 1e6;
/** Waits until `done(state)` holds; returns the state, or undefined after `secs`. */
async function until(done: (s: C.State) => boolean, secs: number) {
  for (const end = Date.now() + secs * 1000; Date.now() < end;) {
    const s = await state();
    if (done(s)) return s;
    await sleep(2500);
  }
  return undefined;
}
const order = (index: number, kind: number, size: number, trigger: number, more: Partial<C.OrderParams> = {}) =>
  C.placeOrder(me, vault, { index, kind, size: BigInt(Math.round(size * 1e6)), trigger: BigInt(Math.round(trigger)), ...more });

let s = await state();
if (!s.trader) await send("open account", [C.openTradingAccount(me), C.routerDeposit(me, 1_000_000_000n)]);
say(`${symbol} vault liquidity ${Number(s.vault.lastNav) / 1e6}; waiting for it to be live`);
s = (await until(x => x.vault.lastNav > 0n && !!x.book, 900))!;
check(!!s, "the vault has liquidity");
for (const o of s.orders) if (!o.queued) await send("clear old order", [C.cancelOrder(me, vault, o.index)]);
if (pos(s) !== 0) { await send("flatten", [C.requestTrade(me, vault, -s.portfolio!.position)]); await until(x => pos(x) === 0, 120); }

// A position to protect: long 2.
s = await state();
await send("market long", [C.requestTrade(me, vault, 2_000_000n)]);
s = (await until(x => pos(x) === 2, 120))!;
check(!!s, "market order: long 2 filled");
const px = () => Number(s.asset.price);

// Refusals: a stop needs a position on its side to exist at all is covered by the program's
// tests; here, an order far from the price just waits, and can be cancelled.
await send("far limit", [order(7, C.ORDER.LIMIT, 1, px() * 0.5)]);
await sleep(12_000);
s = await state();
check(s.orders.some(o => o.index === 7 && !o.queued) && pos(s) === 2, "a limit far below the price waits, untouched by the executor");
await send("cancel", [C.cancelOrder(me, vault, 7)]);
s = await state();
check(!s.orders.some(o => o.index === 7), "and its owner can cancel it");

// Take-profit on half a unit, set at a price already reached: carried out at once.
await send("take-profit", [order(0, C.ORDER.TAKE, 0.5, px() * 0.999)]);
let r = await until(x => pos(x) === 1.5 && !x.orders.some(o => o.index === 0), 150);
check(!!r, "take-profit: closed 0.5 of the long and was removed"); s = r ?? await state();

// Limit buy of 0.5 at 1% above the price: carried out at once, fills at the price or better.
await send("limit buy", [order(1, C.ORDER.LIMIT, 0.5, px() * 1.01)]);
r = await until(x => pos(x) === 2 && !x.orders.some(o => o.index === 1), 150);
check(!!r, "limit: bought 0.5 and was removed"); s = r ?? await state();

// TWAP: sell 0.6 in 3 slices, 15 seconds apart, reduce-only.
await send("twap", [order(2, C.ORDER.TWAP, -0.6, 0, { slices: 3, interval: 15, reduceOnly: true })]);
r = await until(x => Math.abs(pos(x) - 1.4) < 1e-9 && !x.orders.some(o => o.index === 2), 300);
check(!!r, "TWAP: sold 0.6 in three slices and was removed"); s = r ?? await state();

// Trailing stop of 0.01%: fires as soon as the mark comes back that much from its best.
await send("trail", [order(3, C.ORDER.TRAIL, 0, 1)]);
r = await until(x => pos(x) === 0, 420);
if (r) check(!r.orders.some(o => o.index === 3), "trailing stop: closed the position and was removed");
else {
  say("note the mark did not come back 0.01% in seven minutes: the trailing stop is still waiting (not a failure)");
  s = await state();
  const t = s.orders.find(o => o.index === 3);
  say(`     trail records best mark ${t ? Number(t.peak) / 1e6 : "?"}; mark now ${Number(s.asset.price) / 1e6}`);
  // A stop above the price closes it instead, and the trail is then swept away.
  await send("stop", [order(4, C.ORDER.STOP, 0, px() * 1.001)]);
  r = await until(x => pos(x) === 0, 150);
  check(!!r, "stop loss: closed the position");
}
r = await until(x => x.orders.length === 0, 120);
check(!!r, "no order outlives its position: all were removed");
s = await state();
say(`position ${pos(s)}, orders left ${s.orders.length}, equity ${Number(s.health?.equity ?? s.portfolio?.capital ?? 0n) / 1e6}`);
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
