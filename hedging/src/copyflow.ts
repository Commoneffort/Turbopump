// Hedge demo: does hedging on an outside venue make the vault's depositors more money?
//
// Real prices and funding (Hyperliquid's public history, downloaded by demo/fetch-hl.ts) are
// replayed minute by minute. Simulated traders trade against the vaults:
//   - the crowd: many small traders, random direction (they lose only the fee on average);
//   - copiers: groups that copy a "leader". A leader's skill is the chance their trade is on
//     the side the price then moves to (0.5 = a coin flip). Copiers fill one minute after the
//     leader decides, and close one minute after the leader does.
// The trades are worked out once. Then each hedge strategy is run on the same trades through
// the real hedge engine, journal and reconciliation, with the mock venue standing in for the
// outside exchange (its fee, spread and the real funding rates).
//
// Strategies (what the hedge is told to offset):
//   none   no hedge: the vault keeps everything.
//   all    the vault's whole position.
//   copy   only the vault's position against copiers (the crowd stays with the vault).
//   smart  only copiers of leaders with a winning record so far on our platform (last 20
//          trades in profit, at least 8 trades). No look-ahead: the record is what had closed.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { defaultConfig } from "./config";
import { World } from "./simulator";
import { USD } from "./units";

export const SYMBOLS = ["BTC", "ETH", "SOL"] as const;
export type Sym = typeof SYMBOLS[number];
export type Strategy = "none" | "all" | "copy" | "smart";
export const STRATEGIES: Strategy[] = ["none", "all", "copy", "smart"];

export type Market = { coin: Sym; candles: [number, number, number, number, number][]; funding: [number, number][] };

/** One price per minute from 5-minute candles: open, first extreme, middle, second extreme,
 *  close (low first on a rising candle, high first on a falling one). */
export function minutePrices(m: Market): { t: number[]; px: number[] } {
  const t: number[] = [], px: number[] = [];
  for (const [ts, o, h, l, c] of m.candles) {
    const [a, b] = c >= o ? [l, h] : [h, l];
    [o, a, (a + b) / 2, b, c].forEach((p, i) => { t.push(ts + i * 60_000); px.push(p); });
  }
  return { t, px };
}

export type Leader = { name: string; skill: number; copyUsd: number };
export type Crowd = { opensPerMin: number; medianUsd: number; holdMin: number; longShare?: number };

/** Income ideas for depositors, all off by default.
 *  holdPerHour  holding fee: each hour, the side the vault is against pays this share of its
 *               position's value when the vault is at its limit, scaled down in a straight line
 *               to nothing at `holdFrom` of the limit (default 0.1). The other side pays nothing.
 *  sideFeeBps   extra fee on the part of a new trade that makes the vault's position bigger.
 *  profitShare  share of copiers' profit (after all fees) taken on new highs only; depositors
 *               get `shareToDepositors` of it (the rest goes to the leader and the platform). */
export type Mechanisms = { holdPerHour?: number; holdFrom?: number; sideFeeBps?: number; profitShare?: number; shareToDepositors?: number };

export type Scenario = {
  name: string;
  about: string;
  leaders: Leader[];
  /** Our trading fee, charged to the trader on opening and on closing. */
  feeBps: number;
  /** Per symbol: chance of a new crowd trade each minute, its median size, mean hold, and the
   *  share of its trades that are buys (0.5 when not given). */
  crowd?: Crowd;
  /** Optional second crowd: traders who hold for days (counted as crowd in volume and P&L). */
  holders?: Crowd;
  /** Ways the vault charges more (see `Mechanisms`); none when not given. */
  mech?: Mechanisms;
  /** Each vault's deposits, and the largest position it takes (share of deposits). */
  depositsUsd?: number;
  capShare?: number;
};

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** who: leader index, or -1 crowd, -2 holders. paid: extra fees charged to it (side, holding). */
type Pos = { sym: number; q: number; open: number; who: number; closeAt: number; paid: number };

