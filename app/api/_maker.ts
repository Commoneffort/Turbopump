// Our maker's quotes (router `quote`, vault program `maker`): a price for one trading account,
// signed with the maker's key, good for a few slots. The taker's transaction carries it and fills
// in the slot it lands in. Used by GET /api/quote and by scripts/maker.ts (serve, for drills).
//
// The asset is read from the vault on chain (never taken from the caller), the price from the
// exchange-median service, refused when older than PRICE_MAX_AGE_MS; the spread grows with the
// size and leans against the maker's position; no quote above MAX_NOTIONAL, or one that would take
// the maker's position on the asset past MAX_POSITION. The maker's margin is Percolator's: a quote
// the maker cannot afford fails on chain and the trade goes through the vault queue instead.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import L from "./_layout.js";
import { FEED_SYMBOLS, PERCOLATOR, VAULT_PROGRAM } from "./_config.js";

const env = (k: string, d: number) => Number((globalThis as any).process?.env?.[k] ?? d);
export const SPREAD_BPS = () => env("MAKER_SPREAD_BPS", 2);
/** Extra bps for each $10,000 of the trade. */
export const IMPACT_BPS = () => env("MAKER_IMPACT_BPS", 1);
/** Extra bps for each $10,000 the maker already holds on the side the trade adds to. */
export const SKEW_BPS = () => env("MAKER_SKEW_BPS", 1);
export const MAX_NOTIONAL = () => env("MAKER_MAX_NOTIONAL", 20_000);
export const MAX_POSITION = () => env("MAKER_MAX_POSITION", 100_000);
/** How many slots a quote stays good for (X1 slots are ~0.36 s). */
export const QUOTE_SLOTS = () => env("MAKER_QUOTE_SLOTS", 4);
const PRICE_MAX_AGE_MS = 10_000;
const PRICE_URL = () => (globalThis as any).process?.env?.MAKER_PRICES ?? "http://jack0.x1.xyz:8090";
const JACK_SYMBOL: Record<string, string> = { XAU: "GOLD", XAG: "SILVER" };

export type Maker = { kp: Keypair; portfolio: PublicKey; market: PublicKey };
const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const u32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 2 ** 24;
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);
const i128 = (d: Uint8Array, o: number) => BigInt.asIntN(128, u64(d, o) + (u64(d, o + 8) << 64n));

export const makerAccount = (wallet: PublicKey, market: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("maker"), market.toBuffer(), wallet.toBuffer()], new PublicKey(VAULT_PROGRAM))[0];
export const makerDelegate = (m: Maker) => PublicKey.findProgramAddressSync(
  [Buffer.from("matcher"), m.market.toBuffer(), m.portfolio.toBuffer(), m.kp.publicKey.toBuffer(), new PublicKey(VAULT_PROGRAM).toBuffer(), makerAccount(m.kp.publicKey, m.market).toBuffer()],
  new PublicKey(PERCOLATOR),
)[0];

export function quoteMessage(maker: PublicKey, trader: PublicKey, asset: number, size: bigint, price: bigint, expiry: bigint, id: bigint) {
  const m = new Uint8Array(114);
  const dv = new DataView(m.buffer);
  m.set(Buffer.from("TPQUOTE1"), 0);
  m.set(maker.toBuffer(), 8);
  m.set(trader.toBuffer(), 40);
  dv.setUint16(72, asset, true);
  const s = BigInt.asUintN(128, size);
  dv.setBigUint64(74, s & ((1n << 64n) - 1n), true);
  dv.setBigUint64(82, s >> 64n, true);
  dv.setBigUint64(90, price, true);
  dv.setBigUint64(98, expiry, true);
  dv.setBigUint64(106, id, true);
  return m;
}

/** The maker's position on each asset it holds (stored sizes, + = long), from its portfolio. */
function makerPositions(d: Uint8Array): Map<number, bigint> {
  const P = (L as any).portfolio, G = (L as any).leg;
  const out = new Map<number, bigint>();
  for (let i = 0; i < 16; i++) {
    const base = P.legs + i * P.leg_len;
    if (d[base + G.active] !== 1) continue;
    const q = i128(d, base + G.basis_pos_q);
    const abs = q < 0n ? -q : q;
    out.set(u32(d, base + G.asset_index), d[base + G.side] === 0 ? abs : -abs);
  }
  return out;
}

