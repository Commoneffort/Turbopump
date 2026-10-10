// Router executor: fills queued trades at their target price and keeps every vault's mark fresh.
// Anyone can run one (the programs check everything); whoever fills a request earns its bond.
//
// For each live vault, every second and a half (without pause while a trade is queued):
//   1. Fill every request whose target the mark is at, once Percolator's price has reached it.
//      Percolator only takes new risk on an asset that is accrued to the current slot with every
//      position on it settled, so the fill carries those cranks (see `crankPlan` in chain.ts).
//      Their number depends on the slot the transaction lands in, so two versions are sent, one
//      crank apart: only the one that matches can succeed, and the request fills once.
//   2. Expire requests nobody filled within the grace period (their bond is forfeited).
//   3. Move the mark. Once a request's target time has passed, to the first Pyth price published
//      at or after it: fetched from Hermes (one request per target) and posted on chain.
//      Otherwise to Pyth's own sponsored feed account when it is newer (free: no Hermes call, no
//      posting), never past a pending target.
//   4. Every few minutes, refresh the shared feed accounts of feeds not listed yet, so opening a
//      market (which needs a price at most 300 s old) works. One batched Hermes request.
//
// Second price source: an exchange-median price service (JACK_URL). Its prices are unsigned, so
// they reach the chain through the router's reporter key (keys/reporter-keypair.json), which is
// trusted for them. With ORACLE=pyth (default) it is only the fallback: used for a request that
// Hermes has not served 20 s after its target, which is all the router accepts there. With
// ORACLE=jack (an X1 deployment, where there is no Pyth) it is the source, and the mark is also
// refreshed from it every 30 s or on a 0.3% move. The service has no history, so the executor
// records its stream itself to know the first price at or after a target.
//
// Hermes needs an API key (Pyth's free plan covers the feeds in chain.ts FEEDS). The key is read
// from HERMES_API_KEY or ~/.config/solana/percolator-test/hermes-key and never printed.
// Run: RPC=... npx tsx scripts/executor.ts
// On X1 testnet: NETWORK=x1-testnet npx tsx scripts/executor.ts (the price service is then the
// source, the key is ~/.config/solana/percolator-x1/deployer.json, and no Hermes key is needed).
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as fs from "fs";
import { createRequire } from "module";
import * as C from "../src/chain";
import * as S from "../src/social";

// Both SDKs are CommonJS; this package is an ES module.
const require = createRequire(import.meta.url);
const { Wallet } = require("@coral-xyz/anchor");
const { PythSolanaReceiver } = require("@pythnetwork/pyth-solana-receiver");

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch(C.X1 ? 0 : 110) });
// How often a sent transaction is looked up while waiting for it. X1's RPC answers in under
// 0.1 s and does not throttle (170 requests a second went through); the public devnet one does.
const POLL_MS = C.X1 ? 150 : 400;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(
  process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`, "utf8"))));
// ---- the exchange-median price service, recorded locally ----
const ORACLE = process.env.ORACLE === "jack" || (C.X1 && process.env.ORACLE !== "pyth") ? "jack" : "pyth";
const HERMES = process.env.HERMES_URL ?? "https://pyth.dourolabs.app/hermes";
const API_KEY = ORACLE === "jack" ? "" : process.env.HERMES_API_KEY ?? fs.readFileSync(`${process.env.HOME}/.config/solana/percolator-test/hermes-key`, "utf8").trim();
const receiver = new PythSolanaReceiver({ connection: conn, wallet: new Wallet(payer) });
const FAR_BEHIND = 1_000; // slots: beyond this an asset is caught up before anything else is tried
const PRIORITY = 1_000; // micro-lamports per CU: devnet needs little
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
// A rate-limited RPC call must not take the executor down: log it and carry on next pass.
process.on("unhandledRejection", e => log("rpc", String((e as any)?.message ?? e).split("\n")[0].slice(0, 120)));

const JACK = process.env.JACK_URL ?? "http://jack0.x1.xyz:8090";
const JACK_SYMBOL: Record<string, string> = { XAU: "GOLD", XAG: "SILVER" };
const IDLE_JUMP = process.env.IDLE_JUMP === "1";
const IDLE_MARK_SECS = Number(process.env.IDLE_MARK_SECS ?? 600);
const IDLE_MARK_MOVE = Number(process.env.IDLE_MARK_MOVE ?? 0.005);
const HELD_MARK_SECS = Number(process.env.HELD_MARK_SECS ?? 60);
const HELD_MARK_MOVE = 0.001;
// How often accounts are re-valued while nothing needs them (a fill always settles the accounts it
// needs itself). On X1 every compute unit costs, and re-valuing all accounts on every third pass
// was four fifths of the executor's fees (measured 2026-10-10): there, only once a price has moved
// SETTLE_MOVE since the last time, or after SETTLE_SECS. Liquidation is at 15% of the positions
// and Percolator's own level at 10%, so a quarter of a percent of delay is well inside the gap.
const SETTLE_SECS = Number(process.env.SETTLE_SECS ?? (C.X1 ? 120 : 0));
const SETTLE_MOVE = Number(process.env.SETTLE_MOVE ?? 0.0025);
let settledAt = 0;
const settledPrice = new Map<number, bigint>();
function settleDue(market: Uint8Array, assets: number[]) {
  if (!SETTLE_SECS || Date.now() - settledAt > SETTLE_SECS * 1000) return true;
  return assets.some(a => {
    const now = Number(C.decodeAsset(market, a).price), then = Number(settledPrice.get(a) ?? 0n);
    return !then || Math.abs(now - then) / then >= SETTLE_MOVE;
  });
}
function settledNow(market: Uint8Array, assets: number[]) {
  settledAt = Date.now();
  for (const a of assets) settledPrice.set(a, C.decodeAsset(market, a).price);
}
// On a rate-limited RPC (public devnet) the jobs that are not about a waiting trade run this
// seldom, so the passes that fill trades are not refused for want of requests.
const SLOW_JOBS_MS = Number(process.env.SLOW_JOBS_SECS ?? (C.X1 ? 0 : 15)) * 1000;
const SWEEP_MIN = C.X1 ? 1e9 : 0.02e9; // lamports: below this a sweep is not worth its fee
let sweptAt = 0, bookRent = 0;
const URGENT_MARK_MOVE = 0.01; // a move this large on a market with positions is posted even while trades are queued elsewhere
const reporter = (() => {
  const p = process.env.REPORTER_KEY ?? "../keys/reporter-keypair.json";
  return fs.existsSync(p) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))) : null;
})();
type Sample = { t: number; price: number }; // t: unix seconds of the freshest quote used
const samples = new Map<string, Sample[]>();
let jackSymbols = "";

/** Keeps a ten-minute record of the service's stream for `symbols` (reconnects by itself). */
async function recordJack(symbols: string[]) {
  const want = [...new Set(symbols.map(s => JACK_SYMBOL[s] ?? s))].sort().join(",");
  if (!want || want === jackSymbols) return;
  jackSymbols = want;
  for (;;) {
    if (jackSymbols !== want) return; // the set of markets changed: a newer recorder took over
    try {
      const r = await fetch(`${JACK}/v1/stream/prices?symbols=${want.toLowerCase()}`);
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done || jackSymbols !== want) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).split("\n").find(l => l.startsWith("data: "));
          buf = buf.slice(i + 2);
          if (!line) continue;
          for (const x of JSON.parse(line.slice(6)).data ?? []) {
            if (x.status !== "ok" || !(x.price > 0)) continue; // only prices enough exchanges agree on
            const list = samples.get(x.symbol) ?? samples.set(x.symbol, []).get(x.symbol)!;
            const t = Math.floor(new Date(x.updatedAt).getTime() / 1000);
            if (list.length && t < list[list.length - 1].t) continue;
            list.push({ t, price: x.price });
            while (list.length && list[0].t < t - 600) list.shift();
          }
        }
      }
    } catch (e: any) {
      log("price service stream:", String(e?.message ?? e).slice(0, 80));
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

/** The first recorded price with a timestamp at or after `t`, and the timestamp of the one
 *  before it (which is before `t`), or null if the record does not cover `t` yet. */
function jackFirstAtOrAfter(symbol: string, t: number): { price: bigint; publish: number; prev: number } | null {
  const list = samples.get(JACK_SYMBOL[symbol] ?? symbol) ?? [];
  const i = list.findIndex(x => x.t >= t);
  if (i <= 0) return null; // nothing at or after t yet, or no earlier sample to bound it
  return { price: BigInt(Math.round(list[i].price * 1e6)), publish: list[i].t, prev: list[i - 1].t };
}
function jackLatest(symbol: string) {
  const list = samples.get(JACK_SYMBOL[symbol] ?? symbol) ?? [];
  return list.length >= 2 ? { price: BigInt(Math.round(list[list.length - 1].price * 1e6)), publish: list[list.length - 1].t, prev: list[list.length - 2].t } : null;
}

/** Posts a reported price and moves the vault's mark to it, in one transaction. */
/** `catchUpFirst`: for a price a trade is waiting on. The markets fell behind while it waited
 *  (routine cranking stops then), and every account has to be settled next: the catch-up rides in
 *  this transaction, ahead of the price, instead of taking a round of its own afterwards. */
async function advanceReported(v: C.Vault, u: { price: bigint; publish: number; prev: number }, why: string, catchUpFirst = false) {
  if (!reporter) return false;
  // The previous timestamp must be before the new one, and the account only moves forward.
  const prev = Math.min(u.prev, u.publish - 1);
  const [m, posted, clock] = await conn.getMultipleAccountsInfo([C.MARKET, C.reportAddress(v.feed!.id), SYSVAR_CLOCK_PUBKEY]);
  const market = new Uint8Array(m!.data);
  const lagCranks: TransactionInstruction[] = [];
  if (catchUpFirst && clock && servicedAssets.length) {
    const slot = new DataView(clock.data.buffer, clock.data.byteOffset).getBigUint64(0, true);
    const oldest = servicedAssets.map(a => C.decodeAsset(market, a).slotLast).reduce((x, y) => (y < x ? y : x), slot);
    // Every one of these has work whatever slot it lands in (the gap only grows): the k-th needs
    // the oldest market more than 10 (k - 1) slots behind. At most 10 slots are left over.
    const k = Math.min(4, Math.ceil((Number(slot - oldest) - 1) / 10));
    for (let i = 0; i < k; i++) lagCranks.push(C.crank(payer.publicKey, v.lpPortfolio, [...servicedAssets.filter(a => a !== v.assetIndex), v.assetIndex]));
  }
  // A price that is already posted (the service's timestamp has not moved since: a stock outside
  // its trading hours, say) is not posted again; the mark only moves to it.
  const have = posted ? C.decodeReport(new Uint8Array(posted.data)).publish : 0;
  const ixs = [...lagCranks, ...(have >= u.publish ? [] : [C.postPrice(reporter.publicKey, v.feed!.id, u.price, u.publish, prev)]), C.advanceMark(v, C.reportAddress(v.feed!.id), market)];
  const tx = new Transaction().add(...(await budgetFor(ixs)), ...ixs);
  try {
    const sig = await conn.sendTransaction(tx, have >= u.publish ? [payer] : [payer, reporter]);
    await confirmed(sig);
    log("ok", `mark ${v.feed!.symbol} -> reported ${Number(u.price) / 1e6} at ${u.publish} (${why})`);
    return true;
  } catch (e: any) {
    const logs: string[] = e?.logs ?? [];
    log("fail", `mark ${v.feed!.symbol} -> reported ${u.publish} (${why}${lagCranks.length ? `, with ${lagCranks.length} catch-up crank(s)` : ""})`, String(e?.message ?? e).split("\n")[0].slice(0, 100), logs.filter(l => /failed|error/.test(l)).slice(-1)[0] ?? "");
    // The price must not wait on the catch-up (someone else's crank may have landed first).
    return lagCranks.length ? advanceReported(v, u, why) : false;
  }
}

// ---- Hermes (rate-limited: back off for a minute on 429, as Hermes asks) ----
let hermesCalls = 0;
let backoffUntil = 0;
type Update = { vaa: string; publish: number; prev: number; feed: string };

async function hermes(path: string): Promise<any | null> {
  if (Date.now() < backoffUntil) return null;
  hermesCalls++;
  const r = await fetch(`${HERMES}${path}`, { headers: { Authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(10_000) });
  if (r.status === 429) {
    backoffUntil = Date.now() + 60_000;
    log("hermes rate limit: backing off 60 s");
    return null;
  }
  if (!r.ok) {
    log("hermes", r.status, path.split("?")[0]);
    return null;
  }
  return r.json();
}

const ids = (feeds: string[]) => feeds.map(f => `ids%5B%5D=${f}`).join("&");
const updates = (j: any): Update[] =>
  (j?.parsed ?? []).map((p: any, i: number) => ({ vaa: j.binary.data[Math.min(i, j.binary.data.length - 1)], publish: Number(p.price.publish_time), prev: Number(p.metadata.prev_publish_time), feed: p.id }));

/** The first Pyth update for `feed` published at or after `t` (prev_publish_time < t <= publish_time). */
async function firstAtOrAfter(feed: string, t: number): Promise<Update | null> {
  for (let s = t; s < t + 3; s++) {
    const u = updates(await hermes(`/v2/updates/price/${s}?${ids([feed])}&encoding=base64&parsed=true`))[0];
    if (!u) continue;
    if (u.prev < t && t <= u.publish) return u;
    if (u.publish >= t) return null;
  }
  return null;
}

// ---- chain ----
/** Waits for a signature by polling (the public RPC rate-limits the websockets confirmTransaction uses). */
async function confirmed(sig: string, processedIsEnough = false) {
  for (let i = 0; i < 20_000 / POLL_MS; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized" || (processedIsEnough && st?.confirmationStatus === "processed")) return;
  }
  throw new Error("not confirmed within 20 s");
}

/** Sends (with preflight). Only fills wait for confirmation; routine work is checked again on the
 *  next pass from chain state, so it must never hold up a trade's fill. */
async function send(label: string, ixs: TransactionInstruction[], wait = false) {
  const head = await budgetFor(ixs);
  const tx = new Transaction().add(...head, ...ixs);
  try {
    const sig = await conn.sendTransaction(tx, [payer]);
    if (wait) await confirmed(sig);
    log(wait ? "ok" : "sent", label);
    return true;
  } catch (e: any) {
    const logs: string[] = e?.logs ?? [];
    // The failing instruction is the last top-level one that started (the budget instructions come first).
    const at = logs.filter(l => l.endsWith("invoke [1]")).length - 1 - head.length;
    const ix = ixs[at];
    const what = ix?.data[0] === 5 ? `crank #${at} asset ${ix.data[10]} via ${ix.keys[2].pubkey.toBase58().slice(0, 6)}` : ix ? `instruction #${at}` : "";
    log("fail", label, String(e?.message ?? e).split("\n")[0].slice(0, 120), logs.filter(l => /failed|error/.test(l)).slice(-1)[0] ?? "", what);
    return false;
  }
}

