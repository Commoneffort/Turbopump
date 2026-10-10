// Account decoding and instruction building for the vault program and Percolator. Offsets come
// from layout.json, which a Rust test exports from the program and engine types.
import {
  AccountMeta,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import L from "./layout.json";
import D from "./devnet.json";
import X from "./x1-testnet.json";

/** Which deployment this build (VITE_NETWORK) or process (NETWORK) talks to: Solana devnet, or
 *  X1 testnet. The programs and their addresses are the same on both; the market, the test
 *  USDC and the price source differ. X1 has no Pyth: prices there are posted by the router's
 *  reporter key (see `reportAddress`). */
const NETWORK_KEY = "percolator-vaults:network";
function chosenNetwork(): string | undefined {
  // In the browser the visitor chooses (the switch in the header, or a ?network=x1-testnet link),
  // and the choice is remembered.
  if (typeof window !== "undefined") {
    try {
      const q = new URLSearchParams(window.location.search).get("network");
      if (q) localStorage.setItem(NETWORK_KEY, q);
      const saved = localStorage.getItem(NETWORK_KEY);
      if (saved) return saved;
    } catch { /* no storage: the build's default */ }
  }
  return (import.meta as any).env?.VITE_NETWORK ?? (globalThis as any).process?.env?.NETWORK;
}
export const NETWORK: "devnet" | "x1-testnet" = /^x1/.test(chosenNetwork() ?? "") ? "x1-testnet" : "devnet";
/** Switches the page to the other deployment (everything is re-read, so the page reloads). */
export function setNetwork(n: "devnet" | "x1-testnet") {
  try { localStorage.setItem(NETWORK_KEY, n); } catch { /* ignore */ }
  window.location.href = window.location.pathname;
}
/** The coin that pays fees and rent. */
export const COIN = NETWORK === "x1-testnet" ? "XNT" : "SOL";
export const NETWORK_NAME = NETWORK === "x1-testnet" ? "X1 testnet" : "Solana devnet";
export const X1 = NETWORK === "x1-testnet";
// A script can be pointed at another deployment of the same programs (a local rehearsal) by
// passing its manifest in MANIFEST_JSON.
const override = (globalThis as any).process?.env?.MANIFEST_JSON as string | undefined;
const M: typeof D = override ? JSON.parse(override) : X1 ? X : D;
if (!M.market) throw new Error(`no market for ${NETWORK} yet (src/${NETWORK}.json is filled in when the market is set up)`);
export const MANIFEST = M;

export const RPC_URL: string = (import.meta as any).env?.VITE_RPC_URL ?? (X1 ? "https://rpc.testnet.x1.xyz" : "https://api.devnet.solana.com");
export const VAULT_PROGRAM = new PublicKey(M.vault_program);
export const PERCOLATOR = new PublicKey(M.percolator_program);
export const MARKET = new PublicKey(M.market);
export const MINT = new PublicKey(M.collateral_mint);
export const PERC_VAULT = new PublicKey(M.percolator_vault);
export const PERC_VAULT_AUTH = new PublicKey(M.percolator_vault_authority);
export const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
export const USDC = 1_000_000;
/** Epoch length of every canonical vault on devnet (the program's CANON_EPOCH_LEN_SLOTS). */
export const CANON_EPOCH_LEN_SLOTS = 1_500;
export const UNIT = 1_000_000n; // Percolator POS_SCALE: 1 unit = 1 whole token
export const SHARE_DECIMALS = 9;
export const VAULT_LEN = L.vault_len;

/** The feeds on Pyth's free plan (the executor fetches their updates from Hermes), which have
 *  shared devnet accounts and fit a 6-decimal price. */
const PYTH_FEEDS = [
  { symbol: "SOL", name: "Solana", id: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { symbol: "BTC", name: "Bitcoin", id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { symbol: "ETH", name: "Ethereum", id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  { symbol: "PYTH", name: "Pyth Network", id: "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff" },
  { symbol: "DOGE", name: "Dogecoin", id: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c" },
  { symbol: "HYPE", name: "Hyperliquid", id: "4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b" },
  { symbol: "XAU", name: "Gold", id: "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2" },
  { symbol: "EUR", name: "Euro", id: "a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b" },
];
/** On X1 a feed id is only a market's name: prices come from the exchange-median price service,
 *  and these are the markets it serves. The ones Pyth also has keep their Pyth id; the others
 *  have sha256("x1:" + symbol). Stocks and the ETF only have a price while their exchanges are
 *  open; outside those hours their marks stand still and requests on them expire. */
const X1_FEEDS = [
  ...PYTH_FEEDS.filter(f => ["SOL", "BTC", "ETH", "HYPE", "XAU"].includes(f.symbol)),
  { symbol: "ZEC", name: "Zcash", id: "18ef2a004058135517c775c4e45e8c6ae6b6583336c70902329127f87a6d7d81" },
  { symbol: "FARTCOIN", name: "Fartcoin", id: "c7263494c2cf4f1f14575d26864d06f9d9718ebc7c1af2fc28506ef19415b392" },
  { symbol: "TSLA", name: "Tesla", id: "6d1cb9acc057a81bbf43ce459ce7bdfc3db1a040b25718158bf6d9936025838f" },
  { symbol: "NVDA", name: "NVIDIA", id: "d0316d5ef0f1e4bbcf08c8ec72444bf005412a87c5368e130feac8afd862d6c8" },
  { symbol: "MSTR", name: "Strategy", id: "2a4b5bcc3a1a7b6633350fb2f75cc514c57a19071277b992cf4eef17bc20b69e" },
  { symbol: "AAPL", name: "Apple", id: "c98e089b103f2766952e1490d902cb3a811c700e0064d4cee7c2ba6abef37ce6" },
  { symbol: "GOOGL", name: "Alphabet", id: "55fe35fea9478cdac31cff1c57883213faab338a84d1dca3d3b9ca8b91fe7e70" },
  { symbol: "META", name: "Meta Platforms", id: "fb1093c2bfb0c40661d0d6b7731d08cab10bf111a77103e05ff3567ad18d969a" },
  { symbol: "AMD", name: "AMD", id: "665db1539de0d2082e2c2aa72f62317b6f9a2e3d72fe7f9b041b93e31d7ac2f4" },
  { symbol: "COIN", name: "Coinbase", id: "7e2e57832cf14dd0ac3bc79fd2560cfe86f388ade5d9a4d00d1528b75456abec" },
  { symbol: "PLTR", name: "Palantir", id: "66020da42582157facbf93cc3d944e51c4f15c8a4effec7edf4a18b72c846a71" },
  { symbol: "SPCX", name: "SpaceX", id: "38853158dfc20e282627dbc05fc728756ba7e9d5f1d483a8aeccf0123e072372" },
  { symbol: "SPY", name: "S&P 500 ETF", id: "2f9cfc1fca7825bbffe689fcbadd465aecbf42be88e090f0acd23ed427d57dfd" },
  { symbol: "XAG", name: "Silver", id: "e8ecabe1b6c5da82b3a4d5139699da03fb89342705688370b5ac124d91124bb7" },
];
/** The markets kept open on X1 testnet. Every listed market has to be cranked every few seconds
 *  whether or not anyone trades it, which costs the keeper test XNT, so only these are offered
 *  and kept priced. The others can be opened again by adding them here. */
export const X1_ACTIVE = ["SOL", "BTC", "ETH"];
/** The feeds a market can be opened for, and whose prices the executor keeps posted. */
export const FEEDS = X1 ? X1_FEEDS.filter(f => X1_ACTIVE.includes(f.symbol)) : PYTH_FEEDS;
/** Every feed of either network, for tools that read both. */
export const KNOWN_FEEDS = [...PYTH_FEEDS, ...X1_FEEDS.filter(f => !PYTH_FEEDS.includes(f))];
export type Feed = (typeof PYTH_FEEDS)[number];
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map(b => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
/** Any feed of this network, offered or not (a market opened earlier still has to be read). */
export const feedById = (hex: string): Feed | undefined => (X1 ? X1_FEEDS : PYTH_FEEDS).find(f => f.id === hex);
export const feedAccount = (hex: string) =>
  PublicKey.findProgramAddressSync([new Uint8Array([0, 0]), hexBytes(hex)], PUSH_ORACLE)[0];
/** The account a feed's current price is read from, and a market is listed at: Pyth's sponsored
 *  feed account, or on X1 the router's reported-price account. */
export const priceAccount = (hex: string) => (X1 ? reportAddress(hex) : feedAccount(hex));

// ---- little-endian readers ----
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u64 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true);
const u32 = (d: Uint8Array, o: number) => dv(d).getUint32(o, true);
const u16 = (d: Uint8Array, o: number) => dv(d).getUint16(o, true);
const i64 = (d: Uint8Array, o: number) => dv(d).getBigInt64(o, true);
const u128 = (d: Uint8Array, o: number) => u64(d, o) + (u64(d, o + 8) << 64n);
const i128 = (d: Uint8Array, o: number) => {
  const v = u128(d, o);
  return v >= 1n << 127n ? v - (1n << 128n) : v;
};
const key = (d: Uint8Array, o: number) => new PublicKey(d.slice(o, o + 32));

export type Vault = {
  key: PublicKey;
  status: number;
  market: PublicKey;
  creator: PublicKey;
  seed: bigint;
  shareMint: PublicKey;
  buffer: PublicKey;
  escrow: PublicKey;
  lpPortfolio: PublicKey;
  delegate: PublicKey;
  assetIndex: number;
  feedHex: string;
  feed?: Feed;
  oracle: PublicKey;
  epoch: bigint;
  epochStart: bigint;
  epochLen: bigint;
  inventory: bigint;
  pendingDeposit: bigint;
  pendingWithdraw: bigint;
  reserved: bigint;
  lastNav: bigint;
  totalFills: bigint;
  feesHarvested: bigint;
  maxFill: bigint;
  maxInventory: bigint;
  insuranceFloor: bigint;
  createdSlot: bigint;
  canonical: boolean;
  positionNavBps: number;
  fillNavBps: number;
  openerFeesOwed: bigint;
  openerFeesTotal: bigint;
  /** The epoch is overdue and its withdrawals exceed the vault's cash: closing-only until flat. */
  needsFlat: boolean;
  /** Unix time until which the vault takes no deposit or withdrawal requests (its epoch's
   *  settlement is queued and its price fixed); 0 when it takes them. */
  frozenUntil: number;
};

export function decodeVault(k: PublicKey, d: Uint8Array): Vault {
  const v = L.vault;
  const feedHex = toHex(d.slice(v.oracle_feeds, v.oracle_feeds + 32));
  return {
    key: k,
    status: d[v.status],
    market: key(d, v.market),
    creator: key(d, v.creator),
    seed: u64(d, v.seed),
    shareMint: key(d, v.share_mint),
    buffer: key(d, v.buffer),
    escrow: key(d, v.share_escrow),
    lpPortfolio: key(d, v.lp_portfolio),
    delegate: key(d, v.matcher_delegate),
    assetIndex: u16(d, v.asset_index),
    feedHex,
    feed: feedById(feedHex),
    oracle: priceAccount(feedHex),
    epoch: u64(d, v.epoch),
    epochStart: u64(d, v.epoch_start_slot),
    epochLen: u64(d, v.epoch_len_slots),
    inventory: i128(d, v.inventory),
    pendingDeposit: u64(d, v.pending_deposit_assets),
    pendingWithdraw: u64(d, v.pending_withdraw_shares),
    reserved: u64(d, v.reserved_assets),
    lastNav: u64(d, v.last_nav),
    totalFills: u64(d, v.total_fills),
    feesHarvested: u64(d, v.total_fees_harvested),
    maxFill: u128(d, v.max_fill_abs),
    maxInventory: u128(d, v.max_inventory_abs),
    insuranceFloor: u64(d, v.insurance_floor),
    createdSlot: u64(d, v.created_slot),
    canonical: d[v.vault_kind] === 1,
    positionNavBps: u16(d, v.position_nav_bps),
    fillNavBps: u16(d, v.fill_nav_bps),
    openerFeesOwed: u64(d, v.opener_fees_owed),
    openerFeesTotal: u64(d, v.opener_fees_total),
    needsFlat: d[v.needs_flat] === 1,
    frozenUntil: u32(d, v.requests_frozen_until),
  };
}

export type Portfolio = { capital: bigint; pnl: bigint; id: bigint; sequence: bigint; positionEpoch: bigint; position: bigint };

/** A leg's position as Percolator counts it. The stored size is scaled by how much the side has
 *  been deleveraged since the leg was opened (after another position on the asset was reduced
 *  unilaterally), and is zero once the side has been emptied and reset. */
export function legPosition(market: Uint8Array, d: Uint8Array, base: number): bigint {
  const q = i128(d, base + L.leg.basis_pos_q);
  let abs = q < 0n ? -q : q;
  const long = d[base + L.leg.side] === 0;
  const a = L.market.slots + u32(d, base + L.leg.asset_index) * L.market.slot_len + L.market.engine;
  if (u64(d, base + L.leg.epoch_snap) !== u64(market, a + (long ? L.market.epoch_long : L.market.epoch_short))) abs = 0n;
  else {
    const now = u128(market, a + (long ? L.market.a_long : L.market.a_short)), then = u128(d, base + L.leg.a_basis);
    if (then > 0n && now !== then) abs = (abs * now + then - 1n) / then;
  }
  return long ? abs : -abs;
}

/** `market` gives the position as Percolator counts it (see `legPosition`); without it, the
 *  stored size. */
export function decodePortfolio(d: Uint8Array, asset: number, market?: Uint8Array): Portfolio {
  const p = L.portfolio;
  const control = u64(d, p.control);
  let position = 0n;
  for (let i = 0; i < 16; i++) {
    const base = p.legs + i * p.leg_len;
    if (d[base + L.leg.active] !== 1 || u32(d, base + L.leg.asset_index) !== asset) continue;
    if (market) { position = legPosition(market, d, base); continue; }
    const q = i128(d, base + L.leg.basis_pos_q);
    const abs = q < 0n ? -q : q;
    position = d[base + L.leg.side] === 0 ? abs : -abs;
  }
  return {
    capital: u128(d, p.capital),
    pnl: i128(d, p.pnl),
    id: u64(d, p.id),
    sequence: u64(d, p.sequence),
    positionEpoch: (control >> 1n) & ((1n << 49n) - 1n),
    position,
  };
}

export type Asset = { marketId: bigint; price: bigint; slotLast: bigint; oiLong: bigint; oiShort: bigint; insurance: bigint };

export function decodeAsset(market: Uint8Array, index: number): Asset {
  const m = L.market;
  const e = m.slots + index * m.slot_len + m.engine;
  if (e + m.ins_spent_short + 16 > market.length) return { marketId: 0n, price: 0n, slotLast: 0n, oiLong: 0n, oiShort: 0n, insurance: 0n };
  return {
    marketId: u64(market, e + m.market_id),
    price: u64(market, e + m.effective_price),
    slotLast: u64(market, e + m.slot_last),
    oiLong: u128(market, e + m.oi_long),
    oiShort: u128(market, e + m.oi_short),
    insurance:
      u128(market, e + m.ins_budget_long) + u128(market, e + m.ins_budget_short) -
      u128(market, e + m.ins_spent_long) - u128(market, e + m.ins_spent_short),
  };
}

const LIFECYCLE_RETIRED = 4;

export const marketHeader = (d: Uint8Array) => {
  const slots = u32(d, L.market_header.max_market_slots);
  // Percolator refuses to append a slot while a retired one is free, so a listing reuses the
  // first retired slot and only appends when none is.
  let listSlot = slots;
  for (let i = 1; i < slots; i++) {
    if (d[L.market.slots + i * L.market.slot_len + L.market.engine + L.market.lifecycle] === LIFECYCLE_RETIRED) {
      listSlot = i;
      break;
    }
  }
  return { nextMarketId: u64(d, L.market_header.next_market_id), slots, listSlot };
};

let slotSecs = 0.4;
/** Seconds per slot, as measured by `measureSlotSeconds` (0.4 until then). */
export const slotSeconds = () => slotSecs;
/** Measures the cluster's recent slot time; epochs and approvals are counted in slots. */
export async function measureSlotSeconds(conn: Connection) {
  try {
    const samples = await conn.getRecentPerformanceSamples(5);
    const slots = samples.reduce((a, s) => a + s.numSlots, 0);
    if (slots > 0) slotSecs = samples.reduce((a, s) => a + s.samplePeriodSecs, 0) / slots;
  } catch {
    // keep the previous estimate
  }
  return slotSecs;
}

/** Pyth price (e6 atoms per whole token) and publish time from a sponsored price account. */
export function decodePyth(d: Uint8Array) {
  let off = 8 + 32;
  off += d[off] === 1 ? 1 : 2;
  off += 32;
  const price = dv(d).getBigInt64(off, true);
  const expo = dv(d).getInt32(off + 16, true);
  const publish = Number(dv(d).getBigInt64(off + 20, true));
  const prev = Number(dv(d).getBigInt64(off + 28, true));
  const e6 = expo <= -6 ? price / 10n ** BigInt(-6 - expo) : price * 10n ** BigInt(expo + 6);
  return { e6, publish, prev };
}

/** The same from the router's reported-price account (X1). */
export function decodeReport(d: Uint8Array) {
  return { e6: u64(d, 40), publish: Number(i64(d, 48)), prev: Number(i64(d, 56)) };
}
/** Price and publish time from a feed's price account on this network (see `priceAccount`). */
export const decodePrice = (d: Uint8Array) => (X1 ? decodeReport(d) : decodePyth(d));

export type Ticket = { epoch: bigint; deposit: bigint; withdraw: bigint };
export const decodeTicket = (d: Uint8Array): Ticket => ({
  epoch: u64(d, L.ticket.epoch),
  deposit: u64(d, L.ticket.deposit_assets),
  withdraw: u64(d, L.ticket.withdraw_shares),
});

// ---- PDAs ----
const le8 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const enc = (s: string) => new TextEncoder().encode(s);
export const vaultAddress = (creator: PublicKey, seed: bigint) =>
  PublicKey.findProgramAddressSync([enc("vault"), MARKET.toBytes(), creator.toBytes(), le8(seed)], VAULT_PROGRAM)[0];
/** The one vault (and so the one market) the program allows for a feed. */
export const canonicalVaultAddress = (feedHex: string) =>
  PublicKey.findProgramAddressSync([enc("canon"), MARKET.toBytes(), hexBytes(feedHex), le8(0n)], VAULT_PROGRAM)[0];
export const childAddress = (tag: string, vault: PublicKey) =>
  PublicKey.findProgramAddressSync([enc(tag), vault.toBytes()], VAULT_PROGRAM)[0];
export const ticketAddress = (v: PublicKey, user: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("ticket"), v.toBytes(), user.toBytes()], VAULT_PROGRAM)[0];
export const epochAddress = (v: PublicKey, epoch: bigint) =>
  PublicKey.findProgramAddressSync([enc("epoch"), v.toBytes(), le8(epoch)], VAULT_PROGRAM)[0];
export const matcherDelegate = (portfolio: PublicKey, vault: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [enc("matcher"), MARKET.toBytes(), portfolio.toBytes(), vault.toBytes(), VAULT_PROGRAM.toBytes(), vault.toBytes()],
    PERCOLATOR,
  )[0];
export const ata = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner);
/** Each wallet has one trading portfolio per market, at a deterministic address. */
export const PORTFOLIO_LEN = L.portfolio.len;

// ---- instruction data ----
class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 0xff); return this; }
  u16(v: number) { this.b.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number) { for (let i = 0; i < 4; i++) this.b.push((v >>> (8 * i)) & 0xff); return this; }
  u64(v: bigint) { for (let i = 0n; i < 8n; i++) this.b.push(Number((v >> (8n * i)) & 0xffn)); return this; }
  i64(v: bigint) { return this.u64(v < 0n ? (1n << 64n) + v : v); }
  i128(v: bigint) { const x = v < 0n ? (1n << 128n) + v : v; for (let i = 0n; i < 16n; i++) this.b.push(Number((x >> (8n * i)) & 0xffn)); return this; }
  bytes(b: Uint8Array) { this.b.push(...b); return this; }
  done() { return Buffer.from(this.b); }
}
const ro = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });

