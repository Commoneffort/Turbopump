// Puts a badge picture on a test wallet the way the page does (pay and first part, then the
// rest), reads it back, and shows what the treasury received.
//   NETWORK=x1-testnet|devnet npx tsx scripts/badge-smoke.ts <wallet key file> <64x64 jpeg> [remove]
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";
import * as S from "../src/social";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch(C.X1 ? 0 : 150) });
const read = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const deployer = read(`${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
async function send(label: string, kp: Keypair, ixs: TransactionInstruction[]) {
  const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp]);
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
    if (st?.err) throw new Error(`${label}: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return console.log("ok", label);
  }
  throw new Error(`${label}: not confirmed`);
}
(async () => {
  const kp = read(process.argv[2]), me = kp.publicKey;
  if (process.argv[4] === "remove") return send("remove the picture", kp, [S.removeBadgeImage(me)]);
  const bytes = new Uint8Array(fs.readFileSync(process.argv[3]));
  if (bytes.length > S.BADGE_TARGET_BYTES) throw new Error(`the picture is ${bytes.length} bytes: the page stores at most ${S.BADGE_TARGET_BYTES}`);
  const need = S.SOCIAL_FEE + BigInt(0.03 * LAMPORTS_PER_SOL);
  if (BigInt(await conn.getBalance(me)) < need) await send("fee and rent for the wallet", deployer, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: me, lamports: Number(need) })]);
  const before = await conn.getBalance(C.TREASURY);
  await send(`start the picture (${bytes.length} bytes) and pay ${S.SOCIAL_FEE_TEXT}`, kp, [S.setBadgeImage(me, bytes.length, bytes.slice(0, S.BADGE_CHUNK))]);
  for (let at = S.BADGE_CHUNK; at < bytes.length; at += S.BADGE_CHUNK) await send(`bytes from ${at}`, kp, [S.writeBadgeImage(me, at, bytes.slice(at, at + S.BADGE_CHUNK))]);
  const a = await conn.getAccountInfo(S.badgeAddress(me));
  const b = a && S.decodeBadgeImage(new Uint8Array(a.data));
  console.log(`stored: ${b?.written} of ${b?.len} bytes, same as the file: ${!!b && Buffer.from(b.bytes).equals(Buffer.from(bytes))}; treasury received ${(await conn.getBalance(C.TREASURY) - before) / LAMPORTS_PER_SOL} ${C.COIN}`);
  const board = await S.loadBoard(conn);
  console.log(`the board lists a picture for this wallet: ${board.pictures.has(me.toBase58())} (${board.pictures.size} in all)`);
})().catch(e => { console.error(String(e?.message ?? e), e?.logs?.slice(-3) ?? ""); process.exit(1); });
