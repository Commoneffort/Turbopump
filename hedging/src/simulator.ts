// HedgeSimulator: runs the real engine, policy, journal and reconciliation against a simulated
// vault and the mock venue, on a simulated clock, and measures what the hedge did.
//
// Each step: the price moves, traders trade against the vault, the venue's price follows, and
// the engine gets one pass. A scenario can also break things (venue faults, failed reads, a crash
// between any two journal writes) to show the hedge stays correct through them.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config, defaultConfig } from "./config";
import { HedgeEngine, TickReport } from "./engine";
import { ChainRead, ExposureMonitor, ExposureSource } from "./exposure";
import { Journal } from "./journal";
import { Faults, MockOptions, MockVenue } from "./mock-venue";
import { Clock, UNIT, USD, abs } from "./units";
import { HedgeVenue } from "./venue";

export class SimClock implements Clock {
  t = 1_700_000_000_000;
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
}

/** The vaults, as the simulation sets them. */
export class SimSource implements ExposureSource {
  slot = 1;
  /** Reads fail. */
  fail = false;
  /** Reads succeed but the chain is not followed any more. */
  stuck = false;
  vaults = new Map<string, { positionQ: bigint; trackedQ?: bigint; priceE6: bigint }>();
  constructor(private clock: Clock) {}
  async read(): Promise<ChainRead> {
    if (this.fail) throw new Error("429 Too Many Requests");
    if (this.stuck && this.frozen) return { ...this.frozen, readAtMs: this.clock.now() };
    return this.frozen = {
      slot: this.slot, readAtMs: this.clock.now(),
      vaults: [...this.vaults].map(([symbol, v]) => ({
        vault: `vault-${symbol}`, symbol, status: 1, positionQ: v.positionQ, trackedQ: v.trackedQ ?? v.positionQ,
        priceE6: v.priceE6, navE6: 0n, needsFlat: false, closeOnly: false,
      })),
    };
  }
  private frozen?: ChainRead;
}

class Crash extends Error {}

/** Everything a simulation runs: the pieces a real deployment has, wired the same way. */
export class World {
  readonly clock = new SimClock();
  readonly source = new SimSource(this.clock);
  readonly venue: MockVenue;
  /** What the engine trades through: the mock itself, or an adapter in front of it. */
  hedgeVenue: HedgeVenue;
  journal!: Journal;
  engine!: HedgeEngine;
  restarts = 0;
  /** The process dies at the next journal write: before it reaches the disk, or right after. */
  crashAt: "before" | "after" | null = null;
  /** Journal writes so far, and the write (counted from 1) at which the process dies. */
  writes = 0;
  crashOnWrite?: { n: number; when: "before" | "after" };

  constructor(readonly config: Config, venue: MockOptions, readonly dir: string, on = true, private wrap?: (mock: MockVenue, clock: Clock) => HedgeVenue) {
    this.venue = new MockVenue(this.clock, venue);
    this.hedgeVenue = wrap ? wrap(this.venue, this.clock) : this.venue;
    this.start();
    // A new journal starts with hedging off; simulations switch it on.
    if (on) this.journal.append({ type: "switch", scope: "*", on: true, by: "simulator" });
  }
  private start() {
    this.journal = Journal.open(this.dir, this.hedgeVenue.name, this.clock, {
      fsync: false,
      hook: (_, when) => {
        if (when === "before") this.writes++;
        if (this.crashAt === when || (this.crashOnWrite?.n === this.writes && this.crashOnWrite.when === when)) {
          this.crashAt = null;
          this.crashOnWrite = undefined;
          throw new Crash("crash");
        }
      },
    });
    this.engine = new HedgeEngine({ config: this.config, journal: this.journal, venue: this.hedgeVenue, monitor: new ExposureMonitor(this.source), clock: this.clock });
  }
  /** A new process on the same journal: nothing but the journal survives. */
  restart() {
    this.journal.close();
    this.restarts++;
    // An adapter is part of the process: what it remembered is gone too.
    if (this.wrap) this.hedgeVenue = this.wrap(this.venue, this.clock);
    this.start();
  }
  /** One engine pass; null if the process "crashed" during it (it is restarted). */
  async tick(): Promise<TickReport | null> {
    try {
      return await this.engine.tick();
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
      this.restart();
      return null;
    }
  }
  /** Moves the price and the vault's position, as a trade or a mark would. */
  set(symbol: string, priceE6: bigint, positionQ: bigint, venueMidE6 = priceE6) {
    this.source.vaults.set(symbol, { positionQ, priceE6 });
    this.source.slot += 25;
    this.venue.setMid(symbol, venueMidE6);
  }
  /** Passes until the hedge stops moving (or `max` passes). */
  async settle(stepMs = 30_000, max = 50) {
    for (let i = 0; i < max; i++) {
      this.clock.advance(stepMs);
      this.source.slot += 25;
      for (const [s, v] of this.source.vaults) this.venue.setMid(s, v.priceE6);
      const r = await this.tick();
      if (r && !r.venueError && r.symbols.every(s => s.decision.action === "hold" && !/unresolved|waiting/.test(s.decision.reason))) return r;
    }
    return null;
  }
}

