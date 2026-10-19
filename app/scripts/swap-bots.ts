// Swap bots for a test network: wallets that swap on xDEX through the router (src/swap.ts, router
// `Swap`) around the clock, and check every swap. Test traffic, like scripts/bots.ts.
//
//   swap-arb       keeps our coin/USDC pool near the real price: on X1 the price of xDEX's own
//                  mainnet XNT/USDC.X pool (REF_POOL, read on X1 mainnet), on devnet Binance's SOL
//   swap-random    small swaps both ways on our pool, at random
//   swap-margin    swaps coin into USDC and deposits it as trading margin in the same transaction
//                  (the page's "Swap and deposit"), and now and then takes the margin back out and
//                  swaps it back into coin
//   swap-explorer  a tiny swap into another xDEX pool that has the coin on one side, and back
//
// Checked, and written to deploy/logs/<network>-swap-bots.jsonl (a failed check prints CHECK FAILED):
//   - a swap pays exactly its amount in, and delivers at least the least it accepted;
//   - the router's fee is exactly SWAP_FEE_BPS of the amount in, rounded up;
//   - the amount received equals the quote when nobody else traded the pool in between (recorded);
//   - a swap into margin raises the account's capital by exactly what was deposited;
//   - asking for more than the pool gives, or paying the fee anywhere but the treasury, is refused
//     (simulated only, so it costs nothing).
// Run: NETWORK=x1-testnet|devnet npx tsx scripts/swap-bots.ts run
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/swap";

const LOG = process.env.BOT_LOG ?? new URL(`../../deploy/logs/${C.NETWORK}-swap-bots.jsonl`, import.meta.url).pathname;
const KEYS = new URL("../../keys/bots", import.meta.url).pathname;
const PASS_SECS = Number(process.env.SWAP_PASS_SECS ?? (C.X1 ? 45 : 120));
/** xDEX's XNT/USDC.X pool on X1 mainnet: the reference price for our X1 testnet pool. */
const REF_POOL = new PublicKey("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch(C.X1 ? 120 : 400) });
const mainnet = new Connection("https://rpc.mainnet.x1.xyz", "confirmed");
const read = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const note = (o: Record<string, unknown>) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }, (_, v) => (typeof v === "bigint" ? Number(v) : v)) + "\n");
const rand = (a: number, b: number) => a + Math.random() * (b - a);
process.on("unhandledRejection", e => say("rpc", String((e as any)?.message ?? e).split("\n")[0].slice(0, 100)));

const told = new Map<string, number>();
function check(ok: boolean, what: string, more: Record<string, unknown> = {}) {
  note({ type: "check", what, ok, ...more });
  if (!ok && Date.now() - (told.get(what) ?? 0) > 600_000) {
    told.set(what, Date.now());
    say("CHECK FAILED", what, JSON.stringify(more, (_, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 300));
  }
  return ok;
}

const wallet = (name: string) => {
  fs.mkdirSync(KEYS, { recursive: true });
  const p = `${KEYS}/${name}.json`;
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return read(p);
};
const deployer = () => read(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
const faucet = () => { const p = process.env.FAUCET_KEY ?? (C.X1 ? "../keys/x1-faucet.json" : "../keys/faucet.json"); return fs.existsSync(p) ? read(p) : deployer(); };

/** Sends and waits; returns the signature, or the error text. */
async function send(label: string, kp: Keypair, ixs: TransactionInstruction[], extra: Keypair[] = []): Promise<{ sig?: string; err?: string }> {
  try {
    const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp, ...extra]);
    for (let n = 0; n < 40; n++) {
      await sleep(1500);
      const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
      if (st?.err) return { err: `failed: ${JSON.stringify(st.err)}` };
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return { sig };
    }
    return { err: "not confirmed within 60 s" };
  } catch (e: any) {
    const err = [String(e.message).split("\n")[0], ...(e.logs ?? []).filter((l: string) => /custom program error/.test(l)).slice(-1)].join(" ").slice(0, 160);
    say("FAIL", label, err);
    return { err };
  }
}
async function simulateCode(kp: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const r = await conn.simulateTransaction(tx, [kp]).catch(() => null);
  if (!r) return "rpc";
  if (!r.value.err) return "ok";
  return (r.value.logs ?? []).map(l => l.match(/custom program error: (0x[0-9a-f]+)/)?.[1]).filter(Boolean).pop() ?? JSON.stringify(r.value.err);
}