/** Sends the Pyth builder's transactions in order (post, consume, close), confirming each by polling. */
async function sendBuilt(txs: { tx: any; signers: any[] }[]) {
  // Each transaction builds on the one before, so they go in order; only the last has to be
  // confirmed before acting on it, the others just have to have been processed.
  for (const [i, { tx, signers }] of txs.entries()) {
    tx.sign([payer, ...signers]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await confirmed(sig, i < txs.length - 1);
  }
}

/** Posts one verified update (ephemeral account) and moves the vault's mark to it. */
async function advancePosted(v: C.Vault, u: Update) {
  const market = new Uint8Array((await conn.getAccountInfo(C.MARKET))!.data);
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates([u.vaa]);
  await builder.addPriceConsumerInstructions(async (getAccount: (id: string) => any) => [
    { instruction: C.advanceMark(v, getAccount("0x" + v.feed!.id), market), signers: [] },
  ]);
  try {
    const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: PRIORITY });
    const t0 = Date.now();
    await sendBuilt(txs);
    log("ok", `mark ${v.feed!.symbol} -> Pyth ${u.publish} (target price; ${txs.length} transactions, ${((Date.now() - t0) / 1000).toFixed(1)} s, started ${(t0 / 1000 - u.publish).toFixed(1)} s after the price was published)`);
  } catch (e: any) {
    log("fail", `mark ${v.feed!.symbol} -> ${u.publish}`, String(e?.message ?? e).slice(0, 140));
  }
}

let traderKeys: PublicKey[] = [];
let traderKeysAt = 0;
/** The requests a book lists, in the order they were queued. A request lives at its owner's
 *  address, so they are found by a scan of the router's request accounts. A public RPC node's
 *  scan can be some seconds behind the chain; a request it misses would never be filled (and the
 *  mark cannot move past it), so whatever the scan lacks is looked up through the traders'
 *  accounts, each of which names its pending request and is read directly. */