export const mockDefaults: MockOptions = { equityE6: 50_000n * USD, feeBps: 5, spreadBps: 2, marginRateBps: 1_000 };

export type Scenario = {
  name: string;
  about: string;
  seed: number;
  steps: number;
  stepMs: number;
  symbols?: string[];
  startPrice?: number;
  /** Price volatility per step, and drift per step, in basis points. */
  volBps: number;
  driftBps?: number;
  /** A trend: the price drifts this much per step, up or down, and changes direction on
   *  average every `trendSteps` steps (200 when absent). */
  trendBps?: number;
  trendSteps?: number;
  /** Traders: chance of a trade each step, its largest size, the vault's position cap, how often
   *  they trade with the current trend (0.5 = no better than chance; above it they are right
   *  more often than wrong, and the vault pays), and the trading fee they pay (Percolator's base
   *  fee, 5 bps on the devnet market). */
  flow: { tradeProb: number; maxTradeUsd: number; maxInventoryUsd: number; skill?: number; feeBps?: number };
  /** Noise in the venue's price around Percolator's. */
  basisBps?: number;
  fundingPpmPerHour?: number;
  venue?: Partial<MockOptions>;
  /** Chance per order of each venue fault, per step of a failed read, and per step of a crash. */
  chaos?: { drop?: number; loseReply?: number; delay?: number; reject?: number; hideFills?: number; readFail?: number; crash?: number };
  tune?: (c: Config) => void;
  /** Price jumps: step -> multiplier applied to that step's price. */
  shocks?: Record<number, number>;
  /** Steps at which the vault's position is closed (an unwind). */
  unwinds?: number[];
  /** Other things done at given steps. */
  events?: Record<number, (w: World) => void>;
  /** Passes with no price move or trades after the last step, to let the hedge settle. */
  cooldownSteps?: number;
};

