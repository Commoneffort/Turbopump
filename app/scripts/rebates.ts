// What the platform gives back out of its own share of the fees, worked out from what is on chain
// and from the log of every fill (scripts/fills-log.ts), between two readings a period apart. It
// is run once a week.
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/rebates.ts            what would be paid now (sends nothing, saves nothing)
//   NETWORK=...               npx tsx scripts/rebates.ts start      take the first reading (nothing is owed yet)
//   NETWORK=...               npx tsx scripts/rebates.ts pay        pay from the treasury's account and take the next reading
//
// Two things are paid (src/social.ts):
// - The first month's fees back (`NEW_WALLET`): a wallet in its first 30 days gets back the fees
//   of the trades it held at least `HOLD_SECS`, up to $50 a week, out of a weekly budget the
//   treasury sets aside. A trade closed sooner (open and close both) is not refunded, so free
//   volume cannot be made by trading in and out. Only one wallet per funder gets it (the one
//   whose record is oldest; see scripts/funders.ts), so it cannot be multiplied with new
//   wallets. Fills the log missed (more than 16 between two of its reads) are not refunded.
// - Volume rebates (`REBATE`): a wallet that traded 100,000 or more in the period gets 5% of its
//   own fees back, 1,000,000 or more 10%, counted only on the fees not already refunded, and
//   never more in total than the treasury took in in the period.
// There are no referral payments any more (removed 2026-10-20).
//
// `pay` needs the treasury's key (TREASURY_KEYPAIR, default ~/.config/solana/percolator-treasury.json).
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";
import { readLog, type LoggedFill, type CountLine } from "./fills-log";
import { funderOf, sharedFunders } from "./funders";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const manifest = JSON.parse(fs.readFileSync(C.X1 ? "../deploy/x1-testnet.json" : "../deploy/devnet.json", "utf8"));
const account = new PublicKey(manifest.treasury_collateral);
const FILE = `../deploy/logs/rebates-${C.X1 ? "x1" : "devnet"}.json`;
type Reading = { at: number; balance: number; paid: number; volume: Record<string, number>; trades?: Record<string, number>; start?: Record<string, number> };
const usd = (x: number) => `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A trade closed less than this long after it was opened is not refunded (open nor close). */
export const HOLD_SECS = 300;

async function read(): Promise<Reading> {
  const [stats, bal] = await Promise.all([
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: S.STATS_LEN }, { memcmp: { offset: 40, bytes: C.MARKET.toBase58() } }] }),
    conn.getTokenAccountBalance(account),
  ]);
  const volume: Record<string, number> = {}, trades: Record<string, number> = {}, start: Record<string, number> = {};
  for (const a of stats) { const s = S.decodeStats(new Uint8Array(a.account.data)); const w = s.wallet.toBase58(); volume[w] = s.volume; trades[w] = s.trades; start[w] = s.startTime; }
  return { at: Math.floor(Date.now() / 1000), balance: Number(bal.value.amount) / C.USDC, paid: 0, volume, trades, start };
}

/** For each of a wallet's fills (oldest first), the part of its value that may be refunded: all
 *  of it, less what opened a position closed within `HOLD_SECS` and what closed one opened
 *  within it (matched first in, first out, per market). */
export function refundable(fills: LoggedFill[]): number[] {
  const out = fills.map(f => Math.abs(f.size * f.price));
  const lots = new Map<number, { i: number; qty: number; time: number }[]>();
  fills.forEach((f, i) => {
    const q = lots.get(f.asset) ?? lots.set(f.asset, []).get(f.asset)!;
    let left = Math.abs(f.size);
    while (left > 1e-9 && q.length && Math.sign(q[0].qty) !== Math.sign(f.size)) {
      const lot = q[0], take = Math.min(left, Math.abs(lot.qty));
      if (f.time - lot.time < HOLD_SECS) {
        out[i] -= take * f.price;
        out[lot.i] -= take * fills[lot.i].price;
      }
      lot.qty -= Math.sign(lot.qty) * take;
      left -= take;
      if (Math.abs(lot.qty) <= 1e-9) q.shift();
    }
    if (left > 1e-9) q.push({ i, qty: Math.sign(f.size) * left, time: f.time });
  });
  return out.map(x => Math.max(0, x));
}

/** What each wallet is owed for the period between `then` and `now`. `funders` maps a wallet to
 *  the wallet that funded it (itself for shared sources); `log` is the fill log. */
export function owed(then: Reading, now: Reading, log: { fills: LoggedFill[]; counts: CountLine[] }, funders: Map<string, string>) {
  const out = new Map<string, { own: number; volume: number; fresh: number; held: number; quick: number; missed: number }>();
  const feeOf = (notional: number) => notional * S.feeSharePerMillion(1) / 1e6;
  const byWallet = new Map<string, LoggedFill[]>();
  for (const f of log.fills) (byWallet.get(f.wallet) ?? byWallet.set(f.wallet, []).get(f.wallet)!).push(f);
  // One first-month refund per funder: the wallet with the oldest record among those it funded.
  const firstOf = new Map<string, string>();
  for (const w of Object.keys(now.volume).sort((a, b) => (now.start?.[a] ?? 0) - (now.start?.[b] ?? 0))) {
    const f = funders.get(w) ?? w;
    if (!firstOf.has(f)) firstOf.set(f, w);
  }
  for (const [w, total] of Object.entries(now.volume)) {
    const traded = Math.max(0, total - (then.volume[w] ?? 0));
    if (traded <= 0) continue;
    const fills = byWallet.get(w) ?? [];
    const ok = refundable(fills);
    let held = 0, logged = 0;
    fills.forEach((f, i) => { if (f.time > then.at && f.time <= now.at) { held += ok[i]; logged++; } });
    const tradesIn = Math.max(0, (now.trades?.[w] ?? 0) - (then.trades?.[w] ?? 0));
    const r = { own: 0, volume: traded, fresh: 0, held, quick: Math.max(0, traded - held), missed: Math.max(0, tradesIn - logged) };
    const born = now.start?.[w] ?? 0;
    const isFirst = firstOf.get(funders.get(w) ?? w) === w;
    if (born > 0 && now.at - born <= S.NEW_WALLET.days * 86_400 && isFirst) r.fresh = Math.min(S.NEW_WALLET.capPerWeek, feeOf(held) * S.NEW_WALLET.share);
    const tier = S.REBATE.tiers.find(t => traded >= t.weekVolume);
    if (tier) r.own = Math.max(0, feeOf(traded) - r.fresh) * tier.share;
    out.set(w, r);
  }
  const freshTotal = [...out.values()].reduce((t, r) => t + r.fresh, 0);
  const freshScale = freshTotal > S.NEW_WALLET.weekBudget ? S.NEW_WALLET.weekBudget / freshTotal : 1;
  for (const r of out.values()) r.fresh *= freshScale;
  // Volume rebates: never more than the treasury took in since the last reading.
  const income = Math.max(0, now.balance - then.balance);
  const ownTotal = [...out.values()].reduce((s, r) => s + r.own, 0);
  const ownScale = ownTotal > income * S.REBATE.mostOfIncome ? (ownTotal > 0 ? income * S.REBATE.mostOfIncome / ownTotal : 0) : 1;
  for (const r of out.values()) r.own *= ownScale;
  return { rows: out, income, total: ownTotal * ownScale, scale: ownScale, fresh: freshTotal * freshScale };
}

if (process.argv[1]?.endsWith("rebates.ts")) (async () => {
  const cmd = process.argv[2] ?? "show";
  if (cmd === "start" && fs.existsSync(FILE)) throw new Error(`${FILE} exists: there is a reading already`);
  const now = await read();
  if (cmd === "start") {
    fs.writeFileSync(FILE, JSON.stringify(now, null, 1));
    console.log(`first reading taken: ${Object.keys(now.volume).length} track records, treasury holds ${usd(now.balance)}`);
    return;
  }
  if (!fs.existsSync(FILE)) throw new Error(`no reading yet: run "start" first`);
  const then: Reading = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const log = readLog();
  if (!log.fills.length) console.log("  (no fill log yet: run scripts/fills-log.ts; until it has the period's fills nothing is refunded)");
  const shared = await sharedFunders(conn);
  const funders = new Map<string, string>();
  for (const w of Object.keys(now.volume)) {
    const born = now.start?.[w] ?? 0;
    // Only wallets that could get the first month's refund need their funder looked up.
    if (born > 0 && now.at - born <= S.NEW_WALLET.days * 86_400) funders.set(w, await funderOf(conn, w, shared).catch(() => w));
  }
  const { rows, income, total, scale, fresh } = owed(then, now, log, funders);
  const days = (now.at - then.at) / 86_400;
  console.log(`${C.X1 ? "X1 testnet" : "Solana devnet"}: ${days.toFixed(2)} days since the last reading`);
  console.log(`traded ${usd([...rows.values()].reduce((s, r) => s + r.volume, 0))}; the treasury took in ${usd(income)}; volume rebates ${usd(total)}${scale < 1 ? ` (cut to ${(scale * 100).toFixed(0)}% of what they would be: never more than income)` : ""} + first-month refunds ${usd(fresh)}`);
  const sum = (r: { own: number; fresh: number }) => r.own + r.fresh;
  const pay = [...rows.entries()].filter(([, r]) => sum(r) >= 0.01).sort((a, b) => sum(b[1]) - sum(a[1]));
  for (const [w, r] of pay) console.log(`  ${w}  traded ${usd(r.volume).padStart(14)}  held 5 min+ ${usd(r.held).padStart(14)}  rebate ${usd(r.own).padStart(9)}  first month ${usd(r.fresh).padStart(8)}${r.missed ? `  (${r.missed} fills not logged)` : ""}${funders.get(w) && funders.get(w) !== w ? `  funded by ${funders.get(w)!.slice(0, 6)}…` : ""}`);
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
