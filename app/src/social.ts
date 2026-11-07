// Track records, profiles, following and copy trading: the router's `social` accounts, as the
// page, the executor and the scripts read and write them. Offsets are pinned by the router's
// `layouts_are_what_the_page_reads` test.
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import * as C from "./chain";

const rpda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, C.ROUTER)[0];
const ro = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const rw = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const key = (d: Uint8Array, o: number) => new PublicKey(d.slice(o, o + 32));
const u64 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true);
const i64 = (d: Uint8Array, o: number) => dv(d).getBigInt64(o, true);
const u32 = (d: Uint8Array, o: number) => dv(d).getUint32(o, true);
const u16 = (d: Uint8Array, o: number) => dv(d).getUint16(o, true);
const i128le = (v: bigint) => { const b = Buffer.alloc(16); let x = BigInt.asUintN(128, v); for (let i = 0; i < 16; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

export const STATS_LEN = 1184, PROFILE_LEN = 72, FOLLOW_LEN = 88, COPY_LEN = 136;
export const NAME_MIN = 3, NAME_MAX = 16;
export const MAX_COPY_RATIO_BPS = 30_000, COPY_BAND_BPS = 1_000n, MIN_COPY_NOTIONAL = 1_000_000n;
const DAYS = 30, FILLS = 16;
/** The first eight bytes of a `Copy` account, as an RPC filter wants them. */
export const COPY_TAG = bs58.encode(Buffer.from("PRCOPY01", "ascii"));

export const statsAddress = C.statsAddress;
export const profileAddress = (wallet: PublicKey) => rpda(Buffer.from("profile"), wallet.toBuffer());
export const nameAddress = (name: string) => rpda(Buffer.from("name"), Buffer.from(name.toLowerCase(), "ascii"));
export const followAddress = (follower: PublicKey, leader: PublicKey) => rpda(Buffer.from("follow"), follower.toBuffer(), leader.toBuffer());
export const copyAddress = (follower: PublicKey, market = C.activeMarket()) => rpda(Buffer.from("copy"), market.toBuffer(), follower.toBuffer());
export const validName = (name: string) => new RegExp(`^[A-Za-z0-9_]{${NAME_MIN},${NAME_MAX}}$`).test(name);

// ---------------------------------------------------------------- accounts

export type Day = { day: number; pnl: number };
export type RecentFill = { time: number; price: number; size: number; asset: number };
/** A trading account's track record as the router wrote it (money in dollars of collateral). */
export type Stats = {
  wallet: PublicKey; market: PublicKey; startTime: number; startEquity: number; deposited: number; withdrawn: number;
  volume: number; trades: number; daysUp: number; daysDown: number; lastTime: number; lastPnl: number;
  peakPnl: number; maxDrawdown: number; bestDay: number; worstDay: number;
  /** Trading days, oldest first (at most 30). */
  days: Day[];
  /** Fills, oldest first (at most 16). */
  fills: RecentFill[];
};
export function decodeStats(d: Uint8Array): Stats {
  const usd = (x: bigint) => Number(x) / C.USDC;
  const dayAt = d[73] % DAYS, fillAt = d[74] % FILLS;
  const days: Day[] = [];
  for (let n = 1; n <= DAYS; n++) {
    const o = 192 + ((dayAt + n) % DAYS) * 16;
    if (u32(d, o) !== 0) days.push({ day: u32(d, o), pnl: usd(i64(d, o + 8)) });
  }
  const fills: RecentFill[] = [];
  for (let n = 1; n <= FILLS; n++) {
    const o = 672 + ((fillAt + n) % FILLS) * 32;
    if (i64(d, o) !== 0n) fills.push({ time: Number(i64(d, o)), price: Number(u64(d, o + 8)) / 1e6, size: Number(i64(d, o + 16)) / 1e6, asset: u16(d, o + 24) });
  }
  return {
    wallet: key(d, 8), market: key(d, 40), startTime: Number(i64(d, 80)), startEquity: usd(i64(d, 88)), deposited: usd(u64(d, 96)), withdrawn: usd(u64(d, 104)),
    volume: Number(u64(d, 112) + (u64(d, 120) << 64n)) / C.USDC, trades: u32(d, 128), daysUp: u16(d, 132), daysDown: u16(d, 134), lastTime: Number(i64(d, 136)), lastPnl: usd(i64(d, 144)),
    peakPnl: usd(i64(d, 160)), maxDrawdown: usd(u64(d, 168)), bestDay: usd(i64(d, 176)), worstDay: usd(i64(d, 184)), days, fills,
  };
}
/** `featuredUntil`: unix time until which the wallet paid for the leaderboard's featured row (0 = never). */
export type Profile = { wallet: PublicKey; name: string; badge: number; color: number; created: number; featuredUntil?: number };
export const decodeProfile = (d: Uint8Array): Profile => ({ wallet: key(d, 8), name: Buffer.from(d.slice(40, 40 + Math.min(d[56], NAME_MAX))).toString("ascii"), badge: d[57], color: d[58], created: Number(i64(d, 64)), featuredUntil: u32(d, 60) });
export type Follow = { follower: PublicKey; leader: PublicKey; since: number };
export const decodeFollow = (d: Uint8Array): Follow => ({ follower: key(d, 8), leader: key(d, 40), since: Number(i64(d, 72)) });
export type Copy = { key: PublicKey; market: PublicKey; follower: PublicKey; leader: PublicKey; ratioBps: number; maxNotional: bigint; since: number; triggers: number };
export const decodeCopy = (k: PublicKey, d: Uint8Array): Copy => ({ key: k, market: key(d, 8), follower: key(d, 40), leader: key(d, 72), ratioBps: u32(d, 104), maxNotional: u64(d, 112), since: Number(i64(d, 120)), triggers: u32(d, 128) });

// ---------------------------------------------------------------- instructions

/** Opens `wallet`'s track record (anyone may, and pays its rent). */
export const openStats = (payer: PublicKey, wallet: PublicKey) => new TransactionInstruction({
  programId: C.ROUTER,
  // (Last: the wallet's record of values, whether or not it exists; its isolated accounts count from the start.)
  keys: [rw(payer, true), rw(C.traderAddress(wallet)), ro(wallet), rw(statsAddress(wallet)), ro(C.activeMarket()), ro(C.routerPortfolio(wallet)), ro(SystemProgram.programId), rw(C.equitiesAddress(wallet))],
  data: Buffer.from([15]),
});
/** Brings a trading account's track record up to its value now, without a trade (router
 *  `RefreshRecord`, anyone may): a position losing money in an account that is not traded again
 *  shows its loss in the record's days too. `trader`: the account's address (main or isolated). */
export const refreshRecord = (t: C.Trader & { key: PublicKey }) => new TransactionInstruction({
  programId: C.ROUTER,
  keys: [ro(t.key), ro(t.portfolio), ro(C.activeMarket()), rw(C.equitiesAddress(t.wallet)), rw(statsAddress(t.wallet)), ro(C.ledgerAddress(t.wallet, t.sub))],
  data: Buffer.from([35]),
});
/** Sets the wallet's name and badge; `oldName` is the name it holds now, if any. Taking a name,
 *  or changing it to another, costs `NAME_FEE` (paid to the treasury); badge and colour do not. */
export const setProfile = (wallet: PublicKey, name: string, oldName: string | undefined, badge: number, color: number) => {
  const data = Buffer.alloc(2 + NAME_MAX + 2);
  data[0] = 16; data[1] = name.length;
  data.write(name, 2, "ascii");
  data[2 + NAME_MAX] = badge; data[3 + NAME_MAX] = color;
  return new TransactionInstruction({
    programId: C.ROUTER,
    keys: [rw(wallet, true), rw(profileAddress(wallet)), rw(nameAddress(name)), rw(nameAddress(oldName ?? name)), ro(SystemProgram.programId), rw(C.TREASURY)],
    data,
  });
};
export const follow = (wallet: PublicKey, leader: PublicKey) => new TransactionInstruction({
  programId: C.ROUTER, keys: [rw(wallet, true), rw(followAddress(wallet, leader)), ro(leader), ro(SystemProgram.programId)], data: Buffer.from([17]),
});
// ---- rebates ----
// (Referrals were removed on 2026-10-20: a second wallet could refer the first, and earn on
// volume whose fees the first-month refund already paid back. The router's `SetReferrer`, tag
// 24, still exists on chain; nothing reads what it writes.)
/** What the platform gives back out of the treasury's income, as shares of the fee traders pay
 *  (`C.TRADE_FEE_BPS` of what they trade): a wallet that trades a lot in a week earns part of its
 *  own fees back, never more in total than the treasury took in that week. */
export const REBATE = {
  tiers: [{ weekVolume: 1_000_000, share: 0.10 }, { weekVolume: 100_000, share: 0.05 }], // 10% / 5% of its own fees
  mostOfIncome: 1, // never more than what the treasury took in
};
/** New wallets' first month: their own trade fees back, in full, up to `capPerWeek` each, paid
 *  weekly by scripts/rebates.ts out of a budget the treasury sets aside (`weekBudget`), not out of
 *  that week's income (which is a fifth of the fees, so it could not pay all of them back). */
export const NEW_WALLET = { days: 30, share: 1, capPerWeek: 50, weekBudget: 2_000 };

/** The weekly trading contest, Monday 00:00 to Sunday 24:00 UTC: ranked by the dollar profit of
 *  the week's trading days, among accounts funded with at least `minBase` whose track record was
 *  opened at least `minAgeDays` before the week ended and that traded at least `minTrades` times
 *  in the week. The top places win `prizes` (USDC), paid by scripts/contest.ts from the treasury
 *  after the week, once someone has looked at the winners and approved them, and to one wallet
 *  per funder (scripts/funders.ts). Ranking by profit, not return, means many small accounts
 *  betting both ways cannot buy a winner: a prize takes real money at risk. */
export const CONTEST = { prizes: [500, 250, 100, 50, 50], minTrades: 5, minBase: 1_000, minAgeDays: 7 };
const DAY = 86_400;
/** The contest week containing `secs` (unix): its first day number and its end (unix secs). */
export function contestWeek(secs = Date.now() / 1000) {
  const day = Math.floor(secs / DAY);
  const monday = day - ((new Date(day * DAY * 1000).getUTCDay() + 6) % 7);
  return { firstDay: monday, start: monday * DAY, end: (monday + 7) * DAY };
}
export type ContestRow = { wallet: string; pnl: number; base: number; ret: number; trades: number };
/** The week's standings from track records (`stats` keyed by wallet), best first. */
export function contestStandings(stats: { wallet: string; stats: Stats }[], week = contestWeek()): ContestRow[] {
  const out: ContestRow[] = [];
  for (const { wallet, stats: s } of stats) {
    const base = s.startEquity + s.deposited;
    const trades = s.fills.filter(f => f.time >= week.start && f.time < week.end).length;
    if (base < CONTEST.minBase || trades < CONTEST.minTrades || week.end - s.startTime < CONTEST.minAgeDays * DAY) continue;
    const pnl = s.days.filter(d => d.day >= week.firstDay && d.day < week.firstDay + 7).reduce((t, d) => t + d.pnl, 0);
    out.push({ wallet, pnl, base, ret: pnl / base, trades });
  }
  return out.sort((a, b) => b.pnl - a.pnl);
}

/** A share of the trade fee as millionths of the volume (100 = one basis point). */
export const feeSharePerMillion = (share: number) => share * C.TRADE_FEE_BPS * 100;

export const unfollow = (wallet: PublicKey, leader: PublicKey) => new TransactionInstruction({
  programId: C.ROUTER, keys: [rw(wallet, true), rw(followAddress(wallet, leader))], data: Buffer.from([18]),
});
/** Starts copying `leader`, or changes the terms: `ratioBps` of the leader's leverage, and at
 *  most `maxNotional` (collateral atoms, 0 = no limit) on any one market. Starting to copy a
 *  trader costs `SOCIAL_FEE` to the treasury (router `COPY_FEE_LAMPORTS`) plus `SOCIAL_FEE` to the
 *  leader (`COPY_LEADER_FEE_LAMPORTS`); new terms cost nothing. */
export const setCopy = (wallet: PublicKey, leader: PublicKey, ratioBps: number, maxNotional: bigint, leaderMarket = C.activeMarket()) => {
  const data = Buffer.alloc(13);
  data[0] = 19; data.writeUInt32LE(ratioBps, 1); data.writeBigUInt64LE(maxNotional, 5);
  return new TransactionInstruction({
    programId: C.ROUTER,
    keys: [rw(wallet, true), rw(copyAddress(wallet)), rw(C.traderAddress(wallet)), rw(leader), ro(C.traderAddress(leader, 0, leaderMarket)), ro(SystemProgram.programId), rw(C.TREASURY)],
    data,
  });
};
export const stopCopy = (wallet: PublicKey) => new TransactionInstruction({
  programId: C.ROUTER, keys: [rw(wallet, true), rw(copyAddress(wallet))], data: Buffer.from([20]),
});
/** Brings a follower in line with its leader on a vault's market (`size` 0 = the whole difference).
 *  A leader trading on another market (router 2026-11-07) is followed through that market's
 *  vault for the same feed (`leader`: its market and that vault). */
export const triggerCopy = (payer: PublicKey, c: Copy, vault: PublicKey, size = 0n, leader?: { market: PublicKey; vault: PublicKey }) => new TransactionInstruction({
  programId: C.ROUTER,
  keys: [
    rw(payer, true), rw(c.key), rw(C.traderAddress(c.follower)), ro(c.follower), ro(vault), rw(C.bookAddress(vault)), rw(C.requestAddress(vault, c.follower)),
    ro(C.activeMarket()), ro(C.routerPortfolio(c.follower)), ro(C.traderAddress(c.leader, 0, leader?.market)), ro(C.routerPortfolio(c.leader, 0, leader?.market)), ro(SystemProgram.programId),
    ...(leader ? [ro(leader.market), ro(leader.vault)] : []),
    ro(C.tiersAddress()),
  ],
  data: Buffer.concat([Buffer.from([21]), i128le(size)]),
});

// ---------------------------------------------------------------- fees and badge pictures

/** What starting to copy a trader costs, and what a badge picture costs (router
 *  `SOCIAL_FEE_LAMPORTS`): 10 XNT on X1, 0.02 SOL on devnet. Paid to the platform's treasury. */
export const SOCIAL_FEE = C.X1 ? 10_000_000_000n : 20_000_000n;
export const SOCIAL_FEE_TEXT = C.X1 ? "10 XNT" : "0.02 SOL";
/** Whether this network's router pays the copied trader too (`COPY_LEADER_FEE_LAMPORTS`): both
 *  routers do since 2026-10-19. */
export const LEADER_PAID = true;
/** Starting to copy a trader: `SOCIAL_FEE` to the treasury plus the same to the trader copied. */
export const COPY_FEE = LEADER_PAID ? 2n * SOCIAL_FEE : SOCIAL_FEE;
export const COPY_FEE_TEXT = LEADER_PAID ? (C.X1 ? "20 XNT" : "0.04 SOL") : SOCIAL_FEE_TEXT;
/** A tenth of that: a name (taking one, or changing it), and one day in the leaderboard's
 *  featured row (router `NAME_FEE_LAMPORTS`, `FEATURE_FEE_LAMPORTS`). */
export const NAME_FEE = SOCIAL_FEE / 10n, FEATURE_FEE = SOCIAL_FEE / 10n;
export const SMALL_FEE_TEXT = C.X1 ? "1 XNT" : "0.002 SOL";
export const FEATURE_SECS = 86_400, FEATURE_MAX_AHEAD_SECS = 30 * 86_400;
/** One more day in the featured row for `wallet` (it needs a name first). */
export const feature = (wallet: PublicKey) => new TransactionInstruction({
  programId: C.ROUTER, keys: [rw(wallet, true), rw(profileAddress(wallet)), rw(C.TREASURY), ro(SystemProgram.programId)], data: Buffer.from([28]),
});

/** A badge picture as the router stores it: a 56-byte header, then room for 2,048 bytes. The
 *  page only ever writes, and only ever shows, a JPEG of `BADGE_PX` by `BADGE_PX` pixels. */
export const BADGE_HEAD = 56, BADGE_MAX_BYTES = 2_048, BADGE_LEN = BADGE_HEAD + BADGE_MAX_BYTES;
export const BADGE_PX = 64;
/** What the page aims for, so a picture is two transactions: one that pays and one that finishes. */
export const BADGE_CHUNK = 800, BADGE_TARGET_BYTES = 2 * BADGE_CHUNK;
export const badgeAddress = (wallet: PublicKey) => rpda(Buffer.from("badge"), wallet.toBuffer());
const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
/** The picture in a badge account, if it is whole and is what the router says it is. What the
 *  bytes decode to is checked again where they are shown (`Traders.tsx`, `safePicture`). */
export function decodeBadgeImage(d: Uint8Array): { wallet: PublicKey; bytes: Uint8Array; written: number; len: number } | undefined {
  if (d.length !== BADGE_LEN || Buffer.from(d.slice(0, 8)).toString("ascii") !== "PRBADGE1") return undefined;
  const len = u16(d, 40), written = u16(d, 42);
  if (d[44] !== 1 || len > BADGE_MAX_BYTES) return undefined;
  return { wallet: key(d, 8), bytes: d.slice(BADGE_HEAD, BADGE_HEAD + len), written, len };
}
/** Starts a picture of `len` bytes with its first bytes, and pays the fee. */
export const setBadgeImage = (wallet: PublicKey, len: number, first: Uint8Array) => {
  const head = Buffer.alloc(4);
  head[0] = 25; head[1] = 1; head.writeUInt16LE(len, 2);
  return new TransactionInstruction({
    programId: C.ROUTER, keys: [rw(wallet, true), rw(badgeAddress(wallet)), rw(C.TREASURY), ro(SystemProgram.programId)], data: Buffer.concat([head, Buffer.from(first)]),
  });
};
/** The picture's next bytes, starting at `offset`. */
export const writeBadgeImage = (wallet: PublicKey, offset: number, bytes: Uint8Array) => {
  const head = Buffer.alloc(3);
  head[0] = 26; head.writeUInt16LE(offset, 1);
  return new TransactionInstruction({ programId: C.ROUTER, keys: [ro(wallet, true), rw(badgeAddress(wallet))], data: Buffer.concat([head, Buffer.from(bytes)]) });
};
export const removeBadgeImage = (wallet: PublicKey) => new TransactionInstruction({
  programId: C.ROUTER, keys: [rw(wallet, true), rw(badgeAddress(wallet))], data: Buffer.from([27]),
});

// ---------------------------------------------------------------- the copy rule (as the router computes it)

const abs = (x: bigint) => (x < 0n ? -x : x);
/** The position that puts the follower at the leader's leverage on a market, times the copy's
 *  ratio and within its limit (router `copy_target`). */
export function copyTarget(leaderPos: bigint, leaderEquity: bigint, followerEquity: bigint, ratioBps: number, maxNotional: bigint, price: bigint): bigint {
  if (leaderPos === 0n || leaderEquity <= 0n || followerEquity <= 0n || price === 0n) return 0n;
  let q = abs(leaderPos) * followerEquity * BigInt(ratioBps) / leaderEquity / 10_000n;
  if (maxNotional !== 0n) { const cap = maxNotional * C.UNIT / price; if (cap < q) q = cap; }
  return leaderPos > 0n ? q : -q;
}
/** Whether a follower holding `held` with target `target` is to be brought in line (router `copy_due`). */
export function copyDue(held: bigint, target: bigint, price: bigint): boolean {
  const delta = target - held;
  if (delta === 0n) return false;
  if (target === 0n) return true;
  if (abs(delta) * price / C.UNIT < MIN_COPY_NOTIONAL) return false;
  return held === 0n || (held > 0n) !== (target > 0n) || abs(delta) * 10_000n >= abs(target) * COPY_BAND_BPS;
}

// ---------------------------------------------------------------- the board

export type TraderRow = {
  wallet: string;
  /** The market the wallet's accounts are on (see C.MARKETS). */
  market?: string;
  profile?: Profile;
  stats?: Stats;
  /** Equity now, and the profit the record shows with it (live: the record itself only moves at a fill). */
  equity: number; pnl: number; roi: number;
  daysUp: number; daysDown: number; days: Day[];
  /** Sum of the winning days over the sum of the losing days (undefined with no losing day). */
  profitFactor?: number;
  drawdownPct: number;
  positions: { asset: number; size: number; notional: number }[];
  leverage: number;
  followers: number; copiers: number;
  copying?: string;
  /** Below its liquidation level right now (anyone may close it through the router). */
  liquidatable: boolean;
};
export type Board = {
  rows: TraderRow[]; follows: Follow[]; copies: Copy[]; profiles: Map<string, Profile>;
  /** Whole badge pictures by wallet: raw bytes from the chain, not yet checked as a picture. */
  pictures: Map<string, Uint8Array>;
  at: number;
};

/** Every trading account with a track record or a profile on this network's market, with what
 *  the page shows about it. Account scans only: no transaction history. */
export async function loadBoard(conn: Connection): Promise<Board> {
  // Each kind of account starts with its own eight letters: other router accounts can have the same size.
  const kind = (tag: string) => ({ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(tag, "ascii")) } });
  // Every market of the site (since the split each wallet lives on one): records and copies in one
  // scan each, portfolios and trading accounts market by market.
  const ours = (k: PublicKey) => C.isOurMarket(k);
  const perMarket = <T,>(f: (m: PublicKey) => Promise<T[]>) => Promise.all(C.MARKETS.map(x => f(x.key))).then(xs => xs.flat());
  const [statAll, profAccs, followAccs, copyAll, marketAccs, badgeAccs, portfolioAccs, traderAccs] = await Promise.all([
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: STATS_LEN }, kind("PRSTATS1")] }),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: PROFILE_LEN }, kind("PRPROFL1")] }),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: FOLLOW_LEN }, kind("PRFOLLW1")] }),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: COPY_LEN }, kind("PRCOPY01")] }),
    conn.getMultipleAccountsInfo(C.MARKETS.map(x => x.key)),
    // (A router that has no badge pictures yet, or an RPC that refuses the scan: no pictures.)
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: BADGE_LEN }, kind("PRBADGE1")] }).catch(() => []),
    // Every portfolio on the markets (the traders' are picked out below by address).
    perMarket(m => conn.getProgramAccounts(C.PERCOLATOR, { filters: [{ dataSize: C.PORTFOLIO_LEN }, { memcmp: { offset: 16, bytes: m.toBase58() } }] }) as Promise<any[]>),
    // The trading accounts on the markets: a wallet's isolated accounts count in its results too.
    perMarket(m => (conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.TRADER_LEN }, { memcmp: { offset: 8, bytes: m.toBase58() } }] }) as Promise<any[]>).catch(() => [])),
  ]);
  const statAccs = statAll.filter(a => ours(new PublicKey(a.account.data.subarray(40, 72))));
  const copyAccs = copyAll.filter(a => ours(new PublicKey(a.account.data.subarray(8, 40))));
  const marketData = new Map(C.MARKETS.flatMap((x, i) => (marketAccs[i] ? [[x.key.toBase58(), C.noteMarketData(new Uint8Array(marketAccs[i]!.data), x.key)] as const] : [])));
  const pictures = new Map<string, Uint8Array>();
  for (const a of badgeAccs) {
    const b = decodeBadgeImage(new Uint8Array(a.account.data));
    // Only at its own wallet's address, whole, and beginning as a JPEG does.
    if (b && b.written === b.len && isJpeg(b.bytes) && a.pubkey.equals(badgeAddress(b.wallet))) pictures.set(b.wallet.toBase58(), b.bytes);
  }
  // A wallet's market: where its record is (the busiest one, should it have two).
  const statsWithMarket = statAccs.map(a => ({ s: decodeStats(new Uint8Array(a.account.data)), market: new PublicKey(a.account.data.subarray(40, 72)) }))
    .sort((a, b) => b.s.volume - a.s.volume);
  const homeOf = new Map<string, PublicKey>();
  for (const x of statsWithMarket) if (!homeOf.has(x.s.wallet.toBase58())) homeOf.set(x.s.wallet.toBase58(), x.market);
  const stats = statsWithMarket.filter(x => homeOf.get(x.s.wallet.toBase58())!.equals(x.market)).map(x => x.s);
  const profiles = new Map(profAccs.map(a => { const p = decodeProfile(new Uint8Array(a.account.data)); return [p.wallet.toBase58(), p] as const; }));
  const follows = followAccs.map(a => decodeFollow(new Uint8Array(a.account.data)));
  const copies = copyAccs.map(a => decodeCopy(a.pubkey, new Uint8Array(a.account.data)));
  const wallets = [...new Set([...stats.map(s => s.wallet.toBase58()), ...profiles.keys()])];
  const byAddress = new Map(portfolioAccs.map(a => [a.pubkey.toBase58(), new Uint8Array(a.account.data)] as const));
  // Every one of a wallet's accounts: its main one, and its isolated ones (from the trader accounts).
  const portfolios = new Map<string, Uint8Array[]>();
  const add = (w: string, d?: Uint8Array) => { if (d) portfolios.set(w, [...(portfolios.get(w) ?? []), d]); };
  const home = (w: string) => homeOf.get(w) ?? C.placedMarket(new PublicKey(w));
  for (const w of wallets) add(w, byAddress.get(C.routerPortfolio(new PublicKey(w), 0, home(w)).toBase58()));
  const known = new Set(wallets);
  for (const a of traderAccs) {
    const t = C.decodeTrader(new Uint8Array(a.account.data));
    if (t.sub !== 0 && known.has(t.wallet.toBase58()) && t.market.equals(home(t.wallet.toBase58()))) add(t.wallet.toBase58(), byAddress.get(t.portfolio.toBase58()));
  }
  const byWallet = new Map(stats.map(s => [s.wallet.toBase58(), s]));
  const count = (xs: { leader: PublicKey }[], w: string) => xs.filter(x => x.leader.toBase58() === w).length;
  const rows = wallets.map(w => ({ ...row(w, byWallet.get(w), profiles.get(w), portfolios.get(w), marketData.get(home(w).toBase58()), count(follows, w), count(copies, w), copies.find(c => c.follower.toBase58() === w)?.leader.toBase58()), market: home(w).toBase58() }));
  rows.sort((a, b) => b.pnl - a.pnl);
  return { rows, follows, copies, profiles, pictures, at: Date.now() };
}

