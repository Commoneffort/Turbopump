// A crowd for the crash drill: many accounts holding leveraged positions at once, then a price move,
// to see how fast the router clears the liquidations and what is lost when it cannot keep up.
// Local chain only (deploy/crash-drill.sh crowd starts it): the deploy key is the test USDC's mint
// authority there. Each wallet gets 100 of the chain's coin: a request carries a deposit of 0.1%
// of its value in it (returned at the fill), which on X1's rate is about 15 for a $3,000 trade.
//
//   crowd.ts open N [usdc] [leverage]   N new wallets, each funded with `usdc` (default 200) and holding
//                                       a position at about `leverage` (default 8x; majors twice that),
//                                       long or short at random, spread over the markets
//   crowd.ts crash PCT SECS [WATCH]     every price moves PCT% over SECS seconds; then the crowd is
//                                       watched for WATCH seconds (default 600) and a report printed
//
// The report: how many accounts went below their liquidation level, the most at once, how long
// until none was left, how many liquidation fills it took (a partial liquidation leaves a smaller
// position), and the accounts that ended owing money (bad debt) with the total.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";

const conn = new Connection(process.env.RPC ?? "http://127.0.0.1:18899", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR!, "utf8"))));
const ORACLE = process.env.ORACLE_CONTROL ?? "http://127.0.0.1:18090";
const DIR = process.env.CROWD_DIR ?? "../deploy/logs/drill/crowd";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[], quiet = true) {
  try {
    const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, signers[0].publicKey, ixs), ...ixs), signers);
    await conn.confirmTransaction(sig, "confirmed");
    if (!quiet) say("ok  ", label);
    return true;
  } catch (e: any) { say("FAIL", label, String(e.message).split("\n")[0].slice(0, 140)); return false; }
}

const wallets = (): Keypair[] => (fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith(".json")).sort() : []).map(f => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8")))));

async function open(n: number, usdc: number, lev: number) {
  fs.mkdirSync(DIR, { recursive: true });
  const vaults = (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1);
  if (!vaults.length) throw new Error("no open market");
  const made: Keypair[] = [];
  // Wallets, funded and with trading accounts, ten at a time.
  for (let i = 0; i < n; i++) {
    const w = Keypair.generate();
    fs.writeFileSync(`${DIR}/${String(wallets().length).padStart(4, "0")}.json`, JSON.stringify(Array.from(w.secretKey)));
    made.push(w);
  }
  for (let i = 0; i < made.length; i += 10) {
    await Promise.all(made.slice(i, i + 10).map(async w => {
      const ata = C.ata(w.publicKey, C.MINT);
      await send("fund", [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: w.publicKey, lamports: 100 * LAMPORTS_PER_SOL }), createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, w.publicKey, C.MINT), createMintToInstruction(C.MINT, ata, kp.publicKey, BigInt(usdc * C.USDC))], [kp]);
      await send("account", [C.openTradingAccount(w.publicKey), S.openStats(w.publicKey, w.publicKey)], [w]);
      await send("deposit", [C.routerDeposit(w.publicKey, BigInt(usdc * C.USDC))], [w]);
    }));
    say(`${Math.min(i + 10, made.length)} of ${made.length} accounts funded`);
  }
  // Positions: round-robin over the markets, long or short at random; a vault's queue takes 28 at
  // a time, so each wave waits for the one before to fill.
  const snap = await C.marketSnapshot(conn);
  const wave = 20;
  for (let i = 0; i < made.length; i += wave * vaults.length) {
    const batch = made.slice(i, i + wave * vaults.length);
    await Promise.all(batch.map(async (w, j) => {
      const v = vaults[j % vaults.length];
      const price = Number(C.decodeAsset(snap.market, v.assetIndex).price) / 1e6;
      const l = C.tierOfFeed(v.feedHex) === C.TIER_MAJOR ? lev * 2 : lev;
      const units = (usdc * l / price) * (0.9 + Math.random() * 0.2);
      // CROWD_LONG: the share of the crowd that goes long (0.5 = either way at random).
      const size = BigInt(Math.round(units * 1e6)) * (Math.random() < Number(process.env.CROWD_LONG ?? 0.5) ? 1n : -1n);
      await send(`request ${v.feed?.symbol}`, [C.requestTrade(w.publicKey, v.key, size)], [w]);
    }));
    say(`queued ${Math.min(i + batch.length, made.length)} of ${made.length} positions; waiting for them to fill`);
    for (let t = 0; t < 60; t++) {
      const pending = (await Promise.all(vaults.map(v => C.pendingRequests(conn, v.key)))).flat().filter(r => !r.settle).length;
      if (pending === 0) break;
      await sleep(5_000);
    }
  }
  const s = await state();
  say(`crowd ready: ${s.holding} of ${s.total} accounts hold positions (${s.vaultNotional})`);
}