export type SimResult = {
  name: string;
  steps: number;
  /** Orders the venue received, and orders the engine journaled. */
  orders: number;
  intents: number;
  feesE6: bigint;
  fundingE6: bigint;
  /** What the hedge cost to run: venue fees, the spread paid on fills, and funding. */
  hedgeCostE6: bigint;
  /** What traders traded, the fees they paid, and where those fees end up. Percolator charges
   *  the fee to both sides of a trade, into the market's insurance; the vault harvests it, 10%
   *  goes to whoever opened the market, and the vault's own half was its to begin with. So of a
   *  fee `f` the depositors net 0.8 f and the opener gets 0.2 f. The vault earns no spread:
   *  every trade settles at the mark. */
  volumeE6: bigint;
  traderFeesE6: bigint;
  depositorIncomeE6: bigint;
  openerIncomeE6: bigint;
  /** The hedge operator's pay: `operatorFeeBps` of the depositors' fee income. */
  operatorFeeE6: bigint;
  /** What depositors end with: fee income plus the vault's position result, with no hedge; and
   *  with the hedge, plus all of the hedge's result, less the operator's pay. */
  depositorsUnhedgedE6: bigint;
  depositorsHedgedE6: bigint;
  /** What the vault's position made from price moves alone, what the hedge account made (after
   *  fees, spread and funding), and their sum. */
  vaultPnlE6: bigint;
  hedgePnlE6: bigint;
  netPnlE6: bigint;
  /** Standard deviation of the per-step profit, in dollars, without and with the hedge. */
  volUnhedged: number;
  volHedged: number;
  /** Share of that risk the hedge removed (1 = all of it). */
  riskRemoved: number;
  maxResidualE6: bigint;
  meanResidualE6: bigint;
  /** Share of steps that ended with the hedge outside its band. */
  outsideBandShare: number;
  /** The residual after the cooldown, per symbol. */
  finalResidualE6: Record<string, bigint>;
  halts: [string, string][];
  /** Orders the venue refused. */
  rejected: number;
  holds: Record<string, number>;
  restarts: number;
  /** The ledger's positions equal the venue's at the end. */
  ledgerMatchesVenue: boolean;
  /** Share of passes the hedge as a whole spent in each state (see state.ts). */
  states: Record<string, number>;
  /** Times the venue closed the hedge account's positions for lack of margin. */
  liquidations: number;
  /** The closest the hedge account came to that, in basis points of price. */
  minLiqDistanceBps?: number;
  /** Equity at the end that the ledger's fills, fees and funding do not explain. */
  unexplainedE6?: bigint;
};

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const e6 = (x: number) => BigInt(Math.round(x * 1e6));
const std = (xs: number[]) => {
  const m = xs.reduce((a, x) => a + x, 0) / (xs.length || 1);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length || 1));
};

