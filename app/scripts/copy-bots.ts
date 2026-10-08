// Test traffic for copy trading: gives three of the trading bots a name and a badge (they are the
// "leaders"), and sets up three wallets of its own that each follow and copy one of them. Then it
// only watches: the leaders trade as bots.ts makes them, the executor brings the copiers in line,
// and this prints, for each copier and market, the leader's position, what the copier should hold
// (the router's own rule) and what it holds. It sends nothing after the setup.
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/copy-bots.ts setup     once per network
//   NETWORK=...               npx tsx scripts/copy-bots.ts status    one reading
//   NETWORK=...               npx tsx scripts/copy-bots.ts watch [minutes]
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const read = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const deployer = read(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
const faucet = read(C.X1 ? "../keys/x1-faucet.json" : "../keys/faucet.json");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** The leaders: existing bots, with the name and badge they get. */
const LEADERS = [
  { key: "bot-trend", name: "TrendRider", badge: 5, color: 1 },
  { key: "bot-fade", name: "FadeTheMove", badge: 3, color: 2 },
  { key: "bot-scalper", name: "Scalper_01", badge: 4, color: 0 },
];
/** The copiers: who each copies, at what share of the leader's leverage, with what margin. */
const COPIERS = [
  { key: "bot-copy-1", name: "copycat_1", leader: 0, ratioBps: 10_000, cap: 0, usdc: 400, badge: 0, color: 3 },
  { key: "bot-copy-2", name: "copycat_2", leader: 1, ratioBps: 5_000, cap: 0, usdc: 400, badge: 2, color: 3 },
  { key: "bot-copy-3", name: "copycat_3", leader: 2, ratioBps: 20_000, cap: 300, usdc: 400, badge: 8, color: 3 },
];
const keyFile = (k: string) => `../keys/bots/${k}.json`;
function wallet(k: string): Keypair {
  if (!fs.existsSync(keyFile(k))) fs.writeFileSync(keyFile(k), JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return read(keyFile(k));
}

async function send(label: string, kp: Keypair, ixs: TransactionInstruction[], extra: Keypair[] = []): Promise<boolean> {
  let last = "";
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp, ...extra]);
      for (let n = 0; n < 40; n++) {
        await sleep(1500);
        const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
        if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") { say("ok  ", label); return true; }
      }
      throw new Error("not confirmed within 60 s");
    } catch (e: any) {
      last = [String(e.message).split("\n")[0], ...(e.logs ?? []).filter((l: string) => /custom program error/.test(l)).slice(-1)].join(" ").slice(0, 170);
      await sleep(3000);
    }
  }
  say("FAIL", label, last);
  return false;
}
const exists = async (k: PublicKey) => { const a = await conn.getAccountInfo(k); return !!a && a.data.length > 0; };

async function setup() {
  say(`${C.NETWORK_NAME}: router ${C.ROUTER.toBase58()}, market ${C.MARKET.toBase58()}`);
  for (const l of LEADERS) {
    const kp = read(keyFile(l.key));
    const a = await conn.getAccountInfo(S.profileAddress(kp.publicKey));
    const have = a && a.data.length ? S.decodeProfile(new Uint8Array(a.data)) : undefined;
    if (have?.name === l.name && have.badge === l.badge) { say(`${l.key} is already ${l.name}`); continue; }
    await send(`${l.key} takes the name ${l.name}`, kp, [S.setProfile(kp.publicKey, l.name, have?.name, l.badge, l.color)]);
  }
  // Fees, and on devnet the rent of the trading account (about 0.08 SOL) the wallet creates.
  const gasNeed = (C.X1 ? 0.4 : 0.16) * LAMPORTS_PER_SOL;
  for (const c of COPIERS) {
    const kp = wallet(c.key), me = kp.publicKey, leader = read(keyFile(LEADERS[c.leader].key)).publicKey;
    if (await conn.getBalance(me) < ((await exists(C.traderAddress(me))) ? gasNeed / 8 : gasNeed * 0.7)) await send(`fees for ${c.key}`, deployer, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: me, lamports: gasNeed })]);
    if (!(await exists(C.traderAddress(me)))) {
      const ata = C.ata(me, C.MINT);
      const held = await conn.getAccountInfo(C.ata(me, C.MINT));
      if (!held || new DataView(held.data.buffer, held.data.byteOffset).getBigUint64(64, true) < BigInt(c.usdc * C.USDC)) await send(`test USDC for ${c.key}`, deployer, [createAssociatedTokenAccountIdempotentInstruction(deployer.publicKey, ata, me, C.MINT), createMintToInstruction(C.MINT, ata, faucet.publicKey, BigInt(c.usdc * C.USDC))], faucet.publicKey.equals(deployer.publicKey) ? [] : [faucet]);
      // The same instructions the page sends for "Create trading account", then a deposit.
      await send(`${c.key}: trading account, track record, deposit ${c.usdc}`, kp, [C.openTradingAccount(me), S.openStats(me, me), C.routerDeposit(me, BigInt(c.usdc * C.USDC))]);
    }
    if (!(await exists(S.profileAddress(me)))) await send(`${c.key} takes the name ${c.name}`, kp, [S.setProfile(me, c.name, undefined, c.badge, c.color)]);
    const ca = await conn.getAccountInfo(S.copyAddress(me));
    const cur = ca && ca.data.length ? S.decodeCopy(S.copyAddress(me), new Uint8Array(ca.data)) : undefined;
    if (cur?.leader.equals(leader) && cur.ratioBps === c.ratioBps) { say(`${c.key} already copies ${LEADERS[c.leader].name}`); continue; }
    // The page's one click: follow (unless following) and copy, in one transaction.
    await send(`${c.key} follows and copies ${LEADERS[c.leader].name} at ${c.ratioBps / 10_000}x${c.cap ? `, at most $${c.cap} a market` : ""}`, kp, [
      ...((await exists(S.followAddress(me, leader))) ? [] : [S.follow(me, leader)]),
      S.setCopy(me, leader, c.ratioBps, BigInt(c.cap * C.USDC)),
    ]);
  }
}