/** The trades, worked out once for every strategy. */
export type Flow = {
  steps: number;
  t: number[];
  px: number[][];
  /** Per step, per symbol: the vault's position (tokens), and the part of it against each
   *  leader's copiers. */
  vaultQ: Float64Array[];
  copyQ: Float64Array[][];
  /** Per step, per leader: whether their record is winning (the smart strategy hedges them). */
  winning: Uint8Array[];
  /** Depositors' cumulative fee income, and the vault's cumulative position result, per step. */
  feeIncome: Float64Array;
  vaultPnl: Float64Array;
  volume: { crowd: number; copy: number; leaders: number[] };
  /** Every copier trade: step, leader, symbol, size (tokens, + = copiers bought), price; the
   *  leader decided one step before an open. */
  copyEvents: { i: number; leader: number; sym: number; kind: "open" | "close"; q: number; px: number }[];
  /** What each group made or lost before fees (the vault's position result is minus their sum). */
  traderPnl: { crowd: number; leaders: number[] };
  trades: { crowd: number; leaders: number[] };
  refusedUsd: number;
  /** Cumulative depositor income per step from each mechanism (holding fee, side fee, their
   *  part of the profit share), and totals of the profit share by who receives it. */
  hold: Float64Array;
  side: Float64Array;
  share: Float64Array;
  shareTotal: { all: number; depositors: number };
  /** Holding fees paid by crowd, holders, copiers. */
  holdPaid: { crowd: number; holders: number; copy: number };
  holdersPnl: number;
  /** The largest position (dollars) a new trade grew a vault to. */
  maxAfterOpenUsd: number;
};

