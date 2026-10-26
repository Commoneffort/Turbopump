// The weekly trading contest (rules: src/social.ts CONTEST; the leaderboard shows it live).
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/contest.ts          this week's standings now
//   NETWORK=...               npx tsx scripts/contest.ts snap     saves the standings of the week (run just before it ends:
//                                                                 a record keeps its last 16 fills, so the trade count fades later)
//   NETWORK=...               npx tsx scripts/contest.ts pay      proposes last week's winners (sends nothing)
//   NETWORK=...               npx tsx scripts/contest.ts approve  pays the proposed winners from the treasury, once
//
// Rules: src/social.ts CONTEST (most dollar profit; $1,000+ in the account; record 7+ days old).
// `pay` leaves out our own test bots and keeps one winner per funder (scripts/funders.ts: wallets
// funded by the same wallet are one person's), then saves the list for someone to look at;
// nothing is sent until `approve`. `pay` uses the snapshot saved for that week if there is one,
// else reads the chain now. `approve` needs
// the treasury's key (TREASURY_KEYPAIR, default ~/.config/solana/percolator-treasury.json) and
// sends test USDC from the treasury's collateral account; a week is never paid twice
// (deploy/logs/contest-<network>.json).
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";
import { funderOf, sharedFunders } from "./funders";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const manifest = JSON.parse(fs.readFileSync(C.X1 ? "../deploy/x1-testnet.json" : "../deploy/devnet.json", "utf8"));
const FILE = `../deploy/logs/contest-${C.X1 ? "x1" : "devnet"}.json`;
type Saved = { snaps: Record<string, S.ContestRow[]>; paid: Record<string, { at: number; to: { wallet: string; usdc: number; sig?: string }[] }>; proposed?: Record<string, { at: number; to: { wallet: string; usdc: number; funder: string }[] }> };
const saved = (): Saved => { const s: Saved = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { snaps: {}, paid: {} }; s.proposed ??= {}; return s; };
const keep = (s: Saved) => fs.writeFileSync(FILE, JSON.stringify(s, null, 1));

async function standings(week: ReturnType<typeof S.contestWeek>) {
  const accs = await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: S.STATS_LEN }, { memcmp: { offset: 40, bytes: C.MARKET.toBase58() } }] });
  return S.contestStandings(accs.map(a => { const s = S.decodeStats(new Uint8Array(a.account.data)); return { wallet: s.wallet.toBase58(), stats: s }; }), week);
}
const print = (rows: S.ContestRow[]) => rows.slice(0, 20).forEach((r, i) => console.log(`${String(i + 1).padStart(3)}. ${r.wallet}  profit $${r.pnl.toFixed(2)}  return ${(r.ret * 100).toFixed(2)}%  funded $${r.base.toFixed(0)}  trades ${r.trades}${i < S.CONTEST.prizes.length ? `  prize $${S.CONTEST.prizes[i]}` : ""}`));

(async () => {
  const cmd = process.argv[2] ?? "show";
  const s = saved();
  if (cmd === "show" || cmd === "snap") {
    const week = S.contestWeek();
    const rows = await standings(week);
    console.log(`week from ${new Date(week.start * 1000).toISOString().slice(0, 10)}: ${rows.length} qualifying`);
    print(rows);
    if (cmd === "snap") { s.snaps[String(week.start)] = rows; keep(s); console.log("saved"); }
    return;
  }
  if (cmd !== "pay" && cmd !== "approve") throw new Error("usage: contest.ts [show|snap|pay|approve]");
  const week = S.contestWeek(Date.now() / 1000 - 7 * 86_400);
  const id = String(week.start);
  if (s.paid[id]) { console.log(`week ${id} was paid already`); return; }
  if (cmd === "pay") {
    // Our own test bots (keys/bots, keys/copy-bots) and any wallet in CONTEST_EXCLUDE win nothing.
    const ours = new Set((process.env.CONTEST_EXCLUDE ?? "").split(",").filter(Boolean));
    for (const dir of ["../keys/bots", "../keys/copy-bots"]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
        try { ours.add(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")))).publicKey.toBase58()); } catch { /* not a key */ }
      }
    }
    const rows = (s.snaps[id] ?? (await standings(week))).filter(r => !ours.has(r.wallet));
    print(rows);
    // One prize per funder: the best-placed of the wallets one wallet funded.
    const shared = await sharedFunders(conn), seen = new Set<string>();
    const to: { wallet: string; usdc: number; funder: string }[] = [];
    for (const r of rows) {
      if (to.length >= S.CONTEST.prizes.length) break;
      const funder = await funderOf(conn, r.wallet, shared).catch(() => r.wallet);
      if (seen.has(funder)) { console.log(`  skipped ${r.wallet}: funded by ${funder}, like a wallet placed above it`); continue; }
      seen.add(funder);
      to.push({ wallet: r.wallet, usdc: S.CONTEST.prizes[to.length], funder });
    }
    s.proposed![id] = { at: Math.floor(Date.now() / 1000), to };
    keep(s);
    console.log(`proposed for week ${id} (nothing sent):`);
    for (const t of to) console.log(`  $${t.usdc} to ${t.wallet}${t.funder !== t.wallet ? ` (funded by ${t.funder})` : ""}`);
    console.log("look at these accounts, then run: contest.ts approve");
    return;
  }
  const proposal = s.proposed![id];
  if (!proposal) throw new Error(`nothing proposed for week ${id}: run "pay" first`);
  const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.TREASURY_KEYPAIR ?? `${process.env.HOME}/.config/solana/percolator-treasury.json`, "utf8"))));
  const from = new PublicKey(manifest.treasury_collateral);
  const to: Saved["paid"][string]["to"] = [];
  for (const { wallet: w, usdc: prize } of proposal.to) {
    const wallet = new PublicKey(w), ata = getAssociatedTokenAddressSync(C.MINT, wallet, true);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, ata, wallet, C.MINT),
      createTransferInstruction(from, ata, treasury.publicKey, BigInt(prize) * BigInt(C.USDC)),
    );
    const sig = await conn.sendTransaction(tx, [treasury]);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`paid $${prize} to ${w} (${sig})`);
    to.push({ wallet: w, usdc: prize, sig });
  }
  s.paid[id] = { at: Math.floor(Date.now() / 1000), to };
  keep(s);
})();
