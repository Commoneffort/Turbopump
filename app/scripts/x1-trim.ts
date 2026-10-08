// Winds markets down so they can be retired and stop costing keeper fees: closes the seed
// traders' positions on them, withdraws the seed liquidity, and claims it. A market with no
// shares, no position and nothing queued is then retired by the keeper (or `x1-tool retire-idle`)
// and its slot is free; the same feed can be opened again later.
//
// It only acts with the seed wallets (keys/seed). Positions or shares held by anyone else are
// listed and left alone, and a market whose vault holds a position keeps its liquidity.
// Run: NETWORK=x1-testnet npx tsx scripts/x1-trim.ts <status|close|withdraw|claim> KEEP=SOL,BTC,ETH
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const read = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const deployer = read(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
const seeds = ["seed-lp", "seed-trader-1", "seed-trader-2", "seed-trader-3"].filter(n => fs.existsSync(`../keys/seed/${n}.json`)).map(n => ({ name: n, kp: read(`../keys/seed/${n}.json`) }));
const keep = new Set((process.env.KEEP ?? "SOL,BTC,ETH").split(","));
const phase = process.argv[2] ?? "status";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function send(label: string, kp: Keypair, ixs: TransactionInstruction[]) {
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp]);
      for (let n = 0; n < 60; n++) {
        await sleep(1500);
        const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
        if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") { console.log("ok  ", label); return true; }
      }
      throw new Error("not confirmed within 90 s");
    } catch (e: any) {
      if (i === 2) { console.log("FAIL", label, String(e.message).split("\n")[0].slice(0, 140)); return false; }
      await sleep(3000);
    }
  }
  return false;
}

const vaults = (await C.listVaults(conn)).filter(v => v.market.equals(C.MARKET) && (v.status === 1 || phase === "claim" || phase === "status") && v.feed && !keep.has(v.feed.symbol));
console.log(`${phase}: ${vaults.length} market(s) to wind down, keeping ${[...keep].join(", ")}`);
for (const v of vaults) {
  const sym = v.feed!.symbol;
  if (v.status !== 1) {
    // Retired already: its slot is gone, and all that is left is what was withdrawn, to claim.
    for (const s of seeds) {
      const a = await conn.getAccountInfo(C.ticketAddress(v.key, s.kp.publicKey));
      const t = a ? C.decodeTicket(new Uint8Array(a.data)) : undefined;
      if (!t || (t.deposit === 0n && t.withdraw === 0n)) continue;
      console.log(`${sym.padEnd(9)} retired | ${s.name} has ${Number(t.withdraw) / 1e9} shares' worth to claim from epoch ${t.epoch}`);
      const u = s.kp.publicKey;
      if (phase === "claim") await send(`${sym}: ${s.name} claims epoch ${t.epoch}`, s.kp, [createAssociatedTokenAccountIdempotentInstruction(u, C.ata(u, C.MINT), u, C.MINT), createAssociatedTokenAccountIdempotentInstruction(u, C.ata(u, v.shareMint), u, v.shareMint), C.claim(v, u, t.epoch)]);
    }
    continue;
  }
  const states = [];
  for (const s of seeds) states.push({ ...s, st: await C.fetchVault(conn, v.key, s.kp.publicKey) });
  const any = states[0].st;
  const held = states.reduce((a, s) => a + s.st.userShares, 0n);
  const positions = states.filter(s => (s.st.portfolio?.position ?? 0n) !== 0n);
  const seedNet = positions.reduce((a, s) => a + s.st.portfolio!.position, 0n);
  // The vault holds the other side of every trader: if the seeds' positions do not add up to
  // it, someone else has a position here.
  const others = any.vault.inventory + seedNet !== 0n;
  const foreignShares = any.shareSupply - held;
  console.log(`${sym.padEnd(9)} shares ${Number(any.shareSupply) / 1e9} (seed ${Number(held) / 1e9}) vault position ${Number(any.vault.inventory) / 1e6}`
    + positions.map(s => ` | ${s.name} ${Number(s.st.portfolio!.position) / 1e6}`).join("")
    + (others ? " | SOMEONE ELSE HAS A POSITION" : "") + (foreignShares > 0n ? ` | ${Number(foreignShares) / 1e9} shares are someone else's` : "")
    + states.filter(s => s.st.ticket && (s.st.ticket.deposit > 0n || s.st.ticket.withdraw > 0n)).map(s => ` | ${s.name} ticket epoch ${s.st.ticket!.epoch} (vault epoch ${any.vault.epoch})`).join(""));

  if (phase === "close") {
    for (const s of positions) {
      if (s.st.trader?.hasPending) { console.log(`     ${s.name} already has a trade queued`); continue; }
      // The request carries a bond, returned to whoever fills it.
      if (await conn.getBalance(s.kp.publicKey) < C.ROUTER_BOND_LAMPORTS + 0.01 * LAMPORTS_PER_SOL) {
        await send(`top up ${s.name}`, deployer, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: s.kp.publicKey, lamports: C.ROUTER_BOND_LAMPORTS + 0.02 * LAMPORTS_PER_SOL })]);
      }
      const book = (await C.fetchVault(conn, v.key, s.kp.publicKey)).book;
      if (book) await send(`${sym}: queue close of ${s.name}'s ${Number(s.st.portfolio!.position) / 1e6}`, s.kp, [C.requestTrade(s.kp.publicKey, v.key, -s.st.portfolio!.position)]);
      await sleep(12_000); // one queued trade per wallet at a time, and the executor needs a moment
    }
  }
  // A withdrawal from a vault that holds a position would, an epoch later, let anyone close that
  // position by force. Such a market is left as it is until its traders have closed.
  if (phase === "withdraw" && any.vault.inventory !== 0n) console.log(`     ${sym} left alone: the vault holds a position`);
  if (phase === "withdraw" && any.vault.inventory === 0n) {
    for (const s of states.filter(s => s.st.userShares > 0n)) {
      const t = s.st.ticket;
      if (t && (t.deposit > 0n || t.withdraw > 0n)) { console.log(`     ${s.name} has a request outstanding (claim first if its epoch is over)`); continue; }
      await send(`${sym}: ${s.name} requests withdrawal of ${Number(s.st.userShares) / 1e9} shares`, s.kp, [C.requestWithdraw(s.st.vault, s.kp.publicKey, s.st.userShares)]);
    }
  }
  if (phase === "claim") {
    for (const s of states) {
      const t = s.st.ticket;
      if (!t || (t.deposit === 0n && t.withdraw === 0n) || t.epoch >= s.st.vault.epoch) continue;
      const u = s.kp.publicKey;
      await send(`${sym}: ${s.name} claims epoch ${t.epoch}`, s.kp, [
        createAssociatedTokenAccountIdempotentInstruction(u, C.ata(u, v.shareMint), u, v.shareMint),
        createAssociatedTokenAccountIdempotentInstruction(u, C.ata(u, C.MINT), u, C.MINT),
        C.claim(v, u, t.epoch),
      ]);
    }
  }
}
void PublicKey;
