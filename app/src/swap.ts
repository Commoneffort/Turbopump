// Spot swaps on xDEX (X1's exchange, a copy of Raydium's CP-Swap) through the router's `Swap`,
// which takes the platform's fee on chain. The quote below is the pool's own arithmetic; the
// router tests (tests/swap.rs) check that xDEX delivers exactly this amount.
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as C from "./chain";

/** xDEX on this network, and the fee tier our own pools use (0.3% on X1 testnet, 0.25% on devnet). */
export const XDEX = (() => {
  const program = new PublicKey(C.X1 ? "7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf" : "9VBpPJ8GMyttp46TtoiKDaYjY3yPbJbW6c37R66fQgxD");
  return {
    program,
    ammConfig: new PublicKey(C.X1 ? "3FzzbxwpdJKxRW1yNT7UPYmna17SwC9PRmskMa8A2BuY" : "9PzwKv8WyWrmgmimNcWZFYqbGLbssyHb1HM6ysmvq9Cb"),
    authority: () => PublicKey.findProgramAddressSync([Buffer.from("vault_and_lp_mint_auth_seed")], program)[0],
  };
})();

/** The platform's fee on a swap (router `SWAP_FEE_BPS`), on top of the pool's own. */
export const SWAP_FEE_BPS = 20n;
export const swapFee = (amountIn: bigint) => (amountIn * SWAP_FEE_BPS + 9_999n) / 10_000n;
const TAG_SWAP = 30;

/** Our own pool: the chain's coin against this network's test USDC (scripts/xdex-pool.ts). */
export const USDC_POOL = (() => {
  const [m0, m1] = [NATIVE_MINT, C.MINT].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), XDEX.ammConfig.toBuffer(), m0.toBuffer(), m1.toBuffer()], XDEX.program)[0];
})();

export type ListedPool = { pool: string; a: { mint: string; symbol: string }; b: { mint: string; symbol: string }; tvl: number; volume: number };

/** xDEX's pool list for this network (through our /api/pools). */
export async function listPools(): Promise<ListedPool[]> {
  const r = await fetch(`/api/pools?network=${C.NETWORK}`);
  const j = await r.json();
  return Array.isArray(j?.pools) ? j.pools : [];
}

const key = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));
const u64 = (d: Uint8Array, o: number) => Buffer.from(d.buffer, d.byteOffset + o, 8).readBigUInt64LE();

/** A pool as read from chain: its accounts, reserves (net of the fees it holds for others) and fee. */
export type Pool = {
  key: PublicKey; ammConfig: PublicKey; observation: PublicKey;
  mints: [PublicKey, PublicKey]; programs: [PublicKey, PublicKey]; vaults: [PublicKey, PublicKey];
  decimals: [number, number]; reserves: [bigint, bigint];
  /** The pool's own fee, out of 1,000,000. */
  feeRate: bigint;
  /** 0 = open; anything else and xDEX refuses swaps. */
  status: number;
  openTime: number;
  /** A Token-2022 mint with a transfer fee or hook: the router's fee transfer cannot carry it. */
  unsupported?: string;
};

/** Token-2022 extensions a swapped token may have: close authority (3), interest display (10),
 *  metadata and group pointers and data (18-23). Anything else is refused: a transfer fee (1) or
 *  hook (14) the router's fee transfer cannot carry, accounts frozen by default (6), a permanent
 *  delegate who can take the tokens back (12), non-transferable or confidential tokens. */
const OK_EXTENSIONS = new Set([3, 10, 18, 19, 20, 21, 22, 23]);
function mintProblem(owner: PublicKey, d: Uint8Array): string | undefined {
  if (owner.equals(TOKEN_PROGRAM_ID)) return undefined;
  if (!owner.equals(TOKEN_2022_PROGRAM_ID)) return "not a token mint";
  for (let o = 166; o + 4 <= d.length;) {
    const t = d[o] | (d[o + 1] << 8), l = d[o + 2] | (d[o + 3] << 8);
    if (t !== 0 && !OK_EXTENSIONS.has(t)) return ({ 1: "has a transfer fee", 6: "freezes new accounts", 9: "cannot be transferred", 12: "can be taken back by its issuer", 14: "has a transfer hook" } as Record<number, string>)[t] ?? `has Token-2022 extension ${t}`;
    o += 4 + l;
  }
  return undefined;
}