const balanceOf = async (owner: PublicKey, mint: PublicKey, program: PublicKey) => {
  if (mint.equals(NATIVE_MINT)) return BigInt(await conn.getBalance(owner));
  const a = await conn.getAccountInfo(getAssociatedTokenAddressSync(mint, owner, true, program));
  return a ? BigInt(Buffer.from(a.data).readBigUInt64LE(64)) : 0n;
};

// ---- money ----
const COIN_KEEP = C.X1 ? 40 : 0.4, COIN_LOW = C.X1 ? 10 : 0.1;
async function gas(kp: Keypair) {
  const have = await conn.getBalance(kp.publicKey);
  if (have >= COIN_LOW * LAMPORTS_PER_SOL) return;
  const from = deployer();
  const lamports = Math.round(COIN_KEEP * LAMPORTS_PER_SOL) - have;
  if (await conn.getBalance(from.publicKey) < lamports + 2 * LAMPORTS_PER_SOL) return say(`the paying wallet is low on ${C.COIN}: no top-up`);
  const r = await send("coin for a swap bot", from, [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: kp.publicKey, lamports })]);
  note({ type: "gas", wallet: kp.publicKey.toBase58(), lamports, ok: !!r.sig });
}
async function usdc(kp: Keypair, amount: number) {
  if ((await balanceOf(kp.publicKey, C.MINT, TOKEN_PROGRAM_ID)) >= BigInt(amount * C.USDC) / 2n) return;
  const f = faucet(), from = deployer(), ata = C.ata(kp.publicKey, C.MINT);
  await send("test USDC for a swap bot", from, [createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata, kp.publicKey, C.MINT), createMintToInstruction(C.MINT, ata, f.publicKey, BigInt(amount * C.USDC))], f.publicKey.equals(from.publicKey) ? [] : [f]);
}

// ---- prices ----
const coinSide = (p: S.Pool) => (p.mints[0].equals(NATIVE_MINT) ? 0 : 1) as 0 | 1;
/** USDC per coin in a pool (decimals applied). */
const priceOf = (p: S.Pool) => { const c = coinSide(p), u = (1 - c) as 0 | 1; return Number(p.reserves[u]) / 10 ** p.decimals[u] / (Number(p.reserves[c]) / 10 ** p.decimals[c]); };
async function referencePrice(): Promise<number | undefined> {
  try {
    if (!C.X1) {
      const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", { signal: AbortSignal.timeout(5000) });
      return Number((await r.json()).price) || undefined;
    }
    // xDEX's mainnet pool, read on X1 mainnet: reserves net of the fees it holds for others.
    const pa = await mainnet.getAccountInfo(REF_POOL);
    if (!pa) return undefined;
    const d = pa.data, k = (o: number) => new PublicKey(d.subarray(o, o + 32)), q = (o: number) => Number(Buffer.from(d.subarray(o, o + 8)).readBigUInt64LE());
    const [v0, v1] = await mainnet.getMultipleAccountsInfo([k(72), k(104)]);
    if (!v0 || !v1) return undefined;
    const r0 = Number(Buffer.from(v0.data).readBigUInt64LE(64)) - q(341) - q(357), r1 = Number(Buffer.from(v1.data).readBigUInt64LE(64)) - q(349) - q(365);
    const coin0 = k(168).equals(NATIVE_MINT);
    const [rc, ru, dc, du] = coin0 ? [r0, r1, d[331], d[332]] : [r1, r0, d[332], d[331]];
    return ru / 10 ** du / (rc / 10 ** dc);
  } catch { return undefined; }
}