async function requestsOf(v: C.Vault, b: C.Book) {
  if (!b.pending.length) return [];
  const listed = (r: C.RouterRequest) => b.pending.some(p => p.id === r.id);
  const found = (await C.pendingRequests(conn, v.key)).filter(listed);
  if (found.length < b.pending.length) {
    if (Date.now() - traderKeysAt > 20_000) {
      traderKeys = (await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.TRADER_LEN }], dataSlice: { offset: 0, length: 0 } })).map(a => a.pubkey);
      traderKeysAt = Date.now();
    }
    const owners: PublicKey[] = [];
    for (let i = 0; i < traderKeys.length; i += 100) {
      for (const a of await conn.getMultipleAccountsInfo(traderKeys.slice(i, i + 100))) {
        if (!a) continue;
        const t = C.decodeTrader(new Uint8Array(a.data));
        if (t.hasPending && t.pendingVault.equals(v.key) && !found.some(r => r.id === t.pendingId)) owners.push(t.wallet);
      }
    }
    // (A settlement has no trader behind it: ours is at our own address.)
    const keys = [...owners.map(w => C.requestAddress(v.key, w)), C.requestAddress(v.key, payer.publicKey, true)];
    for (const [i, a] of (await conn.getMultipleAccountsInfo(keys)).entries()) {
      if (!a || a.data.length !== C.REQUEST_LEN) continue;
      const r = C.decodeRequest(keys[i], new Uint8Array(a.data));
      if (listed(r) && !found.some(x => x.id === r.id)) found.push(r);
    }
  }
  return found.sort((x, y) => Number(x.id - y.id));
}

type Snapshot = { book: Uint8Array | null; feed: Uint8Array | null; market: Uint8Array; slot: bigint };

const prepared = new Set<string>(); // requests whose assets were brought current while they waited
const LAND_SLOTS = 6; // slots between reading the chain and a transaction landing, roughly
const budget = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY })];
/** The budget instructions for a transaction that is really sent. On Solana, the maximum and a
 *  small priority fee. On X1 every compute unit asked for costs 10 lamports, so: what a
 *  simulation says the instructions use plus a margin, and no priority fee. `atLeast` is for a
 *  transaction that may land in a later state than the one simulated. */
async function budgetFor(ixs: TransactionInstruction[], atLeast = 0): Promise<TransactionInstruction[]> {
  if (!C.X1) return budget();
  const fit = await C.computeLimit(conn, payer.publicKey, ixs);
  const units = Math.min(1_400_000, Math.max(fit.data.readUInt32LE(1), atLeast));
  return [ComputeBudgetProgram.setComputeUnitLimit({ units })];
}

/** Simulates `k` lag cranks, the settlement cranks and `tail`, and adjusts to what the chain
 *  reports: a crank with nothing to do is dropped, and a trade refused because an asset is still
 *  behind gets one more lag crank. Returns what would succeed now, or why nothing does. */
async function tune(lagCrank: TransactionInstruction, k: number, settle: TransactionInstruction[], tail: TransactionInstruction[]) {
  const seen: string[] = [];
  for (let round = 0; round < 10; round++) {
    // The simulation replaces the blockhash, so any well-formed one will do.
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [...budget(), ...Array(k).fill(lagCrank), ...settle, ...tail] }).compileToV0Message();
    const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    const err: any = r.value.err;
    if (!err) return { k, settle };
    const i = (err.InstructionError?.[0] ?? -1) - 2, code = err.InstructionError?.[1]?.Custom;
    seen.push(`${code ?? JSON.stringify(err.InstructionError?.[1])} at ${i} of ${k}+${settle.length}+${tail.length}`);
    const why = err.InstructionError?.[1];
    // Out of compute (with many markets the cranks alone come close to a transaction's limit):
    // settle fewer portfolios in this transaction; the rest follow on later passes.
    if ((why === "ProgramFailedToComplete" || why === "ComputationalBudgetExceeded") && settle.length > 1) settle = settle.slice(0, Math.ceil(settle.length / 2));
    else if (code === 22 && i >= 0 && i < k) k--;
    else if (code === 22 && i >= k && i < k + settle.length) settle = settle.filter((_, j) => j !== i - k);
    else if (code === 21 && i >= k && k < 12) k++;
    else return `simulation failed at instruction ${i} of ${k} + ${settle.length} + ${tail.length}: ${JSON.stringify(err)}`;
  }
  return `simulation kept changing: ${seen.join("; ")}`;
}

/** Sends alternative versions of one action at once (no preflight) and waits until one lands. */
async function race(label: string, variants: TransactionInstruction[][]) {
  const sigs: string[] = [];
  // The variants differ by one crank and only one can succeed, so on X1 each asks for what the
  // largest of them uses in simulation, with room for one more crank.
  let most = 0;
  if (C.X1) most = Math.max(...(await Promise.all(variants.map(ixs => C.computeLimit(conn, payer.publicKey, ixs)))).map(ix => ix.data.readUInt32LE(1)));
  const one = async (ixs: TransactionInstruction[]) => {
    const head = C.X1 ? [ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, most + 150_000) })] : budget();
    const sig = await conn.sendTransaction(new Transaction().add(...head, ...ixs), [payer], { skipPreflight: true }).catch(() => null);
    if (sig) sigs.push(sig);
  };
  if (C.X1) await Promise.all(variants.map(one)); else for (const ixs of variants) await one(ixs);
  for (let i = 0; i < 20_000 / (C.X1 ? POLL_MS : 500) && sigs.length; i++) {
    await new Promise(r => setTimeout(r, C.X1 ? POLL_MS : 500));
    const st = (await conn.getSignatureStatuses(sigs).catch(() => null))?.value ?? [];
    if (st.some(x => x && !x.err && (x.confirmationStatus === "confirmed" || x.confirmationStatus === "finalized"))) { log("ok", label); return true; }
    if (st.length === sigs.length && st.every(x => x?.err)) { log("fail", label, st.map(x => JSON.stringify(x!.err)).join(" / ")); return false; }
  }
  log("fail", label, "not confirmed within 20 s");
  return false;
}

/** Settles many out-of-date accounts at once: `cranks` (a plan's `settleAlone`) go out as many to a
 *  transaction as its compute allows, all transactions together, and this waits until every one has landed or failed.
 *  One after the other, a fill waited one round of about four seconds for every six accounts on
 *  its market; side by side it waits one round however many there are. Each crank catches its
 *  assets up by itself, so the transactions do not depend on each other or on the slot they land
 *  in. Returns how many transactions landed. */
async function settleAll(label: string, cranks: TransactionInstruction[]) {
  // What fits a transaction's compute: a crank costs about 110,000 units plus 55,000 for each
  // asset it names (measured on X1), and a transaction has 1,400,000.
  const cost = (ix: TransactionInstruction) => 110_000 + 55_000 * ix.data[9];
  const chunks: TransactionInstruction[][] = [];
  let room = 0;
  for (const ix of cranks) {
    if (!chunks.length || room < cost(ix) || chunks[chunks.length - 1].length >= 7) { chunks.push([]); room = 1_200_000; }
    chunks[chunks.length - 1].push(ix);
    room -= cost(ix);
  }
  const t0 = Date.now();
  const sigs: string[] = [];
  let refusedFirst = "";
  const one = async (ixs: TransactionInstruction[]) => {
    // (X1 charges for the compute asked for. Whichever of these lands first also does the
    // market's price move, which the simulation of the others did not include: more to spare.)
    const head = C.X1 ? [await C.computeLimit(conn, payer.publicKey, ixs, 1.45)] : budget();
    const sig = await conn.sendTransaction(new Transaction().add(...head, ...ixs), [payer]).catch(e => { refusedFirst ||= String(e?.message ?? e).split("\n")[0].slice(0, 100); return null; });
    if (sig) sigs.push(sig);
  };
  // Prepared and sent side by side where the RPC allows it, one after the other where it throttles.
  if (C.X1) await Promise.all(chunks.map(one)); else for (const ixs of chunks) await one(ixs);
  let landed = 0;
  for (let i = 0; i < 12_000 / POLL_MS && sigs.length; i++) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const st = (await conn.getSignatureStatuses(sigs).catch(() => null))?.value ?? [];
    if (st.length !== sigs.length) continue;
    landed = st.filter(x => x && !x.err && (x.confirmationStatus === "confirmed" || x.confirmationStatus === "finalized")).length;
    if (st.every(x => x && (x.err || x.confirmationStatus === "confirmed" || x.confirmationStatus === "finalized"))) break;
  }
  const txs = chunks.length;
  log(landed === txs ? "ok" : "fail", `settle ${cranks.length} account(s) ${label}: ${landed} of ${txs} transaction(s) landed together in ${((Date.now() - t0) / 1000).toFixed(1)} s`, refusedFirst);
  return landed;
}

/** Brings assets that are far behind up to the chain before a fill. One crank advances an asset
 *  by 10 slots and a transaction holds ten of them, so an asset 180 slots behind needs two
 *  transactions: they are sent together (three at most) instead of one per pass, which is what
 *  made fills slow, and close to their expiry, when several markets had trades queued at once.
 *  Only cranks that certainly have work are sent (a crank with nothing to do fails its whole
 *  transaction); the last few slots are left to the fill itself. */
