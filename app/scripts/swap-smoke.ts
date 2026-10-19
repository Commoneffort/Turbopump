// Swaps a little of the chain's coin on an xDEX pool through the live router, with the page's own
// code (src/swap.ts), and checks the platform fee and the amount received against the quote.
//   NETWORK=x1-testnet|devnet npx tsx scripts/swap-smoke.ts <pool> [coin amount, default 0.05] [back]
// "back" also swaps what it received back into coin.
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/swap";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`, "utf8"))));
const me = kp.publicKey;

async function tokenBalance(mint: PublicKey, program: PublicKey, owner: PublicKey) {
  const a = await conn.getAccountInfo(getAssociatedTokenAddressSync(mint, owner, true, program));
  return a ? Buffer.from(a.data).readBigUInt64LE(64) : 0n;
}

async function swap(p: S.Pool, from: 0 | 1, amountIn: bigint) {
  const to = (1 - from) as 0 | 1;
  const q = S.quote(p, from, amountIn, 100);
  const native = (i: 0 | 1) => p.mints[i].equals(NATIVE_MINT);
  const before = native(to) ? BigInt(await conn.getBalance(me)) : await tokenBalance(p.mints[to], p.programs[to], me);
  const feeBefore = await tokenBalance(p.mints[from], p.programs[from], C.TREASURY);
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ...S.swapInstructions(me, p, from, q));
  const sig = await conn.sendTransaction(tx, [kp]);
  await conn.confirmTransaction(sig, "confirmed");
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const after = native(to) ? BigInt(await conn.getBalance(me)) : await tokenBalance(p.mints[to], p.programs[to], me);
  // Received coin is net of the transaction fee and rent changes; the router's log line has the exact amount.
  const line = (t?.meta?.logMessages ?? []).find(l => l.includes("swap: ")) ?? "";
  const out = BigInt(line.match(/, (\d+) out/)?.[1] ?? "-1");
  const fee = (await tokenBalance(p.mints[from], p.programs[from], C.TREASURY)) - feeBefore;
  console.log(`${sig}\n  ${line.replace("Program log: ", "")}\n  quote ${q.out}, received ${out} (balance change ${after - before}), platform fee ${fee} (expected ${q.platformFee}), impact ${q.impactBps} bps`);
  if (out !== q.out) throw new Error(`received ${out}, quoted ${q.out}`);
  if (fee !== q.platformFee) throw new Error(`treasury got ${fee}, expected ${q.platformFee}`);
  return out;
}

async function main() {
  const poolKey = new PublicKey(process.argv[2] ?? S.USDC_POOL);
  const coin = Number(process.argv[3] ?? 0.05);
  let p = await S.readPool(conn, poolKey);
  const from = p.mints[0].equals(NATIVE_MINT) ? 0 : p.mints[1].equals(NATIVE_MINT) ? 1 : undefined;
  if (from === undefined) throw new Error("this pool has no coin side");
  console.log(`${C.NETWORK_NAME}: pool ${poolKey}, fee ${p.feeRate}/1e6, reserves ${p.reserves}${p.unsupported ? `, UNSUPPORTED: ${p.unsupported}` : ""}`);
  const got = await swap(p, from, BigInt(Math.round(coin * 1e9)));
  if (process.argv[4] === "back") {
    p = await S.readPool(conn, poolKey);
    await swap(p, (1 - from) as 0 | 1, got);
  }
  console.log("ok");
}
main().catch(e => { console.error("FAILED", e?.message ?? e, (e?.logs ?? []).slice(-6).join("\n")); process.exit(1); });
