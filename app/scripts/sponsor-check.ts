// Live check of the fee sponsor (api/relay, 2026-11-07): a trading key with no XNT at all is topped
// up and then trades with its own fee; a key that still has XNT, or one nobody approved, is refused.   QUOTE_URL=http://127.0.0.1:18301 NETWORK=x1-testnet npx tsx scripts/sponsor-check.ts
import { ComputeBudgetProgram, Connection, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";
const SITE = process.env.SITE ?? "https://turbopumpx.vercel.app";
const conn = new Connection(C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(0) });
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(`${process.env.HOME}/.config/solana/percolator-x1/deployer.json`), faucet = load("../keys/x1-faucet.json");
async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
  tx.recentBlockhash = await C.recentBlockhash(conn); tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }); await C.confirmFast(conn, sig); return sig;
}
async function relay(tx: Transaction) {
  const r = await fetch(`${SITE}/api/relay?network=x1-testnet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: tx.serialize({ requireAllSignatures: false }).toString("base64") }) });
  return { status: r.status, j: await r.json() as any };
}
(async () => {
  const sponsor = new (await import("@solana/web3.js")).PublicKey((await (await fetch(`${SITE}/api/relay?network=x1-testnet`)).json() as any).sponsor);
  let w = Keypair.generate();
  while (!C.placedMarket(w.publicKey).equals(C.MARKETS[1].key)) w = Keypair.generate();
  C.setActiveMarket(C.MARKETS[1].key);
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 300_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(w.publicKey, C.MINT), w.publicKey, C.MINT),
    createMintToInstruction(C.MINT, C.ata(w.publicKey, C.MINT), faucet.publicKey, 500n * BigInt(C.USDC))], [payer, faucet]);
  const key = Keypair.generate(); // never given any XNT
  await send([C.openTradingAccount(w.publicKey), C.openLedger(w.publicKey, w.publicKey), S.openStats(w.publicKey, w.publicKey), C.routerDeposit(w.publicKey, 300n * BigInt(C.USDC)),
    C.openSession(w.publicKey, key.publicKey, Math.floor(Date.now() / 1000) + 3600, 1_000n * BigInt(C.USDC), 20)], [w]);
  console.log("key", key.publicKey.toBase58().slice(0, 8), "holds", await conn.getBalance(key.publicKey), "lamports");
  const v = (await C.listVaults(conn)).find(x => x.feed?.symbol === "SOL" && x.canonical)!;
  const top = async (who: Keypair) => { const r = await fetch(`${SITE}/api/relay?network=x1-testnet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: w.publicKey.toBase58(), key: who.publicKey.toBase58() }) }); return { status: r.status, j: await r.json() as any }; };
  const t0 = Date.now();
  const r = await top(key);
  if (r.status !== 200) throw new Error(`top-up refused: ${r.status} ${JSON.stringify(r.j)}`);
  await C.confirmFast(conn, r.j.sig);
  console.log(`ok   topped up in ${Date.now() - t0} ms: the key holds ${(await conn.getBalance(key.publicKey)) / 1e9} XNT`);
  const q = await C.quotedTrade(conn, v, w.publicKey, 0, 200_000n, 6, 3_000, false, key.publicKey);
  if (!q) throw new Error("no quote");
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: q.units }), ...q.ixs);
  tx.recentBlockhash = await C.recentBlockhash(conn); tx.feePayer = key.publicKey; tx.sign(key);
  await C.confirmFast(conn, await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }));
  console.log("ok   the key traded with its own fee; position", Number((await C.fetchVault(conn, v.key, w.publicKey)).portfolio?.position ?? 0n) / 1e6, "SOL; key holds", (await conn.getBalance(key.publicKey)) / 1e9);
  const again = await top(key);
  console.log(again.status === 409 ? "ok  " : "FAIL", "a second top-up while it still has XNT:", again.status, again.j.error);
  const stranger = Keypair.generate();
  const r3 = await top(stranger);
  console.log(r3.status === 403 ? "ok  " : "FAIL", "a key nobody approved:", r3.status, r3.j.error);
})().catch(e => { console.error("FAIL", String(e?.message ?? e).slice(0, 300)); process.exit(1); });