export function makeFlow(markets: Market[], s: Scenario, seed: number): Flow {
  const series = markets.map(minutePrices);
  const steps = Math.min(...series.map(x => x.px.length));
  const px = series.map(x => x.px.slice(0, steps));
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const crowd = s.crowd ?? { opensPerMin: 0.03, medianUsd: 1_200, holdMin: 120 };
  const groups: [Crowd, number][] = [[crowd, -1], ...(s.holders ? [[s.holders, -2] as [Crowd, number]] : [])];
  const m = s.mech ?? {};
  const holdFrom = m.holdFrom ?? 0.1, sideFee = (m.sideFeeBps ?? 0) / 10_000;
  let holdIn = 0, sideIn = 0, shareIn = 0, shareAll = 0;
  const copierNet = new Array(s.leaders.length).fill(0), copierHigh = new Array(s.leaders.length).fill(0);
  const deposits = s.depositsUsd ?? 100_000, capUsd = deposits * (s.capShare ?? 0.75);
  const fee = s.feeBps / 10_000;
  const L = s.leaders.length, S = markets.length;

  const vault = new Array(S).fill(0);
  const copy = Array.from({ length: S }, () => new Array(L).fill(0));
  const open: Pos[] = [];
  const pending: { at: number; sym: number; dir: number; leader: number; closeAt: number }[] = [];
  const leaderBusyUntil = new Array(L).fill(0);
  const closingRecords: { at: number; leader: number; pos: Pos }[] = [];
  const record: number[][] = Array.from({ length: L }, () => []);
  const isWinning = (l: number) => record[l].length >= 8 && record[l].slice(-20).reduce((a, x) => a + x, 0) > 0;

  const f: Flow = {
    steps, t: series[0].t.slice(0, steps), px,
    vaultQ: [], copyQ: [], winning: [],
    feeIncome: new Float64Array(steps), vaultPnl: new Float64Array(steps),
    volume: { crowd: 0, copy: 0, leaders: new Array(L).fill(0) }, copyEvents: [], traderPnl: { crowd: 0, leaders: new Array(L).fill(0) },
    trades: { crowd: 0, leaders: new Array(L).fill(0) }, refusedUsd: 0, maxAfterOpenUsd: 0,
    hold: new Float64Array(steps), side: new Float64Array(steps), share: new Float64Array(steps),
    shareTotal: { all: 0, depositors: 0 }, holdPaid: { crowd: 0, holders: 0, copy: 0 }, holdersPnl: 0,
  };
  let income = 0, vpnl = 0;
  const book = (who: number, usd: number) => {
    income += usd * fee * 0.8; // Percolator fee; depositors keep 80% (see simulator.ts)
    if (who < 0) f.volume.crowd += usd; else { f.volume.copy += usd; f.volume.leaders[who] += usd; }
  };

  for (let i = 0; i < steps; i++) {
    // The vault's position moves with the price.
    if (i > 0) for (let k = 0; k < S; k++) vpnl += vault[k] * (px[k][i] - px[k][i - 1]);
    // Holding fee, by the minute: the side the vault is against pays, more as the vault fills up.
    if (m.holdPerHour) {
      const rate = vault.map((v, k) => {
        const util = Math.abs(v) * px[k][i] / capUsd;
        return m.holdPerHour! / 60 * Math.min(1, Math.max(0, (util - holdFrom) / (1 - holdFrom)));
      });
      for (const p of open) {
        // The vault short (v < 0) means traders are long: longs pay.
        if (!rate[p.sym] || Math.sign(p.q) !== -Math.sign(vault[p.sym])) continue;
        const usd = Math.abs(p.q) * px[p.sym][i] * rate[p.sym];
        p.paid += usd;
        holdIn += usd;
        if (p.who === -1) f.holdPaid.crowd += usd; else if (p.who === -2) f.holdPaid.holders += usd; else f.holdPaid.copy += usd;
      }
    }

    // Closes due now (always filled: closing never needs room).
    for (let j = open.length - 1; j >= 0; j--) {
      const p = open[j];
      if (p.closeAt > i) continue;
      const pnl = p.q * (px[p.sym][i] - p.open);
      if (p.who < 0) { f.traderPnl.crowd += pnl; if (p.who === -2) f.holdersPnl += pnl; }
      else {
        f.traderPnl.leaders[p.who] += pnl;
        // Profit share: on the copiers' running result after every fee, new highs only.
        copierNet[p.who] += pnl - Math.abs(p.q) * (p.open + px[p.sym][i]) * fee - p.paid;
        if (m.profitShare && copierNet[p.who] > copierHigh[p.who]) {
          const cut = (copierNet[p.who] - copierHigh[p.who]) * m.profitShare;
          shareAll += cut;
          shareIn += cut * (m.shareToDepositors ?? 0.4);
        }
        copierHigh[p.who] = Math.max(copierHigh[p.who], copierNet[p.who]);
        copy[p.sym][p.who] += p.q;
        f.copyEvents.push({ i, leader: p.who, sym: p.sym, kind: "close", q: -p.q, px: px[p.sym][i] });
      }
      vault[p.sym] += p.q;
      book(p.who, Math.abs(p.q) * px[p.sym][i]);
      open.splice(j, 1);
    }
    // Opens: up to the vault's limit, the rest refused.
    const fillOpen = (sym: number, wantQ: number, who: number, closeAt: number) => {
      const p = px[sym][i], cap = capUsd / p;
      // A buy of q leaves the vault q shorter; it may go no further than the cap on that side.
      const s = Math.sign(wantQ), room = Math.max(0, cap + s * vault[sym]);
      const q = s * Math.min(Math.abs(wantQ), room);
      f.refusedUsd += Math.abs(wantQ - q) * p;
      if (Math.abs(q) * p < 10) return null;
      const before = Math.abs(vault[sym]);
      vault[sym] -= q;
      if (Math.abs(vault[sym]) > before) f.maxAfterOpenUsd = Math.max(f.maxAfterOpenUsd, Math.abs(vault[sym]) * p);
      // Side fee on the part that made the vault's position bigger.
      const extra = Math.max(0, Math.abs(vault[sym]) - before) * p * sideFee;
      sideIn += extra;
      if (who >= 0) {
        copy[sym][who] -= q;
        f.copyEvents.push({ i, leader: who, sym, kind: "open", q, px: p });
      }
      book(who, Math.abs(q) * p);
      const pos = { sym, q, open: p, who, closeAt, paid: extra };
      open.push(pos);
      return pos;
    };

    // The crowd (and the holders, drawn after it so the crowd's trades stay the same).
    for (const [g, who] of groups) for (let k = 0; k < S; k++) {
      if (rand() >= g.opensPerMin) continue;
      const usd = Math.min(15_000, g.medianUsd * Math.exp(0.8 * gauss()));
      const hold = Math.max(2, Math.round(-g.holdMin * Math.log(1 - rand())));
      const dir = rand() < (g.longShare ?? 0.5) ? 1 : -1;
      if (fillOpen(k, dir * usd / px[k][i], who, Math.min(steps - 1, i + hold))) f.trades.crowd++;
    }

    // Leaders decide (on their own venue); their copiers fill here one minute later.
    for (let l = 0; l < L; l++) {
      if (leaderBusyUntil[l] > i || rand() >= 1 / 240) continue;
      const sym = Math.floor(rand() * S);
      const hold = Math.max(15, Math.round(-240 * Math.log(1 - rand())));
      const at = i + 1, closeAt = Math.min(steps - 1, at + hold + 1);
      if (closeAt - at < 10) continue;
      // Skill: the chance of being on the side the price goes to between their fills.
      const up = px[sym][closeAt] >= px[sym][at];
      const right = rand() < s.leaders[l].skill;
      pending.push({ at, sym, dir: (up === right) ? 1 : -1, leader: l, closeAt });
      leaderBusyUntil[l] = closeAt + 1;
    }
    for (let j = pending.length - 1; j >= 0; j--) {
      const p = pending[j];
      if (p.at !== i) continue;
      pending.splice(j, 1);
      const pos = fillOpen(p.sym, p.dir * s.leaders[p.leader].copyUsd / px[p.sym][i], p.leader, p.closeAt);
      if (pos) {
        f.trades.leaders[p.leader]++;
        // The record counts what copiers made after both fees, known at the close.
        closingRecords.push({ at: p.closeAt, leader: p.leader, pos });
      }
    }
    for (let j = closingRecords.length - 1; j >= 0; j--) {
      const c = closingRecords[j];
      if (c.at !== i) continue;
      closingRecords.splice(j, 1);
      const p = c.pos;
      record[c.leader].push(p.q * (px[p.sym][i] - p.open) - Math.abs(p.q) * (p.open + px[p.sym][i]) * fee);
    }

    f.vaultQ.push(Float64Array.from(vault));
    f.copyQ.push(copy.map(row => Float64Array.from(row)));
    f.winning.push(Uint8Array.from(s.leaders.map((_, l) => (isWinning(l) ? 1 : 0))));
    f.feeIncome[i] = income;
    f.vaultPnl[i] = vpnl;
    f.hold[i] = holdIn;
    f.side[i] = sideIn;
    f.share[i] = shareIn;
  }
  f.shareTotal = { all: shareAll, depositors: shareIn };
  return f;
}

