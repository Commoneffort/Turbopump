// Our maker (router `quote`, vault program `maker`): its account, and a quote server for drills.
//
//   npx tsx scripts/maker.ts setup <usdc>   a maker wallet (MAKER_KEY, default deploy/logs/maker-<network>.json),
//                                           its Percolator portfolio with <usdc> deposited, registered as a
//                                           maker and pointed at the vault program; prints the env for /api/quote
//   npx tsx scripts/maker.ts deposit <usdc> more collateral
//   npx tsx scripts/maker.ts refresh        renews the portfolio's matcher config (it expires: MATCHER_TTL slots)
//   npx tsx scripts/maker.ts status         collateral, positions, matcher expiry
//   npx tsx scripts/maker.ts serve [port]   GET /quote?vault=&trader=&size= locally (what /api/quote does), and
//                                           renews the matcher config before it expires
// The payer (PERCOLATOR_KEYPAIR) pays the rent and gives the maker wallet coin for fees; test USDC
// comes from the faucet key (PERCOLATOR_FAUCET_KEY), as the bots get theirs.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import * as http from "http";
import * as C from "../src/chain";
import { makeQuote, makerAccount, makerDelegate } from "../api/_maker";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, "confirmed");
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = load(process.env.PERCOLATOR_KEYPAIR ?? `${process.env.HOME}/.config/solana/percolator-x1/deployer.json`);
const KEY = process.env.MAKER_KEY ?? `../deploy/logs/maker-${C.NETWORK}.json`;
// (Kept next to the maker's key, so a drill's maker and the network's never mix.)
const INFO = `${KEY.replace(/\.json$/, "")}-portfolio.json`;
const TTL = Number(process.env.MATCHER_TTL ?? 216_000);
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function wallet(): Keypair {
  if (!fs.existsSync(KEY)) fs.writeFileSync(KEY, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return load(KEY);
}
const portfolioKey = () => new PublicKey(JSON.parse(fs.readFileSync(INFO, "utf8")).portfolio);
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128le = (n: bigint) => Buffer.concat([u64le(n & ((1n << 64n) - 1n)), u64le(n >> 64n)]);
const ro = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });

/** id, sequence and position epoch of a portfolio (vault crate `percolator::portfolio_view_of`). */
async function view(pf: PublicKey) {
  const d = new Uint8Array((await conn.getAccountInfo(pf, "confirmed"))!.data);
  const dv = new DataView(d.buffer, d.byteOffset);
  const control = dv.getBigUint64(9435 + 96, true);
  return { id: dv.getBigUint64(9435 + 104, true), sequence: dv.getBigUint64(9435 + 112, true), epoch: (control & (((1n << 49n) - 1n) << 1n)) >> 1n };
}
async function frontier() {
  return C.marketHeader(new Uint8Array((await conn.getAccountInfo(C.MARKET, "confirmed"))!.data)).nextMarketId;
}
async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer, ...signers.filter(s => !s.publicKey.equals(payer.publicKey))], { commitment: "confirmed" });
  say("ok", label, sig.slice(0, 16));
}

async function matcherConfig(w: Keypair, pf: PublicKey) {
  const v = await view(pf);
  const slot = await conn.getSlot("confirmed");
  const maker = makerAccount(w.publicKey, C.MARKET);
  const delegate = makerDelegate({ kp: w, portfolio: pf, market: C.MARKET });
  const data = Buffer.concat([Buffer.from([68]), u64le(v.id), u64le(v.sequence), u64le(v.epoch), u64le(await frontier()), Buffer.from([1]), Buffer.from([100, 0]), u64le(BigInt(slot + TTL))]);
  return new TransactionInstruction({ programId: C.PERCOLATOR, keys: [ro(w.publicKey, true), ro(C.MARKET), rw(pf), ro(C.VAULT_PROGRAM), ro(maker), ro(delegate)], data });
}

async function deposit(w: Keypair, pf: PublicKey, usdc: number) {
  const mint = C.MINT;
  const ata = getAssociatedTokenAddressSync(mint, w.publicKey);
  const faucet = load(process.env.PERCOLATOR_FAUCET_KEY ?? process.env.PERCOLATOR_KEYPAIR ?? `${process.env.HOME}/.config/solana/percolator-x1/deployer.json`);
  const amount = BigInt(Math.round(usdc * 1e6));
  await send(`mint ${usdc} test USDC to the maker`, [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, w.publicKey, mint), createMintToInstruction(mint, ata, faucet.publicKey, amount)], [faucet]);
  const v = await view(pf);
  const data = Buffer.concat([Buffer.from([3]), u64le(v.id), u64le(v.sequence), u128le(amount)]);
  await send(`deposit ${usdc} into the maker's portfolio`, [new TransactionInstruction({ programId: C.PERCOLATOR, keys: [ro(w.publicKey, true), rw(C.MARKET), rw(pf), rw(ata), rw(C.PERC_VAULT), ro(TOKEN_PROGRAM_ID)], data })], [w]);
}

