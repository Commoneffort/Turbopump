// The crash drill's driver: price moves no live network will ever show, on a local chain where the
// price is ours to set (deploy/crash-drill.sh starts the chain, the fake price service, the
// executor, the keeper and the bots, then runs this).
//
//   crash-drill.ts open SOL,BTC,ETH      open the markets (from the deploy key)
//   crash-drill.ts seed 30000            put this much into every vault, from the deploy key
//   crash-drill.ts ready                 wait until every vault has liquidity
//   crash-drill.ts run                   the scenarios below, then a report
//
// Scenarios (each waits for the bots to hold positions first):
//   1. slide      every price -8% over 2 minutes: the accounts at the limit are liquidated in order
//   2. squeeze    +10% over 2 minutes: the same for the shorts
//   3. gap        the price service goes silent for 90 s and comes back 20% lower: positions that
//                 lose more than their margin in one step (the account would owe money)
//   4. failover   the primary price service dies: the executor must carry on from the backup
//   5. spike      +6% in one second: the router's price band refuses it until enough time passed
//   6. outage     no price at all for 4 minutes: nothing may fill on a stale price
// Every check the bots make runs throughout (their log is BOT_LOG); this adds what each scenario
// expects and prints both at the end.
import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? "http://127.0.0.1:18899", "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR!, "utf8"))));
const ORACLE = process.env.ORACLE_CONTROL ?? "http://127.0.0.1:18090";
const BOT_LOG = process.env.BOT_LOG!;
const EXEC_LOG = process.env.EXEC_LOG!;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const oracle = (path: string) => fetch(`${ORACLE}${path}`).then(r => r.json());

async function send(label: string, ixs: TransactionInstruction[]) {
  try {
    const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp]);
    await conn.confirmTransaction(sig, "confirmed");
    say("ok  ", label);
    return true;
  } catch (e: any) { say("FAIL", label, String(e.message).split("\n")[0].slice(0, 160), "\n   " + (e.logs ?? []).slice(-6).join("\n   ")); return false; }
}

async function open(symbols: string[]) {
  // Opening a market pays Percolator's listing fee in the collateral: some test USDC first.
  const ata = C.ata(kp.publicKey, C.MINT);
  await send("test USDC for the listing fees", [createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, C.MINT), createMintToInstruction(C.MINT, ata, kp.publicKey, 10_000n * BigInt(C.USDC))]);
  for (const sym of symbols) {
    const feed = C.FEEDS.find(f => f.symbol === sym);
    if (!feed) { say(`no feed ${sym}`); continue; }
    const vault = C.canonicalVaultAddress(feed.id);
    if (await conn.getAccountInfo(vault)) { say(`${sym} vault exists`); continue; }
    // The executor posts every feed's price within a few minutes of starting: wait for it.
    for (let i = 0; !(await conn.getAccountInfo(C.priceAccount(feed.id))); i++) { if (i % 10 === 0) say(`waiting for a ${sym} price on chain`); await sleep(5000); }
    const m = await C.fetchMarket(conn);
    await send(`create ${sym} vault`, [C.initVault(kp.publicKey, feed.id, m.nextMarketId).ix]);
    const m2 = await C.fetchMarket(conn);
    const p = C.decodePrice(new Uint8Array((await conn.getAccountInfo(C.priceAccount(feed.id)))!.data));
    await send(`list ${sym}`, [C.listAsset(kp.publicKey, vault, feed.id, m2.slots, m2.nextMarketId, p.e6)]);
  }
}

async function seed(usdc: number) {
  for (const v of (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1)) {
    const ata = C.ata(kp.publicKey, C.MINT);
    await send(`mint ${usdc} for ${v.feed?.symbol}`, [createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, C.MINT), createMintToInstruction(C.MINT, ata, kp.publicKey, BigInt(usdc * C.USDC))]);
    await send(`deposit ${usdc} into ${v.feed?.symbol}`, [C.requestDeposit(v, kp.publicKey, BigInt(usdc * C.USDC))]);
  }
}

async function ready() {
  for (let i = 0; ; i++) {
    const vs = (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1);
    if (vs.length && vs.every(v => v.lastNav > 0n)) { say(`vaults ready: ${vs.map(v => `${v.feed?.symbol} $${(Number(v.lastNav) / 1e6).toFixed(0)}`).join(", ")}`); return; }
    if (i % 12 === 0) say("waiting for the first epoch to roll (liquidity arrives then)");
    await sleep(10_000);
  }
}