/** InitVault in operate mode. The program replaces every parameter with its canonical template;
 *  only the feed and the listing-fee budget matter. */
export function initVault(payer: PublicKey, feedHex: string, frontier: bigint) {
  const vault = canonicalVaultAddress(feedHex);
  const portfolio = childAddress("portfolio", vault);
  const data = new W()
    .u8(16).u64(0n).u16(0).u16(10).u16(0).u16(10_000).u16(0)
    .i128(1n).i128(1n)
    .u64(1_500n).u64(216_000n).u64(frontier)
    .u8(1).u64(0n).u64(2n * BigInt(USDC))
    .u8(1).u8(0).u8(0).u32(0).u16(0)
    .u64(300n).u64(200n).u64(1n).u64(0n)
    .bytes(hexBytes(feedHex)).bytes(new Uint8Array(64))
    .u16(0).u16(0)
    .done();
  return {
    vault,
    ix: new TransactionInstruction({
      programId: VAULT_PROGRAM,
      keys: [
        rw(payer, true), ro(payer, true), rw(vault), rw(MARKET), ro(MINT),
        rw(childAddress("shares", vault)), rw(childAddress("buffer", vault)), rw(childAddress("escrow", vault)),
        rw(portfolio), ro(matcherDelegate(portfolio, vault)), ro(PERCOLATOR), ro(VAULT_PROGRAM), ro(TOKEN_PROGRAM_ID), ro(SystemProgram.programId),
      ],
      data,
    }),
  };
}