export async function simulate(s: Scenario, dir?: string, wrap?: (mock: MockVenue, clock: Clock) => HedgeVenue): Promise<SimResult> {
  const symbols = s.symbols ?? ["SOL"];
  const config = defaultConfig(symbols);
  s.tune?.(config);
  const tmp = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "hedge-sim-"));
  const w = new World(config, { ...mockDefaults, ...s.venue }, tmp, true, wrap);
  const rand = rng(s.seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const c = s.chaos ?? {};
  if (c.drop || c.loseReply || c.delay || c.reject || c.hideFills) {
    w.venue.chaos = (): Faults => {
      const r = rand();
      let at = 0;
      const hit = (p = 0) => r >= at && r < (at += p);
      if (hit(c.drop)) return { drop: true };
      if (hit(c.loseReply)) return { loseReply: true };
      if (hit(c.delay)) return { delayMs: s.stepMs * 2 };
      if (hit(c.reject)) return { reject: "rate limited" };
      if (hit(c.hideFills)) return { hideFillsMs: s.stepMs * 2 };
      return {};
    };
  }

  const state = new Map(symbols.map(sym => [sym, { px: s.startPrice ?? 150, pos: 0n, trend: 1 }]));
  let volume = 0n;
  const equity0 = (s.venue?.equityE6 ?? mockDefaults.equityE6);
  let vaultPnl = 0n, prevTotal = 0n, maxResidual = 0n, sumResidual = 0n, outside = 0, counted = 0;
  const unhedged: number[] = [], hedged: number[] = [];
  const holds: Record<string, number> = {};
  const states: Record<string, number> = {};
  let passes = 0, minLiq: number | undefined, unexplained: bigint | undefined;
  const residuals = () => symbols.map(sym => {
    const st = state.get(sym)!;
    const q = st.pos * BigInt(config.symbols[sym].hedgeRatioBps) / 10_000n + w.venue.position(sym);
    return { sym, e6: q * e6(st.px) / UNIT };
  });

  const total = s.steps + (s.cooldownSteps ?? 30);
  for (let t = 0; t < total; t++) {
    const live = t < s.steps;
    w.clock.advance(s.stepMs);
    w.source.slot += Math.round(s.stepMs / 400);
    let stepVault = 0n;
    for (const sym of symbols) {
      const st = state.get(sym)!;
      if (live) {
        if (rand() < 1 / (s.trendSteps ?? 200)) st.trend = -st.trend;
        const drift = (s.driftBps ?? 0) + st.trend * (s.trendBps ?? 0);
        const next = st.px * (1 + (s.volBps * gauss() + drift) / 10_000) * (s.shocks?.[t] ?? 1);
        stepVault += st.pos * (e6(next) - e6(st.px)) / UNIT;
        st.px = next;
        if (rand() < s.flow.tradeProb) {
          // A trader's buy leaves the vault shorter. The vault fills only up to its position cap.
          const buys = (rand() < (s.flow.skill ?? 0.5)) === (st.trend > 0);
          const size = e6(rand() * s.flow.maxTradeUsd / st.px);
          const cap = e6(s.flow.maxInventoryUsd / st.px);
          const want = st.pos + (buys ? -size : size);
          const pos = want > cap ? cap : want < -cap ? -cap : want;
          volume += abs(pos - st.pos) * e6(st.px) / UNIT;
          st.pos = pos;
        }
        if (s.unwinds?.includes(t)) st.pos = 0n;
      }
      w.source.vaults.set(sym, { positionQ: st.pos, priceE6: e6(st.px) });
      w.venue.setMid(sym, e6(st.px * (1 + (s.basisBps ?? 0) * gauss() / 10_000)));
      if (s.fundingPpmPerHour) w.venue.fund(sym, BigInt(Math.round(s.fundingPpmPerHour * 1000 * s.stepMs / 3_600_000)));
    }
    vaultPnl += stepVault;
    s.events?.[t]?.(w);
    if (c.readFail) w.source.fail = rand() < c.readFail;
    if (c.crash && rand() < c.crash) w.crashAt = rand() < 0.5 ? "before" : "after";

    const r = await w.tick();
    if (r) {
      passes++;
      states[r.state] = (states[r.state] ?? 0) + 1;
      const d = r.risk.account?.liqDistanceBps;
      if (d !== undefined && (minLiq === undefined || d < minLiq)) minLiq = d;
      unexplained = r.risk.account?.unexplainedE6 ?? unexplained;
    }
    for (const row of r?.symbols ?? []) {
      if (row.decision.action !== "hold") continue;
      const why = row.decision.reason.replace(/0x[0-9a-f]+/, "…").replace(/-?\d+\.\d%/, "…%");
      holds[why] = (holds[why] ?? 0) + 1;
    }
    if (!live) continue;
    const now = vaultPnl + w.venue.equity() - equity0;
    unhedged.push(Number(stepVault) / 1e6);
    hedged.push(Number(now - prevTotal) / 1e6);
    prevTotal = now;
    for (const { sym, e6: res } of residuals()) {
      const a = abs(res);
      if (a > maxResidual) maxResidual = a;
      sumResidual += a;
      counted++;
      if (a >= config.symbols[sym].bandE6) outside++;
    }
  }

  const L = w.journal.ledger;
  const traderFees = volume * BigInt(s.flow.feeBps ?? 5) / 10_000n;
  const hedgePnl = w.venue.equity() - equity0;
  const income = traderFees * 8n / 10n, operatorFee = income * BigInt(config.operatorFeeBps) / 10_000n;
  const vu = std(unhedged), vh = std(hedged);
  const result: SimResult = {
    name: s.name, steps: s.steps, orders: w.venue.received, intents: L.intents.size,
    feesE6: w.venue.feesE6, fundingE6: w.venue.fundingE6,
    hedgeCostE6: w.venue.feesE6 + w.venue.spreadCostE6 + w.venue.fundingE6,
    volumeE6: volume, traderFeesE6: traderFees, depositorIncomeE6: income, openerIncomeE6: traderFees * 2n / 10n,
    operatorFeeE6: operatorFee, depositorsUnhedgedE6: income + vaultPnl, depositorsHedgedE6: income + vaultPnl + hedgePnl - operatorFee,
    vaultPnlE6: vaultPnl, hedgePnlE6: hedgePnl, netPnlE6: vaultPnl + hedgePnl,
    volUnhedged: vu, volHedged: vh, riskRemoved: vu > 0 ? 1 - vh / vu : 0,
    maxResidualE6: maxResidual, meanResidualE6: counted ? sumResidual / BigInt(counted) : 0n,
    outsideBandShare: counted ? outside / counted : 0,
    finalResidualE6: Object.fromEntries(residuals().map(r => [r.sym, r.e6])),
    halts: [...L.halts], rejected: [...L.intents.values()].filter(i => i.status === "rejected").length, holds, restarts: w.restarts,
    ledgerMatchesVenue: symbols.every(sym => L.position(sym) === w.venue.position(sym)),
    states: Object.fromEntries(Object.entries(states).map(([k, n]) => [k, n / passes])),
    liquidations: w.venue.liquidations, minLiqDistanceBps: minLiq, unexplainedE6: unexplained,
  };
  w.journal.close();
  if (!dir) fs.rmSync(tmp, { recursive: true, force: true });
  return result;
}