export type RunResult = {
  strategy: Strategy;
  /** Depositors' result over the period, and per hour (for charts). */
  depositorsUsd: number;
  hourly: number[];
  feeIncomeUsd: number;
  vaultPnlUsd: number;
  hedgePnlUsd: number;
  hedgeFeesUsd: number;
  hedgeSpreadUsd: number;
  hedgeFundingUsd: number;
  operatorPayUsd: number;
  hedgeOrders: number;
  /** Largest drop from a high, in dollars, and the spread of daily results. */
  maxDrawdownUsd: number;
  dailyStdUsd: number;
  worstDayUsd: number;
  /** Biggest net position the vaults kept unhedged, in dollars. */
  maxOpenUsd: number;
  ledgerMatchesVenue: boolean;
  liquidations: number;
  /** Dollars the hedge traded on the venue, and its fills (time, symbol, + = bought, price, fee). */
  hedgeVolumeUsd: number;
  hedgeFills: { t: number; sym: string; usd: number; px: number; fee: number }[];
};

export type HedgeOptions = {
  /** Outside venue: taker fee and full spread, in basis points; the hedge account's money. */
  venueFeeBps?: number;
  venueSpreadBps?: number;
  hedgeEquityUsd?: number;
  bandUsd?: number;
  /** Share of the hedge operator's pay out of the depositors' fee income. */
  operatorFeeBps?: number;
};

const e6 = (x: number) => BigInt(Math.round(x * 1e6));

