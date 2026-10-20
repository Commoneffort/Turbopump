// The weekly trading contest (rules: src/social.ts CONTEST; the leaderboard shows it live).
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/contest.ts          this week's standings now
//   NETWORK=...               npx tsx scripts/contest.ts snap     saves the standings of the week (run just before it ends:
//                                                                 a record keeps its last 16 fills, so the trade count fades later)
//   NETWORK=...               npx tsx scripts/contest.ts pay      pays last week's prizes from the treasury, once
//
// `pay` uses the snapshot saved for that week if there is one, else reads the chain now. It needs
// the treasury's key (TREASURY_KEYPAIR, default ~/.config/solana/percolator-treasury.json) and
// sends test USDC from the treasury's collateral account; a week is never paid twice
// (deploy/logs/contest-<network>.json).
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const manifest = JSON.parse(fs.readFileSync(C.X1 ? "../deploy/x1-testnet.json" : "../deploy/devnet.json", "utf8"));
const FILE = `../deploy/logs/contest-${C.X1 ? "x1" : "devnet"}.json`;
type Saved = { snaps: Record<string, S.ContestRow[]>; paid: Record<string, { at: number; to: { wallet: string; usdc: number; sig?: string }[] }> };
const saved = (): Saved => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { snaps: {}, paid: {} });
const keep = (s: Saved) => fs.writeFileSync(FILE, JSON.stringify(s, null, 1));

async function standings(week: ReturnType<typeof S.contestWeek>) {
  const accs = await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: S.STATS_LEN }, { memcmp: { offset: 40, bytes: C.MARKET.toBase58() } }] });
  return S.contestStandings(accs.map(a => { const s = S.decodeStats(new Uint8Array(a.account.data)); return { wallet: s.wallet.toBase58(), stats: s }; }), week);
}
const print = (rows: S.ContestRow[]) => rows.slice(0, 20).forEach((r, i) => console.log(`${String(i + 1).padStart(3)}. ${r.wallet}  return ${(r.ret * 100).toFixed(2)}%  profit $${r.pnl.toFixed(2)}  funded $${r.base.toFixed(0)}  trades ${r.trades}${i < S.CONTEST.prizes.length ? `  prize $${S.CONTEST.prizes[i]}` : ""}`));

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
  if (cmd !== "pay") throw new Error("usage: contest.ts [show|snap|pay]");
  const week = S.contestWeek(Date.now() / 1000 - 7 * 86_400);
  const id = String(week.start);
  if (s.paid[id]) { console.log(`week ${id} was paid already`); return; }
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
  const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.TREASURY_KEYPAIR ?? `${process.env.HOME}/.config/solana/percolator-treasury.json`, "utf8"))));
  const from = new PublicKey(manifest.treasury_collateral);
  const to: Saved["paid"][string]["to"] = [];
  for (const [i, prize] of S.CONTEST.prizes.entries()) {
    const r = rows[i];
    if (!r) break;
    const wallet = new PublicKey(r.wallet), ata = getAssociatedTokenAddressSync(C.MINT, wallet, true);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, ata, wallet, C.MINT),
      createTransferInstruction(from, ata, treasury.publicKey, BigInt(prize) * BigInt(C.USDC)),
    );
    const sig = await conn.sendTransaction(tx, [treasury]);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`paid $${prize} to ${r.wallet} (${sig})`);
    to.push({ wallet: r.wallet, usdc: prize, sig });
  }
  s.paid[id] = { at: Math.floor(Date.now() / 1000), to };
  keep(s);
})();