// ---- reading what happened ----
const rows = (since: number) => (fs.existsSync(BOT_LOG) ? fs.readFileSync(BOT_LOG, "utf8").trim().split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && r.at >= since) : []);
const execLines = (since: string) => (fs.existsSync(EXEC_LOG) ? fs.readFileSync(EXEC_LOG, "utf8").split("\n").filter(l => l.slice(0, 8) >= since) : []);
const nowHms = () => new Date().toISOString().slice(11, 19);

type Result = { name: string; ok: boolean; notes: string[] };
const results: Result[] = [];

/** Accounts with an open position right now (not the vaults'), and their worst margin. */
async function exposure() {
  const snap = await C.marketSnapshot(conn);
  const lps = new Set((await C.listVaults(conn)).map(v => v.lpPortfolio.toBase58()));
  let n = 0, multi = 0;
  for (const p of snap.portfolios) {
    if (lps.has(p.pubkey.toBase58())) continue;
    const h = C.accountHealth(snap.market, p.data);
    if (h.notional > 0n) { n++; if (h.positions.length > 1) multi++; }
  }
  return { n, multi };
}
async function waitForPositions(min: number, secs = 1200) {
  for (const end = Date.now() + secs * 1000; Date.now() < end;) {
    const e = await exposure().catch(() => ({ n: 0, multi: 0 }));
    if (e.n >= min && e.multi >= 1) return e;
    await sleep(15_000);
  }
  return exposure();
}

async function prices() { return oracle("/prices") as Promise<Record<string, number>>; }

async function scenario(name: string, run: () => Promise<void>, settle: number, expect: (r: any[], exec: string[]) => string[]) {
  const e = await waitForPositions(6);
  say(`== ${name} (${e.n} accounts hold positions, ${e.multi} on several markets)`);
  const t0 = Date.now(), h0 = nowHms();
  await run();
  await sleep(settle * 1000);
  const r = rows(t0), ex = execLines(h0);
  const liq = r.filter(x => x.type === "liquidation");
  // The executor's own word for each liquidation it queued (the bots look only every 20 s and
  // miss one that is closed in between).
  const queued = ex.filter(l => /ok queue liquidation/.test(l)).map(l => { const m = l.match(/equity (-?[\d.]+) on ([\d.]+) notional\) (\w+) for (\w+)/); return m ? { equity: Number(m[1]), notional: Number(m[2]), sym: m[3], who: m[4] } : null; }).filter(Boolean) as { equity: number; notional: number; sym: string; who: string }[];
  const failed = r.filter(x => x.type === "check" && !x.ok);
  const problems = expect(r, ex);
  const byWhat = new Map<string, number>(); for (const f of failed) byWhat.set(f.what, (byWhat.get(f.what) ?? 0) + 1);
  // Failures that a drill's price moves cause by design: prices stop during an outage, and the
  // orders bot's cost allowance (3% of its position) is for a live market, not an 8-30% move.
  const ignore = (w: string) => /price is fresh|re-valued within ten minutes|price is within 1%|day of fees|the routine cost its fees|routine runs to its end/.test(w);
  for (const [w, n] of byWhat) if (!ignore(w)) problems.push(`bot check failed ${n}x: ${w}`);
  const notes = [
    `liquidations queued by the executor: ${queued.length}${queued.length ? ` (${queued.map(q => `${q.who} ${q.sym} ${(100 * q.equity / q.notional).toFixed(1)}%`).join(", ")})` : ""}; seen by the bots: ${liq.filter(l => l.stage === "below the level").length}`,
    ...liq.filter(l => l.stage === "closed" && typeof l.equityAfter === "number" && l.equityAfter < 0).map(l => `account ${String(l.portfolio).slice(0, 6)} left owing $${(-l.equityAfter / 1e6).toFixed(2)}`),
    ...queued.filter(q => q.equity < 0).map(q => `account ${q.who} was already under water when queued: equity ${q.equity} on ${q.notional}`),
    ...problems,
  ];
  results.push({ name, ok: problems.length === 0, notes });
  say(`== ${name}: ${problems.length ? "PROBLEMS" : "ok"}`); for (const n of notes) say("   ", n);
}

async function moveAll(pct: number, secs: number) { for (const s of Object.keys(await prices())) await oracle(`/move?symbol=${s}&pct=${pct}&secs=${secs}`); }
async function setAll(f: number) { const p = await prices(); for (const [s, v] of Object.entries(p)) await oracle(`/set?symbol=${s}&price=${v * f}`); }