const prices = new Map<string, { price: number; at: number }>();
async function priceOf(symbol: string): Promise<number> {
  const sym = JACK_SYMBOL[symbol] ?? symbol;
  const cached = prices.get(sym);
  if (cached && Date.now() - cached.at < 300) return cached.price;
  const r = await fetch(`${PRICE_URL()}/v1/prices?symbols=${sym.toLowerCase()}`, { signal: AbortSignal.timeout(1_500) });
  const j: any = await r.json();
  const p = (j.prices ?? []).find((x: any) => String(x.symbol).toUpperCase() === sym);
  if (!p || p.status !== "ok" || !(p.price > 0)) throw new Error(`no price for ${symbol}`);
  if (Date.now() - new Date(p.updatedAt).getTime() > PRICE_MAX_AGE_MS) throw new Error(`price for ${symbol} is stale`);
  prices.set(sym, { price: p.price, at: Date.now() });
  return p.price;
}

export type QuoteOut = { maker: string; wallet: string; portfolio: string; delegate: string; makerAssets: number[]; vault: string; trader: string; asset: number; size: string; price: string; expiry: string; id: string; signature: string; symbol: string; spreadBps: number };

/** A signed quote for `trader` (a router trading account) to trade `size` (e6 units, + = buy) on
 *  `vault`'s market. Throws when no quote is offered. */
export async function makeQuote(conn: Connection, m: Maker, vault: PublicKey, trader: PublicKey, size: bigint): Promise<QuoteOut> {
  if (size === 0n) throw new Error("no size");
  const V = (L as any).vault;
  const [accs, slot] = await Promise.all([conn.getMultipleAccountsInfo([vault, m.portfolio], "processed"), conn.getSlot("processed")]);
  const [va, pa] = accs;
  if (!va || !va.owner.equals(new PublicKey(VAULT_PROGRAM)) || !pa) throw new Error("unknown vault or maker");
  const vd = new Uint8Array(va.data), pd = new Uint8Array(pa.data);
  if (!new PublicKey(vd.slice(V.market, V.market + 32)).equals(m.market)) throw new Error("vault on another market");
  const asset = u16(vd, V.asset_index);
  const symbol = FEED_SYMBOLS[Buffer.from(vd.slice(V.oracle_feeds, V.oracle_feeds + 32)).toString("hex")];
  if (!symbol) throw new Error("unknown feed");
  const ref = await priceOf(symbol);
  const notional = (Math.abs(Number(size)) / 1e6) * ref;
  if (notional > MAX_NOTIONAL()) throw new Error("too large for a quote");
  const held = makerPositions(pd).get(asset) ?? 0n;
  // The maker takes the other side: a taker buy moves it short.
  const after = Number(held - size) / 1e6;
  if (Math.abs(after) * ref > MAX_POSITION()) throw new Error("maker position limit");
  const adds = Math.sign(after) === Math.sign(Number(held)) || held === 0n;
  const skew = adds ? (Math.abs(Number(held)) / 1e6 * ref / 10_000) * SKEW_BPS() : 0;
  const spreadBps = SPREAD_BPS() + (notional / 10_000) * IMPACT_BPS() + skew;
  const px = ref * (1 + (size > 0n ? 1 : -1) * spreadBps / 10_000);
  const price = BigInt(Math.round(px * 1e6));
  const expiry = BigInt(slot + QUOTE_SLOTS());
  // Ids rise with the slot (the maker's window of used ids follows them), 32 a slot.
  const id = BigInt(slot) * 32n + BigInt(Math.floor(Math.random() * 32));
  const maker = makerAccount(m.kp.publicKey, m.market);
  const msg = quoteMessage(maker, trader, asset, size, price, expiry, id);
  const signature = ed25519.sign(msg, m.kp.secretKey.slice(0, 32));
  return {
    maker: maker.toBase58(), wallet: m.kp.publicKey.toBase58(), portfolio: m.portfolio.toBase58(), delegate: makerDelegate(m).toBase58(),
    makerAssets: [...makerPositions(pd).keys()], vault: vault.toBase58(), trader: trader.toBase58(), asset,
    size: size.toString(), price: price.toString(), expiry: expiry.toString(), id: id.toString(), signature: Buffer.from(signature).toString("base64"), symbol, spreadBps: Math.round(spreadBps * 100) / 100,
  };
}
