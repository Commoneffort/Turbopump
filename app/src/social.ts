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
export const copyAddress = (follower: PublicKey) => rpda(Buffer.from("copy"), C.MARKET.toBuffer(), follower.toBuffer());
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
  keys: [rw(payer, true), rw(C.traderAddress(wallet)), ro(wallet), rw(statsAddress(wallet)), ro(C.MARKET), ro(C.routerPortfolio(wallet)), ro(SystemProgram.programId)],
  data: Buffer.from([15]),
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
export const setCopy = (wallet: PublicKey, leader: PublicKey, ratioBps: number, maxNotional: bigint) => {
  const data = Buffer.alloc(13);
  data[0] = 19; data.writeUInt32LE(ratioBps, 1); data.writeBigUInt64LE(maxNotional, 5);
  return new TransactionInstruction({
    programId: C.ROUTER,
    keys: [rw(wallet, true), rw(copyAddress(wallet)), ro(C.traderAddress(wallet)), rw(leader), ro(C.traderAddress(leader)), ro(SystemProgram.programId), rw(C.TREASURY)],
    data,
  });
};
export const stopCopy = (wallet: PublicKey) => new TransactionInstruction({
  programId: C.ROUTER, keys: [rw(wallet, true), rw(copyAddress(wallet))], data: Buffer.from([20]),
});
/** Brings a follower in line with its leader on a vault's market (`size` 0 = the whole difference). */
export const triggerCopy = (payer: PublicKey, c: Copy, vault: PublicKey, size = 0n) => new TransactionInstruction({
  programId: C.ROUTER,
  keys: [
    rw(payer, true), rw(c.key), rw(C.traderAddress(c.follower)), ro(c.follower), ro(vault), rw(C.bookAddress(vault)), rw(C.requestAddress(vault, c.follower)),
    ro(C.MARKET), ro(C.routerPortfolio(c.follower)), ro(C.traderAddress(c.leader)), ro(C.routerPortfolio(c.leader)), ro(SystemProgram.programId),
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
  const [statAccs, profAccs, followAccs, copyAccs, market, badgeAccs, portfolioAccs] = await Promise.all([
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: STATS_LEN }, kind("PRSTATS1"), { memcmp: { offset: 40, bytes: C.MARKET.toBase58() } }] }),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: PROFILE_LEN }, kind("PRPROFL1")] }),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: FOLLOW_LEN }, kind("PRFOLLW1")] }),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: COPY_LEN }, kind("PRCOPY01"), { memcmp: { offset: 8, bytes: C.MARKET.toBase58() } }] }),
    conn.getAccountInfo(C.MARKET),
    // (A router that has no badge pictures yet, or an RPC that refuses the scan: no pictures.)
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: BADGE_LEN }, kind("PRBADGE1")] }).catch(() => []),
    // Every portfolio on the market, in one scan (the traders' are picked out below by address).
    conn.getProgramAccounts(C.PERCOLATOR, { filters: [{ dataSize: C.PORTFOLIO_LEN }, { memcmp: { offset: 16, bytes: C.MARKET.toBase58() } }] }),
  ]);
  const pictures = new Map<string, Uint8Array>();
  for (const a of badgeAccs) {
    const b = decodeBadgeImage(new Uint8Array(a.account.data));
    // Only at its own wallet's address, whole, and beginning as a JPEG does.
    if (b && b.written === b.len && isJpeg(b.bytes) && a.pubkey.equals(badgeAddress(b.wallet))) pictures.set(b.wallet.toBase58(), b.bytes);
  }
  const stats = statAccs.map(a => decodeStats(new Uint8Array(a.account.data)));
  const profiles = new Map(profAccs.map(a => { const p = decodeProfile(new Uint8Array(a.account.data)); return [p.wallet.toBase58(), p] as const; }));
  const follows = followAccs.map(a => decodeFollow(new Uint8Array(a.account.data)));
  const copies = copyAccs.map(a => decodeCopy(a.pubkey, new Uint8Array(a.account.data)));
  const wallets = [...new Set([...stats.map(s => s.wallet.toBase58()), ...profiles.keys()])];
  const byAddress = new Map(portfolioAccs.map(a => [a.pubkey.toBase58(), new Uint8Array(a.account.data)] as const));
  const portfolios = new Map<string, Uint8Array>();
  for (const w of wallets) {
    const d = byAddress.get(C.routerPortfolio(new PublicKey(w)).toBase58());
    if (d) portfolios.set(w, d);
  }
  const m = market ? new Uint8Array(market.data) : undefined;
  const byWallet = new Map(stats.map(s => [s.wallet.toBase58(), s]));
  const count = (xs: { leader: PublicKey }[], w: string) => xs.filter(x => x.leader.toBase58() === w).length;
  const rows = wallets.map(w => row(w, byWallet.get(w), profiles.get(w), portfolios.get(w), m, count(follows, w), count(copies, w), copies.find(c => c.follower.toBase58() === w)?.leader.toBase58()));
  rows.sort((a, b) => b.pnl - a.pnl);
  return { rows, follows, copies, profiles, pictures, at: Date.now() };
}

function row(wallet: string, s: Stats | undefined, profile: Profile | undefined, portfolio: Uint8Array | undefined, market: Uint8Array | undefined, followers: number, copiers: number, copying?: string): TraderRow {
  const h = portfolio && market ? C.accountHealth(market, portfolio) : undefined;
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
