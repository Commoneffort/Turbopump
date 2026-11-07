// Live check (2026-11-07): standing orders on an isolated account. A new wallet's first order on
// isolated account 1 opens it and moves its margin in the same transaction (as the page does), a
// marketable limit buy is carried out by the executor, and a stop on the isolated position is accepted.
//   NETWORK=x1-testnet npx tsx scripts/iso-order-check.ts
import { ComputeBudgetProgram, Connection, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
const conn = new Connection(C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(0) });
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(`${process.env.HOME}/.config/solana/percolator-x1/deployer.json`), faucet = load("../keys/x1-faucet.json");
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function send(ixs: TransactionInstruction[], signers: Keypair[], units = 600_000) {
  for (let attempt = 1; ; attempt++) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs);
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx.feePayer = signers[0].publicKey; tx.sign(...signers);
    try { const sig = await conn.sendRawTransaction(tx.serialize()); await C.confirmFast(conn, sig, 30_000); return sig; }
    catch (e: any) { if (attempt >= 3 || /custom program error/.test(String(e?.message ?? e))) throw e; }
  }
}
(async () => {
  const w = Keypair.generate(), SUB = 1;
  C.setActiveMarket(C.MARKET);
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 300_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(w.publicKey, C.MINT), w.publicKey, C.MINT),
    createMintToInstruction(C.MINT, C.ata(w.publicKey, C.MINT), faucet.publicKey, 200n * BigInt(C.USDC))], [payer, faucet]);
  const vs = await C.listVaults(conn);
  const sol = vs.find(x => x.feed?.symbol === "SOL" && x.canonical)!;
  const p = (await C.fetchVault(conn, sol.key)).asset.price;
  // One transaction: open isolated account 1, move 30 USDC of margin, a limit buy of 0.1 SOL 1% above the price.
  await send([C.openTradingAccount(w.publicKey, SUB), C.openLedger(w.publicKey, w.publicKey, SUB), C.routerDeposit(w.publicKey, 30n * BigInt(C.USDC), SUB),
    C.placeOrder(w.publicKey, sol.key, { index: 0, kind: C.ORDER.LIMIT, size: 100_000n, trigger: p * 101n / 100n }, SUB)], [w]);
  const st0 = await C.fetchVault(conn, sol.key, w.publicKey, SUB);
  say(st0.trader && st0.orders.length === 1 ? "ok  " : "FAIL", "isolated account opened with its margin and a limit order:", st0.orders.length, "order(s), equity", Number(st0.health?.equity ?? 0n) / 1e6);
  let filled = false;
  for (let i = 0; i < 60 && !filled; i++) {
    await new Promise(r => setTimeout(r, 2_000));
    filled = ((await C.fetchVault(conn, sol.key, w.publicKey, SUB)).portfolio?.position ?? 0n) === 100_000n;
  }
  say(filled ? "ok  " : "FAIL", "isolated limit buy", filled ? "carried out and filled: long 0.1 SOL" : "not filled within 2 minutes");
  const main = await C.fetchVault(conn, sol.key, w.publicKey, 0);
  say(!main.trader ? "ok  " : "FAIL", "the cross account was not touched");
  if (filled) {
    await send([C.placeOrder(w.publicKey, sol.key, { index: 1, kind: C.ORDER.STOP, size: 0n, trigger: p * 80n / 100n }, SUB)], [w]);
    const st = await C.fetchVault(conn, sol.key, w.publicKey, SUB);
    say(st.orders.some(o => o.kind === C.ORDER.STOP) ? "ok  " : "FAIL", "stop on the isolated position accepted");
  }
})().catch(e => { console.error("FAIL", String(e?.message ?? e).slice(0, 300)); process.exit(1); });
