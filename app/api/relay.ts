// POST /api/relay?network=x1-testnet  {tx: base64}  ->  {sig}
// GET  /api/relay?network=x1-testnet                ->  {sponsor, enabled}
//
// The fee sponsor: pays the network fee of a trade signed by a wallet's trading key (router
// `session`), so a key that has run out of XNT still trades. It signs only as the fee payer, and
// only a transaction that cannot use its XNT for anything else:
//   - its instructions are compute-budget (a unit limit up to 1.4M, no priority fee), Ed25519
//     signature checks, and the router's TakeQuote (tag 38), at most two of them;
//   - the sponsor's key is in no instruction, so no instruction can move its lamports (the fee is
//     the only thing it pays);
//   - every other signature is there, and the router instruction's signer is a trading key the
//     session account names, not expired, with fewer than SPONSOR_DAILY trades in its day (the
//     router counts them on chain);
//   - at most PER_KEY_PER_MIN a minute per key and GLOBAL_PER_MIN a minute in all (per instance);
//   - nothing while the sponsor holds less than FLOOR lamports.
// SPONSOR_SECRET_X1 holds the sponsor's keypair (JSON byte array).
import { ComputeBudgetProgram, Connection, Ed25519Program, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { ROUTER, networkOf } from "./_config.js";

const SESSION_LENS = new Set([152, 176]);
const SPONSOR_DAILY = 300, PER_KEY_PER_MIN = 30, GLOBAL_PER_MIN = 600, FLOOR = 1_000_000_000;
const MAX_UNITS = 1_400_000;
let conns: Record<string, Connection> = {};
const seen = new Map<string, number[]>();
let all: number[] = [];
let balance = { lamports: 0, at: 0 };

const within = (times: number[], max: number) => { const now = Date.now(); const t = times.filter(x => now - x < 60_000); t.push(now); return { ok: t.length <= max, t }; };

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  const x1 = req?.query?.network === "x1-testnet";
  const secret = process.env[x1 ? "SPONSOR_SECRET_X1" : "SPONSOR_SECRET"];
  if (!secret) return res.status(404).json({ error: "no fee sponsor on this network" });
  const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  if (req.method !== "POST") return res.status(200).json({ sponsor: sponsor.publicKey.toBase58(), enabled: true });
  const net = networkOf(req);
  const conn = (conns[net.rpc] ??= new Connection(net.rpc, "confirmed"));
  let tx: Transaction;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    tx = Transaction.from(Buffer.from(String(body?.tx ?? ""), "base64"));
  } catch {
    return res.status(400).json({ error: "a transaction is needed" });
  }
  const refuse = (why: string) => res.status(403).json({ error: why });
  if (!tx.feePayer?.equals(sponsor.publicKey)) return refuse("the sponsor is not the fee payer");
  const router = new PublicKey(ROUTER);
  let routerIxs = 0, actor: PublicKey | undefined, session: PublicKey | undefined;
  for (const ix of tx.instructions) {
    if (ix.keys.some(k => k.pubkey.equals(sponsor.publicKey))) return refuse("the sponsor is named in an instruction");
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (ix.data[0] === 2 && ix.data.length === 5 && ix.data.readUInt32LE(1) <= MAX_UNITS) continue;
      return refuse("only a compute unit limit is sponsored");
    }
    if (ix.programId.equals(Ed25519Program.programId)) continue;
    if (ix.programId.equals(router) && ix.data[0] === 38 && ix.keys.length > 1) {
      routerIxs++;
      const a = ix.keys[0].pubkey, s = ix.keys[ix.keys.length - 1].pubkey;
      if (!ix.keys[0].isSigner || (actor && !actor.equals(a))) return refuse("one trading key signs");
      actor = a; session = s;
      continue;
    }
    return refuse("only maker-quote trades are sponsored");
  }
  if (!routerIxs || routerIxs > 2 || !actor || !session) return refuse("only maker-quote trades are sponsored");
  // Every signature but the sponsor's is there and good.
  for (const s of tx.signatures) {
    if (s.publicKey.equals(sponsor.publicKey)) continue;
    if (!s.signature) return refuse("a signature is missing");
  }
  if (!tx.verifySignatures(false)) return refuse("a signature does not verify");
  const k = actor.toBase58(), r1 = within(seen.get(k) ?? [], PER_KEY_PER_MIN), r2 = within(all, GLOBAL_PER_MIN);
  seen.set(k, r1.t); all = r2.t;
  if (!r1.ok || !r2.ok) return res.status(429).json({ error: "too many sponsored trades just now" });
  try {
    const [sa] = await conn.getMultipleAccountsInfo([session], "confirmed");
    if (!sa || !sa.owner.equals(router) || !SESSION_LENS.has(sa.data.length)) return refuse("no trading key approved");
    const d = sa.data;
    const key = new PublicKey(d.subarray(72, 104)), expires = Number(d.readBigInt64LE(104)), trades = d.readUInt32LE(124), windowStart = Number(d.readBigInt64LE(128));
    const now = Date.now() / 1000;
    if (!key.equals(actor) || expires <= now + 5) return refuse("the trading key is not approved now");
    if (now - windowStart < 86_400 && trades >= SPONSOR_DAILY) return refuse(`the sponsor pays for ${SPONSOR_DAILY} trades a day per key`);
    if (Date.now() - balance.at > 30_000) balance = { lamports: await conn.getBalance(sponsor.publicKey, "confirmed"), at: Date.now() };
    if (balance.lamports < FLOOR) return res.status(503).json({ error: "the fee sponsor is out of funds" });
    tx.partialSign(sponsor);
    if (!tx.verifySignatures(true)) return refuse("signatures do not verify");
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    return res.status(200).json({ sig });
  } catch (e: any) {
    return res.status(502).json({ error: String(e?.message ?? e).replace(/https?:\/\/\S+/g, "the RPC") });
  }
}