async function catchUp(label: string, lagCrank: TransactionInstruction, lag: number, wait: boolean) {
  const sizes: number[] = [];
  // Further behind than three transactions cover (the services stood still, or trades were queued
  // for minutes on end): more transactions per pass, or catching up takes as long again as the
  // gap did.
  const most = lag > 300 ? 8 : 3;
  for (let left = Math.floor(lag / 10); left > 0 && sizes.length < most; left -= 10) sizes.push(Math.min(10, left));
  if (!sizes.length) return false;
  const sigs: string[] = [];
  for (const [i, n] of sizes.entries()) {
    const ixs = Array(n).fill(lagCrank);
    // The same cranks twice would be the same transaction: each gets a budget of its own.
    const head = C.X1
      ? [ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, (await C.computeLimit(conn, payer.publicKey, ixs)).data.readUInt32LE(1) + i) })]
      : [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY + i })];
    const sig = await conn.sendTransaction(new Transaction().add(...head, ...ixs), [payer]).catch(e => { if (i === 0) log("fail", label, String(e?.message ?? e).split("\n")[0].slice(0, 120)); return null; });
    if (sig) sigs.push(sig); else break;
  }
  if (!sigs.length) return false;
  if (wait) await confirmed(sigs[sigs.length - 1]).catch(() => undefined);
  log(wait ? "ok" : "sent", `${label} (${lag} slots behind, ${sigs.length} transaction${sigs.length > 1 ? "s" : ""})`);
  return true;
}

/** Forced closes and bookkeeping that nobody else does, while no trade is queued:
 *   - Close-outs. A close-only market (a position on it was force-reduced: the vault's Unwind, or
 *     Percolator's own liquidation) reopens only once every position on it is closed, and the
 *     vault cannot take the other side of a close there.
 *   - Liquidations. An account below the router's level is closed against the vault, before it
 *     reaches Percolator's maintenance margin (whose liquidation makes the market close-only).
 *   - A vault's tracked position is re-read when Percolator changed it outside a fill.
 *  Anyone may queue a forced close for a trader; this queues one per pass and market, and the
 *  fill path executes it at its target Pyth price like any request. */
async function watch(vaults: C.Vault[], market: Uint8Array, full: boolean) {
  const closing = vaults.filter(v => C.closeOnly(market, v.assetIndex));
  if (!closing.length && !full) return false;
  const [snap, traders, fresh] = await Promise.all([
    C.marketSnapshot(conn),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.TRADER_LEN }] }),
    conn.getMultipleAccountsInfo(vaults.map(v => v.key)),
  ]);
  const owners = new Map(traders.map(t => { const d = C.decodeTrader(new Uint8Array(t.account.data)); return [d.portfolio.toBase58(), d] as const; }));
  for (const [i, v] of vaults.entries()) {
    const lp = snap.portfolios.find(p => p.pubkey.equals(v.lpPortfolio));
    if (!lp || !fresh[i]) continue;
    const held = C.decodePortfolio(lp.data, v.assetIndex, snap.market).position;
    const tracked = C.decodeVault(v.key, new Uint8Array(fresh[i]!.data)).inventory;
    if (held !== tracked) await send(`sync ${v.feed?.symbol} vault position ${Number(tracked) / 1e6} -> ${Number(held) / 1e6}`, [C.syncInventory(v)]);
  }
  // An epoch that is over with deposits or withdrawals waiting, while the vault holds a position
  // (a flat vault is rolled directly by the keeper): settle it at a committed price if its
  // withdrawals fit in the vault's cash, otherwise it has to get flat first.
  let sent = false;
  for (const [i, v] of vaults.entries()) {
    const lp = snap.portfolios.find(p => p.pubkey.equals(v.lpPortfolio));
    if (!lp || !fresh[i]) continue;
    const cur = C.decodeVault(v.key, new Uint8Array(fresh[i]!.data));
    const over = BigInt(snap.slot) >= cur.epochStart + cur.epochLen;
    if (!over || cur.needsFlat || (cur.pendingDeposit === 0n && cur.pendingWithdraw === 0n)) continue;
    if (C.decodePortfolio(lp.data, v.assetIndex, snap.market).position === 0n || C.closeOnly(snap.market, v.assetIndex)) continue;
    const s = await C.fetchVault(conn, v.key);
    if (!s.book) continue;
    // One settlement in the queue is enough (this scan also runs while trades are queued).
    if (s.book.pending.length && (await requestsOf(v, s.book)).some(r => r.settle)) continue;
    if (C.canSettleOpen(s)) sent = (await send(`queue settlement of ${v.feed?.symbol} epoch ${cur.epoch}`, [C.requestSettle(payer.publicKey, v.key)], true)) || sent;
    else await send(`require flat ${v.feed?.symbol} (withdrawals exceed the vault's cash)`, [C.requireFlat(v)]);
  }
  const queue = (v: C.Vault, wallet: PublicKey, why: string) =>
    send(`queue ${why} ${v.feed?.symbol} for ${wallet.toBase58().slice(0, 6)}`, [C.requestClose(payer.publicKey, wallet, v.key)], true);
  const busy = new Set<string>();
  for (const v of closing) {
    const holder = snap.portfolios.find(p => { const o = owners.get(p.pubkey.toBase58()); return o && !o.hasPending && C.decodePortfolio(p.data, v.assetIndex, snap.market).position !== 0n; });
    if (!holder) continue;
    const t = owners.get(holder.pubkey.toBase58())!;
    busy.add(holder.pubkey.toBase58());
    sent = (await queue(v, t.wallet, "close-out")) || sent;
  }
  for (const p of snap.portfolios) {
    const o = owners.get(p.pubkey.toBase58());
    if (!o || o.hasPending || busy.has(p.pubkey.toBase58())) continue;
    const h = C.accountHealth(snap.market, p.data);
    if (!h.liquidatable) continue;
    // Close the largest position first; the next pass looks again.
    const worst = h.positions.reduce((a, b) => (b.notional > a.notional ? b : a));
    const v = vaults.find(x => x.assetIndex === worst.asset);
    if (v && !C.closeOnly(snap.market, v.assetIndex)) sent = (await queue(v, o.wallet, `liquidation (equity ${(Number(h.equity) / 1e6).toFixed(2)} on ${(Number(h.notional) / 1e6).toFixed(2)} notional)`)) || sent;
  }
  return sent;
}

/** Routine upkeep while no trade is queued: finalize parked sides, keep every listed asset within
 *  ~50 slots of the chain (one crank advances all of them by 10), and every third pass settle
 *  the positions that price moves left out of date, so a fill has little left to do. */
async function upkeep(vaults: C.Vault[], market: Uint8Array, slot: bigint, pass: number, force = false) {
  // IDLE_JUMP=1 is for a Percolator build in which a market with no positions catches up in
  // one crank (a prototype, not deployed anywhere): such markets are then left alone until
  // someone trades on them, and only markets with positions are kept current.
  const all = vaults.map(v => v.assetIndex);
  const every = IDLE_JUMP ? all.filter(a => { const s = C.decodeAsset(market, a); return s.oiLong !== 0n || s.oiShort !== 0n; }) : all;
  const resets = all.flatMap(a => C.finalizeResets(market, a));
  if (resets.length) await send("finalize side reset", resets);
  // One transaction has compute for about ten cranks of four assets (and a crank names at most
  // 16). With more markets than that, each pass works on the four furthest behind, which rotates
  // through all of them.
  const age = new Map(every.map(a => [a, C.decodeAsset(market, a).slotLast]));
  const assets = [...every].sort((a, b) => Number(age.get(a)! - age.get(b)!)).slice(0, 4);
  const oldest = assets.map(a => age.get(a)!).reduce((m, t) => (t < m ? t : m), slot);
  const lag = Number(slot - oldest);
  if (!assets.length) return;
  const vehicle = vaults[0].lpPortfolio;
  const due = settleDue(market, all);
  if (force && !due) return;
  // `force`: the settling pass that runs while trades are queued. Routine cranking is off then,
  // so the assets are usually far behind: they are caught up first, then the accounts settled.
  if (force && lag > 60) await catchUp("catch up before settling accounts", C.crank(payer.publicKey, vehicle, assets), lag, true);
  // Far behind, nothing can be settled yet (a settling transaction would need a crank for every
  // ten slots of the gap, thousands of them): only catch up, on every pass.
  if (lag > FAR_BEHIND) { if (!force) await catchUp("catch up", C.crank(payer.publicKey, vehicle, assets), lag, false); return; }
  if (due && ((pass % 3 === 0 && lag <= 60) || force)) {
    const snap = await C.marketSnapshot(conn);
    const plan = C.crankPlan(snap, payer.publicKey, vehicle, undefined, undefined, assets);
    // Still too far behind for one transaction to bridge (it holds about ten lag cranks, and more
    // do not even fit in its size): the next pass catches up further.
    if (plan.lag > 100) return;
    // Many accounts and the assets close to current: all at once (see `settleAll`).
    if (plan.settle.length > 6 && plan.lag < 10) { if (await settleAll("out of date", plan.settleAlone)) settledNow(snap.market, all); return; }
    if (plan.settle.length) {
      const t = await tune(plan.lagCrank, Math.max(1, Math.ceil((plan.lag + LAND_SLOTS) / 10)), plan.settle.slice(0, 6), []);
      if (typeof t === "string") log("fail", "settle positions", t);
      else if (t.settle.length) { await send(`settle ${t.settle.length} out-of-date portfolio(s)`, [...Array(t.k).fill(plan.lagCrank), ...t.settle]); if (plan.settle.length <= 6) settledNow(snap.market, all); }
      return;
    }
    // Nothing is out of date: the next look is a period away, or a price move.
    settledNow(snap.market, all);
  }
  if (lag > 50) await send(`crank ${assets.length} asset(s) (${lag} slots behind)`, Array(Math.min(10, Math.ceil(lag / 10))).fill(C.crank(payer.publicKey, vehicle, assets)));
}

