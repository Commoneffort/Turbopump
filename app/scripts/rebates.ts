// What the platform gives back out of its own share of the fees: a part to whoever referred a
// wallet, and a part to wallets that trade a lot. Worked out from what is on chain (every wallet's
// track record holds the total it has traded; a referral is an account the referred wallet wrote
// once), between two readings a period apart. It is run once a week.
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/rebates.ts            what would be paid now (sends nothing, saves nothing)
//   NETWORK=...               npx tsx scripts/rebates.ts start      take the first reading (nothing is owed yet)
//   NETWORK=...               npx tsx scripts/rebates.ts pay        pay from the treasury's account and take the next reading
//
// Rates (src/social.ts `REBATE`, shares of the trade fee): a referrer gets 21% of the fees its
// wallets paid since the last reading (only wallets that were already referred at that reading); a
// wallet that traded 100,000 or more in the period gets 5% of its own fees back, 1,000,000 or more
// 10%. The platform takes in a fifth of the fees. Referrals are paid first and volume rebates from
// what is left; nothing is paid beyond what the treasury's account actually received in the
// period (both are cut in proportion when they would be): rebates never cost more than it earned.
// Apart from that, a wallet in its first 30 days gets its own fees back in full (src/social.ts
// NEW_WALLET: at most $50 a week each, out of a $2,000 weekly budget the treasury sets aside).
//
// `pay` needs the treasury's key (TREASURY_KEYPAIR, default ~/.config/solana/percolator-treasury.json).
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const manifest = JSON.parse(fs.readFileSync(C.X1 ? "../deploy/x1-testnet.json" : "../deploy/devnet.json", "utf8"));
const account = new PublicKey(manifest.treasury_collateral);
const FILE = `../deploy/logs/rebates-${C.X1 ? "x1" : "devnet"}.json`;
type Reading = { at: number; balance: number; paid: number; volume: Record<string, number>; referred: Record<string, string>; start?: Record<string, number> };
const usd = (x: number) => `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function read(): Promise<Reading> {
  const [stats, refs, bal] = await Promise.all([
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: S.STATS_LEN }, { memcmp: { offset: 40, bytes: C.MARKET.toBase58() } }] }),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: S.REFERRAL_LEN }] }),
    conn.getTokenAccountBalance(account),
  ]);
  const volume: Record<string, number> = {};
  const start: Record<string, number> = {};
  for (const a of stats) { const s = S.decodeStats(new Uint8Array(a.account.data)); volume[s.wallet.toBase58()] = s.volume; start[s.wallet.toBase58()] = s.startTime; }
  const referred: Record<string, string> = {};
  for (const a of refs) { const r = S.decodeReferral(new Uint8Array(a.account.data)); referred[r.wallet.toBase58()] = r.referrer.toBase58(); }
  return { at: Math.floor(Date.now() / 1000), balance: Number(bal.value.amount) / C.USDC, paid: 0, volume, referred, start };
}

/** What each wallet is owed for the period between `then` and `now`. */
export function owed(then: Reading, now: Reading) {
  const out = new Map<string, { own: number; referral: number; volume: number; fresh: number }>();
  const row = (w: string) => out.get(w) ?? out.set(w, { own: 0, referral: 0, volume: 0, fresh: 0 }).get(w)!;
  for (const [w, total] of Object.entries(now.volume)) {
    const traded = Math.max(0, total - (then.volume[w] ?? 0));
    if (traded <= 0) continue;
    row(w).volume = traded;
    const tier = S.REBATE.tiers.find(t => traded >= t.weekVolume);
    if (tier) row(w).own = traded * S.feeSharePerMillion(tier.share) / 1e6;
    const referrer = then.referred[w];
    if (referrer && referrer !== w) row(referrer).referral += traded * S.feeSharePerMillion(S.REBATE.referrerShare) / 1e6;
    // A wallet in its first month gets its own fees back (up to a cap), from a budget of its own.
    const born = now.start?.[w] ?? 0;
    if (born > 0 && now.at - born <= S.NEW_WALLET.days * 86_400) row(w).fresh = Math.min(S.NEW_WALLET.capPerWeek, traded * S.feeSharePerMillion(S.NEW_WALLET.share) / 1e6);
  }
  const freshTotal = [...out.values()].reduce((t, r) => t + r.fresh, 0);
  const freshScale = freshTotal > S.NEW_WALLET.weekBudget ? S.NEW_WALLET.weekBudget / freshTotal : 1;
  for (const r of out.values()) r.fresh *= freshScale;
  // Never more than the treasury took in since the last reading: referrals first, then volume rebates.
  const income = Math.max(0, now.balance - then.balance);
  const rs = [...out.values()];
  const refTotal = rs.reduce((s, r) => s + r.referral, 0), ownTotal = rs.reduce((s, r) => s + r.own, 0);
  const total = refTotal + ownTotal;
  const most = income * S.REBATE.mostOfIncome;
  const refScale = refTotal > most ? most / refTotal : 1;
  const left = most - refTotal * refScale;
  const ownScale = ownTotal > left ? (ownTotal > 0 ? left / ownTotal : 0) : 1;
  for (const r of rs) { r.referral *= refScale; r.own *= ownScale; }
  const scale = total > 0 ? (refTotal * refScale + ownTotal * ownScale) / total : 1;
  return { rows: out, income, total: total * scale, scale, fresh: freshTotal * freshScale };
}

if (process.argv[1]?.endsWith("rebates.ts")) (async () => {
  const cmd = process.argv[2] ?? "show";
  if (cmd === "start" && fs.existsSync(FILE)) throw new Error(`${FILE} exists: there is a reading already`);
  const now = await read();
  if (cmd === "start") {
    fs.writeFileSync(FILE, JSON.stringify(now, null, 1));
    console.log(`first reading taken: ${Object.keys(now.volume).length} track records, ${Object.keys(now.referred).length} referrals, treasury holds ${usd(now.balance)}`);
    return;
  }
  if (!fs.existsSync(FILE)) throw new Error(`no reading yet: run "start" first`);
  const then: Reading = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const { rows, income, total, scale, fresh } = owed(then, now);
  const days = (now.at - then.at) / 86_400;
  console.log(`${C.X1 ? "X1 testnet" : "Solana devnet"}: ${days.toFixed(2)} days since the last reading`);
  console.log(`traded ${usd([...rows.values()].reduce((s, r) => s + r.volume, 0))}; the treasury took in ${usd(income)}; rebates ${usd(total)} + first-month refunds ${usd(fresh)}${scale < 1 ? ` (cut to ${(scale * 100).toFixed(0)}%: three quarters of income is the most)` : ""}`);
  const sum = (r: { own: number; referral: number; fresh: number }) => r.own + r.referral + r.fresh;
  const pay = [...rows.entries()].filter(([, r]) => sum(r) >= 0.01).sort((a, b) => sum(b[1]) - sum(a[1]));
  for (const [w, r] of pay) console.log(`  ${w}  traded ${usd(r.volume).padStart(14)}  own ${usd(r.own).padStart(9)}  as referrer ${usd(r.referral).padStart(9)}  first month ${usd(r.fresh).padStart(8)}`);
  if (!pay.length) console.log("  nobody is owed a cent yet");
  if (cmd !== "pay") return;
  const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.TREASURY_KEYPAIR ?? `${process.env.HOME}/.config/solana/percolator-treasury.json`, "utf8"))));
  if (!treasury.publicKey.equals(C.TREASURY)) throw new Error("not the treasury's key");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`, "utf8"))));
  let paid = 0;
  for (let i = 0; i < pay.length; i += 6) {
    const tx = new Transaction();
    for (const [w, r] of pay.slice(i, i + 6)) {
      const to = new PublicKey(w), amount = BigInt(Math.floor(sum(r) * C.USDC));
      tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, C.ata(to, C.MINT), to, C.MINT), createTransferInstruction(account, C.ata(to, C.MINT), treasury.publicKey, amount));
      paid += Number(amount) / C.USDC;
    }
    const sig = await conn.sendTransaction(tx, [payer, treasury]);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`  paid ${Math.min(i + 6, pay.length)} of ${pay.length}: ${sig}`);
  }
  // The next period starts from what the treasury holds after paying.
  fs.writeFileSync(FILE, JSON.stringify({ ...now, balance: now.balance - paid, paid }, null, 1));
  console.log(`paid ${usd(paid)}; next reading saved`);
})().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
