// Loss covers (vault program InitCover / CoverLoss / WithdrawCover): money that pays a vault's
// providers back when its share price falls below its highest. Needs the vault build of
// 2026-10-20 (commit 92a01184) deployed.
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/covers.ts show
//   NETWORK=... npx tsx scripts/covers.ts init                  creates a cover for every live vault
//   NETWORK=... npx tsx scripts/covers.ts fund <USDC> [SYMBOL]  adds money to each (or one) cover
//
// `fund` on a test network mints the test USDC (FAUCET_KEY). With TREASURY_KEY set it instead
// moves the treasury's own USDC (what a real deployment does), so the first losses of a market
// are the platform's and not its first providers'.
import fs from "fs";
import { Connection, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createMintToInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed" });
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
const usd = (x: bigint) => (Number(x) / 1e6).toFixed(2);

async function send(what: string, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(...(C.X1 ? [await C.computeLimit(conn, payer.publicKey, ixs, 1.3)] : []), ...ixs);
  try {
    const sig = await conn.sendTransaction(tx, [payer, ...signers]);
    await conn.confirmTransaction(sig, "confirmed");
    console.log("ok  ", what);
  } catch (e: any) {
    console.log("fail", what, String(e?.message ?? e).split("\n")[0].slice(0, 160), (e?.logs ?? []).filter((l: string) => /error|failed/.test(l)).slice(-1)[0] ?? "");
  }
}

const live = async () => (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1 && v.lastNav > 0n);

(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  const vaults = await live();
  if (cmd === "init") {
    for (const v of vaults) {
      if (await conn.getAccountInfo(C.coverAddress(v.key))) { console.log("have", v.feed?.symbol); continue; }
      await send(`cover for ${v.feed?.symbol}`, [C.initCover(v, payer.publicKey)]);
    }
  } else if (cmd === "fund") {
    const amount = BigInt(Math.round(Number(a1) * 1e6));
    if (!(amount > 0n)) throw new Error("usage: fund <USDC> [SYMBOL]");
    for (const v of vaults.filter(v => !a2 || v.feed?.symbol === a2)) {
      const to = C.coverTokensAddress(v.key);
      if (!(await conn.getAccountInfo(to))) { console.log(`no cover for ${v.feed?.symbol}: run init first`); continue; }
      if (process.env.TREASURY_KEY) {
        const t = load(process.env.TREASURY_KEY);
        await send(`${usd(amount)} USDC from the treasury into ${v.feed?.symbol}'s cover`, [createTransferInstruction(getAssociatedTokenAddressSync(C.MINT, t.publicKey, true), to, t.publicKey, amount)], [t]);
      } else {
        const faucet = load(process.env.FAUCET_KEY ?? (C.X1 ? "../keys/x1-faucet.json" : "../keys/faucet.json"));
        await send(`${usd(amount)} test USDC into ${v.feed?.symbol}'s cover`, [createMintToInstruction(C.MINT, to, faucet.publicKey, amount)], [faucet]);
      }
    }
  } else {
    for (const v of vaults) {
      const [c, t] = await conn.getMultipleAccountsInfo([C.coverAddress(v.key), C.coverTokensAddress(v.key)]);
      if (!c || !t) { console.log(`${v.feed?.symbol}: no cover`); continue; }
      const cv = C.decodeCover(new Uint8Array(c.data));
      const held = new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(64, true);
      console.log(`${v.feed?.symbol}: holds ${usd(held)} USDC | paid back so far ${usd(cv.totalCovered)} | highest share price ${(Number(cv.highPrice) / 1e12 / 10 ** (6 - C.SHARE_DECIMALS)).toFixed(6)} | last applied after epoch ${cv.coveredEpoch}`);
    }
  }
})();
