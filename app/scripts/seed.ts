// Seeds clearly labelled demo activity on devnet: one liquidity provider that opens markets and
// deposits, and three traders. Every wallet here is listed in api/_config.ts SEED_WALLETS, so the
// site tags its activity as seeded. Trades are queued through the router; a running executor
// (scripts/executor.ts) fills them.
// Run: npx tsx scripts/seed.ts <phase>   (phase: setup | trade | one <trader 1-3> <symbol> <size>)
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const KEYS = "../keys/seed";
// On X1 testnet (NETWORK=x1-testnet) the deploy wallet is another one, and it is the test USDC's
// mint authority until a faucet key (keys/x1-faucet.json) takes that over.
const read = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const deployer = read(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
const faucetKey = process.env.FAUCET_KEY ?? (C.X1 ? "../keys/x1-faucet.json" : "../keys/faucet.json");
const faucet = fs.existsSync(faucetKey) ? read(faucetKey) : deployer;
const wallet = (name: string) => {
  const p = `${KEYS}/${name}.json`;
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
};
const LP = wallet("seed-lp");
const TRADERS = [wallet("seed-trader-1"), wallet("seed-trader-2"), wallet("seed-trader-3")];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
process.on("unhandledRejection", e => console.log("rpc", String((e as any)?.message ?? e).split("\n")[0].slice(0, 100)));

/** Waits for a signature by polling (the public RPC rate-limits websockets). */
async function confirmed(sig: string) {
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
  }
  throw new Error("not confirmed within 90 s");
}

async function send(label: string, kp: Keypair, ixs: TransactionInstruction[], extra: Keypair[] = []) {
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp, ...extra]);
      await confirmed(sig);
      console.log("ok  ", label);
      return true;
    } catch (e: any) {
      const m = String(e.message).split("\n")[0].slice(0, 120);
      if (i === 2) { console.log("FAIL", label, m); return false; }
      await sleep(3000);
    }
  }
  return false;
}

async function fund(kp: Keypair, usdc: number, sol: number) {
  const ata = C.ata(kp.publicKey, C.MINT);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata, kp.publicKey, C.MINT),
    createMintToInstruction(C.MINT, ata, faucet.publicKey, BigInt(usdc * C.USDC)),
  ];
  const bal = await conn.getBalance(kp.publicKey);
  if (bal < sol * LAMPORTS_PER_SOL) ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: Math.round(sol * LAMPORTS_PER_SOL) - bal }));
  await send(`fund ${kp.publicKey.toBase58().slice(0, 6)}`, deployer, ixs, faucet === deployer ? [] : [faucet]);
}

async function openMarket(sym: string) {
  const f = C.FEEDS.find(x => x.symbol === sym)!;
  const vault = C.canonicalVaultAddress(f.id);
  if (!(await conn.getAccountInfo(vault))) {
    const m = await C.fetchMarket(conn);
    await send(`open ${sym}: create vault`, LP, [C.initVault(LP.publicKey, f.id, m.nextMarketId).ix]);
  }
  const v = C.decodeVault(vault, new Uint8Array((await conn.getAccountInfo(vault))!.data));
  if (v.status === 0) {
    const m = await C.fetchMarket(conn);
    const pyth = C.decodePrice(new Uint8Array((await conn.getAccountInfo(C.priceAccount(f.id)))!.data));
    await send(`open ${sym}: list`, LP, [C.listAsset(LP.publicKey, vault, f.id, m.listSlot, m.nextMarketId, pyth.e6)]);
  }
  if (!(await conn.getAccountInfo(C.bookAddress(vault)))) await send(`open ${sym}: router book`, LP, [C.openBook(LP.publicKey, vault)]);
  return vault;
}