/** `portfolios`: every account of the wallet (main and isolated), counted as one. */
function row(wallet: string, s: Stats | undefined, profile: Profile | undefined, portfolios: Uint8Array[] | undefined, market: Uint8Array | undefined, followers: number, copiers: number, copying?: string): TraderRow {
  const hs = market ? (portfolios ?? []).map(p => C.accountHealth(market, p)) : [];
  const h = hs.length ? {
    equity: hs.reduce((t, x) => t + x.equity, 0n), notional: hs.reduce((t, x) => t + x.notional, 0n),
    positions: hs.flatMap(x => x.positions), liquidatable: hs.some(x => x.liquidatable),
  } : undefined;
  const equity = h ? Number(h.equity) / C.USDC : 0;
  const base = s ? s.startEquity + s.deposited : 0;
  const pnl = s ? equity - s.startEquity - s.deposited + s.withdrawn : 0;
  const days = s?.days ?? [];
  const up = days.filter(d => d.pnl > 0), down = days.filter(d => d.pnl < 0);
  const won = up.reduce((t, d) => t + d.pnl, 0), lost = -down.reduce((t, d) => t + d.pnl, 0);
  // The record counts days that are over; the newest day in the list is still running.
  const today = days[days.length - 1];
  const daysUp = (s?.daysUp ?? 0) + (today && today.pnl > 0 ? 1 : 0), daysDown = (s?.daysDown ?? 0) + (today && today.pnl < 0 ? 1 : 0);
  const notional = h ? Number(h.notional) / C.USDC : 0;
  return {
    wallet, profile, stats: s, equity, pnl, roi: base > 0 ? pnl / base : 0, daysUp, daysDown, days,
    profitFactor: lost > 0 ? won / lost : undefined,
    drawdownPct: s && base > 0 ? Math.max(s.maxDrawdown, s.peakPnl - pnl, 0) / base : 0,
    positions: (h?.positions ?? []).map(p => ({ asset: p.asset, size: Number(p.size) / 1e6, notional: Number(p.notional) / C.USDC })),
    leverage: equity > 0 ? notional / equity : 0,
    followers, copiers, copying,
    liquidatable: !!h?.liquidatable,
  };
}