// ---- one swap, checked ----
type Done = { out: bigint; sig: string } | undefined;
async function swap(bot: string, kp: Keypair, p: S.Pool, from: 0 | 1, amountIn: bigint, then: TransactionInstruction[] = [], label = "swap"): Promise<Done> {
  const to = (1 - from) as 0 | 1;
  const q = S.quote(p, from, amountIn, 100);
  if (q.out === 0n) return undefined;
  const fromNative = p.mints[from].equals(NATIVE_MINT);
  const inBefore = fromNative ? 0n : await balanceOf(kp.publicKey, p.mints[from], p.programs[from]);
  const r = await send(`${bot} ${label}`, kp, [...S.swapInstructions(kp.publicKey, p, from, q), ...then]);
  if (!r.sig) { note({ type: "swap", bot, pool: p.key.toBase58(), from, amountIn, ok: false, err: r.err }); return undefined; }
  const t = await conn.getTransaction(r.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
  const line = (t?.meta?.logMessages ?? []).find(l => l.includes("swap: ")) ?? "";
  const m = line.match(/swap: (\d+) in, fee (\d+), (\d+) out/);
  if (!m) { note({ type: "swap", bot, sig: r.sig, ok: true, unread: true }); return undefined; }
  const [paid, fee, out] = [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])];
  check(paid === amountIn, "a swap pays exactly its amount in", { bot, sig: r.sig, paid, amountIn });
  check(fee === S.swapFee(amountIn), "the platform fee is SWAP_FEE_BPS of the amount in", { bot, sig: r.sig, fee, want: S.swapFee(amountIn) });
  check(out >= q.minOut, "a swap delivers at least the least it accepted", { bot, sig: r.sig, out, minOut: q.minOut });
  if (!fromNative) {
    const inAfter = await balanceOf(kp.publicKey, p.mints[from], p.programs[from]);
    check(inBefore - inAfter === amountIn, "the wallet's input balance falls by exactly the amount in", { bot, sig: r.sig, before: inBefore, after: inAfter, amountIn });
  }
  note({ type: "swap", bot, sig: r.sig, pool: p.key.toBase58(), from, amountIn, out, quote: q.out, exact: out === q.out, impactBps: q.impactBps, ok: true });
  say(`${bot}: ${label} ${fmtAmt(amountIn, p.decimals[from])} ${name(p, from)} -> ${fmtAmt(out, p.decimals[to])} ${name(p, to)}${out === q.out ? "" : ` (quoted ${fmtAmt(q.out, p.decimals[to])})`}`);
  return { out, sig: r.sig };
}
const fmtAmt = (a: bigint, dp: number) => (Number(a) / 10 ** dp).toFixed(Math.min(dp, 4));
const name = (p: S.Pool, i: 0 | 1) => (p.mints[i].equals(NATIVE_MINT) ? C.COIN : p.mints[i].equals(C.MINT) ? "USDC" : p.mints[i].toBase58().slice(0, 4));
const coinAtoms = (x: number) => BigInt(Math.round(x * 1e9));

// ---- the bots ----
const ARB = wallet("swap-arb"), RANDOM = wallet("swap-random"), MARGIN = wallet("swap-margin"), EXPLORER = wallet("swap-explorer");
/** Sizes on our pool: small next to it (X1 200 XNT, devnet 1 SOL deep). */
const SMALL = C.X1 ? [0.3, 3] : [0.003, 0.02];