/** ListAsset: the vault activates its own asset and configures its Pyth feed. */
export function listAsset(payer: PublicKey, vault: PublicKey, feedHex: string, assetIndex: number, marketId: bigint, initialPrice: bigint) {
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [
      rw(payer, true), rw(ata(payer, MINT)), rw(vault), rw(MARKET), rw(childAddress("buffer", vault)), rw(PERC_VAULT),
      ro(TOKEN_PROGRAM_ID), ro(SystemProgram.programId), ro(PERCOLATOR), ro(priceAccount(feedHex)),
    ],
    data: new W().u8(26).u16(assetIndex).u64(marketId).u64(0n).u64(initialPrice).u64(1n).u64(0n).done(),
  });
}

export function requestDeposit(v: Vault, user: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [rw(user, true), rw(v.key), rw(ticketAddress(v.key, user)), rw(ata(user, MINT)), rw(v.buffer), ro(TOKEN_PROGRAM_ID), ro(SystemProgram.programId)],
    data: new W().u8(17).u64(amount).done(),
  });
}

export function requestWithdraw(v: Vault, user: PublicKey, shares: bigint) {
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [rw(user, true), rw(v.key), rw(ticketAddress(v.key, user)), rw(ata(user, v.shareMint)), rw(v.escrow), ro(TOKEN_PROGRAM_ID), ro(SystemProgram.programId)],
    data: new W().u8(18).u64(shares).done(),
  });
}

export function claim(v: Vault, user: PublicKey, epoch: bigint) {
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [ro(user, true), rw(v.key), rw(ticketAddress(v.key, user)), ro(epochAddress(v.key, epoch)), rw(ata(user, MINT)), rw(ata(user, v.shareMint)), rw(v.buffer), rw(v.escrow), ro(TOKEN_PROGRAM_ID)],
    data: new W().u8(20).done(),
  });
}

export const OPENER_FEE_BPS = 500;
/** The fee each side of a trade pays, fixed by the vault program (CANON_TRADE_FEE_BPS). */
export const TRADE_FEE_BPS = 10;
/** The fee was 5 bps until this slot (2026-10-09): older fills in a history are shown at that. */
export const feeBpsAt = (slot: number) => (slot >= (X1 ? 194_112_461 : 509_124_939) ? TRADE_FEE_BPS : 5);
export const TRADE_FEE_PCT = `${(TRADE_FEE_BPS / 100).toFixed(2)}%`;

export function claimOpenerFees(v: Vault, opener: PublicKey) {
  return new TransactionInstruction({
    programId: VAULT_PROGRAM,
    keys: [ro(opener, true), rw(v.key), rw(ata(opener, MINT)), rw(v.buffer), ro(TOKEN_PROGRAM_ID)],
    data: new W().u8(29).done(),
  });
}

