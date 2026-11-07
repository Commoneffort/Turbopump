// Live check of strategy orders and the liquidation shield (router 2026-11-07) on X1:
//   - a cross trigger whose condition already holds is carried out by the executor and fills;
//   - a grid level is accepted on chain;
//   - a shield is accepted, and refused (ShieldNotNeeded) while the account is healthy.
//   NETWORK=x1-testnet npx tsx scripts/strategy-check.ts
import { ComputeBudgetProgram, Connection, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";
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
  const w = Keypair.generate();
  C.setActiveMarket(C.MARKET);
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 500_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(w.publicKey, C.MINT), w.publicKey, C.MINT),
    createMintToInstruction(C.MINT, C.ata(w.publicKey, C.MINT), faucet.publicKey, 1_000n * BigInt(C.USDC))], [payer, faucet]);
  await send([C.openTradingAccount(w.publicKey), C.openLedger(w.publicKey, w.publicKey), S.openStats(w.publicKey, w.publicKey), C.routerDeposit(w.publicKey, 500n * BigInt(C.USDC))], [w]);
  const vs = await C.listVaults(conn);
  const sol = vs.find(x => x.feed?.symbol === "SOL" && x.canonical)!, btc = vs.find(x => x.feed?.symbol === "BTC" && x.canonical)!;
  // Cross trigger: buy 0.1 SOL if BTC is at or below $1,000,000 (true now).
  await send([C.placeOrder(w.publicKey, sol.key, { index: 0, kind: C.ORDER.CROSS, size: 100_000n, trigger: 1_000_000_000_000n, interval: btc.assetIndex, slices: 2 })], [w]);
  say("ok   cross trigger placed; waiting for the executor to carry it out");
  let filled = false;
  for (let i = 0; i < 60 && !filled; i++) {
    await new Promise(r => setTimeout(r, 2_000));
    const st = await C.fetchVault(conn, sol.key, w.publicKey);
    filled = (st.portfolio?.position ?? 0n) === 100_000n;
  }
  say(filled ? "ok  " : "FAIL", "cross trigger", filled ? "carried out and filled: long 0.1 SOL" : "not filled within 2 minutes");
  // A grid level: buy 0.1 SOL 2% below the price, then sell one step (1%) higher.
  const p = (await C.fetchVault(conn, sol.key, w.publicKey)).asset.price;
  await send([C.placeOrder(w.publicKey, sol.key, { index: 1, kind: C.ORDER.GRID, size: 100_000n, trigger: p * 98n / 100n, interval: Number(p / 100n), slices: 0 })], [w]);
  const o = C.decodeOrder(C.orderAddress(sol.key, w.publicKey, 1), new Uint8Array((await conn.getAccountInfo(C.orderAddress(sol.key, w.publicKey, 1)))!.data));
  say(o.kind === C.ORDER.GRID ? "ok  " : "FAIL", `grid level on chain: buy 0.1 at ${Number(o.trigger) / 1e6}, then turn ${Number(o.slice) / 1e6} up`);
  // A shield: 5 USDC a step, 20 in all, within 25% of liquidation. Healthy now: refused.
  await send([createApproveInstruction(C.ata(w.publicKey, C.MINT), C.routerAuthority(), w.publicKey, 20n * BigInt(C.USDC)), C.setShield(w.publicKey, 5n * BigInt(C.USDC), 20n * BigInt(C.USDC), 2_500)], [w]);
  const sh = C.decodeShield(C.shieldAddress(w.publicKey), new Uint8Array((await conn.getAccountInfo(C.shieldAddress(w.publicKey)))!.data));
  say("ok   shield on chain:", Number(sh.step) / 1e6, "USDC a step,", Number(sh.maxTotal) / 1e6, "in all, within", sh.triggerBps / 100, "%");
  try { await send([C.triggerShield(payer.publicKey, w.publicKey)], [payer]); say("FAIL shield triggered on a healthy account"); }
  catch (e: any) { const m = String(e?.message ?? e); say(m.includes("0x5725") ? "ok  " : "FAIL", "shield refused on a healthy account:", m.slice(0, 80)); }
})().catch(e => { console.error("FAIL", String(e?.message ?? e).slice(0, 300)); process.exit(1); });
