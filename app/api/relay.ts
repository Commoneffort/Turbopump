// POST /api/relay?network=x1-testnet  {wallet, key}  ->  {sig, lamports}
// GET  /api/relay?network=x1-testnet                 ->  {sponsor, enabled, topup}
//
// The fee sponsor (2026-11-07): when a wallet's trading key (router `session`) runs out of XNT
// for its fees, the sponsor sends it a small top-up, so trading needs no XNT from the user. (A
// first version co-signed the key's trades as their fee payer, but a second signer makes a quoted
// trade 7 bytes too large for a transaction; a top-up keeps the key's trades as they are.)
//
// The sponsor signs nothing but a transfer it builds itself, of TOPUP lamports to the key, and
// only when:
//   - the session account of (market, wallet) names that key, and has not expired;
//   - the key holds less than LOW lamports;
//   - the key has had fewer than PER_DAY top-ups in the last day (per instance), and the sponsor
//     fewer than GLOBAL_PER_MIN a minute, and the sponsor itself holds at least FLOOR.
// What a key holds goes back to the wallet when one-click trading is turned off, so a top-up is
// at most PER_DAY x TOPUP a day for one approved key.
// SPONSOR_SECRET_X1 holds the sponsor's keypair (JSON byte array).
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { MARKET, ROUTER, X1_MARKETS, networkOf } from "./_config.js";

const TOPUP = 100_000_000, LOW = 20_000_000, PER_DAY = 3, GLOBAL_PER_MIN = 30, FLOOR = 1_000_000_000;
const SESSION_LENS = new Set([152, 176]);
let conns: Record<string, Connection> = {};
const given = new Map<string, number[]>();
let recent: number[] = [];

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  const x1 = req?.query?.network === "x1-testnet";
  const secret = process.env[x1 ? "SPONSOR_SECRET_X1" : "SPONSOR_SECRET"];
  if (!secret) return res.status(404).json({ error: "no fee sponsor on this network" });
  const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  if (req.method !== "POST") return res.status(200).json({ sponsor: sponsor.publicKey.toBase58(), enabled: true, topup: TOPUP });
  let wallet: PublicKey, key: PublicKey;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    wallet = new PublicKey(String(body?.wallet)); key = new PublicKey(String(body?.key));
  } catch {
    return res.status(400).json({ error: "wallet and key are needed" });
  }
  const refuse = (why: string, code = 403) => res.status(code).json({ error: why });
  const now = Date.now();
  const k = key.toBase58();
  const mine = (given.get(k) ?? []).filter(t => now - t < 86_400_000);
  if (mine.length >= PER_DAY) return refuse(`the sponsor tops a key up ${PER_DAY} times a day`, 429);
  recent = recent.filter(t => now - t < 60_000);
  if (recent.length >= GLOBAL_PER_MIN) return refuse("too many top-ups just now", 429);
  try {
    const net = networkOf(req);
    const conn = (conns[net.rpc] ??= new Connection(net.rpc, "confirmed"));
    const router = new PublicKey(ROUTER);
    // The key's approval on any of the network's markets (X1 runs five).
    const markets = x1 ? X1_MARKETS : [MARKET];
    const sessions = markets.map(m => PublicKey.findProgramAddressSync([Buffer.from("session"), new PublicKey(m).toBuffer(), wallet.toBuffer()], router)[0]);
    const accs = await conn.getMultipleAccountsInfo([...sessions, key, sponsor.publicKey], "confirmed");
    const approved = accs.slice(0, sessions.length).some(a => {
      if (!a || !a.owner.equals(router) || !SESSION_LENS.has(a.data.length)) return false;
      const d = a.data;
      return new PublicKey(d.subarray(40, 72)).equals(wallet) && new PublicKey(d.subarray(72, 104)).equals(key) && Number(d.readBigInt64LE(104)) > now / 1000 + 60;
    });
    if (!approved) return refuse("no trading key of this wallet's is approved now");
    const held = accs[sessions.length]?.lamports ?? 0, have = accs[sessions.length + 1]?.lamports ?? 0;
    if (held >= LOW) return refuse("the key still has XNT for its fees", 409);
    if (have < FLOOR + TOPUP) return refuse("the fee sponsor is out of funds", 503);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: key, lamports: TOPUP }));
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.feePayer = sponsor.publicKey;
    tx.sign(sponsor);
    mine.push(now); given.set(k, mine); recent.push(now);
    const sig = await conn.sendRawTransaction(tx.serialize());
    return res.status(200).json({ sig, lamports: TOPUP });
  } catch (e: any) {
    return res.status(502).json({ error: String(e?.message ?? e).replace(/https?:\/\/\S+/g, "the RPC") });
  }
}