/** Executes a queued epoch settlement: the vault's own position has to be settled at the mark
 *  (one crank on its portfolio once its asset is current), then the router rolls the epoch. */
async function settleEpoch(v: C.Vault, r: C.RouterRequest, what: string) {
  const [snap, va] = await Promise.all([C.marketSnapshot(conn), conn.getAccountInfo(v.key)]);
  if (!va) return;
  const cur = C.decodeVault(v.key, new Uint8Array(va.data));
  const own = { ...snap, portfolios: snap.portfolios.filter(p => p.pubkey.equals(v.lpPortfolio)) };
  const plan = C.crankPlan(own, payer.publicKey, v.lpPortfolio, v.assetIndex);
  const k = Math.max(1, Math.ceil((plan.lag + LAND_SLOTS) / 10));
  if (k > 8) {
    await send(`catch up for settlement ${what} (${plan.lag} slots behind)`, Array(Math.min(k, 12)).fill(plan.lagCrank), true);
    return;
  }
  const tail = [C.settleEpoch(payer.publicKey, cur, r, C.marketHeader(snap.market).nextMarketId)];
  const t = await tune(plan.lagCrank, k, plan.settle, tail);
  if (typeof t === "string") {
    log("fail", `settle epoch ${cur.epoch} of ${what}`, t);
    // 0x560e: the withdrawals do not fit in the vault's cash after all. It has to get flat.
    if (t.includes('"Custom":22030') && !cur.needsFlat) await send(`require flat ${v.feed?.symbol}`, [C.requireFlat(v)]);
    return;
  }
  const version = (n: number) => [...Array(n).fill(plan.lagCrank), ...t.settle, ...tail];
  await race(`settle epoch ${cur.epoch} of ${what} at ${Number(C.decodeAsset(snap.market, v.assetIndex).price) / 1e6} with the vault's position open`, [version(t.k), version(t.k + 1)]);
}

async function serviceVault(v: C.Vault, now: number, snap: Snapshot, queued: boolean): Promise<boolean> {
  if (!snap.book) {
    await send(`open book ${v.feed?.symbol}`, [C.openBook(payer.publicKey, v.key)]);
    return false;
  }
  let b = C.decodeBook(snap.book);
  const reqs = await requestsOf(v, b);
  const live = reqs.filter(r => now <= r.target + C.ROUTER_GRACE_SECS);

  // 0. While a request waits for its target time, bring every asset its fill will touch up to
  //    the chain (once per request), so the fill itself has only a few seconds to catch up.
  for (const r of live.filter(r => r.target > b.markPublish && now < r.target && !prepared.has(`${v.key}:${r.id}`))) {
    prepared.add(`${v.key}:${r.id}`);
    const plan = C.crankPlan(await C.marketSnapshot(conn), payer.publicKey, v.lpPortfolio, v.assetIndex, r.settle ? undefined : r.wallet);
    if (plan.lag <= 15) continue;
    await catchUp(`get ready for ${v.feed?.symbol} #${r.id}`, plan.lagCrank, plan.lag, false);
  }

  // 1. Time-critical: once the earliest pending target has passed, post the first Pyth price at
  //    or after it (only while its requests can still fill), then fill at it right away.
  const waiting = live.filter(r => r.target > b.markPublish).map(r => r.target);
  const earliest = waiting.length ? Math.min(...waiting) : null;
  // (Wall time decides when to ask Hermes: the chain clock can run a second or two behind it.)
  // The router does not move the mark past a request that is still in the book at or before it
  // (it would lose its price), so such a request is filled, or expired, first: steps 2 and 3.
  const owed = reqs.some(r => r.target <= b.markPublish);
  if (!owed && earliest !== null && Math.max(now, Date.now() / 1000) >= earliest + 0.6 && now < earliest + C.ROUTER_GRACE_SECS - 3) {
    const u = ORACLE === "pyth" ? await firstAtOrAfter(v.feed!.id, earliest).catch(() => null) : null;
    let moved = false;
    if (u && u.publish > b.markPublish) {
      await advancePosted(v, u);
      moved = true;
    } else if (ORACLE === "jack" || Date.now() / 1000 >= earliest + C.REPORT_FALLBACK_SECS + 1) {
      // No Pyth price for this target (Hermes down, out of quota, or no Pyth on this chain):
      // the recorded exchange-median price at the target, through the reporter key.
      const j = jackFirstAtOrAfter(v.feed!.symbol, earliest);
      if (j && j.publish > b.markPublish) moved = await advanceReported(v, j, ORACLE === "jack" ? "target price" : "fallback: no Pyth price for this target", true);
    }
    if (moved) {
      const ba = await conn.getAccountInfo(C.bookAddress(v.key));
      if (ba) b = C.decodeBook(new Uint8Array(ba.data));
    }
  }

  // 2. Fill requests the mark is at. The cranks in front bring every asset involved to the
  //    current slot (which also walks Percolator's price to the mark) and settle the positions
  //    that leaves out of date; a miss is retried next pass.
  const refused = new Set<bigint>();
  const tried = new Set<bigint>(); // settlements executed (or attempted) in this pass
  for (const r of live.filter(r => b.markPrev < r.target && r.target <= b.markPublish)) {
    const what = `${v.feed?.symbol} #${r.id}`;
    if (r.settle) { await settleEpoch(v, r, what); tried.add(r.id); continue; }
    // Getting ready (catching up, settling the market's accounts) and the fill follow each other
    // here without going back through the whole pass in between, which cost seconds each time.
    for (let attempt = 0; attempt < 4; attempt++) {
    const plan = C.crankPlan(await C.marketSnapshot(conn), payer.publicKey, v.lpPortfolio, v.assetIndex, r.wallet);
    const k = Math.max(1, Math.ceil((plan.lag + LAND_SLOTS) / 10));
    if (k > 6) {
      // Too far behind to catch up inside the fill: advance first, wait, then fill.
      if (!(await catchUp(`catch up for ${what}`, plan.lagCrank, plan.lag, true))) break;
      continue;
    }
    if (plan.settle.length > 3) {
      // More accounts to settle than fit in the fill's own transaction: all of them at once,
      // then the fill. (A settling crank catches up at most 10 slots by itself.)
      // Further behind than that (routine cranking stops while a trade waits for its price):
      // the catch-up goes out just ahead of them, without waiting for it. Should a settling
      // transaction overtake it, an account or two stay out of date and go with the fill.
      if (plan.lag >= 10) await send(`catch up for ${what} (${plan.lag} slots behind)`, Array(Math.max(1, Math.ceil((plan.lag - 1) / 10))).fill(plan.lagCrank));
      if ((await settleAll(`for ${what}`, plan.settleAlone)) === 0) break;
      continue;
    }
    const tail = [...plan.resets, C.fillRequest(payer.publicKey, v, r)];
    let t = await tune(plan.lagCrank, k, plan.settle, plan.settle.length > 3 ? [] : tail);
    if (typeof t !== "string" && plan.settle.length > 3 && t.settle.length <= 3) t = await tune(plan.lagCrank, t.k, t.settle, tail);
    if (typeof t === "string" ? t.includes("ProgramFailedToComplete") : t.settle.length > 3) {
      // Settling this many accounts does not fit in one transaction with the fill (compute
      // budget): settle first, wait, fill next pass. The price does not move again meanwhile.
      const first = typeof t === "string" ? await tune(plan.lagCrank, k, plan.settle.slice(0, 6), []) : { k: t.k, settle: t.settle.slice(0, 6) };
      if (typeof first === "string") { log("fail", `settle for ${what}`, first); break; }
      if (!(await send(`settle ${first.settle.length} account(s) for ${what}`, [...Array(first.k).fill(plan.lagCrank), ...first.settle], true))) break;
      continue;
    }
    // Refused whatever the cranks: Percolator will not take this trade (the router ends the
    // cases it can foresee itself, without trading). It is expired below once it has stalled.
    if (typeof t === "string") { log("fail", `fill ${what}`, t); refused.add(r.id); break; }
    const tuned = t;
    // The lag crank count is right for the slot simulated; one more is right from the next
    // 10-slot boundary on. Whichever matches the landing slot fills; the other fails harmlessly.
    const version = (n: number) => [...Array(n).fill(plan.lagCrank), ...tuned.settle, ...tail];
    await race(`${r.size === 0n ? "forced close" : "fill"} ${what} size ${Number(r.size) / 1e6} at ${Number(b.markPrice) / 1e6} (${tuned.k} lag + ${tuned.settle.length} settle cranks)`, [version(tuned.k), version(tuned.k + 1)]);
    log(`  ${what}: ${Math.round(Date.now() / 1000 - (r.target - C.ROUTER_DELAY_SECS))} s from request to result (${(Date.now() / 1000 - r.target).toFixed(1)} s after its price time)`);
    break;
    }
  }

  // 3. Expire requests past their grace period, and a request this pass could not fill once
  //    the mark has held its price for the stall time: it is in the way of every request behind
  //    it (the mark cannot move past it), and a liquidation may be among them.
  const stalled = b.markSet > 0 && now > b.markSet + C.ROUTER_STALL_SECS;
  // A settlement whose epoch has rolled already (another one, or the keeper, got there first)
  // has nothing left to do and goes at once: the mark cannot move past it while it is queued.
  let dead = false;
  if (reqs.some(r => r.settle && !tried.has(r.id))) {
    const va = await conn.getAccountInfo(v.key);
    const cur = va && C.decodeVault(v.key, new Uint8Array(va.data));
    dead = !!cur && (snap.slot < cur.epochStart + cur.epochLen || (cur.pendingDeposit === 0n && cur.pendingWithdraw === 0n));
  }
  for (const r of reqs.filter(r => now > r.target + C.ROUTER_GRACE_SECS || (dead && r.settle && !tried.has(r.id)) || (stalled && refused.has(r.id) && b.markPrev < r.target && r.target <= b.markPublish))) {
    await send(`expire ${v.feed?.symbol} #${r.id}${now > r.target + C.ROUTER_GRACE_SECS ? "" : dead && r.settle ? " (its epoch has rolled)" : " (it cannot fill, and others are waiting behind it)"}`, [C.expireRequest(payer.publicKey, r)]);
  }

  // 4. Free: move the mark to Pyth's sponsored feed account when it is newer, never past a
  //    pending target.
  // While trades are queued on other markets they come first, with one exception: a market with
  // positions whose price has moved 1% or more is brought up to date at once. Liquidations and
  // stops depend on it, and in a fast market there is always a trade queued somewhere.
  if (ORACLE === "jack" && live.length === 0 && reqs.length === 0) {
    // No sponsored feed accounts here: refresh the mark from the price service every 30 s or
    // on a 0.3% move (each refresh is a transaction, so not on every tick). That is for a market
    // with positions, where liquidations depend on the mark. A market nobody holds a position on
    // needs no more than a price that is roughly right for the next trader to look at (the trade
    // itself fills at the price at its target time): every 10 minutes, or on a 0.5% move.
    const j = jackLatest(v.feed!.symbol);
    const moved = j && b.markPrice > 0n ? Math.abs(Number(j.price) / Number(b.markPrice) - 1) : 1;
    const a = C.decodeAsset(snap.market, v.assetIndex);
    const held = a.oiLong !== 0n || a.oiShort !== 0n;
    const [every, move] = held ? [HELD_MARK_SECS, 0.003] : [IDLE_MARK_SECS, IDLE_MARK_MOVE];
    const urgent = held && moved >= URGENT_MARK_MOVE;
    // With positions open: at once on a 0.3% move, after 30 s on a 0.1% move, and every 60 s
    // whatever the price did. Each update is followed by a re-valuation of every account on the
    // market, which is most of what the service costs; a price that has not moved needs neither.
    const age = j ? j.publish - b.markPublish : 0;
    if ((!queued || urgent) && j && j.publish > b.markPublish && (age >= every || moved >= move || (held && age >= 30 && moved >= HELD_MARK_MOVE))) await advanceReported(v, j, urgent && queued ? "refresh: the price moved 1% or more" : held ? "refresh" : "refresh, no positions");
  } else if (snap.feed && live.length === 0 && reqs.length === 0) {
    const p = C.decodePyth(snap.feed);
    const a = C.decodeAsset(snap.market, v.assetIndex);
    const urgent = (a.oiLong !== 0n || a.oiShort !== 0n) && b.markPrice > 0n && Math.abs(Number(p.e6) / Number(b.markPrice) - 1) >= URGENT_MARK_MOVE;
    if (p.publish > b.markPublish && (!queued || urgent)) await send(`mark ${v.feed!.symbol} -> sponsored ${p.publish}`, [C.advanceMark(v, C.feedAccount(v.feed!.id), snap.market)]);
  }
  return reqs.length > 0;
}