/** The largest fill the vault would take right now in each direction (mirrors the matcher). */
export function depth(s: State): { long: bigint; short: bigint } {
  const v = s.vault;
  const price = s.asset.price;
  let maxFill = v.maxFill, maxInv = v.maxInventory;
  if (v.positionNavBps && price > 0n) {
    const cap = (bps: number) => (v.lastNav * BigInt(bps) / 10_000n) * UNIT / price;
    maxInv = maxInv < cap(v.positionNavBps) ? maxInv : cap(v.positionNavBps);
    maxFill = maxFill < cap(v.fillNavBps) ? maxFill : cap(v.fillNavBps);
  }
  const inv = v.inventory;
  const abs = inv < 0n ? -inv : inv;
  // Closing the vault's position is never capped; only new exposure is (per fill, and in total).
  const room = (lpSign: 1n | -1n) => {
    const reducing = inv !== 0n && (inv > 0n) !== (lpSign > 0n);
    const open = reducing ? maxInv : maxInv > abs ? maxInv - abs : 0n;
    return (reducing ? abs : 0n) + (open < maxFill ? open : maxFill);
  };
  const epochOver = s.slot >= v.epochStart + v.epochLen && v.needsFlat;
  if (epochOver) {
    // Reduce-only: a taker long is only filled if the vault is long (and vice versa).
    return { long: inv > 0n ? abs : 0n, short: inv < 0n ? abs : 0n };
  }
  // A taker long moves the vault short (lpSign -1).
  return { long: room(-1n), short: room(1n) };
}

// ---- cranks ----

/** A `fetch` for the public RPC, which rate-limits per address: requests go out one at a time, at
 *  least `gapMs` apart, and a 429 is retried after a pause instead of failing the caller. A request
 *  the server never answers is given up after `timeoutMs`: every request waits for the one before
 *  it, so without that one hung connection stops its caller for good. */
export function politeFetch(gapMs = 120, retries = 4, timeoutMs = 20_000): typeof fetch {
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
  return (input, init) => {
    // `gapMs` 0: an RPC that does not throttle (X1's). Requests then go out as they come, side
    // by side, keeping only the time limit and the retry.
    if (gapMs <= 0) return (async () => {
      for (let i = 0; ; i++) {
        const limit = AbortSignal.timeout(timeoutMs);
        const res = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit });
        if (res.status !== 429 || i >= retries) return res;
        await pause(700 * (i + 1));
      }
    })();
    const run = async () => {
      for (let i = 0; ; i++) {
        const wait = last + gapMs - Date.now();
        if (wait > 0) await pause(wait);
        last = Date.now();
        const limit = AbortSignal.timeout(timeoutMs);
        const res = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit });
        if (res.status !== 429 || i >= retries) return res;
        await pause(700 * (i + 1));
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => undefined);
    return p;
  };
}

/** What `crankPlan` reads: the market account, the slot it was read at, and every portfolio. */
export type MarketSnapshot = { market: Uint8Array; slot: number; portfolios: { pubkey: PublicKey; data: Uint8Array }[] };

export async function marketSnapshot(conn: Connection): Promise<MarketSnapshot> {
  const [m, slot, accs] = await Promise.all([
    conn.getAccountInfo(MARKET, "confirmed"),
    conn.getSlot("confirmed"),
    conn.getProgramAccounts(PERCOLATOR, { commitment: "confirmed", filters: [{ dataSize: PORTFOLIO_LEN }, { memcmp: { offset: 16, bytes: MARKET.toBase58() } }] }),
  ]);
  return { market: new Uint8Array(m!.data), slot, portfolios: accs.map(a => ({ pubkey: a.pubkey, data: new Uint8Array(a.account.data) })) };
}

/** The compute a transaction asks for. On Solana that is the maximum: Percolator instructions
 *  can use several hundred thousand units, and the fee does not depend on the request. On X1 a
 *  transaction pays 10 lamports for every unit it asks for, used or not (0.014 XNT at the
 *  maximum), so it asks for what a simulation says it uses, plus `spare`. */
export async function computeLimit(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[], spare = 1.2): Promise<TransactionInstruction> {
  const max = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  if (!X1) return max;
  try {
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [max, ...ixs] }).compileToV0Message();
    const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    const used = r.value.unitsConsumed;
    if (used) return ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(1_400_000, Math.ceil(used * spare) + 10_000) });
  } catch { /* fall through: ask for the maximum */ }
  return max;
}

const IDLE_JUMP = (globalThis as any).process?.env?.IDLE_JUMP === "1";

/** The most assets one crank can name (Percolator's V16_MAX_PORTFOLIO_ASSETS_N). */
export const MAX_CRANK_ASSETS = 16;

/** Percolator's permissionless crank on `portfolio`, naming the assets it may accrue (each by at
 *  most 10 slots a call, up to the current slot). It fails (NonProgress) when it finds nothing to do. */
export const crank = (payer: PublicKey, portfolio: PublicKey, assets: number[]) => {
  const w = new W().u8(5).u64(0n).u8(assets.length);
  for (const a of assets) w.u16(a).u8(0);
  return new TransactionInstruction({ programId: PERCOLATOR, keys: [rw(payer, true), rw(MARKET), rw(portfolio)], data: w.done() });
};

/** The cranks Percolator needs before it accepts new risk on asset `focus`, as it works on chain:
 *   - an asset with positions must be accrued to the current slot, and one crank accrues every
 *     asset it names by at most 10 slots, so `ceil(lag / 10)` copies of `lagCrank` are needed,
 *     counted at the slot the transaction lands in: one too few leaves an asset out of date
 *     (the trade fails with LockActive), one too many has nothing to do (NonProgress);
 *   - every price move marks all positions on the asset out of date, and a portfolio is settled
 *     as a whole by one crank, which only works once every asset it holds is current. So the lag
 *     cranks cover `focus` and every asset held by anyone with a position on it (and by the
 *     trader), and `settle` has one crank for each of those portfolios that is, or is about to
 *     be, out of date. They end on `focus`, whose state decides whether the trade is accepted.
 *  With `focus` omitted the plan covers `assets` and every portfolio (routine upkeep). */
/** `settleAlone`: the same accounts as `settle`, each crank naming every asset its account holds
 *  (the one in focus last). Such a crank brings those assets to the current slot itself (up to
 *  10 slots) before it settles the account, so it needs no lag crank in front and transactions
 *  of them can be sent side by side. */
export type CrankPlan = { lag: number; lagCrank: TransactionInstruction; settle: TransactionInstruction[]; settleAlone: TransactionInstruction[]; resets: TransactionInstruction[] };

