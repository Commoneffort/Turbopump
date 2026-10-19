// Opens an xDEX pool of the chain's coin (wrapped XNT / SOL) against this network's test USDC, so
// the page's Swap can turn coin into margin. xDEX is Raydium's CP-Swap program; this sends its
// `initialize`. Without "send" it only simulates (and prints the pool-fee account xDEX expects).
//   NETWORK=x1-testnet|devnet npx tsx scripts/xdex-pool.ts <coin amount> <usdc amount> [send]
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as C from "../src/chain";
import { XDEX } from "../src/swap";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, "confirmed");
const key = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const kp = key(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
const faucet = key(process.env.FAUCET_KEY ?? (C.X1 ? "../keys/x1-faucet.json" : "../keys/faucet.json"));
const [coin, usdc, mode] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
if (!(coin > 0 && usdc > 0)) throw new Error("usage: xdex-pool.ts <coin amount> <usdc amount> [send]");

const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, XDEX.program)[0];
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (x: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return b; };

async function main() {
  const [m0, m1] = [NATIVE_MINT, C.MINT].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  const amount = (m: PublicKey) => (m.equals(NATIVE_MINT) ? BigInt(Math.round(coin * 1e9)) : BigInt(Math.round(usdc * C.USDC)));
  const pool = pda(Buffer.from("pool"), XDEX.ammConfig.toBuffer(), m0.toBuffer(), m1.toBuffer());
  const lp = pda(Buffer.from("pool_lp_mint"), pool.toBuffer());
  const me = kp.publicKey;
  const mine = (m: PublicKey) => getAssociatedTokenAddressSync(m, me);
  // xDEX's account for its pool-opening fee (its program names it when given a wrong one).
  const feeAccount = new PublicKey(process.env.POOL_FEE_ACCOUNT ?? (C.X1 ? "DwhWUT38Dwth5e1NYAJ2SSacYSaLEvct3kMndM7VSbcS" : "EogcepbZTPwPRQv6FCdViMjLwoFbrPy2i4NKv3zersvP"));
  console.log(`${C.NETWORK_NAME}: pool ${pool} (${m0} / ${m1}), ${coin} ${C.COIN} + ${usdc} USDC, config ${XDEX.ammConfig}`);
  if (await conn.getAccountInfo(pool)) { console.log("the pool exists already"); return; }

  const rw = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const init = new TransactionInstruction({
    programId: XDEX.program,
    keys: [
      rw(me, true), ro(XDEX.ammConfig), ro(XDEX.authority()), rw(pool), ro(m0), ro(m1), rw(lp),
      rw(mine(m0)), rw(mine(m1)), rw(getAssociatedTokenAddressSync(lp, me)),
      rw(pda(Buffer.from("pool_vault"), pool.toBuffer(), m0.toBuffer())), rw(pda(Buffer.from("pool_vault"), pool.toBuffer(), m1.toBuffer())),
      rw(feeAccount), rw(pda(Buffer.from("observation"), pool.toBuffer())),
      ro(TOKEN_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(TOKEN_PROGRAM_ID), ro(ASSOCIATED_TOKEN_PROGRAM_ID), ro(SystemProgram.programId), ro(SYSVAR_RENT_PUBKEY),
    ],
    data: Buffer.concat([disc("initialize"), u64(amount(m0)), u64(amount(m1)), u64(0n)]),
  });
  const wsol = mine(NATIVE_MINT);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(me, wsol, me, NATIVE_MINT),
    // The coin side, plus what xDEX charges for opening a pool (paid in wrapped coin).
    SystemProgram.transfer({ fromPubkey: me, toPubkey: wsol, lamports: amount(NATIVE_MINT) + 1_000_000_000n }),
    createSyncNativeInstruction(wsol),
    createAssociatedTokenAccountIdempotentInstruction(me, mine(C.MINT), me, C.MINT),
    createMintToInstruction(C.MINT, mine(C.MINT), faucet.publicKey, amount(C.MINT)),
    init,
  ];
  const tx = new Transaction().add(...ixs);
  tx.feePayer = me;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp, faucet);
  const sim = await conn.simulateTransaction(tx);
  console.log((sim.value.logs ?? []).filter(l => !/Tokenkeg|ATokenGP|ComputeBudget|invoke|success/.test(l)).join("\n"));
  if (sim.value.err) { console.log("simulation failed:", JSON.stringify(sim.value.err)); return; }
  if (mode !== "send") { console.log("simulation ok (add 'send' to open it)"); return; }
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  console.log("opened", pool.toBase58(), sig);
}
main().catch(e => { console.error(e); process.exit(1); });