/** The crowd's accounts now: how many hold positions, are below their level, owe money. */
async function state() {
  const snap = await C.marketSnapshot(conn);
  const byKey = new Map(snap.portfolios.map(p => [p.pubkey.toBase58(), p.data]));
  let holding = 0, below = 0, negative = 0, owed = 0, positions = 0;
  const ws = wallets();
  for (const w of ws) {
    const d = byKey.get(C.routerPortfolio(w.publicKey).toBase58());
    if (!d) continue;
    const h = C.accountHealth(snap.market, d);
    if (h.notional > 0n) { holding++; positions += h.positions.length; }
    if (h.liquidatable) below++;
    if (h.equity < 0n) { negative++; owed += -Number(h.equity) / 1e6; }
  }
  const vaults = (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1);
  const vaultNotional = vaults.map(v => `${v.feed?.symbol} vault ${Number(v.inventory) / 1e6}`).join(", ");
  return { total: ws.length, holding, below, negative, owed, positions, vaultNotional };
}

async function crash(pct: number, secs: number, watch: number) {
  const before = await state();
  say(`before: ${before.holding} accounts hold ${before.positions} positions; ${before.vaultNotional}`);
  const prices = await fetch(`${ORACLE}/prices`).then(r => r.json()) as Record<string, number>;
  for (const s of Object.keys(prices)) await fetch(`${ORACLE}/move?symbol=${s}&pct=${pct}&secs=${secs}`);
  const t0 = Date.now();
  let most = 0, everBelow = new Set<string>(), clearedAt: number | undefined, sawBelow = false;
  const execStart = new Date().toISOString().slice(11, 19);
  for (; Date.now() - t0 < watch * 1000; await sleep(5_000)) {
    const s = await state();
    const snap = await C.marketSnapshot(conn);
    const byKey = new Map(snap.portfolios.map(p => [p.pubkey.toBase58(), p.data]));
    for (const w of wallets()) {
      const d = byKey.get(C.routerPortfolio(w.publicKey).toBase58());
      if (d && C.accountHealth(snap.market, d).liquidatable) everBelow.add(w.publicKey.toBase58());
    }
    most = Math.max(most, s.below);
    if (s.below > 0) { sawBelow = true; clearedAt = undefined; } else if (sawBelow && clearedAt === undefined) clearedAt = Date.now();
    say(`t+${Math.round((Date.now() - t0) / 1000)}s: ${s.holding} holding, ${s.below} below their level, ${s.negative} owing $${s.owed.toFixed(2)}`);
  }
  const after = await state();
  const log = process.env.EXEC_LOG && fs.existsSync(process.env.EXEC_LOG) ? fs.readFileSync(process.env.EXEC_LOG, "utf8").split("\n").filter(l => l.slice(0, 8) >= execStart) : [];
  const liqFills = log.filter(l => /ok (forced close|fill)/.test(l) && /size 0 /.test(l)).length;
  const together = log.filter(l => /ok fill \d+ together/.test(l));
  say("==== crowd crash report");
  say(`  move: ${pct}% over ${secs} s`);
  say(`  accounts below their level at some point: ${everBelow.size} of ${before.holding} holding (most at once: ${most})`);
  say(`  time from the start of the move until none was below: ${clearedAt ? `${Math.round((clearedAt - t0) / 1000)} s` : sawBelow ? "not within the watch" : "none went below"}`);
  say(`  liquidation fills: ${liqFills}; fills sent several to a transaction: ${together.length} transactions`);
  say(`  still holding after: ${after.holding} (${after.positions} positions)`);
  say(`  accounts owing money (bad debt): ${after.negative}, total $${after.owed.toFixed(2)}`);
}