export function crankPlan(s: MarketSnapshot, payer: PublicKey, vehicle: PublicKey, focus: number | undefined, trader?: PublicKey, assets: number[] = []): CrankPlan {
  const at = (a: number) => L.market.slots + a * L.market.slot_len + L.market.engine;
  const legs = (d: Uint8Array) => {
    const out: { asset: number; stale: boolean; losing: boolean }[] = [];
    for (let i = 0; i < 16; i++) {
      const leg = L.portfolio.legs + i * L.portfolio.leg_len;
      if (d[leg + L.leg.active] !== 1) continue;
      const asset = u32(d, leg + L.leg.asset_index);
      const long = d[leg + L.leg.side] === 0;
      // Out of date after a price move, or left over from a side that was emptied and reset.
      const stale = u64(d, leg + L.leg.kf_epoch_snap) < u64(s.market, at(asset) + (long ? L.market.kf_epoch_long : L.market.kf_epoch_short))
        || u64(d, leg + L.leg.epoch_snap) !== u64(s.market, at(asset) + (long ? L.market.epoch_long : L.market.epoch_short));
      // Whether settling this position books a loss: its side's price index is below the one
      // the position was last settled at.
      const losing = i128(s.market, at(asset) + (long ? L.market.k_long : L.market.k_short)) < i128(d, leg + L.leg.k_snap);
      out.push({ asset, stale, losing });
    }
    return out;
  };
  const mine = trader && routerPortfolio(trader);
  const held = s.portfolios.map(p => ({ key: p.pubkey, legs: legs(p.data) })).filter(p => p.legs.length);
  let holders = held.filter(p => focus === undefined || p.legs.some(l => l.asset === focus) || (mine && p.key.equals(mine)));
  // A crank names at most `MAX_CRANK_ASSETS`. Routine upkeep on a market with more assets than
  // that works on the ones it was given (the caller rotates through them) and settles only the
  // portfolios whose every position is among them.
  if (focus === undefined && new Set([...assets, ...holders.flatMap(p => p.legs.map(l => l.asset))]).size > MAX_CRANK_ASSETS) {
    holders = holders.filter(p => p.legs.every(l => assets.includes(l.asset)));
  }
  // The trader first, holders of `focus` last, so the last asset touched is `focus`.
  holders.sort((x, y) => Number(mine ? y.key.equals(mine) : 0) - Number(mine ? x.key.equals(mine) : 0));
  // Settlement order: accounts with a loss to book before accounts with a gain. Percolator counts
  // a gain only as far as the losses behind it have been booked, and what it counts at the moment
  // a later loss arrives is final: a winner settled while a loser on the same market was not can
  // lose part of that gain for good if the price turns (tests/reversal.rs). Settling losers
  // first, and all of a market's holders together, never leaves that state behind.
  const settleOrder = [...holders].sort((x, y) => Number(y.legs.some(l => l.stale && l.losing)) - Number(x.legs.some(l => l.stale && l.losing)));
  const set = new Set<number>([...assets, ...holders.flatMap(p => p.legs.map(l => l.asset))]);
  if (focus !== undefined) { set.delete(focus); set.add(focus); }
  const all = [...set];
  const moving = (a: number) => u64(s.market, at(a) + L.market.effective_price) !== u64(s.market, at(a) + L.market.raw_oracle_target_price);
  // (Prototype, IDLE_JUMP=1: a market with no positions catches up in one crank, so only the
  // markets with positions decide how many cranks are needed.)
  const counts = (a: number) => !IDLE_JUMP || u128(s.market, at(a) + L.market.oi_long) !== 0n || u128(s.market, at(a) + L.market.oi_short) !== 0n;
  const oldest = all.filter(counts).reduce((m, a) => { const t = u64(s.market, at(a) + L.market.slot_last); return t < m ? t : m; }, BigInt(s.slot));
  const due = settleOrder.filter(p => p.legs.some(l => l.stale || moving(l.asset)));
  const own = (p: { legs: { asset: number }[] }) => {
    const as = [...new Set(p.legs.map(l => l.asset))];
    return focus !== undefined && as.includes(focus) ? [...as.filter(a => a !== focus), focus] : as;
  };
  return {
    lag: s.slot - Number(oldest),
    lagCrank: crank(payer, vehicle, all),
    settle: due.map(p => crank(payer, p.key, [focus ?? p.legs[0].asset])),
    settleAlone: due.map(p => crank(payer, p.key, own(p))),
    resets: focus === undefined ? all.flatMap(a => finalizeResets(s.market, a)) : finalizeResets(s.market, focus),
  };
}

/** When the last position on one side of an asset closes, Percolator parks that side ("reset
 *  pending") and refuses new positions on the asset until anyone finalizes the reset. Returns
 *  that instruction for each parked side that is ready (no stored or out-of-date positions). */
export function finalizeResets(market: Uint8Array, assetIndex: number): TransactionInstruction[] {
  const a = L.market.slots + assetIndex * L.market.slot_len + L.market.engine;
  const sides = [
    [L.market.mode_long, L.market.stored_pos_count_long, L.market.stale_account_count_long],
    [L.market.mode_short, L.market.stored_pos_count_short, L.market.stale_account_count_short],
  ];
  return sides.flatMap(([mode, stored, stale], side) =>
    market[a + mode] === 2 && u64(market, a + stored) === 0n && u64(market, a + stale) === 0n
      ? [new TransactionInstruction({ programId: PERCOLATOR, keys: [rw(MARKET)], data: new W().u8(45).u16(assetIndex).u8(side).done() })]
      : []);
}

/** The trader takes `sizeQ` (positive = long) against the vault through Percolator's TradeCpi. */
export async function listVaults(conn: Connection): Promise<Vault[]> {
  const accs = await conn.getProgramAccounts(VAULT_PROGRAM, { commitment: "confirmed", filters: [{ dataSize: VAULT_LEN }] });
  return accs
    .map(a => decodeVault(a.pubkey, new Uint8Array(a.account.data)))
    .filter(v => v.market.equals(MARKET) && v.feed && (v.status !== 0 || v.canonical))
    .sort((a, b) => Number(b.createdSlot - a.createdSlot));
}

export async function fetchVault(conn: Connection, vaultKey: PublicKey, user?: PublicKey) {
  const va = await conn.getAccountInfo(vaultKey, "confirmed");
  if (!va) throw new Error("vault not found");
  const v = decodeVault(vaultKey, new Uint8Array(va.data));
  // Traders trade through the router: their portfolio belongs to the router's address for them.
  const pf = user ? routerPortfolio(user) : undefined;
  const keys = [MARKET, v.lpPortfolio, v.buffer, v.shareMint, v.oracle, bookAddress(v.key)];
  if (user) keys.push(ticketAddress(v.key, user), ata(user, MINT), ata(user, v.shareMint), pf!, traderAddress(user));
  const firstOrder = keys.length;
  if (user) for (let i = 0; i < MAX_ORDERS; i++) keys.push(orderAddress(v.key, user, i));
  const [accs, slot] = await Promise.all([conn.getMultipleAccountsInfo(keys, "confirmed"), conn.getSlot("confirmed")]);
  const data = (i: number) => (accs[i] ? new Uint8Array(accs[i]!.data) : undefined);
  const tokenAmount = (d?: Uint8Array) => (d ? u64(d, 64) : 0n);
  const book = data(5) ? decodeBook(data(5)!) : undefined;
  const trader = user && data(10) ? decodeTrader(data(10)!) : undefined;
  let pending: RouterRequest | undefined;
  if (trader?.hasPending && trader.pendingVault.equals(v.key)) {
    const k = requestAddress(v.key, user!);
    const ra = await conn.getAccountInfo(k, "confirmed");
    if (ra) pending = decodeRequest(k, new Uint8Array(ra.data));
  }
  return {
    slot: BigInt(slot),
    vault: v,
    asset: decodeAsset(data(0)!, v.assetIndex),
    lp: decodePortfolio(data(1)!, v.assetIndex, data(0)!),
    closeOnly: closeOnly(data(0)!, v.assetIndex),
    buffer: tokenAmount(data(2)),
    shareSupply: data(3) ? u64(data(3)!, 36) : 0n,
    pyth: data(4) ? decodePrice(data(4)!) : undefined,
    book,
    ticket: user && data(6) ? decodeTicket(data(6)!) : undefined,
    userCollateral: user ? tokenAmount(data(7)) : 0n,
    userShares: user ? tokenAmount(data(8)) : 0n,
    portfolioKey: pf,
    portfolio: user && data(9) ? decodePortfolio(data(9)!, v.assetIndex, data(0)!) : undefined,
    margin: user && data(9) ? marginRoom(data(0)!, data(9)!, v.assetIndex) : undefined,
    openPositions: user && data(9) ? openPositions(data(9)!) : 0,
    health: user && data(9) ? accountHealth(data(0)!, data(9)!) : undefined,
    trader,
    pending,
    /** The wallet's standing orders on this market. */
    orders: user ? Array.from({ length: MAX_ORDERS }, (_, i) => (accs[firstOrder + i]?.data.length === ORDER_LEN ? [decodeOrder(keys[firstOrder + i], new Uint8Array(accs[firstOrder + i]!.data))] : [])).flat() : [],
  };
}
export type State = Awaited<ReturnType<typeof fetchVault>>;

/** The router liquidates an account whose equity is below this share (bps) of its notional. */
export const LIQUIDATION_BPS = BigInt(L.router.liquidation_bps);

/** An account's margin position across all markets: equity (capital + PnL), each position as
 *  Percolator counts it with its notional at the current price, and whether every position is
 *  settled at that price (until it is, capital and PnL do not reflect the latest move). */
export function accountHealth(market: Uint8Array, portfolio: Uint8Array) {
  const P = L.portfolio;
  const at = (a: number) => L.market.slots + a * L.market.slot_len + L.market.engine;
  const positions: { asset: number; size: bigint; price: bigint; notional: bigint }[] = [];
  let settled = true, notional = 0n;
  for (let i = 0; i < 16; i++) {
    const leg = P.legs + i * P.leg_len;
    if (portfolio[leg + L.leg.active] !== 1) continue;
    const asset = u32(portfolio, leg + L.leg.asset_index);
    const size = legPosition(market, portfolio, leg);
    const price = u64(market, at(asset) + L.market.effective_price);
    const n = (size < 0n ? -size : size) * price / UNIT;
    const long = portfolio[leg + L.leg.side] === 0;
    if (u64(portfolio, leg + L.leg.kf_epoch_snap) < u64(market, at(asset) + (long ? L.market.kf_epoch_long : L.market.kf_epoch_short))) settled = false;
    notional += n;
    if (size !== 0n) positions.push({ asset, size, price, notional: n });
  }
  const equity = u128(portfolio, P.capital) + i128(portfolio, P.pnl);
  return { equity, notional, settled, positions, liquidatable: settled && notional > 0n && equity * 10_000n < notional * LIQUIDATION_BPS };
}