const flow = { tradeProb: 0.4, maxTradeUsd: 4_000, maxInventoryUsd: 30_000 };
const base = { seed: 7, steps: 2_000, stepMs: 10_000, volBps: 12, flow };

/** The scenarios `npm run sim` reports and the tests assert on. */
export const scenarios: Scenario[] = [
  { ...base, name: "calm", about: "random trades, ordinary volatility" },
  { ...base, name: "adverse", about: "the price trends, and traders are on the right side of it 65% of the time", trendBps: 1.5, flow: { ...flow, skill: 0.65 } },
  { ...base, name: "two-symbols", about: "two vaults, both hedged", symbols: ["SOL", "BTC"] },
  { ...base, name: "gross-limit", about: "two vaults, and a limit on the total hedge that is too small for both", symbols: ["SOL", "BTC"], tune: c => { c.maxGrossE6 = 30_000n * USD; } },
  { ...base, name: "costly", about: "wide spread, noisy venue price, funding against the hedge", venue: { spreadBps: 10 }, basisBps: 2, fundingPpmPerHour: 50 },
  { ...base, name: "gap", about: "price drops 12% in one step, then the vault is unwound to flat",
    shocks: { 900: 0.88 }, unwinds: [1300] },
  { ...base, name: "thin-margin", about: "the hedge account is too small for the vault's position", venue: { equityE6: 1_500n * USD } },
  { ...base, name: "half-hedge", about: "hedge ratio 50%", tune: c => { c.symbols.SOL.hedgeRatioBps = 5_000; } },
  { ...base, name: "venue-outage", about: "the venue is unreachable for 200 steps",
    events: { 600: w => { w.venue.faults.down = true; }, 800: w => { w.venue.faults.down = false; } } },
  { ...base, name: "chain-outage", about: "vault reads fail for 200 steps",
    events: { 600: w => { w.source.fail = true; }, 800: w => { w.source.fail = false; } } },
  { ...base, name: "refused", about: "the venue refuses every order for 300 steps",
    events: { 600: w => { w.venue.faults.reject = "rate limited"; }, 900: w => { w.venue.faults.reject = undefined; } } },
  { ...base, name: "squeeze", about: "a small hedge account, a strong trend, and traders on the wrong side of it: the vault gains and the hedge loses",
    venue: { equityE6: 3_000n * USD }, trendBps: 4, trendSteps: 500, flow: { ...flow, skill: 0.3 } },
  { ...base, name: "chaos", about: "lost replies, dropped and late orders, rejects, late fills, failed reads, crashes",
    chaos: { drop: 0.08, loseReply: 0.08, delay: 0.06, reject: 0.06, hideFills: 0.06, readFail: 0.05, crash: 0.03 } },
];