/** Throughput: small trades (`usd` each) from the crowd's wallets at `rps` a second for `secs`
 *  seconds, each wallet at most once; then waits until every one has filled or expired and reports
 *  how many filled, how fast, and what was refused at the door (a full queue, for one). */
async function load(rps: number, secs: number, usd: number) {
  const vaults = (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1);
  const ws = wallets().sort(() => Math.random() - 0.5).slice(0, Math.ceil(rps * secs));
  if (ws.length < rps * secs) say(`only ${ws.length} wallets: the run sends that many`);
  const snap = await C.marketSnapshot(conn);
  const holders = snap.portfolios.filter(p => C.accountHealth(snap.market, p.data).notional > 0n).length;
  type Job = { w: Keypair; v: typeof vaults[number]; size: bigint; before: bigint; sent?: number; ok?: boolean; err?: string; done?: number };
  const jobs: Job[] = [];
  for (const [i, w] of ws.entries()) {
    const v = vaults[i % vaults.length];
    const price = Number(C.decodeAsset(snap.market, v.assetIndex).price) / 1e6;
    const s = await C.fetchVault(conn, v.key, w.publicKey);
    const size = BigInt(Math.max(1, Math.round(usd / price * 1e6))) * (Math.random() < 0.5 ? 1n : -1n);
    jobs.push({ w, v, size, before: s.portfolio?.position ?? 0n });
  }
  say(`load: ${jobs.length} trades of $${usd} at ${rps}/s over ${vaults.length} markets; ${holders} accounts hold positions`);
  const t0 = Date.now();
  let stop = false;
  const poll = (async () => {
    while (!stop) {
      const pend = new Set((await Promise.all(vaults.map(v => C.pendingRequests(conn, v.key)))).flat().map(r => r.wallet.toBase58()));
      const now = Date.now();
      for (const j of jobs) if (j.ok && !j.done && !pend.has(j.w.publicKey.toBase58())) j.done = now;
      await sleep(500);
    }
  })();
  const sends: Promise<void>[] = [];
  for (const [i, j] of jobs.entries()) {
    const at = t0 + (i / rps) * 1000;
    if (at > Date.now()) await sleep(at - Date.now());
    j.sent = Date.now();
    sends.push((async () => {
      try {
        const ixs = [C.requestTrade(j.w.publicKey, j.v.key, j.size)];
        const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, j.w.publicKey, ixs), ...ixs), [j.w]);
        const r = await conn.confirmTransaction(sig, "confirmed");
        if (r.value.err) throw new Error(JSON.stringify(r.value.err));
        j.ok = true;
      } catch (e: any) { j.ok = false; j.err = (String(e?.message ?? e).match(/custom program error: (0x[0-9a-f]+)/)?.[1]) ?? String(e?.message ?? e).split("\n")[0].slice(0, 60); }
    })());
  }
  await Promise.all(sends);
  const sendEnd = Date.now();
  for (let t = 0; t < 240 && jobs.some(j => j.ok && !j.done); t++) await sleep(1_000);
  stop = true; await poll;
  let filled = 0, expired = 0;
  for (const j of jobs.filter(j => j.ok && j.done)) {
    const s = await C.fetchVault(conn, j.v.key, j.w.publicKey);
    if ((s.portfolio?.position ?? 0n) !== j.before) filled++; else expired++;
  }
  const lat = jobs.filter(j => j.done).map(j => (j.done! - j.sent!) / 1000).sort((a, b) => a - b);
  const q = (f: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * f))].toFixed(1) : "-";
  const lastDone = Math.max(...jobs.map(j => j.done ?? 0));
  const refused = new Map<string, number>(); for (const j of jobs.filter(j => j.ok === false)) refused.set(j.err!, (refused.get(j.err!) ?? 0) + 1);
  say(`==== load report: ${rps}/s for ${secs} s, ${holders} accounts holding`);
  say(`  sent ${jobs.length}, accepted ${jobs.filter(j => j.ok).length}, refused at the door ${jobs.filter(j => j.ok === false).length} ${JSON.stringify(Object.fromEntries(refused))}`);
  say(`  filled ${filled}, expired ${expired}, not finished ${jobs.filter(j => j.ok && !j.done).length}`);
  say(`  seconds from send to result: p50 ${q(0.5)}, p90 ${q(0.9)}, max ${q(1)}`);
  say(`  fills per second over the run: ${(filled / ((lastDone - t0) / 1000)).toFixed(2)} (sending took ${((sendEnd - t0) / 1000).toFixed(0)} s, last result at ${((lastDone - t0) / 1000).toFixed(0)} s)`);
}