async function setup(usdc: number) {
  const w = wallet();
  say("maker wallet", w.publicKey.toBase58());
  if ((await conn.getBalance(w.publicKey)) < 50_000_000) await send("coin for the maker's fees", [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w.publicKey, lamports: 200_000_000 })], []);
  let pf: PublicKey;
  if (fs.existsSync(INFO) && (await conn.getAccountInfo(portfolioKey()))) pf = portfolioKey();
  else {
    const kp = Keypair.generate();
    pf = kp.publicKey;
    const rent = await conn.getMinimumBalanceForRentExemption(C.PORTFOLIO_LEN);
    await send("the maker's Percolator portfolio", [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: pf, lamports: rent, space: C.PORTFOLIO_LEN, programId: C.PERCOLATOR }),
      new TransactionInstruction({ programId: C.PERCOLATOR, keys: [ro(w.publicKey, true), rw(C.MARKET), rw(pf)], data: Buffer.from([1]) }),
    ], [w, kp]);
    fs.writeFileSync(INFO, JSON.stringify({ portfolio: pf.toBase58(), wallet: w.publicKey.toBase58() }));
  }
  const maker = makerAccount(w.publicKey, C.MARKET);
  if (!(await conn.getAccountInfo(maker))) {
    await send("register as a maker", [new TransactionInstruction({ programId: C.VAULT_PROGRAM, keys: [rw(payer.publicKey, true), ro(w.publicKey, true), rw(maker), ro(C.MARKET), ro(pf), ro(SystemProgram.programId)], data: Buffer.from([44]) })], [w]);
  }
  if (usdc > 0) await deposit(w, pf, usdc);
  await send("point the portfolio's matcher at the vault program", [await matcherConfig(w, pf)], [w]);
  say(`env for /api/quote: MAKER_SECRET_X1='${JSON.stringify(Array.from(w.secretKey))}' MAKER_PORTFOLIO_X1=${pf.toBase58()}`.replace(/\[[0-9,]+\]/, "<contents of " + KEY + ">"));
}

async function status() {
  const w = wallet(), pf = portfolioKey();
  const d = new Uint8Array((await conn.getAccountInfo(pf))!.data);
  const market = new Uint8Array((await conn.getAccountInfo(C.MARKET))!.data);
  const h = C.accountHealth(market, d);
  say("maker", makerAccount(w.publicKey, C.MARKET).toBase58(), "wallet", w.publicKey.toBase58(), "portfolio", pf.toBase58());
  say("equity", Number(h.equity) / 1e6, "assets", C.portfolioAssets(d));
}

async function serve(port: number) {
  const w = wallet(), pf = portfolioKey();
  const m = { kp: w, portfolio: pf, market: C.MARKET };
  const qconn = new Connection(process.env.RPC ?? C.RPC_URL, "processed");
  http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("access-control-allow-origin", "*");
    try {
      const life = u.searchParams.get("life");
      const q = await makeQuote(qconn, m, new PublicKey(u.searchParams.get("vault")!), new PublicKey(u.searchParams.get("trader")!), BigInt(u.searchParams.get("size")!), life ? Number(life) : undefined);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(q));
    } catch (e: any) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  }).listen(port, () => say(`quotes on :${port}`));
  // The matcher config expires: renewed every quarter of its life.
  for (;;) {
    await new Promise(r => setTimeout(r, (TTL / 4) * C.slotSeconds() * 1000));
    await send("renew the maker's matcher config", [await matcherConfig(w, pf)], [w]).catch(e => say("fail", "renew", String(e?.message ?? e).slice(0, 120)));
  }
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "setup") await setup(Number(arg ?? 10_000));
  else if (cmd === "deposit") await deposit(wallet(), portfolioKey(), Number(arg));
  else if (cmd === "refresh") await send("renew the maker's matcher config", [await matcherConfig(wallet(), portfolioKey())], [wallet()]);
  else if (cmd === "status") await status();
  else if (cmd === "serve") await serve(Number(arg ?? 18300));
  else console.log("usage: maker.ts setup <usdc> | deposit <usdc> | refresh | status | serve [port]");
})().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
