// Live check of trade notes (2026-11-07): a trading key's quoted trade carries a note signed by the
// key, and the page's reader (S.loadNotes) finds it; a note a stranger attaches to the same trading
// account is not counted.   QUOTE_URL=http://127.0.0.1:18301 NETWORK=x1-testnet npx tsx scripts/note-check.ts
import { ComputeBudgetProgram, Connection, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";
const conn = new Connection(C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(0) });
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(`${process.env.HOME}/.config/solana/percolator-x1/deployer.json`), faucet = load("../keys/x1-faucet.json");
async function send(ixs: TransactionInstruction[], signers: Keypair[], units = 1_000_000) {
  for (let attempt = 1; ; attempt++) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs);
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; tx.feePayer = signers[0].publicKey; tx.sign(...signers);
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await C.confirmFast(conn, sig, 30_000);
      return { sig, bytes: tx.serialize().length };
    } catch (e) { if (attempt >= 3) throw e; }
  }
}
(async () => {
  let w = Keypair.generate();
  while (!C.placedMarket(w.publicKey).equals(C.MARKETS[1].key)) w = Keypair.generate();
  C.setActiveMarket(C.MARKETS[1].key);
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 300_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(w.publicKey, C.MINT), w.publicKey, C.MINT),
    createMintToInstruction(C.MINT, C.ata(w.publicKey, C.MINT), faucet.publicKey, 500n * BigInt(C.USDC))], [payer, faucet]);
  const key = Keypair.generate();
  await send([C.openTradingAccount(w.publicKey), C.openLedger(w.publicKey, w.publicKey), S.openStats(w.publicKey, w.publicKey), C.routerDeposit(w.publicKey, 300n * BigInt(C.USDC)),
    C.openSession(w.publicKey, key.publicKey, Math.floor(Date.now() / 1000) + 3600, 1_000n * BigInt(C.USDC), 20), SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: key.publicKey, lamports: 100_000_000 })], [w]);
  const v = (await C.listVaults(conn)).find(x => x.feed?.symbol === "SOL" && x.canonical)!;
  const q = await C.quotedTrade(conn, v, w.publicKey, 0, 200_000n, 6, 3_000, false, key.publicKey);
  if (!q) {
    const { TransactionMessage, VersionedTransaction, PublicKey: PK } = await import("@solana/web3.js");
    const raw = await (await fetch(`${process.env.QUOTE_URL}/quote?network=x1-testnet&vault=${v.key}&trader=${C.traderAddress(w.publicKey, 0, v.market)}&size=200000&life=6`)).json() as any;
    if (raw.error) throw new Error("no quote: maker says " + raw.error);
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...C.takeQuoteIxs(v, w.publicKey, 0, raw, [], key.publicKey)];
    const sim = await conn.simulateTransaction(new VersionedTransaction(new TransactionMessage({ payerKey: key.publicKey, recentBlockhash: PK.default.toBase58(), instructions: ixs }).compileToV0Message()), { sigVerify: false, replaceRecentBlockhash: true });
    throw new Error("no quote: " + JSON.stringify(sim.value.err) + " " + (sim.value.logs ?? []).filter(l => /error|failed|exceeded/.test(l)).slice(-2).join(" | ").slice(0, 300));
  }
  const t = await send([...q.ixs, S.tradeNote(key.publicKey, "SOL looks strong here")], [key], q.units);
  console.log(`ok   quoted trade by the key with a note: ${t.bytes} bytes`);
  // A note a stranger attaches to the same trading account: it must not count.
  const stranger = Keypair.generate();
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: 20_000_000 })], [payer]);
  await send([SystemProgram.transfer({ fromPubkey: stranger.publicKey, toPubkey: C.traderAddress(w.publicKey), lamports: 1 }), S.tradeNote(stranger.publicKey, "fake note")], [stranger]);
  await new Promise(r => setTimeout(r, 3000));
  const notes = (await S.loadNotes(conn, w.publicKey)).map(n => n.text);
  console.log(notes.length === 1 && notes[0] === "SOL looks strong here" ? "ok  " : "FAIL", "notes the page reads:", JSON.stringify(notes));
})().catch(e => { console.error("FAIL", String(e?.message ?? e).slice(0, 300)); process.exit(1); });