/** One reading. Returns how many (copier, market) pairs are out of line. */
async function status(): Promise<number> {
  const [snap, vaults, board] = await Promise.all([C.marketSnapshot(conn), C.listVaults(conn), S.loadBoard(conn)]);
  const live = vaults.filter(v => v.market.equals(C.MARKET) && v.canonical && v.status === 1 && v.feed && C.FEEDS.some(f => f.id === v.feed!.id));
  const data = (k: PublicKey) => snap.portfolios.find(p => p.pubkey.equals(C.routerPortfolio(k)))?.data;
  const eq = (d: Uint8Array) => { const p = C.decodePortfolio(d, 0); return p.capital + p.pnl; };
  let off = 0;
  for (const c of COPIERS) {
    if (!fs.existsSync(keyFile(c.key))) { say(`${c.key}: not set up`); continue; }
    const me = read(keyFile(c.key)).publicKey, leader = read(keyFile(LEADERS[c.leader].key)).publicKey;
    const copy = board.copies.find(x => x.follower.equals(me));
    const fd = data(me), ld = data(leader);
    if (!copy || !fd || !ld) { say(`${c.key}: ${!copy ? "is not copying anyone" : "no trading account"}`); continue; }
    const row = board.rows.find(r => r.wallet === me.toBase58()), lrow = board.rows.find(r => r.wallet === leader.toBase58());
    const parts: string[] = [];
    for (const v of live) {
      const price = C.decodeAsset(snap.market, v.assetIndex).price;
      const held = C.decodePortfolio(fd, v.assetIndex, snap.market).position, lead = C.decodePortfolio(ld, v.assetIndex, snap.market).position;
      const target = S.copyTarget(lead, eq(ld), eq(fd), copy.ratioBps, copy.maxNotional, price);
      const due = S.copyDue(held, target, price);
      if (due) off++;
      if (lead !== 0n || held !== 0n) parts.push(`${v.feed!.symbol} leader ${Number(lead) / 1e6} -> should ${Number(target) / 1e6}, holds ${Number(held) / 1e6}${due ? " (OUT OF LINE)" : ""}`);
    }
    say(`${row?.profile?.name ?? c.key} copies ${lrow?.profile?.name ?? LEADERS[c.leader].key} at ${copy.ratioBps / 10_000}x | equity $${(Number(eq(fd)) / 1e6).toFixed(2)} (leader $${(Number(eq(ld)) / 1e6).toFixed(2)}) | brought in line ${copy.triggers} times | record: ${row?.stats ? `${row.stats.trades} fills, profit $${row.pnl.toFixed(2)}` : "none"} | ${parts.join("; ") || "both flat"}`);
  }
  say(`track records on this market: ${board.rows.filter(r => r.stats).length}, profiles: ${board.profiles.size}, follows: ${board.follows.length}, copies: ${board.copies.length}`);
  return off;
}

(async () => {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "setup") { await setup(); await status().catch(e => say("status not read:", String(e?.message ?? e).slice(0, 100))); }
  else if (cmd === "watch") {
    const until = Date.now() + Number(process.argv[3] ?? 15) * 60_000;
    while (Date.now() < until) { await status().catch(e => say("error", String(e?.message ?? e).slice(0, 140))); await sleep(60_000); }
  } else await status();
})();