// ---- standing orders ----
const orderRetry = new Map<string, number>(); // order address -> not before (ms)
let ordersAt = 0;
let orderCache: C.StandingOrder[] = [];
/** Carries out the standing orders whose condition holds at their vault's mark (stop,
 *  take-profit, limit, a TWAP slice that is due), records a trailing stop's better mark once it
 *  is 0.1% better than the one recorded, and removes orders that can do nothing any more. Each is
 *  one small transaction; the request it queues is then filled like any other. */
async function serviceOrders(vaults: C.Vault[], books: Map<string, C.Book>, market: Uint8Array, now: number, slot: bigint) {
  if (Date.now() - ordersAt > (C.X1 ? 4_000 : 6_000)) {
    const accs = await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.ORDER_LEN }] });
    orderCache = accs.map(a => C.decodeOrder(a.pubkey, new Uint8Array(a.account.data)));
    ordersAt = Date.now();
  }
  const due = orderCache.filter(o => !o.queued && (orderRetry.get(o.key.toBase58()) ?? 0) <= Date.now() && vaults.some(v => v.key.equals(o.vault)) && books.has(o.vault.toBase58()));
  if (!due.length) return;
  const accs = await conn.getMultipleAccountsInfo(due.flatMap(o => [C.routerPortfolio(o.wallet), C.traderAddress(o.wallet)]));
  const queuedNow = new Set<string>(); // a wallet has one request at a time: its other orders wait for the next pass
  for (const [i, o] of due.entries()) {
    const v = vaults.find(x => x.key.equals(o.vault))!, b = books.get(o.vault.toBase58())!;
    const pf = accs[2 * i], tr = accs[2 * i + 1];
    if (!pf || !tr) continue;
    const held = C.decodePortfolio(new Uint8Array(pf.data), v.assetIndex, market).position;
    const what = C.orderAction(o, b.markPrice, held, now);
    if (what === "wait") continue;
    // A trail's record is only worth a transaction once the mark is clearly better.
    if (what === "record" && (o.peak === 0n || (b.markPrice > o.peak ? b.markPrice - o.peak : o.peak - b.markPrice) * 1000n < o.peak)) continue;
    if (what === "fire" && (queuedNow.has(o.wallet.toBase58()) || C.decodeTrader(new Uint8Array(tr.data)).hasPending || b.pending.length >= 30 || C.closeOnly(market, v.assetIndex))) continue;
    // A vault closing its position to pay withdrawals takes only trades that shrink it: an order
    // the other way would be queued, filled with nothing and due again at once. It waits.
    if (what === "fire" && v.needsFlat && slot >= v.epochStart + v.epochLen) {
      const buys = o.kind <= C.ORDER.TRAIL ? held < 0n : o.size > 0n;
      if (buys ? v.inventory <= 0n : v.inventory >= 0n) { orderRetry.set(o.key.toBase58(), Date.now() + 30_000); continue; }
    }
    const name = ["stop", "take-profit", "trailing stop", "limit", "TWAP"][o.kind] ?? "order";
    const ok = await send(`${what === "fire" ? "carry out" : what === "record" ? "record a better mark for" : "remove"} ${name} of ${o.wallet.toBase58().slice(0, 6)} on ${v.feed?.symbol} (mark ${Number(b.markPrice) / 1e6})`, [C.triggerOrder(payer.publicKey, o)], true);
    // Refused (not enough margin, the mark moved back): leave it a while. Done: read the orders again.
    if (ok) { ordersAt = 0; if (what === "fire") queuedNow.add(o.wallet.toBase58()); } else orderRetry.set(o.key.toBase58(), Date.now() + 30_000);
  }
}

// ---- copy trading and track records ----
let copiesAt = 0;
let copyCache: S.Copy[] = [];
const copyRetry = new Map<string, number>();
/** Brings every follower whose position has left its leader's in line (router `TriggerCopy`:
 *  anyone may, the size is the router's to compute). Where the follower's margin does not take
 *  the whole difference, the step that it does take is sent. One request per wallet at a time. */