// ---------------------------------------------------------------- trade notes
// A trader can send a short note with a trade, for the people who follow them. It goes in the
// trade's own transaction as a memo signed by the trader's wallet (so nobody else can write one
// in their name), and followers' charts show it on that trade's badge. Nothing is stored by us.
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const NOTE_MAX = 140;
const NOTE_TAG = "tp:";
/** Keeps a note to what is shown: one line, no control characters, at most NOTE_MAX characters. */
export const cleanNote = (text: string) => [...text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim()].slice(0, NOTE_MAX).join("");
export const tradeNote = (wallet: PublicKey, text: string) => new TransactionInstruction({
  programId: MEMO_PROGRAM, keys: [ro(wallet, true)], data: Buffer.from(NOTE_TAG + cleanNote(text), "utf8"),
});
export type Note = { time: number; text: string; sig: string };
/** The note in a transaction's memo field as an RPC reports it ("[len] text", several joined by "; "). */
export function noteOf(memo: string | null | undefined): string | undefined {
  if (!memo) return undefined;
  for (const part of memo.split(/;\s*(?=\[\d+\])/)) {
    const m = /^(?:\[\d+\]\s*)?(.*)$/s.exec(part.trim());
    if (m && m[1].startsWith(NOTE_TAG)) { const t = cleanNote(m[1].slice(NOTE_TAG.length)); if (t) return t; }
  }
  return undefined;
}
/** A wallet's recent trade notes, newest first: read from its trading accounts' transactions (on
 *  every market of the site: a wallet trades on one of X1's five). Anyone can send a transaction
 *  that names someone else's trading account and carries a memo, so a note only counts when the
 *  same transaction trades for that wallet through the router (Request 4, RequestClose 8,
 *  TakeQuote 38), signed by the wallet itself or by its approved trading key (the router checked
 *  the key against the wallet's session, which the instruction names), and the memo is signed by
 *  that same signer. */
