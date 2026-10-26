// Who first funded a wallet: the wallet that sent its first coins. Wallets funded by the same
// wallet are taken to be one person's for the payouts that only one wallet per person should get
// (the first month's fee refund, contest prizes). Shared sources (the faucet, which is the test
// USDC's mint authority; our deploy wallets; the treasury) are not anyone's, so a wallet funded
// by one of them counts as its own funder.
//
// Answers are kept in deploy/logs/funders-<network>.json: a wallet's first funder never changes.
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";

const FILE = `../deploy/logs/funders-${C.X1 ? "x1" : "devnet"}.json`;

/** Wallets that fund everybody (faucet, deploy wallets, treasury), as base58. */
export async function sharedFunders(conn: Connection): Promise<Set<string>> {
  const out = new Set<string>([C.TREASURY.toBase58()]);
  for (const f of [`${process.env.HOME}/.config/solana/percolator-x1/deployer.json`, `${process.env.HOME}/.config/solana/percolator-test/deployer.json`]) {
    try {
      const { Keypair } = await import("@solana/web3.js");
      out.add(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8")))).publicKey.toBase58());
    } catch { /* not on this machine */ }
  }
  try {
    const mint = await conn.getParsedAccountInfo(C.MINT);
    const auth = (mint.value?.data as any)?.parsed?.info?.mintAuthority;
    if (auth) out.add(auth);
  } catch { /* keep the others */ }
  for (const k of (process.env.SHARED_FUNDERS ?? "").split(",").map(s => s.trim()).filter(Boolean)) out.add(k);
  return out;
}

/** The wallet that sent `wallet` its first coins (or, failing that, paid for its first
 *  transaction); the wallet itself when that is a shared funder or nothing is found. */
export async function funderOf(conn: Connection, wallet: string, shared: Set<string>): Promise<string> {
  const cache: Record<string, string> = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};
  if (cache[wallet]) return shared.has(cache[wallet]) ? wallet : cache[wallet];
  const me = new PublicKey(wallet);
  // Walk back to the wallet's oldest transaction (1,000 at a time).
  let before: string | undefined, oldest: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await conn.getSignaturesForAddress(me, { before, limit: 1000 }, "confirmed");
    if (!page.length) break;
    oldest = page[page.length - 1].signature;
    if (page.length < 1000) break;
    before = oldest;
  }
  let funder = wallet;
  if (oldest) {
    const tx = await conn.getParsedTransaction(oldest, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const ixs: any[] = tx?.transaction.message.instructions ?? [];
    const transfer = ixs.find(ix => ix.programId?.equals?.(SystemProgram.programId) && ix.parsed?.info?.destination === wallet && ix.parsed?.info?.source);
    const payer = tx?.transaction.message.accountKeys?.[0]?.pubkey?.toBase58?.();
    funder = transfer?.parsed.info.source ?? (payer && payer !== wallet ? payer : wallet);
  }
  cache[wallet] = funder;
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 1));
  return shared.has(funder) ? wallet : funder;
}
