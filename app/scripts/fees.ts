// What the router's fees (router `carry`) look like on a network, read only: each vault's holding
// fee rate now, and what the trading accounts owe the vaults.
// Run: NETWORK=x1-testnet|devnet npx tsx scripts/fees.ts   (RPC=... to read another chain)
import { Connection, PublicKey } from "@solana/web3.js";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, "confirmed");
const vaults = (await C.listVaults(conn)).filter(v => v.canonical);
const carries = await conn.getMultipleAccountsInfo(vaults.map(v => C.carryAddress(v.key)));
console.log("vault       meter  rate now");
vaults.forEach((v, i) => {
  const c = C.decodeCarry(carries[i] ? new Uint8Array(carries[i]!.data) : null);
  const rate = c?.rateE12 ?? 0n;
  console.log(`${(v.feed?.symbol ?? v.key.toBase58().slice(0, 6)).padEnd(11)} ${c ? "yes" : "no "}    ${rate === 0n ? "none" : `${rate > 0n ? "longs" : "shorts"} pay ${C.holdPctHour(rate).toFixed(4)}%/h (${C.holdPctYear(rate).toFixed(1)}%/yr)`}`);
});
const ledgers = await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.CARRY.ledgerLen }] });
const owed = ledgers.map(l => ({ trader: new PublicKey(l.account.data.subarray(8, 40)), owed: C.decodeLedger(new Uint8Array(l.account.data)) }));
const total = owed.reduce((t, o) => t + C.totalOwed(o.owed), 0n);
const byAsset = new Map<number, bigint>();
for (const o of owed) for (const e of o.owed) byAsset.set(e.asset, (byAsset.get(e.asset) ?? 0n) + e.owed);
console.log(`\n${ledgers.length} fee ledgers, ${owed.filter(o => C.totalOwed(o.owed) > 0n).length} owing, $${(Number(total) / 1e6).toFixed(4)} owed in all`);
for (const [a, x] of byAsset) console.log(`  ${(vaults.find(v => v.assetIndex === a)?.feed?.symbol ?? `asset ${a}`).padEnd(10)} $${(Number(x) / 1e6).toFixed(4)}`);