async function setup() {
  // On X1 every market the price service has is opened (about 0.12 XNT of rent each).
  const deposits: Record<string, number> = C.X1 ? Object.fromEntries(C.FEEDS.map(f => [f.symbol, 3_000])) : { SOL: 6_000, BTC: 6_000, ETH: 5_000 };
  await fund(LP, C.X1 ? 80_000 : 20_000, C.X1 ? 3.5 : 0.6);
  for (const t of TRADERS) await fund(t, 3_000, 0.3);
  for (const [sym, amt] of Object.entries(deposits)) {
    // A market can only be listed at a price posted in the last few minutes (the executor's job).
    if (!(await conn.getAccountInfo(C.canonicalVaultAddress(C.FEEDS.find(x => x.symbol === sym)!.id)).then(a => a && C.decodeVault(C.MARKET, new Uint8Array(a.data)).status !== 0))) {
      const pa = await conn.getAccountInfo(C.priceAccount(C.FEEDS.find(x => x.symbol === sym)!.id));
      const age = pa ? Date.now() / 1000 - C.decodePrice(new Uint8Array(pa.data)).publish : Infinity;
      if (age > 240) { console.log(`skip ${sym}: no recent price to list at (${pa ? Math.round(age) + " s old" : "none posted"})`); continue; }
    }
    const vault = await openMarket(sym);
    const s = await C.fetchVault(conn, vault, LP.publicKey);
    const t = s.ticket;
    if (t && (t.deposit > 0n || t.withdraw > 0n)) { console.log(`skip ${sym} deposit: already queued`); continue; }
    await send(`deposit ${amt} into ${sym}`, LP, [C.requestDeposit(s.vault, LP.publicKey, BigInt(amt * C.USDC))]);
  }
  console.log("wallets:", [LP, ...TRADERS].map(k => k.publicKey.toBase58()).join(" "));
}

/** Opens the trader's router account (once) and tops up its margin. */
async function account(kp: Keypair, margin: number) {
  const ixs: TransactionInstruction[] = [];
  if (!(await conn.getAccountInfo(C.traderAddress(kp.publicKey)))) ixs.push(C.openTradingAccount(kp.publicKey));
  if (margin > 0) ixs.push(C.routerDeposit(kp.publicKey, BigInt(margin * C.USDC)));
  if (ixs.length) await send(`${kp.publicKey.toBase58().slice(0, 6)} account + ${margin} margin`, kp, ixs);
}

/** Queues a trade and waits for an executor to fill it (or for it to expire). */
async function trade(kp: Keypair, sym: string, size: number) {
  const vault = C.canonicalVaultAddress(C.FEEDS.find(x => x.symbol === sym)!.id);
  const s = await C.fetchVault(conn, vault, kp.publicKey);
  if (!s.book) { console.log(`skip ${sym}: no router book`); return; }
  const q = BigInt(Math.round(size * 1e6));
  const label = `${kp.publicKey.toBase58().slice(0, 6)} ${size > 0 ? "long" : "short"} ${Math.abs(size)} ${sym}`;
  if (!(await send(`queue ${label}`, kp, [C.requestTrade(kp.publicKey, vault, q)]))) return;
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const t = await conn.getAccountInfo(C.traderAddress(kp.publicKey)).catch(() => null);
    if (t && !C.decodeTrader(new Uint8Array(t.data)).hasPending) {
      const pos = (await C.fetchVault(conn, vault, kp.publicKey)).portfolio?.position ?? 0n;
      console.log(`done ${label} -> position ${Number(pos) / 1e6}`);
      return;
    }
  }
  console.log(`still queued: ${label} (is an executor running?)`);
}

async function trades() {
  const [a, b, c] = TRADERS;
  await account(a, 1_000);
  await account(b, 900);
  await account(c, 800);
  await trade(a, "SOL", 12);
  await trade(b, "SOL", -8);
  await trade(a, "BTC", 0.02);
  await trade(c, "ETH", 0.6);
  await trade(b, "ETH", -0.4);
  await trade(c, "BTC", -0.015);
}

(async () => {
  const phase = process.argv[2];
  if (phase === "setup") await setup();
  else if (phase === "trade") await trades();
  else if (phase === "one") await trade(TRADERS[Number(process.argv[3]) - 1], process.argv[4], Number(process.argv[5]));
  else console.log("usage: seed.ts setup | trade | one <trader 1-3> <symbol> <size>");
})();