/** True while a market is close-only: a position on it was reduced unilaterally (the vault's
 *  Unwind, a liquidation), which deleverages the other side, and Percolator then refuses every
 *  risk-increasing trade on it until all positions on it are closed and its sides reset. */
export const closeOnly = (market: Uint8Array, asset: number) => {
  const a = L.market.slots + asset * L.market.slot_len + L.market.engine;
  return u128(market, a + L.market.a_long) !== ADL_ONE || u128(market, a + L.market.a_short) !== ADL_ONE;
};
const ADL_ONE = 1_000_000_000_000_000n;

/** How many markets a portfolio holds a position on. Percolator only pays margin out of a
 *  portfolio with none. */
export function openPositions(portfolio: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < 16; i++) if (portfolio[L.portfolio.legs + i * L.portfolio.leg_len + L.leg.active] === 1) n++;
  return n;
}

/** The largest position (absolute, in position units) on `asset` that the router's margin check
 *  at request time accepts for this portfolio: equity must cover initial margin and fees on every
 *  position after a further `stress_bps` price move, plus that move as a loss (the router's
 *  `margin_covers`). A trade that only shrinks a position is always accepted. */
export function marginRoom(market: Uint8Array, portfolio: Uint8Array, asset: number): bigint {
  const R = L.router, P = L.portfolio;
  const price = (a: number) => u64(market, L.market.slots + a * L.market.slot_len + L.market.engine + L.market.effective_price);
  let other = 0n;
  for (let i = 0; i < 16; i++) {
    const leg = P.legs + i * P.leg_len;
    if (portfolio[leg + L.leg.active] !== 1) continue;
    const a = u32(portfolio, leg + L.leg.asset_index);
    const q = legPosition(market, portfolio, leg);
    if (a !== asset) other += (q < 0n ? -q : q) * price(a) / UNIT;
  }
  const equity = u128(portfolio, P.capital) + i128(portfolio, P.pnl);
  const stress = BigInt(R.stress_bps), rate = u64(market, R.im_bps_off) + marketRates(market).feeBps;
  // need(total) = total * perUnit / 1e8 + minimum
  const perUnit = (10_000n + stress) * rate + stress * 10_000n;
  const total = (equity - u128(market, R.min_im_off)) * 100_000_000n / perUnit - other;
  const p = price(asset);
  return total > 0n && p > 0n ? total * UNIT * 999n / (p * 1000n) : 0n;
}

/** The market's trading fee and initial (= maintenance) margin, in basis points of notional. */
export const marketRates = (market: Uint8Array) => ({ feeBps: u64(market, L.router.fee_bps_off), marginBps: u64(market, L.router.im_bps_off) });

export const navOf = (s: State) =>
  s.lp.capital + (s.lp.pnl > 0n ? s.lp.pnl : 0n) + s.buffer - s.vault.reserved - s.vault.pendingDeposit;

export async function fetchMarket(conn: Connection) {
  const d = new Uint8Array((await conn.getAccountInfo(MARKET, "confirmed"))!.data);
  return { data: d, ...marketHeader(d) };
}

// ---- router: the only way to trade. A request fills at the first Pyth price published at or
// after its target time (landing time + a fixed delay), so nobody can trade at a price they know.

const R = L.router;
export const ROUTER = new PublicKey(R.program);
export const ROUTER_DELAY_SECS = R.delay_secs;
export const ROUTER_GRACE_SECS = R.grace_secs;
/** What a request posts and its executor earns. Larger on X1 (the router's X1 build), where a
 *  fill costs its sender about that much in fees. */
export const ROUTER_BOND_LAMPORTS = X1 ? 20_000_000 : R.bond_lamports;
/** The deposit (lamports) a trader's own request carries on top of the bond: a share of its
 *  notional, in the chain's coin at a fixed rate. It comes back when the request fills, and is
 *  kept only if the request expires after its price had arrived. */
export const EXPIRY_DEPOSIT_BPS: number = R.expiry_deposit_bps;
export const LAMPORTS_PER_ATOM = X1 ? 5_000 : R.lamports_per_atom;
export const expiryDeposit = (size: bigint, priceE6: bigint) => (size < 0n ? -size : size) * priceE6 / UNIT * BigInt(EXPIRY_DEPOSIT_BPS) / 10_000n * BigInt(LAMPORTS_PER_ATOM);
export const TRADER_LEN = R.trader_len;
const rpda = (...seeds: (Uint8Array | Buffer)[]) => PublicKey.findProgramAddressSync(seeds, ROUTER)[0];
export const routerAuthority = () => rpda(Buffer.from("authority"));
export const traderAddress = (wallet: PublicKey) => rpda(Buffer.from("trader"), MARKET.toBuffer(), wallet.toBuffer());
export const routerPortfolio = (wallet: PublicKey) => rpda(Buffer.from("portfolio"), MARKET.toBuffer(), wallet.toBuffer());
export const routerCollateral = (wallet: PublicKey) => rpda(Buffer.from("collateral"), MARKET.toBuffer(), wallet.toBuffer());
export const bookAddress = (vault: PublicKey) => rpda(Buffer.from("book"), vault.toBuffer());
/** A trading account's track record (see social.ts). Deposits, withdrawals and fills name it. */
export const statsAddress = (wallet: PublicKey) => rpda(Buffer.from("stats"), MARKET.toBuffer(), wallet.toBuffer());
/** A pending request lives at its owner's address: the trader's wallet (one request at a time),
 *  or for an epoch settlement whoever queued it. */
export const requestAddress = (vault: PublicKey, owner: PublicKey, settlement = false) =>
  rpda(Buffer.from("request"), vault.toBuffer(), owner.toBuffer(), Buffer.from([settlement ? 1 : 0]));

/** `markSet`: chain time at which the mark was last moved (0 if not recorded). */
export type Book = { vault: PublicKey; len: number; markSet: number; markPublish: number; markPrev: number; markPrice: bigint; nextId: bigint; pending: { id: bigint; target: number }[] };
export function decodeBook(d: Uint8Array): Book {
  const b = R.book;
  const len = d[b.len];
  const pending = Array.from({ length: len }, (_, i) => ({ id: u64(d, b.pending_id + 8 * i), target: Number(i64(d, b.pending_target + 8 * i)) }));
  return { vault: key(d, b.vault), len, markSet: u32(d, b.mark_set_time), markPublish: Number(i64(d, b.mark_publish_time)), markPrev: Number(i64(d, b.mark_prev_publish_time)), markPrice: u64(d, b.mark_price), nextId: u64(d, b.next_id), pending };
}
/** `settle`: an epoch settlement of the vault (then `wallet` is whoever queued it), not a trade.
 *  `order`: the index of the standing order that queued it, if one did. */
export type RouterRequest = { key: PublicKey; vault: PublicKey; wallet: PublicKey; id: bigint; size: bigint; target: number; settle: boolean; order?: number };
export const decodeRequest = (k: PublicKey, d: Uint8Array): RouterRequest => ({
  key: k, vault: key(d, R.request.vault), wallet: key(d, R.request.wallet), id: u64(d, R.request.id), size: i128(d, R.request.size), target: Number(i64(d, R.request.target_time)),
  settle: d[R.request.kind] === 1, order: d[R.request.kind] === 2 ? d[R.request.order_index] : undefined,
});

/** Every request waiting in a vault's queue (one read of the router's request accounts). */
export async function pendingRequests(conn: Connection, vault: PublicKey): Promise<RouterRequest[]> {
  const accs = await conn.getProgramAccounts(ROUTER, { commitment: "confirmed", filters: [{ dataSize: R.request_len }, { memcmp: { offset: R.request.vault, bytes: vault.toBase58() } }] });
  return accs.map(a => decodeRequest(a.pubkey, new Uint8Array(a.account.data)));
}
/** How long a request whose price the mark holds may stay unfilled before anyone may expire it. */
export const ROUTER_STALL_SECS = R.stall_secs;
export const REQUEST_LEN: number = R.request_len;

