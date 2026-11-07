// QUOTE_URL=http://127.0.0.1:18301 NETWORK=x1-testnet npx tsx scripts/quote-price-check.ts
// Live check (2026-11-07): a quoted trade now pays the quote. A fresh test wallet buys 0.5 SOL at a
// maker's quote and sells it back at the next one; the round trip should cost the two spreads
// (plus fees), where before this upgrade it cost only the fees.
import { ComputeBudgetProgram, Connection, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";
const conn = new Connection(C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(0) });
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(`${process.env.HOME}/.config/solana/percolator-x1/deployer.json`), faucet = load("../keys/x1-faucet.json");
async function send(ixs: TransactionInstruction[], signers: Keypair[], units = 1_400_000) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, Math.max(units, 600_000)) }), ...ixs);
  tx.recentBlockhash = await C.recentBlockhash(conn); tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }); await C.confirmFast(conn, sig); return sig;
}
(async () => {
  let w = Keypair.generate();
  while (!C.placedMarket(w.publicKey).equals(C.MARKETS[1].key)) w = Keypair.generate();
  C.setActiveMarket(C.MARKETS[1].key);
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 300_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(w.publicKey, C.MINT), w.publicKey, C.MINT),
    createMintToInstruction(C.MINT, C.ata(w.publicKey, C.MINT), faucet.publicKey, 1_000n * BigInt(C.USDC))], [payer, faucet]);
  await send([C.openTradingAccount(w.publicKey), C.openLedger(w.publicKey, w.publicKey), S.openStats(w.publicKey, w.publicKey), C.routerDeposit(w.publicKey, 500n * BigInt(C.USDC))], [w]);
  const v = (await C.listVaults(conn)).find(x => x.feed?.symbol === "SOL" && x.canonical)!;
  const eq = async () => { const s = await C.fetchVault(conn, v.key, w.publicKey); return { e: Number((s.portfolio?.capital ?? 0n) + (s.portfolio?.pnl ?? 0n)) / 1e6, pos: Number(s.portfolio?.position ?? 0n) / 1e6, mark: Number(s.asset.price) / 1e6 }; };
  const e0 = await eq();
  const buy = await C.quotedTrade(conn, v, w.publicKey, 0, 500_000n, 6, 3_000, false);
  if (!buy) throw new Error("no quote to buy");
  const pb = Number(BigInt(buy.quote.price)) / 1e6;
  await send(buy.ixs, [w], buy.units);
  const e1 = await eq();
  const sell = await C.quotedTrade(conn, v, w.publicKey, 0, -500_000n, 6, 3_000, false);
  if (!sell) throw new Error("no quote to sell");
  const ps = Number(BigInt(sell.quote.price)) / 1e6;
  await send(sell.ixs, [w], sell.units);
  const e2 = await eq();
  console.log(`buy 0.5 at ${pb} (mark ${e0.mark}), sell 0.5 at ${ps} (mark ${e1.mark}); position after ${e2.pos}`);
  console.log(`equity ${e0.e} -> ${e1.e} -> ${e2.e}: round trip ${(e2.e - e0.e).toFixed(6)} USDC; the quotes' difference ${(0.5 * (ps - pb)).toFixed(6)}`);
})().catch(e => { console.error("FAIL", String(e?.message ?? e).slice(0, 300)); process.exit(1); });
