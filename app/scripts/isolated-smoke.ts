// End-to-end check of isolated accounts and close-only requests against a live network and its
// running executor: a wallet opens an isolated account for one market, funds it, trades there
// while its main account stays untouched, is refused a second market in the isolated account,
// and closes with close-only requests (one oversized, one on the wrong side).
// Run: NETWORK=... npx tsx scripts/isolated-smoke.ts [keypair file] [SYMBOL] [OTHER SYMBOL]
import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2] ?? "../keys/seed/seed-trader-2.json", "utf8"))));
const [symbol, other] = [process.argv[3] ?? "BTC", process.argv[4] ?? "ETH"];
const vaultOf = (sym: string) => C.canonicalVaultAddress(C.FEEDS.find(f => f.symbol === sym)!.id);
const vault = vaultOf(symbol), vault2 = vaultOf(other);
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
/** The router error a transaction would fail with (by simulation), or "" if it would succeed. */
async function refusal(ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = me;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const r = await conn.simulateTransaction(tx);
  return r.value.err ? JSON.stringify(r.value.err) : "";
}
const code = (n: number) => `{"Custom":${n}}`;
const NOT_REDUCING = 0x5700 + 30, ISOLATED = 0x5700 + 31;

const s0 = await C.fetchVault(conn, vault, me);
const sub = C.isolatedSub(s0.vault.assetIndex);
const st = () => C.fetchVault(conn, vault, me, sub);
const mainState = () => C.fetchVault(conn, vault, me, 0);
const pos = (s: C.State) => s.portfolio?.position ?? 0n;
async function until(read: () => Promise<C.State>, done: (s: C.State) => boolean, secs: number) {
  for (const end = Date.now() + secs * 1000; Date.now() < end;) {
    const s = await read();
    if (done(s)) return s;
    await sleep(2500);
  }
  return undefined;
}
say(`wallet ${me.toBase58()}, isolated account ${sub} for ${symbol} at ${C.traderAddress(me, sub).toBase58()}`);
const mainBefore = pos(await mainState());

let s = await st();
if (!s.trader) await send("open isolated account", [C.openTradingAccount(me, sub), C.openLedger(me, me, sub)]);
s = await st();
check(!!s.trader && s.trader.sub === sub, `isolated account ${sub} exists`);
if ((s.portfolio?.capital ?? 0n) < 20_000_000n) await send("fund it", [C.routerDeposit(me, 30_000_000n, sub)]);
if (pos(s) !== 0n) { await send("flatten", [C.requestTrade(me, vault, -pos(s), { sub, closeOnly: true })]); await until(st, x => pos(x) === 0n, 120); }

// A close-only request with nothing to close is refused.
check((await refusal([C.requestTrade(me, vault, -1000n, { sub, closeOnly: true })])).includes(code(NOT_REDUCING)), "close-only with no position: refused (NotReducing)");

// Open a small long in the isolated account (about $40 at 2x of $30 margin... sized from the price).
s = await st();
const q = BigInt(Math.max(1, Math.floor(40 * 1e12 / Number(s.asset.price))));
await send("isolated long", [C.requestTrade(me, vault, q, { sub })]);
s = (await until(st, x => pos(x) === q && !x.trader?.hasPending, 120))!;
check(!!s, `isolated long ${Number(q) / 1e6} ${symbol} filled`);
check(pos(await mainState()) === mainBefore, "main account position unchanged");

// One market at a time: a second market is refused in the isolated account.
if (vault2) check((await refusal([C.requestTrade(me, vault2, q, { sub })])).includes(code(ISOLATED)), `${other} in the ${symbol} isolated account: refused (Isolated)`);

// A close-only buy on a long is refused; a close-only sell of twice the size closes exactly.
check((await refusal([C.requestTrade(me, vault, q, { sub, closeOnly: true })])).includes(code(NOT_REDUCING)), "close-only buy on a long: refused (NotReducing)");
await send("close-only sell of twice the position", [C.requestTrade(me, vault, -2n * q, { sub, closeOnly: true })]);
s = (await until(st, x => !x.trader?.hasPending, 120))!;
check(!!s && pos(s) === 0n, "the oversized close-only request closed the position and did not go short");

// The margin comes back: fees first (anyone may), then the withdrawal.
s = await st();
const pay = s.owed.flatMap(o => o.owed > 0n ? [C.payFees(s.vault, me, sub)] : []);
const cap = (await st()).portfolio?.capital ?? 0n;
const profit = s.portfolio && s.portfolio.pnl > 0n ? [C.crank(me, C.routerPortfolio(me, sub), [s.vault.assetIndex]), C.routerConvertPnl(me, sub)] : [];
if (cap > 0n) {
  try { await send("pay fees and withdraw", [...profit, ...pay, C.routerWithdraw(me, cap - 1_000_000n, sub)]); check(true, "withdrew the isolated margin"); }
  catch (e: any) { check(false, `withdraw: ${e.message}`); }
}
say(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
