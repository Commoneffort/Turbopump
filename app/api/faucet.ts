// Faucet: mints test USDC (and a little SOL, or XNT on X1 testnet, for fees and rent) to a wallet.
// FAUCET_SECRET (FAUCET_SECRET_X1 for X1) holds the faucet keypair (JSON byte array); it is that
// network's test USDC mint authority.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { networkOf } from "./_config.js";

const USDC = 1_000_000;
const DRIP_USDC = 1_000;
const MAX_HELD_USDC = 5_000;
// The coin drip (0.3) is enough to launch a market (~0.12) or open a trading account (~0.07).

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  let to: PublicKey;
  try {
    to = new PublicKey((typeof req.body === "string" ? JSON.parse(req.body) : req.body).address);
  } catch {
    return res.status(400).json({ error: "invalid address" });
  }
  const net = networkOf(req);
  const DRIP_SOL = net.drip;
  const secret = process.env[net.faucetSecret];
  if (!secret) return res.status(500).json({ error: "faucet not configured" });
  const faucet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  const conn = new Connection(net.rpc, "confirmed");
  const mint = new PublicKey(net.mint);
  const ata = getAssociatedTokenAddressSync(mint, to);

  const held = await conn.getTokenAccountBalance(ata).then(b => Number(b.value.amount) / USDC).catch(() => 0);
  if (held >= MAX_HELD_USDC) return res.status(429).json({ error: `you already hold ${held} test USDC` });
  const sol = (await conn.getBalance(to)) / LAMPORTS_PER_SOL;

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, ata, to, mint),
    createMintToInstruction(mint, ata, faucet.publicKey, BigInt(DRIP_USDC * USDC)),
  );
  const sendSol = sol < net.lowWater;
  if (sendSol) tx.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: to, lamports: DRIP_SOL * LAMPORTS_PER_SOL }));
  try {
    const sig = await conn.sendTransaction(tx, [faucet]);
    await conn.confirmTransaction(sig, "confirmed");
    return res.status(200).json({ usdc: DRIP_USDC, sol: sendSol ? DRIP_SOL : 0, coin: net.coin, sig });
  } catch (e: any) {
    return res.status(500).json({ error: String(e.message ?? e).replace(/https?:\/\/\S+/g, "the RPC").replace(/api-key=[^&\s"]+/g, "api-key=***") });
  }
}