/** Turns funding on for the market (anyone may). */
async function fundingOn() {
  const m = await C.fetchMarket(conn);
  if (C.fundingOf(m.data, 0).capE9 > 0n) { say("funding is on already"); return; }
  await send("funding on (SetFundingCap)", [C.setFundingCap()], [kp], false);
}
/** Each market's funding now: rate, who pays, what the vault holds. */
async function funding() {
  const m = await C.fetchMarket(conn);
  for (const v of (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1)) {
    const f = C.fundingOf(m.data, v.assetIndex);
    say(`${v.feed?.symbol}: cap ${f.capE9}, rate ${f.rateE9} e9/slot (${(C.fundingPerHour(f.rateE9) * 100).toFixed(5)}%/h, ${f.rateE9 > 0n ? "longs pay" : f.rateE9 < 0n ? "shorts pay" : "nobody"}), set at slot ${f.setSlot}; vault holds ${Number(v.inventory) / 1e6}`);
  }
}

/** The crowd's total equity and each vault's equity in Percolator (dollars). */
async function equity() {
  const snap = await C.marketSnapshot(conn);
  const byKey = new Map(snap.portfolios.map(p => [p.pubkey.toBase58(), p.data]));
  let crowd = 0;
  for (const w of wallets()) { const d = byKey.get(C.routerPortfolio(w.publicKey).toBase58()); if (d) crowd += Number(C.accountHealth(snap.market, d).equity) / 1e6; }
  const vaults = (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1);
  const parts = vaults.map(v => { const d = byKey.get(v.lpPortfolio.toBase58()); return `${v.feed?.symbol} vault ${d ? (Number(C.accountHealth(snap.market, d).equity) / 1e6).toFixed(4) : "?"}`; });
  say(`crowd equity ${crowd.toFixed(4)}; ${parts.join(", ")}`);
}

const cmd = process.argv[2];
if (cmd === "open") await open(Number(process.argv[3] ?? 100), Number(process.argv[4] ?? 200), Number(process.argv[5] ?? 8));
else if (cmd === "crash") await crash(Number(process.argv[3] ?? -8), Number(process.argv[4] ?? 120), Number(process.argv[5] ?? 600));
else if (cmd === "state") console.log(await state());
else if (cmd === "funding-on") await fundingOn();
else if (cmd === "funding") await funding();
else if (cmd === "equity") await equity();
else if (cmd === "load") await load(Number(process.argv[3] ?? 2), Number(process.argv[4] ?? 30), Number(process.argv[5] ?? 25));
else console.log("usage: crowd.ts open N [usdc] [leverage] | crash PCT SECS [WATCH] | state");