// ---- standing orders: stop, take-profit, trailing stop, limit, TWAP ----
// The wallet signs an order once. Anyone (an executor) may carry it out when its condition
// holds against the vault's mark; that queues an ordinary request, which fills like any trade
// at the first oracle price at or after its target time.
export const ORDER = { STOP: 0, TAKE: 1, TRAIL: 2, LIMIT: 3, TWAP: 4 } as const;
export const ORDER_LEN: number = R.order_len;
export const MAX_ORDERS: number = R.max_orders;
export const orderAddress = (vault: PublicKey, wallet: PublicKey, index: number) => rpda(Buffer.from("order"), vault.toBuffer(), wallet.toBuffer(), Buffer.from([index]));
export type StandingOrder = {
  key: PublicKey; vault: PublicKey; wallet: PublicKey; index: number; kind: number; reduceOnly: boolean;
  /** Stop, take-profit, trail: the side of the position it protects (1 long, -1 short). */
  side: number;
  /** Limit, TWAP: what is left to trade (+ = buy). Stop, take-profit, trail: how much to close (0 = all). */
  size: bigint;
  /** A price (e6), or a trail's distance in basis points. */
  trigger: bigint;
  peak: bigint; slice: bigint; interval: number; nextTime: number; expiry: number;
  /** A request it queued is waiting to fill. */
  queued: boolean;
};
export const decodeOrder = (k: PublicKey, d: Uint8Array): StandingOrder => {
  const o = R.order;
  return {
    key: k, vault: key(d, o.vault), wallet: key(d, o.wallet), index: d[o.index], kind: d[o.kind], reduceOnly: d[o.reduce_only] === 1,
    side: d[o.side] === 1 ? 1 : d[o.side] === 255 ? -1 : 0, size: i128(d, o.size), trigger: u64(d, o.trigger), peak: u64(d, o.peak), slice: u64(d, o.slice),
    interval: Number(i64(d, o.interval)), nextTime: Number(i64(d, o.next_time)), expiry: Number(i64(d, o.expiry)), queued: u64(d, o.queued_id) !== 0n,
  };
};
export type OrderParams = { index: number; kind: number; reduceOnly?: boolean; size: bigint; trigger: bigint; interval?: number; slices?: number; expiry?: number };
export const placeOrder = (wallet: PublicKey, vault: PublicKey, o: OrderParams) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(wallet, true), ro(traderAddress(wallet)), ro(vault), ro(bookAddress(vault)), rw(orderAddress(vault, wallet, o.index)), ro(MARKET), ro(routerPortfolio(wallet)), ro(SystemProgram.programId)],
  data: new W().u8(12).u8(o.index).u8(o.kind).u8(o.reduceOnly ? 1 : 0).i128(o.size).u64(o.trigger).i64(BigInt(o.interval ?? 0)).u32(o.slices ?? 0).i64(BigInt(o.expiry ?? 0)).done(),
});
export const cancelOrder = (wallet: PublicKey, vault: PublicKey, index: number) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(wallet, true), rw(orderAddress(vault, wallet, index))],
  data: new W().u8(13).done(),
});
/** Carries a standing order out (anyone may). */
export const triggerOrder = (payer: PublicKey, o: StandingOrder) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(payer, true), rw(o.key), rw(traderAddress(o.wallet)), rw(o.wallet), ro(o.vault), rw(bookAddress(o.vault)), rw(requestAddress(o.vault, o.wallet)), ro(MARKET), ro(routerPortfolio(o.wallet)), ro(SystemProgram.programId)],
  data: new W().u8(14).done(),
});
/** What an order would do at mark price `mark` with the wallet's position `held`, as the router
 *  decides it: "fire" (queue its trade), "record" (a trail noting a better mark), "void" (it can
 *  do nothing any more and is removed), or "wait". */
export function orderAction(o: StandingOrder, mark: bigint, held: bigint, now: number): "fire" | "record" | "void" | "wait" {
  if (o.queued) return "wait";
  const protective = o.kind <= ORDER.TRAIL;
  if ((o.expiry !== 0 && now > o.expiry) || (protective && (held === 0n || (held > 0n) !== (o.side > 0)))) return "void";
  if (mark === 0n) return "wait";
  const long = held > 0n;
  if (o.kind === ORDER.STOP || o.kind === ORDER.TAKE) {
    const below = (o.kind === ORDER.STOP) === long;
    return (below ? mark <= o.trigger : mark >= o.trigger) ? "fire" : "wait";
  }
  if (o.kind === ORDER.TRAIL) {
    if (long ? mark > o.peak : mark < o.peak) return "record";
    return (long ? mark * 10_000n <= o.peak * (10_000n - o.trigger) : mark * 10_000n >= o.peak * (10_000n + o.trigger)) ? "fire" : "wait";
  }
  if (!protective && o.reduceOnly && (held === 0n || (held > 0n) === (o.size > 0n))) return "void";
  if (o.kind === ORDER.LIMIT) return (o.size > 0n ? mark <= o.trigger : mark >= o.trigger) ? "fire" : "wait";
  return now >= o.nextTime ? "fire" : "wait";
}
export type Trader = { wallet: PublicKey; portfolio: PublicKey; collateral: PublicKey; hasPending: boolean; hasStats: boolean; pendingVault: PublicKey; pendingId: bigint };
export const decodeTrader = (d: Uint8Array): Trader => ({
  wallet: key(d, R.trader.wallet), portfolio: key(d, R.trader.portfolio), collateral: key(d, R.trader.collateral),
  hasPending: d[R.trader.has_pending] === 1, hasStats: d[R.trader.has_pending + 1] === 1, pendingVault: key(d, R.trader.pending_vault), pendingId: u64(d, R.trader.pending_id),
});

/** An asset's next oracle observation sequence and its authority epoch (Percolator checks both). */
export function controlSequences(market: Uint8Array, asset: number) {
  const base = L.market.slots + asset * L.market.slot_len + L.market.control_sequences;
  return { nextObservation: u64(market, base + L.market.oracle_observation) + 1n, authorityEpoch: u64(market, base + L.market.authority_epoch) };
}

export const openTradingAccount = (wallet: PublicKey) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(wallet, true), rw(traderAddress(wallet)), rw(routerPortfolio(wallet)), rw(routerCollateral(wallet)), rw(MARKET), ro(MINT), ro(PERCOLATOR), ro(SystemProgram.programId), ro(TOKEN_PROGRAM_ID)],
  data: new W().u8(0).done(),
});
export const routerDeposit = (wallet: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: ROUTER,
  keys: [ro(wallet, true), ro(traderAddress(wallet)), rw(ata(wallet, MINT)), rw(routerCollateral(wallet)), rw(routerPortfolio(wallet)), rw(MARKET), rw(PERC_VAULT), ro(TOKEN_PROGRAM_ID), ro(PERCOLATOR), rw(statsAddress(wallet))],
  data: new W().u8(1).u64(amount).done(),
});
export const routerWithdraw = (wallet: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: ROUTER,
  keys: [ro(wallet, true), ro(traderAddress(wallet)), rw(routerPortfolio(wallet)), rw(MARKET), rw(routerCollateral(wallet)), rw(ata(wallet, MINT)), rw(PERC_VAULT), ro(PERC_VAULT_AUTH), ro(TOKEN_PROGRAM_ID), ro(PERCOLATOR), rw(statsAddress(wallet))],
  data: new W().u8(2).u64(amount).done(),
});
/** Turns a trading account's released profit into capital (what a withdrawal pays out). Anyone
 *  may send it; it fails when there is nothing to convert. */