export async function readPool(conn: Connection, poolKey: PublicKey): Promise<Pool> {
  const pa = await conn.getAccountInfo(poolKey);
  if (!pa || !pa.owner.equals(XDEX.program) || pa.data.length !== 637) throw new Error("not an xDEX pool");
  const d = pa.data;
  const p = {
    ammConfig: key(d, 8), vaults: [key(d, 72), key(d, 104)] as [PublicKey, PublicKey], mints: [key(d, 168), key(d, 200)] as [PublicKey, PublicKey],
    programs: [key(d, 232), key(d, 264)] as [PublicKey, PublicKey], observation: key(d, 296),
  };
  const [cfg, v0, v1, m0, m1] = await conn.getMultipleAccountsInfo([p.ammConfig, ...p.vaults, ...p.mints]);
  if (!cfg || !v0 || !v1 || !m0 || !m1) throw new Error("pool accounts missing");
  const fees = (i: 0 | 1) => u64(d, 341 + 8 * i) + u64(d, 357 + 8 * i);
  const unsupported = mintProblem(m0.owner, m0.data) ?? mintProblem(m1.owner, m1.data);
  return {
    key: poolKey, ...p,
    decimals: [d[331], d[332]],
    reserves: [u64(v0.data, 64) - fees(0), u64(v1.data, 64) - fees(1)],
    feeRate: u64(cfg.data, 12),
    status: d[329], openTime: Number(u64(d, 373)),
    unsupported,
  };
}

export type Quote = { amountIn: bigint; platformFee: bigint; poolFee: bigint; out: bigint; minOut: bigint; impactBps: number };

/** What `amountIn` of token `from` (0 or 1) buys, after both fees, and the least to accept. */
export function quote(p: Pool, from: 0 | 1, amountIn: bigint, slippageBps: number): Quote {
  const platformFee = amountIn > 0n ? swapFee(amountIn) : 0n;
  const x = amountIn - platformFee;
  const poolFee = x > 0n ? (x * p.feeRate + 999_999n) / 1_000_000n : 0n;
  const net = x - poolFee;
  const [rin, rout] = from === 0 ? [p.reserves[0], p.reserves[1]] : [p.reserves[1], p.reserves[0]];
  const out = net > 0n && rin > 0n ? (net * rout) / (rin + net) : 0n;
  // Price impact: the fill price against the pool's price before the swap (fees not counted).
  const impactBps = net > 0n && rout > 0n ? Number(10_000n - (out * rin * 10_000n) / (net * rout)) : 0;
  const minOut = (out * BigInt(10_000 - slippageBps)) / 10_000n;
  return { amountIn, platformFee, poolFee, out, minOut, impactBps };
}

const rw = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const ataOf = (owner: PublicKey, mint: PublicKey, program: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, program);

/** Everything a swap needs, in one transaction: the wallet's and the treasury's token accounts
 *  (created if missing), the coin wrapped when it is paid in, the router's `Swap`, and wrapped
 *  coin turned back into coin when it is received. */
export function swapInstructions(wallet: PublicKey, p: Pool, from: 0 | 1, q: Quote): TransactionInstruction[] {
  const to = (1 - from) as 0 | 1;
  const input = ataOf(wallet, p.mints[from], p.programs[from]);
  const output = ataOf(wallet, p.mints[to], p.programs[to]);
  const fee = ataOf(C.TREASURY, p.mints[from], p.programs[from]);
  const ixs: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(wallet, input, wallet, p.mints[from], p.programs[from]),
    createAssociatedTokenAccountIdempotentInstruction(wallet, output, wallet, p.mints[to], p.programs[to]),
    createAssociatedTokenAccountIdempotentInstruction(wallet, fee, C.TREASURY, p.mints[from], p.programs[from]),
  ];
  if (p.mints[from].equals(NATIVE_MINT)) {
    ixs.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: input, lamports: q.amountIn }), createSyncNativeInstruction(input));
  }
  const data = Buffer.alloc(17);
  data[0] = TAG_SWAP;
  data.writeBigUInt64LE(q.amountIn, 1);
  data.writeBigUInt64LE(q.minOut, 9);
  ixs.push(new TransactionInstruction({
    programId: C.ROUTER,
    keys: [
      rw(wallet, true), rw(fee), ro(XDEX.program),
      rw(wallet, true), ro(XDEX.authority()), ro(p.ammConfig), rw(p.key), rw(input), rw(output),
      rw(p.vaults[from]), rw(p.vaults[to]), ro(p.programs[from]), ro(p.programs[to]), ro(p.mints[from]), ro(p.mints[to]), rw(p.observation),
    ],
    data,
  }));
  // Wrapped coin the wallet ends up holding goes back to plain coin.
  const wsol = p.mints[from].equals(NATIVE_MINT) ? input : p.mints[to].equals(NATIVE_MINT) ? output : undefined;
  if (wsol) ixs.push(createCloseAccountInstruction(wsol, wallet, wallet));
  return ixs;
}

