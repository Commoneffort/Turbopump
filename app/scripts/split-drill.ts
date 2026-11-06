// Throughput drill for the market split (2026-11-06): K fresh wallets on each X1 market take a
// maker quote at the same moment; reports how many landed in each block and fills a second.
//   NETWORK=x1-testnet K=10 npx tsx scripts/split-drill.ts
// The wallets are kept in deploy/logs/split-drill-wallets.json and reused by the next run.
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";

const conn = new Connection(C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(0) });
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(`${process.env.HOME}/.config/solana/percolator-x1/deployer.json`), faucet = load("../keys/x1-faucet.json");
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const K = Number(process.env.K ?? 10);
const FILE = "../deploy/logs/split-drill-wallets.json";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  for (let i = 0; ; i++) {
    try {
      const sig = await conn.sendTransaction(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs), signers);
      await C.confirmFast(conn, sig);
      return;
    } catch (e) { if (i >= 3) throw e; await sleep(1500); }
  }
}

(async () => {
  // K wallets per market, each with an account there and 300 test USDC in it.
  type W = { kp: Keypair; market: number };
  let ws: W[] = fs.existsSync(FILE) ? (JSON.parse(fs.readFileSync(FILE, "utf8")) as { s: number[]; m: number }[]).map(x => ({ kp: Keypair.fromSecretKey(Uint8Array.from(x.s)), market: x.m })) : [];
  for (let m = 0; m < C.MARKETS.length; m++) {
    for (let have = ws.filter(w => w.market === m).length; have < K; have++) {
      let kp = Keypair.generate();
      // The original market (0) takes anyone who opens an account there; the others by address.
      while (m > 0 && !C.placedMarket(kp.publicKey).equals(C.MARKETS[m].key)) kp = Keypair.generate();
      ws.push({ kp, market: m });
    }
  }
  fs.writeFileSync(FILE, JSON.stringify(ws.map(w => ({ s: Array.from(w.kp.secretKey), m: w.market }))), { mode: 0o600 });
  const mk = (w: W) => C.MARKETS[w.market].key;
  const traders = await conn.getMultipleAccountsInfo(ws.map(w => C.traderAddress(w.kp.publicKey, 0, mk(w))));
  const fresh = ws.filter((_, i) => !traders[i]);
  say(`${ws.length} wallets on ${C.MARKETS.length} markets, ${fresh.length} to set up`);
  for (let i = 0; i < fresh.length; i += 4) {
    const part = fresh.slice(i, i + 4);
    await send(part.flatMap(w => [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.kp.publicKey, lamports: 150_000_000 }),
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(w.kp.publicKey, C.MINT), w.kp.publicKey, C.MINT),
      createMintToInstruction(C.MINT, C.ata(w.kp.publicKey, C.MINT), faucet.publicKey, 300n * BigInt(C.USDC))]), [payer, faucet]);
    for (const w of part) {
      C.setActiveMarket(mk(w));
      await send([C.openTradingAccount(w.kp.publicKey), C.openLedger(w.kp.publicKey, w.kp.publicKey), S.openStats(w.kp.publicKey, w.kp.publicKey)], [w.kp]);
      await send([C.routerDeposit(w.kp.publicKey, 300n * BigInt(C.USDC))], [w.kp]);
    }
    say(`set up ${Math.min(i + 4, fresh.length)} of ${fresh.length}`);
  }

  // A quote for each (SOL, 0.05, alternating sides), from each market's maker server.
  const vaults = (await C.listVaults(conn, true)).filter(v => v.feed?.symbol === "SOL" && v.canonical);
  const vaultOf = (w: W) => vaults.find(v => v.market.equals(mk(w)))!;
  const bh = await C.recentBlockhash(conn);
  const txs: { w: W; raw: Buffer }[] = [];
  for (const [i, w] of ws.entries()) {
    const v = vaultOf(w);
    const size = i % 2 ? -50_000n : 50_000n;
    const q = await (await fetch(`http://127.0.0.1:${18300 + w.market}/quote?vault=${v.key}&trader=${C.traderAddress(w.kp.publicKey, 0, mk(w))}&size=${size}&life=40`)).json() as C.Quote & { error?: string };
    if (q.error) { say("no quote for", w.market, q.error); continue; }
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), ...C.takeQuoteIxs(v, w.kp.publicKey, 0, q));
    tx.recentBlockhash = bh; tx.feePayer = w.kp.publicKey; tx.sign(w.kp);
    txs.push({ w, raw: tx.serialize() });
  }
  say(`${txs.length} signed quoted trades ready; sending them all at once`);

  // All at once; then their statuses, a batch at a time.
  const t0 = Date.now();
  const sent = await Promise.all(txs.map(async x => ({ ...x, sig: await conn.sendRawTransaction(x.raw, { skipPreflight: true, maxRetries: 3 }).catch(e => { say("send refused:", String(e?.message ?? e).slice(0, 80)); return ""; }), at: Date.now() - t0 })));
  const tSent = Date.now() - t0;
  const done = new Map<string, { ok: boolean; at: number; slot: number }>();
  const live = sent.filter(x => x.sig);
  while (done.size < live.length && Date.now() - t0 < 60_000) {
    const pending = live.filter(x => !done.has(x.sig));
    for (let i = 0; i < pending.length; i += 200) {
      const st = (await conn.getSignatureStatuses(pending.slice(i, i + 200).map(x => x.sig))).value;
      st.forEach((s, j) => { if (s && (s.err || s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) done.set(pending[i + j].sig, { ok: !s.err, at: Date.now() - t0, slot: s.slot }); });
    }
    await sleep(150);
  }
  const ok = [...done.values()].filter(d => d.ok), bad = [...done.values()].filter(d => !d.ok);
  const slots = new Map<number, number>();
  for (const d of ok) slots.set(d.slot, (slots.get(d.slot) ?? 0) + 1);
  const span = ok.length ? Math.max(...ok.map(d => d.slot)) - Math.min(...ok.map(d => d.slot)) + 1 : 0;
  say(`sent ${live.length} of ${txs.length} in ${tSent} ms; ${ok.length} filled, ${bad.length} failed, ${live.length - done.size} unconfirmed after 60 s`);
  say(`filled per block: ${[...slots.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join(" ")}`);
  if (ok.length) say(`last fill confirmed ${Math.max(...ok.map(d => d.at))} ms after the first send; ${span} block(s) => ${(ok.length / (span * C.slotSeconds())).toFixed(0)} fills a second over those blocks`);
  const perMarket = new Map<number, number>();
  for (const x of live) if (done.get(x.sig)?.ok) perMarket.set(x.w.market, (perMarket.get(x.w.market) ?? 0) + 1);
  say("filled per market:", [...perMarket.entries()].sort().map(([m, n]) => `m${m}:${n}`).join(" "));
  if (bad.length) {
    const errs = new Map<string, number>();
    for (const x of live) { const d = done.get(x.sig); if (d && !d.ok) { const st = (await conn.getSignatureStatuses([x.sig])).value[0]; const k = JSON.stringify(st?.err); errs.set(k, (errs.get(k) ?? 0) + 1); } }
    say("failures:", [...errs.entries()].map(([k, n]) => `${n}x ${k}`).join(", "));
    // One failed transaction's log per kind of failure.
    const shown = new Set<string>();
    for (const x of live) {
      const d = done.get(x.sig); if (!d || d.ok) continue;
      const tx = await conn.getTransaction(x.sig, { maxSupportedTransactionVersion: 0 });
      const k = JSON.stringify(tx?.meta?.err); if (shown.has(k)) continue; shown.add(k);
      say(`== market ${x.w.market}, ${k}:`); for (const l of (tx?.meta?.logMessages ?? []).filter(l => !/invoke|success|consumed/.test(l) || /failed/.test(l)).slice(-8)) console.log("   ", l.slice(0, 170));
    }
  }
})().catch(e => { console.error("FAIL", String(e?.message ?? e).slice(0, 300)); process.exit(1); });