async function serviceCopies(vaults: C.Vault[], books: Map<string, C.Book>, market: Uint8Array) {
  if (Date.now() - copiesAt > (C.X1 ? 6_000 : 20_000)) {
    const accs = await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: S.COPY_LEN }, { memcmp: { offset: 0, bytes: S.COPY_TAG } }, { memcmp: { offset: 8, bytes: C.MARKET.toBase58() } }] });
    copyCache = accs.map(a => S.decodeCopy(a.pubkey, new Uint8Array(a.account.data)));
    copiesAt = Date.now();
  }
  const due = copyCache.filter(c => (copyRetry.get(c.key.toBase58()) ?? 0) <= Date.now());
  if (!due.length) return;
  const accs = await conn.getMultipleAccountsInfo(due.flatMap(c => [C.routerPortfolio(c.follower), C.traderAddress(c.follower), C.routerPortfolio(c.leader)]));
  const abs = (x: bigint) => (x < 0n ? -x : x);
  for (const [i, c] of due.entries()) {
    const pf = accs[3 * i], tr = accs[3 * i + 1], lpf = accs[3 * i + 2];
    if (!pf || !tr || !lpf || C.decodeTrader(new Uint8Array(tr.data)).hasPending) continue;
    const fd = new Uint8Array(pf.data), ld = new Uint8Array(lpf.data);
    const eq = (d: Uint8Array) => { const p = C.decodePortfolio(d, 0); return p.capital + p.pnl; };
    for (const v of vaults) {
      const b = books.get(v.key.toBase58());
      if (!b || b.pending.length >= 28 || C.closeOnly(market, v.assetIndex)) continue; // (the last 4 places are for forced closes and settlements)
      const price = C.decodeAsset(market, v.assetIndex).price;
      const held = C.decodePortfolio(fd, v.assetIndex, market).position, lead = C.decodePortfolio(ld, v.assetIndex, market).position;
      const target = S.copyTarget(lead, eq(ld), eq(fd), c.ratioBps, c.maxNotional, price);
      if (!S.copyDue(held, target, price)) continue;
      // The whole difference, or as far towards it as the follower's margin goes.
      let size = 0n;
      const room = C.marginRoom(market, fd, v.assetIndex);
      const grows = target !== 0n && (held === 0n || (held > 0n) !== (target > 0n) || abs(target) > abs(held));
      if (grows && abs(target) > room) {
        const reach = target > 0n ? room : -room;
        size = reach - held;
        // The router takes no less than a quarter of the difference, or the follower's equity
        // in notional if that is less (nobody can keep a follower's place in the queue taken
        // with slivers).
        const quarter = abs(target - held) / 4n, oneX = eq(fd) > 0n && price > 0n ? eq(fd) * C.UNIT / price : abs(target - held);
        const minPart = quarter < oneX ? quarter : oneX;
        if (size === 0n || (size > 0n) !== (target - held > 0n) || abs(size) * price / C.UNIT < S.MIN_COPY_NOTIONAL || abs(size) < minPart) { copyRetry.set(c.key.toBase58(), Date.now() + 60_000); continue; }
      }
      const who = `${c.follower.toBase58().slice(0, 6)} to ${c.leader.toBase58().slice(0, 6)}`;
      const ok = await send(`copy: bring ${who} in line on ${v.feed?.symbol} (${Number(held) / 1e6} -> ${Number(size === 0n ? target : held + size) / 1e6})`, [S.triggerCopy(payer.publicKey, c, v.key, size)], true);
      if (!ok) copyRetry.set(c.key.toBase58(), Date.now() + 30_000);
      break; // one request per wallet at a time: its other markets follow on later passes
    }
  }
}

let convertAt = 0;
const convertRetry = new Map<string, number>();
/** Turns traders' booked profit into capital (router `ConvertPnl`, which anyone may send). A gain
 *  is booked as profit first, and a withdrawal only pays out capital: without this a trader who
 *  won could take out the margin but not the winnings. A few accounts a minute. */
async function convertProfits(vaults: C.Vault[], market: Uint8Array) {
  if (Date.now() - convertAt < 45_000 || !vaults.length) return;
  convertAt = Date.now();
  const accs = await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.TRADER_LEN }, { memcmp: { offset: 8, bytes: C.MARKET.toBase58() } }] });
  const traders = accs.map(a => C.decodeTrader(new Uint8Array(a.account.data))).filter(t => !t.hasPending && (convertRetry.get(t.wallet.toBase58()) ?? 0) <= Date.now());
  let sent = 0;
  for (let i = 0; i < traders.length && sent < 4; i += 100) {
    const chunk = traders.slice(i, i + 100);
    const pfs = await conn.getMultipleAccountsInfo(chunk.map(t => t.portfolio));
    for (const [j, t] of chunk.entries()) {
      if (sent >= 4 || !pfs[j]) continue;
      const d = new Uint8Array(pfs[j]!.data);
      if (C.decodePortfolio(d, 0).pnl < 1_000_000n) continue;
      sent++;
      // Percolator converts for an account it has just looked at: the account's own crank goes first.
      // Only for an account with no position: that is when it can withdraw, and Percolator
      // releases little of a gain while the position that made it is still open.
      if (C.openPositions(d) !== 0) { sent--; continue; }
      const ixs = [C.crank(payer.publicKey, t.portfolio, [vaults[0].assetIndex]), C.routerConvertPnl(t.wallet)];
      // Refused (nothing released yet, or the account moved meanwhile): leave it for ten minutes.
      if (!(await send(`turn the profit of ${t.wallet.toBase58().slice(0, 6)} into capital`, ixs, true))) convertRetry.set(t.wallet.toBase58(), Date.now() + 600_000);
    }
  }
}

let statsAt = 0;
/** Opens a track record for every trading account that has none (a few per pass; it costs its
 *  rent once). From then on the router books that account's deposits, withdrawals and fills. */
async function openTrackRecords() {
  if (Date.now() - statsAt < 60_000) return;
  statsAt = Date.now();
  const accs = await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.TRADER_LEN }, { memcmp: { offset: 8, bytes: C.MARKET.toBase58() } }] });
  const without = accs.map(a => C.decodeTrader(new Uint8Array(a.account.data))).filter(t => !t.hasStats);
  for (const t of without.slice(0, 4)) {
    // Refused (a router that does not have track records yet): leave it for ten minutes.
    if (!(await send(`open the track record of ${t.wallet.toBase58().slice(0, 6)}`, [S.openStats(payer.publicKey, t.wallet)], true))) { statsAt = Date.now() + 540_000; return; }
  }
  if (without.length > 4) statsAt = 0;
}

let vaultList: C.Vault[] = [];
let servicedAssets: number[] = []; // the asset of every market being serviced
let idleNames = "?";
let lastFeedRefresh = 0;
const posted = new Map<string, number>(); // feed id -> when its listing price was last posted
let refreshing = false;
/** Keeps the shared (shard 0) feed accounts of unlisted feeds under ~4 minutes old, so opening a
 *  market works. One batched Hermes request for all stale ones, every 3 minutes at most. */
async function refreshUnlistedFeeds(listed: Set<string>) {
  const wall = Math.floor(Date.now() / 1000);
  if (ORACLE === "jack") {
    // No Pyth here: a market is listed at the reported price, so the reporter keeps one posted
    // (at most 3 minutes old) for each feed that has no market yet.
    for (const f of C.FEEDS.filter(f => !listed.has(f.id))) {
      const j = jackLatest(f.symbol);
      if (!reporter || !j || wall - (posted.get(f.id) ?? 0) < 180) continue;
      posted.set(f.id, wall);
      const post = [C.postPrice(reporter.publicKey, f.id, j.price, j.publish, Math.min(j.prev, j.publish - 1))];
      const tx = new Transaction().add(...(await budgetFor(post)), ...post);
      try {
        await confirmed(await conn.sendTransaction(tx, [payer, reporter]));
        log("ok", `posted ${f.symbol} ${Number(j.price) / 1e6} for listing`);
      } catch (e: any) {
        log("fail", `post ${f.symbol}`, String(e?.message ?? e).split("\n")[0].slice(0, 120));
      }
    }
    return;
  }
  if (wall - lastFeedRefresh < 180) return;
  lastFeedRefresh = wall;
  const stale: string[] = [];
  const accs = await conn.getMultipleAccountsInfo(C.FEEDS.map(f => C.feedAccount(f.id)));
  C.FEEDS.forEach((f, i) => {
    if (listed.has(f.id)) return;
    const a = accs[i];
    if (!a || wall - C.decodePyth(new Uint8Array(a.data)).publish > 200) stale.push(f.id);
  });
  if (!stale.length) return;
  const j = await hermes(`/v2/updates/price/latest?${ids(stale)}&encoding=base64`);
  if (!j) return;
  try {
    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    await builder.addUpdatePriceFeed(j.binary.data, 0);
    await sendBuilt(await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: PRIORITY }));
    log("ok", `refreshed ${stale.length} unlisted feed account(s)`);
  } catch (e: any) {
    log("fail", "refresh feeds", String(e?.message ?? e).slice(0, 140));
  }
}

