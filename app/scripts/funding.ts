// Funding on a live network: show each market's rate, or switch funding on.
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/funding.ts          each market's rate now (sends nothing)
//   NETWORK=...               npx tsx scripts/funding.ts off      sets the market's funding cap to the
//                                                                 vault program's constant, 0 since
//                                                                 2026-10-20 (SetFundingCap; anyone may
//                                                                 send it, the governor signs)
//
// Needs the engine, vault and router builds with funding (deploy/apply-funding.sh does them first).
// KEYPAIR (default the network's deploy wallet) pays the fee.
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, "confirmed");
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function show() {
  const m = await C.fetchMarket(conn);
  const cap = C.fundingOf(m.data, 0).capE9;
  say(`${C.NETWORK_NAME}: funding ${cap > 0n ? `on, cap ${cap} e9 per slot (${(C.fundingPerHour(cap) * 100).toFixed(4)}%/h)` : "off"}`);
  for (const v of (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1)) {
    const f = C.fundingOf(m.data, v.assetIndex);
    const who = f.rateE9 > 0n ? "longs pay" : f.rateE9 < 0n ? "shorts pay" : "nobody pays";
    say(`  ${v.feed?.symbol}: ${f.rateE9} e9/slot, ${(Math.abs(C.fundingPerHour(f.rateE9)) * 100).toFixed(5)}%/h, ${who}; set at slot ${f.setSlot}; vault holds ${Number(v.inventory) / 1e6}`);
  }
}

(async () => {
  if (process.argv[2] === "on" || process.argv[2] === "off") {
    // SetFundingCap sets the cap to the vault program's constant: "on" or "off" is whichever that
    // build has (0 = off), and the word only says what is expected.
    const want = BigInt((C.LAYOUT.router as any).funding_canon_cap_e9 ?? 0);
    if ((want > 0n) !== (process.argv[2] === "on")) throw new Error(`this build of the vault program sets the cap to ${want}: funding ${want > 0n ? "on" : "off"}, not ${process.argv[2]}`);
    const m = await C.fetchMarket(conn);
    if (C.fundingOf(m.data, 0).capE9 === want) say(`funding is ${process.argv[2]} already`);
    else {
      const key = process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`;
      const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(key, "utf8"))));
      const ixs = [C.setFundingCap()];
      const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp]);
      await conn.confirmTransaction(sig, "confirmed");
      say(`funding switched ${process.argv[2]}: ${sig}`);
    }
  }
  await show();
})().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