export const routerConvertPnl = (wallet: PublicKey) => new TransactionInstruction({
  programId: ROUTER,
  keys: [ro(traderAddress(wallet)), rw(MARKET), rw(routerPortfolio(wallet)), ro(PERCOLATOR)],
  data: new W().u8(22).done(),
});
export const openBook = (payer: PublicKey, vault: PublicKey) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(payer, true), ro(vault), rw(bookAddress(vault)), ro(SystemProgram.programId)],
  data: new W().u8(3).done(),
});
/** Queues a trade; `id` is the book's next id. It cannot be cancelled. */
export const requestTrade = (wallet: PublicKey, vault: PublicKey, size: bigint) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(wallet, true), rw(traderAddress(wallet)), ro(vault), rw(bookAddress(vault)), rw(requestAddress(vault, wallet)), ro(MARKET), ro(routerPortfolio(wallet)), ro(SystemProgram.programId)],
  data: new W().u8(4).i128(size).done(),
});
/** The router's price account for a feed, written only by the reporter key (`PostPrice`). A
 *  reported price is not verifiable on chain. On Solana the router accepts it only for a queued
 *  request that Pyth has not served for `REPORT_FALLBACK_SECS`; in an X1 build it is the source. */
export const reportAddress = (feedHex: string) => rpda(Buffer.from("report"), Buffer.from(feedHex, "hex"));
export const REPORT_FALLBACK_SECS = R.fallback_secs;
export const postPrice = (reporter: PublicKey, feedHex: string, priceE6: bigint, publish: number, prev: number) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(reporter, true), rw(reportAddress(feedHex)), ro(SystemProgram.programId)],
  data: Buffer.concat([new W().u8(11).done(), Buffer.from(feedHex, "hex"), new W().u64(priceE6).u64(BigInt(publish)).u64(BigInt(prev)).done()]),
});
/** Queues the settlement of a vault's epoch at the first Pyth price after its target time. */
export const requestSettle = (payer: PublicKey, vault: PublicKey) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(payer, true), rw(vault), rw(bookAddress(vault)), rw(requestAddress(vault, payer, true)), ro(SystemProgram.programId), ro(routerAuthority()), ro(VAULT_PROGRAM)],
  data: new W().u8(9).done(),
});
/** Executes a queued settlement: rolls the vault's epoch through the router at the mark. */
export const settleEpoch = (executor: PublicKey, v: Vault, r: RouterRequest, frontier: bigint) => new TransactionInstruction({
  programId: ROUTER,
  keys: [
    rw(executor, true), rw(r.key), rw(r.wallet), rw(bookAddress(v.key)), ro(routerAuthority()),
    rw(v.key), rw(MARKET), rw(v.lpPortfolio), rw(v.buffer), rw(PERC_VAULT), ro(PERC_VAULT_AUTH), rw(v.shareMint), rw(v.escrow),
    rw(epochAddress(v.key, v.epoch)), ro(v.delegate), ro(PERCOLATOR), ro(VAULT_PROGRAM), ro(TOKEN_PROGRAM_ID), ro(SystemProgram.programId),
  ],
  data: new W().u8(10).u64(frontier).done(),
});
/** Switches a vault to closing-only when its overdue epoch's withdrawals exceed its cash. */
export const requireFlat = (v: Vault) => new TransactionInstruction({
  programId: VAULT_PROGRAM,
  keys: [rw(v.key), ro(MARKET), ro(v.lpPortfolio), ro(v.buffer), ro(v.shareMint)],
  data: new W().u8(35).done(),
});
/** Whether an epoch's withdrawals fit in the vault's cash, so it can settle with the vault's
 *  position open (the vault program's own test in `RequireFlat` and `RollEpoch`). */
export function canSettleOpen(s: State): boolean {
  const v = s.vault;
  const cash = s.buffer - v.reserved - v.pendingDeposit;
  const navLow = cash + s.lp.capital - (s.lp.pnl < 0n ? -s.lp.pnl : 0n);
  // assets_for_shares with the program's virtual offsets rounds down; this is within an atom.
  const owed = s.shareSupply > 0n ? v.pendingWithdraw * navLow / s.shareSupply : 0n;
  return owed <= cash + v.pendingDeposit;
}
/** Sets a vault's tracked position to what its portfolio holds (after Percolator changed it
 *  outside a fill: a liquidation or a close-out on the other side). Anyone can send it. */
export const syncInventory = (v: Vault) => new TransactionInstruction({
  programId: VAULT_PROGRAM,
  keys: [rw(v.key), ro(MARKET), ro(v.lpPortfolio)],
  data: new W().u8(34).done(),
});
/** Queues the forced close of `wallet`'s position on a vault's market (`payer` may be anyone):
 *  a close-out on a close-only market, or a liquidation of an account below the router's level. */
export const requestClose = (payer: PublicKey, wallet: PublicKey, vault: PublicKey) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(payer, true), rw(traderAddress(wallet)), ro(wallet), ro(vault), rw(bookAddress(vault)), rw(requestAddress(vault, wallet)), ro(MARKET), ro(SystemProgram.programId), ro(routerPortfolio(wallet))],
  data: new W().u8(8).done(),
});
/** Moves a vault's mark to a verified Pyth update (a PriceUpdateV2 account). */
export const advanceMark = (v: Vault, pyth: PublicKey, market: Uint8Array) => {
  const s = controlSequences(market, v.assetIndex);
  return new TransactionInstruction({
    programId: ROUTER,
    keys: [ro(routerAuthority()), ro(v.key), rw(bookAddress(v.key)), rw(MARKET), ro(pyth), ro(VAULT_PROGRAM), ro(PERCOLATOR)],
    data: new W().u8(5).u64(s.nextObservation).u64(s.authorityEpoch).done(),
  });
};
/** Fills a request whose target the mark is at. Anyone can; the executor earns the bond. */
export const fillRequest = (executor: PublicKey, v: Vault, r: RouterRequest) => new TransactionInstruction({
  programId: ROUTER,
  keys: [
    rw(executor, true), rw(r.key), rw(traderAddress(r.wallet)), rw(r.wallet), rw(bookAddress(v.key)), rw(v.key), rw(MARKET),
    rw(routerPortfolio(r.wallet)), rw(v.lpPortfolio), ro(v.delegate), ro(routerAuthority()), ro(VAULT_PROGRAM), ro(PERCOLATOR),
    // A request queued by a standing order comes with that order.
    ...(r.order !== undefined ? [rw(orderAddress(r.vault, r.wallet, r.order))] : []),
    // Last: the trader's track record (ignored when the trader has none).
    rw(statsAddress(r.wallet)),
  ],
  data: new W().u8(6).done(),
});
/** A vault worth less than this at its last roll pays the platform nothing (the program's PLATFORM_FREE_NAV). */
export const PLATFORM_FREE_NAV = 5_000_000_000n;

/** What one share was worth at each of the vault's last `n` rolls, oldest first. A roll's record
 *  holds the vault's value and the shares outstanding at that moment. */
export async function vaultHistory(conn: Connection, v: Vault, n = 96): Promise<{ epoch: bigint; price: number; slot: bigint }[]> {
  const epochs: bigint[] = [];
  for (let e = v.epoch - 1n; e >= 0n && epochs.length < n; e--) epochs.push(e);
  const accs = await conn.getMultipleAccountsInfo(epochs.map(e => epochAddress(v.key, e)));
  const out: { epoch: bigint; price: number; slot: bigint }[] = [];
  for (const [i, a] of accs.entries()) {
    if (!a || a.data.length < 112) continue;
    const d = new Uint8Array(a.data);
    const nav = u64(d, 80), supply = u64(d, 96);
    if (supply > 0n) out.push({ epoch: epochs[i], price: Number(nav) / USDC / (Number(supply) / 10 ** SHARE_DECIMALS), slot: u64(d, 104) });
  }
  return out.reverse();
}

/** The platform's treasury: its share of harvested fees, and what expired requests leave behind. */
export const TREASURY = new PublicKey("B9Ke1KTC8x46ZxAMTa7oU73HXEzPXt17GC7bZujxiiWV");
/** Sends what expired requests left in a vault's book to the treasury (anyone may). */
export const sweepBook = (vault: PublicKey) => new TransactionInstruction({
  programId: ROUTER,
  keys: [rw(bookAddress(vault)), rw(TREASURY)],
  data: new W().u8(23).done(),
});
export const expireRequest = (caller: PublicKey, r: RouterRequest) => new TransactionInstruction({
  programId: ROUTER,
  // (A settlement names its vault: it can then go as soon as its epoch has rolled.)
  keys: [ro(caller, true), rw(r.key), rw(traderAddress(r.wallet)), rw(r.wallet), rw(bookAddress(r.vault)), ...(r.order !== undefined ? [rw(orderAddress(r.vault, r.wallet, r.order))] : r.settle ? [ro(r.vault)] : [])],
  data: new W().u8(7).done(),
});