// Watchdog: the loop below ends every pass by noting the time. If no pass has ended for three
// minutes the process is stuck in a way no time limit caught (it froze for 8.5 minutes on
// 2026-10-08 with trades waiting); it exits, and the service script starts it again.
let lastPass = Date.now();
const WATCHDOG_MS = Number(process.env.WATCHDOG_SECS ?? 180) * 1000;
setInterval(() => {
  if (Date.now() - lastPass > WATCHDOG_MS) {
    log("watchdog", `no pass finished for ${Math.round((Date.now() - lastPass) / 1000)} s: exiting to be restarted`);
    process.exit(3);
  }
}, 10_000).unref();

(async () => {
  log("executor", payer.publicKey.toBase58(), "router", C.ROUTER.toBase58(), "prices:", ORACLE === "jack" ? `${JACK} (reported)` : `Pyth via ${HERMES}${reporter ? `, fallback ${JACK} (reported)` : ""}`);
  let lastStats = Date.now();
  let vaults: C.Vault[] = [];
  let vaultsAt = 0;
  let pass = 0;
  let watchAt = 0;
  let upkeepAt = 0;
  let slowAt = 0;
  for (;;) {
    let waiting = false; // a trade is queued: come back sooner
    try {
      // The vault list is re-read every 20 seconds, so a market opened just now is serviced
      // before its first request can expire; everything else is one batched read per pass (the
      // public devnet RPC allows about 100 requests per 10 seconds).
      if (!vaults.length || Date.now() - vaultsAt > 20_000) {
        vaultList = await C.listVaults(conn);
        const open = vaultList.filter(v => v.market.equals(C.MARKET) && v.canonical && v.status === 1 && v.feed);
        // A market nobody has money in (no liquidity, no position, nothing queued to come in or
        // out) is left alone: keeping its price and its clock current costs fees for nobody's
        // benefit. It is picked up again within 20 seconds of its first deposit request.
        // (No shares outstanding: the supply of the vault's share mint, which also counts shares
        // waiting in escrow for a withdrawal.)
        const mints = await conn.getMultipleAccountsInfo(open.map(v => v.shareMint));
        const shares = new Map(open.map((v, i) => [v.key.toBase58(), mints[i] ? new DataView(mints[i]!.data.buffer, mints[i]!.data.byteOffset).getBigUint64(36, true) : 1n]));
        const empty = (v: C.Vault) => shares.get(v.key.toBase58()) === 0n && v.inventory === 0n && v.pendingDeposit === 0n && v.pendingWithdraw === 0n;
        const idle = open.filter(empty).map(v => v.feed!.symbol).sort().join(", ");
        if (idle !== idleNames) { idleNames = idle; log(idle ? `not servicing empty market(s): ${idle}` : "no empty markets"); }
        vaults = open.filter(v => !empty(v));
        servicedAssets = vaults.map(v => v.assetIndex);
        vaultsAt = Date.now();
        // Runs in the background. Where the service is the source, every feed is recorded, so
        // a market that is not open yet has a price to be listed at.
        if (reporter) recordJack([...(ORACLE === "jack" ? C.FEEDS.map(f => f.symbol) : []), ...vaults.map(v => v.feed!.symbol)]);
      }
      const keys = [SYSVAR_CLOCK_PUBKEY, C.MARKET, ...vaults.flatMap(v => [C.bookAddress(v.key), C.feedAccount(v.feed!.id)])];
      const accs = await conn.getMultipleAccountsInfo(keys);
      const clock = new DataView(accs[0]!.data.buffer, accs[0]!.data.byteOffset);
      const now = Number(clock.getBigInt64(32, true));
      const slot = clock.getBigUint64(0, true);
      const market = new Uint8Array(accs[1]!.data);
      let busy = false;
      // While any trade is queued, routine cranking stops: the fill carries the exact cranks it
      // needs, and one landing in between would make one of those a no-op and fail the fill.
      // The fill catches up whatever the request needs itself.
      const queued = vaults.some((_, i) => accs[2 + 2 * i] && C.decodeBook(new Uint8Array(accs[2 + 2 * i]!.data)).pending.length > 0);
      // Liquidations and close-outs are looked for whether or not trades are queued: a busy
      // market always has some, and an account below the level cannot wait for a quiet moment.
      // While trades are queued the scan runs every 6 seconds at most (it reads every account).
      const scan = queued || !C.X1 ? Date.now() - watchAt > 6_000 : pass % 3 === 1;
      if (vaults.length && (scan || !queued)) {
        if (scan) watchAt = Date.now();
        const sent = await watch(vaults, market, scan).catch(e => { log("error", "watch", String(e?.message ?? e).slice(0, 140)); return false; });
        if (sent && !queued) continue;
      }
      if (!queued && vaults.length) await upkeep(vaults, market, slot, pass++).catch(e => log("error", "upkeep", String(e?.message ?? e).slice(0, 140)));
      // On a busy network a trade is queued somewhere nearly all the time. Accounts that no fill
      // touches would then never be re-valued after a price move, and an account that is not
      // re-valued cannot be liquidated: every 30 seconds they are settled anyway. (This can make
      // one fill's cranks miss, and that fill is retried on the next pass.)
      else if (queued && vaults.length && Date.now() - upkeepAt > 30_000) {
        upkeepAt = Date.now();
        await upkeep(vaults, market, slot, 0, true).catch(e => log("error", "upkeep", String(e?.message ?? e).slice(0, 140)));
      }
      waiting = queued;
      // Markets with trades queued first; the others after them (while trades are queued, all
      // that is done for those is an urgent price update).
      const hasPending = (i: number) => !!accs[2 + 2 * i] && C.decodeBook(new Uint8Array(accs[2 + 2 * i]!.data)).pending.length > 0;
      const order = [...vaults.keys()].sort((x, y) => Number(hasPending(y)) - Number(hasPending(x)));
      for (const i of order) {
        const v = vaults[i];
        const snap = { market, slot, book: accs[2 + 2 * i] ? new Uint8Array(accs[2 + 2 * i]!.data) : null, feed: accs[3 + 2 * i] ? new Uint8Array(accs[3 + 2 * i]!.data) : null };
        busy = (await serviceVault(v, now, snap, queued).catch(e => { log("error", v.feed?.symbol, String(e?.message ?? e).slice(0, 140)); return false; })) || busy;
      }
      const books = new Map(vaults.flatMap((v, i) => (accs[2 + 2 * i] ? [[v.key.toBase58(), C.decodeBook(new Uint8Array(accs[2 + 2 * i]!.data))] as [string, C.Book]] : [])));
      // Once an hour: what expired requests left in the books goes to the treasury.
      if (Date.now() - sweptAt > 3_600_000) {
        sweptAt = Date.now();
        bookRent ||= await conn.getMinimumBalanceForRentExemption(accs[2]?.data.length ?? 0);
        for (const [i, v] of vaults.entries()) {
          const spare = (accs[2 + 2 * i]?.lamports ?? 0) - bookRent;
          if (accs[2 + 2 * i] && spare >= SWEEP_MIN) await send(`sweep ${(spare / 1e9).toFixed(3)} ${C.X1 ? "XNT" : "SOL"} left by expired requests on ${v.feed?.symbol} to the treasury`, [C.sweepBook(v.key)]);
        }
      }
      await serviceOrders(vaults, books, market, now, slot).catch(e => log("error", "orders", String(e?.message ?? e).slice(0, 140)));
      await serviceCopies(vaults, books, market).catch(e => log("error", "copies", String(e?.message ?? e).slice(0, 140)));
      if (Date.now() - slowAt >= SLOW_JOBS_MS) {
        slowAt = Date.now();
        if (!queued) await openTrackRecords().catch(e => log("error", "track records", String(e?.message ?? e).slice(0, 140)));
        await convertProfits(vaults, market).catch(e => log("error", "profits", String(e?.message ?? e).slice(0, 140)));
      }
      // Low priority, in the background, and only while no trade is waiting.
      if (!busy && !refreshing) {
        refreshing = true;
        refreshUnlistedFeeds(new Set(vaults.map(v => v.feed!.id))).finally(() => (refreshing = false));
      }
      if (Date.now() - lastStats > 600_000) {
        log(`hermes requests in the last 10 min: ${hermesCalls}`);
        hermesCalls = 0;
        lastStats = Date.now();
      }
    } catch (e: any) {
      log("error", String(e?.message ?? e).slice(0, 140));
    }
    lastPass = Date.now();
    await new Promise(r => setTimeout(r, waiting ? (C.X1 ? 200 : 500) : 1500));
  }
})();
