// Opens the canonical markets of a freshly set up Percolator market (deploy/new-market.sh runs it),
// from the deploy key: creates each vault, lists its asset at the current price, records the
// asset's leverage tier with the router (SetTier: 20x for BTC and ETH, 10x for the rest), and
// puts seed liquidity in. Safe to run again: what exists is skipped, tiers are re-recorded.
//   NETWORK=x1-testnet|devnet KEYPAIR=<deploy key> npx tsx scripts/open-markets.ts SOL,BTC,ETH [seed USDC each]
import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";

// (Spaced out on devnet: its public RPC refuses bursts, and the services share it.)
const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(C.X1 ? 0 : 400) });
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`, "utf8"))));
const faucet = (() => { const p = process.env.FAUCET_KEY ?? (C.X1 ? "../keys/x1-faucet.json" : "../keys/faucet.json"); return fs.existsSync(p) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8")))) : kp; })();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const symbols = (process.argv[2] ?? "SOL,BTC,ETH").split(",");
const seed = Number(process.argv[3] ?? 10_000);

async function send(label: string, ixs: TransactionInstruction[], extra: Keypair[] = []) {
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp, ...extra]);
      await conn.confirmTransaction(sig, "confirmed");
      say("ok  ", label);
      return true;
    } catch (e: any) {
      if (i === 2) { say("FAIL", label, String(e.message).split("\n")[0].slice(0, 160), "\n   " + (e.logs ?? []).slice(-4).join("\n   ")); return false; }
      await sleep(3000);
    }
  }
  return false;
}
const usdc = async (amount: number) => {
  const ata = C.ata(kp.publicKey, C.MINT);
  return send(`${amount} test USDC`, [createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, C.MINT), createMintToInstruction(C.MINT, ata, faucet.publicKey, BigInt(Math.round(amount * C.USDC)))], faucet === kp ? [] : [faucet]);
};

say(`market ${C.MARKET.toBase58()} on ${C.NETWORK_NAME}: ${symbols.join(", ")}, ${seed} USDC each`);
await usdc(100 + seed * symbols.length); // listing fees and the seed deposits
for (const sym of symbols) {
  const feed = C.FEEDS.find(f => f.symbol === sym);
  if (!feed) { say(`no feed ${sym}`); continue; }
  const vault = C.canonicalVaultAddress(feed.id);
  if (!(await conn.getAccountInfo(vault))) {
    // On X1 the executor posts every feed's price within a few minutes of starting.
    for (let i = 0; !(await conn.getAccountInfo(C.priceAccount(feed.id))); i++) { if (i % 10 === 0) say(`waiting for a ${sym} price on chain`); await sleep(5000); }
    const m = await C.fetchMarket(conn);
    if (!(await send(`create ${sym} vault`, [C.initVault(kp.publicKey, feed.id, m.nextMarketId).ix]))) continue;
  }
  // (A public RPC lists a new account some seconds after it was created.)
  const find = async () => { for (let i = 0; i < 20; i++) { const x = (await C.listVaults(conn)).find(x => x.key.equals(vault)); if (x) return x; await sleep(6000); } throw new Error(`${sym} vault not found`); };
  let v = await find();
  if (v.status !== 1) {
    const m2 = await C.fetchMarket(conn);
    const p = C.decodePrice(new Uint8Array((await conn.getAccountInfo(C.priceAccount(feed.id)))!.data));
    if (!(await send(`list ${sym} at ${Number(p.e6) / 1e6}`, [C.listAsset(kp.publicKey, vault, feed.id, m2.slots, m2.nextMarketId, p.e6)]))) continue;
    for (let i = 0; i < 20 && (v = await find()).status !== 1; i++) await sleep(3000);
  }
  await send(`${sym} tier: ${C.tierOfFeed(feed.id) === C.TIER_MAJOR ? "major (20x)" : "default (10x)"}`, [C.setTier(kp.publicKey, vault)]);
  if (seed > 0 && v.lastNav === 0n && v.pendingDeposit === 0n) await send(`seed ${seed} USDC into ${sym}`, [C.requestDeposit(v, kp.publicKey, BigInt(seed * C.USDC))]);
}
const m = new Uint8Array((await conn.getAccountInfo(C.MARKET))!.data);
await C.fetchTiers(conn);
for (const v of (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1)) {
  const l = C.levels(m, v.assetIndex);
  say(`${v.feed?.symbol}: opens at ${Number(l.open) / 100}% (${C.maxLeverage(m, v.assetIndex)}x), liquidated below ${Number(l.liq) / 100}%, Percolator's own level ${Number(l.mm) / 100}%`);
}
