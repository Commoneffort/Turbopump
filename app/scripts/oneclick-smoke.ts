// Live check of one-click trading (router `session`, 2026-11-06) on X1: a fresh wallet approves a
// trading key; the key trades (a maker quote, a queued trade) with no wallet signature; it is
// refused above its limits, without approval, and for a withdrawal; then it ends itself.
//   NETWORK=x1-testnet TARGET=1 QUOTE_URL=http://127.0.0.1:18301 npx tsx scripts/oneclick-smoke.ts
import { ComputeBudgetProgram, Connection, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";

const conn = new Connection(C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(0) });
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(`${process.env.HOME}/.config/solana/percolator-x1/deployer.json`), faucet = load("../keys/x1-faucet.json");
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function send(ixs: TransactionInstruction[], signers: Keypair[], units = 1_400_000): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs);
  tx.recentBlockhash = await C.recentBlockhash(conn); tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await C.confirmFast(conn, sig);
  return sig;
}
const refused = async (label: string, ixs: TransactionInstruction[], signers: Keypair[], want: string) => {
  try { await send(ixs, signers); say("FAIL", label, "went through"); process.exitCode = 1; }
  catch (e: any) { const m = String(e?.message ?? e); say(m.includes(want) ? "ok  " : "FAIL", label, "refused:", m.slice(0, 90)); if (!m.includes(want)) process.exitCode = 1; }
};

(async () => {
  const target = Number(process.env.TARGET ?? 1);
  let w = Keypair.generate();
  while (!C.placedMarket(w.publicKey).equals(C.MARKETS[target].key)) w = Keypair.generate();
  const market = C.MARKETS[target].key;
  C.setActiveMarket(market);
  say("wallet", w.publicKey.toBase58(), "on market", target);
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 1_000_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(w.publicKey, C.MINT), w.publicKey, C.MINT),
    createMintToInstruction(C.MINT, C.ata(w.publicKey, C.MINT), faucet.publicKey, 1_000n * BigInt(C.USDC))], [payer, faucet]);
  await send([C.openTradingAccount(w.publicKey), C.openLedger(w.publicKey, w.publicKey), S.openStats(w.publicKey, w.publicKey), C.routerDeposit(w.publicKey, 500n * BigInt(C.USDC))], [w]);
  // The trading key: approved for an hour, $100 a trade, 5 trades a day; 0.2 XNT for its fees.
  const key = Keypair.generate();
  const expires = Math.floor(Date.now() / 1000) + 3600;
  await send([C.openSession(w.publicKey, key.publicKey, expires, 100n * BigInt(C.USDC), 5), SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: key.publicKey, lamports: 200_000_000 })], [w]);
  const s = C.decodeSession(new Uint8Array((await conn.getAccountInfo(C.sessionAddress(w.publicKey)))!.data))!;
  say("ok   approved", s.key.toBase58().slice(0, 8), "until", new Date(s.expires * 1000).toISOString().slice(11, 19), "max", Number(s.maxNotional) / 1e6, "USDC a trade,", s.maxTrades, "a day");
  const v = (await C.listVaults(conn)).find(x => x.feed?.symbol === "SOL" && x.canonical)!;
  // A quote, taken by the key alone.
  const t0 = Date.now();
  const q = await C.quotedTrade(conn, v, w.publicKey, 0, 200_000n, 6, 3_000, true, key.publicKey);
  if (!q) { say("FAIL no quote"); process.exit(1); }
  await send([ComputeBudgetProgram.setComputeUnitLimit({ units: q.units }), ...q.ixs].slice(1), [key], q.units);
  say(`ok   key took a quote for 0.2 SOL in ${Date.now() - t0} ms; position`, Number((await C.fetchVault(conn, v.key, w.publicKey)).portfolio?.position ?? 0n) / 1e6);
  // A queued trade, by the key; the market's executor fills it.
  await send([C.requestTrade(w.publicKey, v.key, 100_000n, { actor: key.publicKey })], [key]);
  for (let i = 0; i < 40; i++) { const st = await C.fetchVault(conn, v.key, w.publicKey); if (!st.pending) { say("ok   key's queued buy filled; position", Number(st.portfolio?.position ?? 0n) / 1e6); break; } await new Promise(r => setTimeout(r, 500)); }
  // Refusals.
  const big = await C.quotedTrade(conn, v, w.publicKey, 0, 2_000_000n, 6, 3_000, false);  // 2 SOL ~ $180 > $100
  if (big) await refused("a trade above the key's size", takeWith(big.ixs, key, w), [key], "0x5724");
  const stranger = Keypair.generate();
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: 50_000_000 })], [payer]);
  await refused("a key nobody approved", [C.requestTrade(w.publicKey, v.key, 100_000n, { actor: stranger.publicKey })], [stranger], "0x5722");
  const wd = C.routerWithdraw(w.publicKey, 1n * BigInt(C.USDC));
  await refused("a withdrawal signed by the key", [new TransactionInstruction({ programId: wd.programId, data: wd.data, keys: [{ pubkey: key.publicKey, isSigner: true, isWritable: true }, ...wd.keys.slice(1)] })], [key], "error");
  // The key ends itself and gives its XNT back.
  const left = await conn.getBalance(key.publicKey);
  await send([C.closeSession(key.publicKey, w.publicKey), SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: w.publicKey, lamports: left - 20_000_000 })], [key]);
  say("ok   key ended itself; approval account", (await conn.getAccountInfo(C.sessionAddress(w.publicKey))) ? "STILL THERE" : "gone", "; key left with", (await conn.getBalance(key.publicKey)) / 1e9, "XNT");
  await refused("the ended key trading", [C.requestTrade(w.publicKey, v.key, 100_000n, { actor: key.publicKey })], [key], "0x");
})().catch(e => { console.error("FAIL", String(e?.message ?? e).slice(0, 300)); process.exit(1); });

/** A quote's instructions taken by `key` instead of the wallet. */
function takeWith(ixs: TransactionInstruction[], key: Keypair, w: Keypair) {
  return ixs.map(ix => (ix.programId.equals(C.ROUTER) ? C.byKey(ix, key.publicKey, w.publicKey, C.activeMarket()) : ix));
}
