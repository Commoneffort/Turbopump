// Smoke test of the market split (2026-11-06): a fresh wallet on the market it is placed on opens
// an account, deposits, takes a maker quote, then queues a trade for that market's executor.
//   NETWORK=x1-testnet npx tsx scripts/split-smoke.ts
import { Connection, ComputeBudgetProgram, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";
const conn = new Connection(C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(0) });
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(`${process.env.HOME}/.config/solana/percolator-x1/deployer.json`), faucet = load("../keys/x1-faucet.json");
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  const t = Date.now();
  const sig = await conn.sendTransaction(tx, signers, { skipPreflight: false });
  await C.confirmFast(conn, sig);
  say("ok", label, `${Date.now() - t} ms`);
}
(async () => {
  // (TARGET: which market to test, 1..4; the quote server is that market's, QUOTE_URL.)
  const target = Number(process.env.TARGET ?? 1);
  let w = Keypair.generate();
  while (!C.placedMarket(w.publicKey).equals(C.MARKETS[target].key)) w = Keypair.generate();
  const m = C.placedMarket(w.publicKey);
  C.setActiveMarket(m);
  const n = C.MARKETS.findIndex(x => x.key.equals(m));
  say("wallet", w.publicKey.toBase58(), "placed on market", n, m.toBase58());
  await send("coin + test USDC", [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 1_000_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(w.publicKey, C.MINT), w.publicKey, C.MINT), createMintToInstruction(C.MINT, C.ata(w.publicKey, C.MINT), faucet.publicKey, 2_000n * BigInt(C.USDC))], [payer, faucet]);
  await send("open account, ledger, track record", [C.openTradingAccount(w.publicKey), C.openLedger(w.publicKey, w.publicKey), S.openStats(w.publicKey, w.publicKey)], [w]);
  await send("deposit 1000", [C.routerDeposit(w.publicKey, 1_000n * BigInt(C.USDC))], [w]);
  console.log("home market found:", (await C.homeMarket(conn, w.publicKey)).equals(m));
  const v = (await C.listVaults(conn)).find(v => v.feed?.symbol === "SOL" && v.canonical)!;
  say("SOL vault on this market", v.key.toBase58(), "asset", v.assetIndex, "market ok", v.market.equals(m));
  // A maker quote, from this market's maker server.
  for (const size of [200_000n, -100_000n]) {
    const t = Date.now();
    const q = await C.quotedTrade(conn, v, w.publicKey, 0, size, 6, 3_000);
    if (!q) { say("no quote / simulation failed"); continue; }
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: q.units }), ...q.ixs);
    tx.recentBlockhash = await C.recentBlockhash(conn); tx.feePayer = w.publicKey; tx.sign(w);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await C.confirmFast(conn, sig);
    const st = await C.fetchVault(conn, v.key, w.publicKey);
    say(`quoted ${Number(size) / 1e6} SOL at ${Number(q.quote.price) / 1e6}: ${Date.now() - t} ms, position now ${Number(st.portfolio?.position ?? 0n) / 1e6}`);
  }
  // The queue: this market's executor fills it.
  const before = (await C.fetchVault(conn, v.key, w.publicKey)).portfolio?.position ?? 0n;
  await send("queue a 0.05 SOL buy", [C.requestTrade(w.publicKey, v.key, 50_000n)], [w]);
  const t = Date.now();
  for (let i = 0; i < 60; i++) {
    const s = await C.fetchVault(conn, v.key, w.publicKey);
    if (i % 10 === 0) say("waiting", { pending: !!s.pending, position: String(s.portfolio?.position) });
    if ((s.portfolio?.position ?? 0n) !== before && !s.pending) { say(`queued buy filled after ${Date.now() - t} ms, position ${Number(s.portfolio!.position) / 1e6}`); break; }
    await new Promise(r => setTimeout(r, 500));
  }
  const s = await C.fetchVault(conn, v.key, w.publicKey);
  if (s.pending) say("still queued after 30 s (the vault may wait for its first epoch roll to hold liquidity)");
  fs.writeFileSync("../deploy/logs/split-smoke-wallet.json", JSON.stringify(Array.from(w.secretKey)), { mode: 0o600 });
})().catch(e => { console.error("FAIL", String(e?.message ?? e).slice(0, 400), (e?.logs ?? []).slice(-6).join("\n")); process.exit(1); });