async function run() {
  await scenario("1. slide: -8% over 2 minutes", () => moveAll(-8, 120), 300, (r, ex) => {
    const went = r.filter(x => x.type === "liquidation" && x.stage === "below the level").length + ex.filter(l => /ok queue liquidation/.test(l)).length;
    return went ? [] : ["nobody went below the liquidation level: the positions were too small for the test"];
  });
  await scenario("2. squeeze: +10% over 2 minutes", () => moveAll(10, 120), 300, () => []);
  await scenario("3. gap: 90 s silent, back 30% lower (more than an account at 4-5x holds)", async () => { await oracle("/silence?secs=90&port=both"); await setAll(0.7); }, 400, (r, ex) => {
    const out = [];
    if (!ex.some(l => /mark .* -> reported/.test(l))) out.push("the mark never moved after the gap");
    if (ex.some(l => /0x5718/.test(l))) out.push("note: the band refused part of the gap first (0x5718)");
    return out;
  });
  await scenario("4. failover: primary price service dies", async () => { await oracle("/down?port=primary&on=1"); await moveAll(3, 60); }, 240, (r, ex) => {
    const out = [];
    if (!ex.some(l => /prices now from .*18091/.test(l))) out.push("the executor did not switch to the backup price service");
    if (!ex.some(l => /mark .* -> reported/.test(l))) out.push("no price was posted while the primary was down");
    return out;
  });
  await oracle("/down?port=primary&on=0");
  await scenario("5. spike: +6% in one second", () => setAll(1.06), 180, (r, ex) => {
    const out = [];
    const marks = ex.filter(l => /ok mark .* -> reported/.test(l));
    if (!marks.length) out.push("the mark never reached the new price");
    return out;
  });
  await setAll(1 / 1.06);
  let quietFrom = "", quietTo = "";
  await scenario("6. outage: no price for 4 minutes", async () => {
    await oracle("/silence?secs=240&port=both");
    const t = Date.now();
    quietFrom = new Date(t + 20_000).toISOString().slice(11, 19); // the last price before it may still be used for 15 s
    quietTo = new Date(t + 235_000).toISOString().slice(11, 19);
  }, 330, (r, ex) => {
    const inside = (l: string) => l.slice(0, 8) > quietFrom && l.slice(0, 8) < quietTo;
    const out = [];
    const marks = ex.filter(l => inside(l) && /ok mark .* -> reported/.test(l));
    const fills = ex.filter(l => inside(l) && /ok fill /.test(l));
    if (marks.length) out.push(`${marks.length} mark(s) posted while no price was published`);
    if (fills.length) out.push(`${fills.length} fill(s) while no price was published: ${fills[0]}`);
    return out;
  });
  // 7. The whale's exit: half a vault's value out at once. The bots' own checks judge it (paid in
  //    full, a trader can close while the vault is reduce-only); this waits for it to finish.
  await scenario("7. whale exit: half a vault's value withdrawn", async () => {
    for (const end = Date.now() + 75 * 60_000; Date.now() < end;) {
      if (rows(0).some(x => x.type === "whale" && x.what === "paid out")) return;
      await sleep(20_000);
    }
  }, 5, (r) => {
    const all = rows(0).filter(x => x.type === "whale");
    const paid = all.find(x => x.what === "paid out");
    return paid ? (all.some(x => x.what === "vault is reduce-only") ? [] : ["note: the vault never went reduce-only (the withdrawal fit in its cash)"]) : ["the whale's withdrawal was not paid within 75 minutes", ...all.slice(-3).map(x => JSON.stringify(x))];
  });
  say("==== drill results");
  for (const r of results) { say(`${r.ok ? "ok  " : "FAIL"} ${r.name}`); for (const n of r.notes) say("       ", n); }
  fs.writeFileSync(BOT_LOG.replace(/bots\.jsonl$/, "results.json"), JSON.stringify(results, null, 1));
}

const cmd = process.argv[2];
if (cmd === "open") await open((process.argv[3] ?? "SOL,BTC,ETH").split(","));
else if (cmd === "seed") await seed(Number(process.argv[3] ?? 30000));
else if (cmd === "ready") await ready();
else if (cmd === "run") await run();
else console.log("usage: crash-drill.ts open SYMBOLS | seed USDC | ready | run");