export async function runStrategy(markets: Market[], flow: Flow, strategy: Strategy, o: HedgeOptions = {}): Promise<RunResult> {
  const S = markets.length, syms = markets.map(m => m.coin);
  const hedging = strategy !== "none";
  const config = defaultConfig(syms);
  config.maxGrossE6 = 400_000n * USD;
  config.marginRateBps = 1_000;
  config.operatorFeeBps = o.operatorFeeBps ?? 2_000;
  for (const sym of syms) Object.assign(config.symbols[sym], {
    bandE6: e6(o.bandUsd ?? 1_500), maxHedgeE6: 150_000n * USD, maxOrderE6: 40_000n * USD,
    minOrderGapMs: 20_000, maxUnhedgedE6: 40_000n * USD, maxBasisBps: 100,
  });
  const lots: Record<string, bigint> = { BTC: 100n, ETH: 1_000n, SOL: 10_000n };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hedge-demo-"));
  const equity0 = e6(o.hedgeEquityUsd ?? 60_000);
  const w = hedging ? new World(config, {
    equityE6: equity0, feeBps: o.venueFeeBps ?? 5, spreadBps: o.venueSpreadBps ?? 1, marginRateBps: 500,
    meta: Object.fromEntries(syms.map(s => [s, { lotQ: lots[s] ?? 10_000n, minNotionalE6: 10n * USD, tickE6: 1n }])),
  }, dir) : null;

  const fundingAt = markets.map(m => new Map(m.funding.map(([t, r]) => [Math.floor(t / 3_600_000), r])));
  const hourly: number[] = [];
  let maxOpen = 0;
  const L = flow.copyQ[0][0].length;
  const target = (i: number, k: number) => {
    if (strategy === "all") return flow.vaultQ[i][k];
    let q = 0;
    for (let l = 0; l < L; l++) if (strategy === "copy" || flow.winning[i][l]) q += flow.copyQ[i][k][l];
    return q;
  };

  for (let i = 0; i < flow.steps; i++) {
    if (w) {
      w.clock.t = flow.t[i];
      w.source.slot += 150;
      for (let k = 0; k < S; k++) {
        const p = e6(flow.px[k][i]);
        w.source.vaults.set(syms[k], { positionQ: BigInt(Math.round(target(i, k) * 1e6)), priceE6: p });
        w.venue.setMid(syms[k], p);
        // Hourly funding, at the real rate of that hour (longs pay a positive rate).
        if (flow.t[i] % 3_600_000 === 0) {
          const r = fundingAt[k].get(flow.t[i] / 3_600_000);
          if (r !== undefined) w.venue.fund(syms[k], BigInt(Math.round(r * 1e9)));
        }
      }
      await w.tick();
    }
    let open = 0;
    for (let k = 0; k < S; k++) {
      const hedgeQ = w ? Number(w.venue.position(syms[k])) / 1e6 : 0;
      open += Math.abs((flow.vaultQ[i][k] + hedgeQ) * flow.px[k][i]);
    }
    maxOpen = Math.max(maxOpen, open);
    if (i % 60 === 59 || i === flow.steps - 1) {
      const hedgePnl = w ? Number(w.venue.equity() - equity0) / 1e6 : 0;
      const op = hedging ? flow.feeIncome[i] * config.operatorFeeBps / 10_000 : 0;
      hourly.push(flow.feeIncome[i] + flow.vaultPnl[i] + hedgePnl - op);
    }
  }

  const fills = w ? await w.venue.fills(null) : [];
  const hedgeFills = fills.map(x => {
    const px = Number(x.priceE6) / 1e6, usd = Number(x.sizeQ) / 1e6 * px;
    return { t: x.atMs, sym: x.symbol, usd: x.side === "buy" ? usd : -usd, px, fee: Number(x.feeE6) / 1e6 };
  });
  const last = flow.steps - 1;
  const hedgePnl = w ? Number(w.venue.equity() - equity0) / 1e6 : 0;
  const operatorPay = hedging ? flow.feeIncome[last] * config.operatorFeeBps / 10_000 : 0;
  let peak = 0, dd = 0;
  for (const v of hourly) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  const days: number[] = [];
  for (let h = 23; h < hourly.length; h += 24) days.push(hourly[h] - (h >= 24 ? hourly[h - 24] : 0));
  const mean = days.reduce((a, x) => a + x, 0) / (days.length || 1);
  const r: RunResult = {
    strategy,
    depositorsUsd: flow.feeIncome[last] + flow.vaultPnl[last] + hedgePnl - operatorPay,
    hourly,
    feeIncomeUsd: flow.feeIncome[last],
    vaultPnlUsd: flow.vaultPnl[last],
    hedgePnlUsd: hedgePnl,
    hedgeFeesUsd: w ? Number(w.venue.feesE6) / 1e6 : 0,
    hedgeSpreadUsd: w ? Number(w.venue.spreadCostE6) / 1e6 : 0,
    hedgeFundingUsd: w ? Number(w.venue.fundingE6) / 1e6 : 0,
    operatorPayUsd: operatorPay,
    hedgeOrders: w ? w.venue.received : 0,
    maxDrawdownUsd: dd,
    dailyStdUsd: Math.sqrt(days.reduce((a, x) => a + (x - mean) ** 2, 0) / (days.length || 1)),
    worstDayUsd: Math.min(...days),
    maxOpenUsd: maxOpen,
    ledgerMatchesVenue: w ? syms.every(s => w.journal.ledger.position(s) === w.venue.position(s)) : true,
    liquidations: w ? w.venue.liquidations : 0,
    hedgeVolumeUsd: hedgeFills.reduce((a, x) => a + Math.abs(x.usd), 0),
    hedgeFills,
  };
  w?.journal.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

export function loadMarkets(dataDir: string): Market[] {
  return SYMBOLS.map(coin => {
    const j = JSON.parse(fs.readFileSync(path.join(dataDir, `${coin}.json`), "utf8"));
    return { coin, candles: j.candles, funding: j.funding };
  });
}