const verified = new Map<string, boolean>();
export async function loadNotes(conn: Connection, wallet: PublicKey, limit = 60): Promise<Note[]> {
  const traders = C.MARKETS.map(m => C.traderAddress(wallet, 0, m.key));
  const live = (await conn.getMultipleAccountsInfo(traders, "confirmed")).map((a, i) => (a ? i : -1)).filter(i => i >= 0);
  const out: Note[] = [];
  const me = wallet.toBase58(), router = C.ROUTER.toBase58(), memo = MEMO_PROGRAM.toBase58();
  for (const i of live) {
    const session = C.sessionAddress(wallet, C.MARKETS[i].key).toBase58();
    const sigs = await conn.getSignaturesForAddress(traders[i], { limit }, "confirmed");
    for (const s of sigs) {
      const text = !s.err && s.blockTime ? noteOf(s.memo) : undefined;
      if (!text) continue;
      let ok = verified.get(s.signature);
      if (ok === undefined) {
        const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
        if (!tx) continue;
        const m = tx.transaction.message, keys = m.staticAccountKeys.map(k => k.toBase58());
        const signers = new Set(keys.slice(0, m.header.numRequiredSignatures));
        const ixs = m.compiledInstructions;
        // The trade: by the wallet, or by a key the router accepted for it (its session named).
        const trade = ixs.find(ix => keys[ix.programIdIndex] === router && [4, 8, 38].includes(ix.data[0]) && signers.has(keys[ix.accountKeyIndexes[0]])
          && (keys[ix.accountKeyIndexes[0]] === me || ix.accountKeyIndexes.some(k => keys[k] === session)));
        const by = trade && keys[trade.accountKeyIndexes[0]];
        ok = !!by && ixs.some(ix => keys[ix.programIdIndex] === memo && ix.accountKeyIndexes.some(k => keys[k] === by));
        verified.set(s.signature, ok);
      }
      if (ok) out.push({ time: s.blockTime!, text, sig: s.signature });
    }
  }
  return out.sort((a, b) => b.time - a.time);
}