async function arb(p: S.Pool) {
  const ref = await referencePrice();
  if (!ref) return;
  const now = priceOf(p), gap = (now - ref) / ref;
  note({ type: "price", pool: now, ref, gapBps: Math.round(gap * 10_000) });
  if (Math.abs(gap) < 0.01) return; // within 1%: leave it
  // Move half the way: the coin reserve that gives that price on the same product.
  const c = coinSide(p), u = (1 - c) as 0 | 1;
  const x = Number(p.reserves[c]) / 10 ** p.decimals[c], y = Number(p.reserves[u]) / 10 ** p.decimals[u];
  const target = now + (ref - now) / 2;
  const x2 = Math.sqrt((x * y) / target);
  if (x2 > x) { // the coin is too dear: sell coin
    const coin = Math.min(x2 - x, C.X1 ? 15 : 0.15);
    await swap("swap-arb", ARB, p, c, coinAtoms(coin), [], `price ${now.toFixed(4)} -> ${ref.toFixed(4)}: sell`);
  } else { // too cheap: buy coin with USDC
    const usdcIn = Math.min((x - x2) * now, C.X1 ? 3 : 15);
    await swap("swap-arb", ARB, p, u, BigInt(Math.round(usdcIn * 10 ** p.decimals[u])), [], `price ${now.toFixed(4)} -> ${ref.toFixed(4)}: buy`);
  }
}

async function random(p: S.Pool) {
  const c = coinSide(p), u = (1 - c) as 0 | 1;
  if (Math.random() < 0.5) return swap("swap-random", RANDOM, p, c, coinAtoms(rand(SMALL[0], SMALL[1])));
  const usdcIn = rand(SMALL[0], SMALL[1]) * priceOf(p);
  return swap("swap-random", RANDOM, p, u, BigInt(Math.round(usdcIn * 10 ** p.decimals[u])));
}

async function capitalOf(wallet: PublicKey): Promise<bigint | undefined> {
  const a = await conn.getAccountInfo(C.routerPortfolio(wallet));
  return a ? C.decodePortfolio(a.data, 0).capital : undefined;
}
async function margin(p: S.Pool) {
  const me = MARGIN.publicKey;
  if (!(await conn.getAccountInfo(C.traderAddress(me)))) {
    await usdc(MARGIN, 20);
    const r = await send("swap-margin opens a trading account", MARGIN, [C.openTradingAccount(me), C.routerDeposit(me, 1_000_000n)]);
    note({ type: "open", bot: "swap-margin", ok: !!r.sig, err: r.err });
    return;
  }
  const cap = await capitalOf(me);
  if (cap === undefined) return;
  if (cap > BigInt(C.X1 ? 5 : 3) * BigInt(C.USDC)) {
    // Take most of it back out and swap it back into coin.
    const amount = cap - BigInt(C.USDC);
    const r = await send("swap-margin withdraws margin", MARGIN, [createAssociatedTokenAccountIdempotentInstruction(me, C.ata(me, C.MINT), me, C.MINT), C.routerWithdraw(me, amount)]);
    note({ type: "withdraw", bot: "swap-margin", amount, ok: !!r.sig, err: r.err });
    if (r.sig) await swap("swap-margin", MARGIN, p, (1 - coinSide(p)) as 0 | 1, amount, [], "margin back to coin");
    return;
  }
  const c = coinSide(p);
  const q = S.quote(p, c, coinAtoms(rand(SMALL[0], SMALL[1])), 100);
  if (q.minOut === 0n) return;
  const before = cap;
  const done = await swap("swap-margin", MARGIN, p, c, q.amountIn, [C.routerDeposit(me, q.minOut)], "swap and deposit");
  if (!done) return;
  const after = await capitalOf(me);
  check(after !== undefined && after - before === q.minOut, "a swap into margin raises capital by exactly the deposit", { sig: done.sig, before, after, deposit: q.minOut });
}