// ---------------------------------------------------------------- reading a record

/** Share of trading days that ended up (undefined with none). */
export const winRatio = (r: TraderRow) => (r.daysUp + r.daysDown ? r.daysUp / (r.daysUp + r.daysDown) : undefined);

/** How bullish an account is, 0 (all bearish) to 1 (all bullish): its open positions' value long
 *  against short, or with nothing open, the share of buying in its recent trades. */
export function leanOf(r: TraderRow): { bull: number; from: "positions" | "trades" | "none" } {
  const long = r.positions.filter(p => p.size > 0).reduce((t, p) => t + Math.abs(p.notional), 0);
  const short = r.positions.filter(p => p.size < 0).reduce((t, p) => t + Math.abs(p.notional), 0);
  if (long + short > 0) return { bull: long / (long + short), from: "positions" };
  const fills = r.stats?.fills ?? [];
  const buy = fills.filter(f => f.size > 0).reduce((t, f) => t + Math.abs(f.size * f.price), 0);
  const all = fills.reduce((t, f) => t + Math.abs(f.size * f.price), 0);
  return all > 0 ? { bull: buy / all, from: "trades" } : { bull: 0.5, from: "none" };
}
export const leanName = (bull: number) => (bull >= 0.55 ? "Bullish" : bull <= 0.45 ? "Bearish" : "Neutral");