let others: S.ListedPool[] = [];
async function explorer() {
  if (!others.length) {
    try { others = (await (await fetch(`https://turbopumpx.vercel.app/api/pools?network=${C.NETWORK}`)).json()).pools ?? []; } catch { return; }
    others = others.filter(l => l.pool !== S.USDC_POOL.toBase58() && (l.a.mint === NATIVE_MINT.toBase58() || l.b.mint === NATIVE_MINT.toBase58()));
  }
  const pick = others[Math.floor(Math.random() * others.length)];
  if (!pick) return;
  const p = await S.readPool(conn, new PublicKey(pick.pool)).catch(() => undefined);
  if (!p || p.unsupported || p.status !== 0 || p.reserves[0] === 0n || p.reserves[1] === 0n) return note({ type: "skip", pool: pick.pool, why: p?.unsupported ?? "unreadable, paused or empty" });
  const c = coinSide(p);
  const q = S.quote(p, c, coinAtoms(SMALL[0] / 3), 100);
  if (q.impactBps > 300 || q.out === 0n) return note({ type: "skip", pool: pick.pool, why: `impact ${q.impactBps} bps` });
  const got = await swap("swap-explorer", EXPLORER, p, c, q.amountIn, [], `into ${pick.a.symbol}/${pick.b.symbol}`);
  if (!got) return;
  const p2 = await S.readPool(conn, p.key).catch(() => undefined);
  if (p2) await swap("swap-explorer", EXPLORER, p2, (1 - c) as 0 | 1, got.out, [], "and back");
}

/** Hourly: what must be refused, simulated only. */
async function refusals(p: S.Pool) {
  const c = coinSide(p), me = RANDOM.publicKey;
  const q = S.quote(p, c, coinAtoms(SMALL[0]), 0);
  const greedy = S.swapInstructions(me, p, c, { ...q, minOut: q.out + q.out / 100n + 1n });
  const code = await simulateCode(RANDOM, greedy);
  if (code !== "rpc") check(code === "0x1775" || code === "0x571b", "a swap asking for more than the pool gives is refused", { code });
  const wrongFee = S.swapInstructions(me, p, c, q);
  const ix = wrongFee[wrongFee.length - 2]; // the router's Swap (the last one closes wrapped coin)
  ix.keys[1] = { ...ix.keys[1], pubkey: getAssociatedTokenAddressSync(p.mints[c], me, true, p.programs[c]) };
  const code2 = await simulateCode(RANDOM, wrongFee);
  if (code2 !== "rpc") check(code2 === "0x5701", "a swap paying its fee anywhere but the treasury is refused", { code: code2 });
}

async function run() {
  say(`swap bots on ${C.NETWORK_NAME}: arb ${ARB.publicKey.toBase58().slice(0, 6)}, random ${RANDOM.publicKey.toBase58().slice(0, 6)}, margin ${MARGIN.publicKey.toBase58().slice(0, 6)}, explorer ${EXPLORER.publicKey.toBase58().slice(0, 6)}; pool ${S.USDC_POOL.toBase58()}`);
  let lastRefusals = 0, pass = 0;
  for (;;) {
    try {
      for (const kp of [ARB, RANDOM, MARGIN, EXPLORER]) await gas(kp);
      await usdc(ARB, C.X1 ? 30 : 100);
      await usdc(RANDOM, C.X1 ? 20 : 50);
      const p = await S.readPool(conn, S.USDC_POOL).catch(() => undefined);
      if (!p) { say("our coin/USDC pool is not readable (not open yet?)"); await sleep(PASS_SECS * 1000); continue; }
      if (pass === 0) say(`pool price ${priceOf(p).toFixed(4)} USDC per ${C.COIN}, reserves ${p.reserves}`);
      await arb(p);
      const fresh = async () => S.readPool(conn, S.USDC_POOL);
      const turn = pass % 4;
      if (turn === 0 || turn === 2) await random(await fresh());
      if (turn === 1) await margin(await fresh());
      if (turn === 3 && pass % 12 === 3) await explorer();
      if (Date.now() - lastRefusals > 3600_000) { await refusals(await fresh()); lastRefusals = Date.now(); }
    } catch (e: any) {
      say("pass error", String(e?.message ?? e).split("\n")[0].slice(0, 160));
    }
    pass++;
    await sleep(PASS_SECS * 1000 * rand(0.7, 1.3));
  }
}

if (process.argv[2] === "run") run();
else console.log("usage: NETWORK=x1-testnet|devnet npx tsx scripts/swap-bots.ts run");
