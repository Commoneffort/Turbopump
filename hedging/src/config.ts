// Risk limits. Every limit can only make the hedge smaller or slower than the policy would
// otherwise choose; none can make it larger than the vault's position.
import * as fs from "fs";
import { USD } from "./units";

export type SymbolConfig = {
  /** The venue's name for the market that hedges this Percolator symbol. */
  venueSymbol: string;
  /** Share of the vault's position to offset, in basis points (10_000 = all of it). */
  hedgeRatioBps: number;
  /** No order while the hedge is within this many dollars (e6) of its target. */
  bandE6: bigint;
  /** Largest hedge position, in dollars (e6). */
  maxHedgeE6: bigint;
  /** Largest single order, in dollars (e6). */
  maxOrderE6: bigint;
  /** Shortest time between two orders on this symbol. */
  minOrderGapMs: number;
  /** How far from the venue's mid price an order may fill. */
  maxSlippageBps: number;
  /** No order while the venue's mid price is further than this from Percolator's price. */
  maxBasisBps: number;
  /** The most the hedge may leave open, in dollars (e6). The hedger cannot enforce it (it has no
   *  say over the vault): past it the symbol is reported as degraded, and as an emergency once it
   *  has lasted `unhedgedAlarmMs`. */
  maxUnhedgedE6: bigint;
};

export type Config = {
  symbols: Record<string, SymbolConfig>;
  /** Largest sum of all hedge positions, in dollars (e6). */
  maxGrossE6: bigint;
  maxOrdersPerHour: number;
  /** A vault reading older than this is not acted on. */
  maxExposureAgeMs: number;
  /** A venue quote older than this is not acted on. */
  maxQuoteAgeMs: number;
  /** Margin the venue needs for new exposure, per dollar of it, in basis points. */
  marginRateBps: number;
  /** Free margin that orders never use. */
  marginReserveE6: bigint;
  /** An order the venue has never heard of is given up on after this long. */
  lostAfterMs: number;
  /** Report a symbol whose hedge has been outside its band for this long. */
  unhedgedAlarmMs: number;
  /** How far every hedged price can move against the hedge account before the venue closes it,
   *  in basis points. Below `minLiqDistanceBps` the hedge may only shrink. Below
   *  `deleverageLiqDistanceBps` the hedges are cut, all by the same share, until the distance is
   *  back at `minLiqDistanceBps` (0 never cuts). */
  minLiqDistanceBps: number;
  deleverageLiqDistanceBps: number;
  /** After this many orders in a row that traded nothing, the symbol is reported as failed. Each
   *  such order doubles the wait before the next, up to `maxBackoffMs`. */
  maxFailures: number;
  maxBackoffMs: number;
  /** The price move the risk report prices what is left open at, in basis points. */
  stressBps: number;
  /** The account's value may differ from what the ledger explains by this much before it is
   *  reported. */
  maxUnexplainedE6: bigint;
  /** The terms of the hedge. All of its result, gains and costs, is the depositors'. Whoever
   *  runs and funds it is paid this share of the depositors' fee income, in basis points. The
   *  engine does not move this money; the simulator and reports account for it. */
  operatorFeeBps: number;
};

const dollars = (n: number) => BigInt(Math.round(n * 1e6));

export const symbolDefaults = (venueSymbol: string): SymbolConfig => ({
  venueSymbol,
  hedgeRatioBps: 10_000,
  bandE6: 250n * USD,
  maxHedgeE6: 50_000n * USD,
  maxOrderE6: 10_000n * USD,
  minOrderGapMs: 20_000,
  maxSlippageBps: 30,
  maxBasisBps: 100,
  maxUnhedgedE6: 10_000n * USD,
});

export const defaultConfig = (symbols: string[]): Config => ({
  symbols: Object.fromEntries(symbols.map(s => [s, symbolDefaults(s)])),
  maxGrossE6: 100_000n * USD,
  maxOrdersPerHour: 600,
  maxExposureAgeMs: 60_000,
  maxQuoteAgeMs: 15_000,
  marginRateBps: 2_000,
  marginReserveE6: 500n * USD,
  lostAfterMs: 60_000,
  unhedgedAlarmMs: 300_000,
  minLiqDistanceBps: 1_000,
  deleverageLiqDistanceBps: 500,
  maxFailures: 3,
  maxBackoffMs: 600_000,
  stressBps: 1_000,
  maxUnexplainedE6: 25n * USD,
  operatorFeeBps: 2_000,
});

/** What is wrong with a configuration (empty when it is usable). */
export function problems(c: Config): string[] {
  const out: string[] = [];
  const positive = (name: string, v: number | bigint) => { if (!(v > 0)) out.push(`${name} must be positive`); };
  positive("maxGrossE6", c.maxGrossE6);
  positive("maxOrdersPerHour", c.maxOrdersPerHour);
  positive("maxExposureAgeMs", c.maxExposureAgeMs);
  positive("maxQuoteAgeMs", c.maxQuoteAgeMs);
  positive("marginRateBps", c.marginRateBps);
  positive("lostAfterMs", c.lostAfterMs);
  if (c.marginReserveE6 < 0n) out.push("marginReserveE6 must not be negative");
  positive("minLiqDistanceBps", c.minLiqDistanceBps);
  if (!(c.deleverageLiqDistanceBps >= 0 && c.deleverageLiqDistanceBps < c.minLiqDistanceBps)) out.push("deleverageLiqDistanceBps must be 0 or more, and below minLiqDistanceBps");
  positive("maxFailures", c.maxFailures);
  positive("maxBackoffMs", c.maxBackoffMs);
  positive("stressBps", c.stressBps);
  if (c.maxUnexplainedE6 < 0n) out.push("maxUnexplainedE6 must not be negative");
  if (!(c.operatorFeeBps >= 0 && c.operatorFeeBps <= 10_000)) out.push("operatorFeeBps must be 0..10000");
  const venues = new Set<string>();
  for (const [s, v] of Object.entries(c.symbols)) {
    if (!Number.isInteger(v.hedgeRatioBps) || v.hedgeRatioBps < 0 || v.hedgeRatioBps > 10_000) out.push(`${s}: hedgeRatioBps must be 0..10000`);
    positive(`${s}: bandE6`, v.bandE6);
    positive(`${s}: maxHedgeE6`, v.maxHedgeE6);
    positive(`${s}: maxOrderE6`, v.maxOrderE6);
    if (v.maxOrderE6 < v.bandE6) out.push(`${s}: maxOrderE6 is below bandE6, so the hedge could never catch up in one order`);
    if (v.minOrderGapMs < 0) out.push(`${s}: minOrderGapMs must not be negative`);
    if (!(v.maxSlippageBps > 0 && v.maxSlippageBps < 10_000)) out.push(`${s}: maxSlippageBps must be 1..9999`);
    positive(`${s}: maxBasisBps`, v.maxBasisBps);
    if (v.maxUnhedgedE6 < v.bandE6) out.push(`${s}: maxUnhedgedE6 is below bandE6, which the hedge is allowed to leave open`);
    if (venues.has(v.venueSymbol)) out.push(`${s}: venue market ${v.venueSymbol} is used twice`);
    venues.add(v.venueSymbol);
  }
  return out;
}

/** Reads a configuration file. Amounts are in dollars and times in seconds there:
 *  { "symbols": { "SOL": { "venueSymbol": "SOL", "hedgeRatio": 1, "bandUsd": 250, ... } }, "maxGrossUsd": 100000, ... }
 *  Anything left out keeps its default. */
export function loadConfig(path: string): Config {
  const j = JSON.parse(fs.readFileSync(path, "utf8"));
  const c = defaultConfig([]);
  for (const [s, raw] of Object.entries<any>(j.symbols ?? {})) {
    const d = symbolDefaults(raw.venueSymbol ?? s);
    c.symbols[s] = {
      venueSymbol: d.venueSymbol,
      hedgeRatioBps: raw.hedgeRatio !== undefined ? Math.round(raw.hedgeRatio * 10_000) : d.hedgeRatioBps,
      bandE6: raw.bandUsd !== undefined ? dollars(raw.bandUsd) : d.bandE6,
      maxHedgeE6: raw.maxHedgeUsd !== undefined ? dollars(raw.maxHedgeUsd) : d.maxHedgeE6,
      maxOrderE6: raw.maxOrderUsd !== undefined ? dollars(raw.maxOrderUsd) : d.maxOrderE6,
      minOrderGapMs: raw.minOrderGapSecs !== undefined ? raw.minOrderGapSecs * 1000 : d.minOrderGapMs,
      maxSlippageBps: raw.maxSlippageBps ?? d.maxSlippageBps,
      maxBasisBps: raw.maxBasisBps ?? d.maxBasisBps,
      maxUnhedgedE6: raw.maxUnhedgedUsd !== undefined ? dollars(raw.maxUnhedgedUsd) : d.maxUnhedgedE6,
    };
    // A band set wider than the default limit, with no limit given: the limit follows the band.
    if (raw.maxUnhedgedUsd === undefined && c.symbols[s].maxUnhedgedE6 < c.symbols[s].bandE6 * 2n) c.symbols[s].maxUnhedgedE6 = c.symbols[s].bandE6 * 2n;
  }
  if (j.maxGrossUsd !== undefined) c.maxGrossE6 = dollars(j.maxGrossUsd);
  if (j.maxOrdersPerHour !== undefined) c.maxOrdersPerHour = j.maxOrdersPerHour;
  if (j.maxExposureAgeSecs !== undefined) c.maxExposureAgeMs = j.maxExposureAgeSecs * 1000;
  if (j.maxQuoteAgeSecs !== undefined) c.maxQuoteAgeMs = j.maxQuoteAgeSecs * 1000;
  if (j.marginRateBps !== undefined) c.marginRateBps = j.marginRateBps;
  if (j.marginReserveUsd !== undefined) c.marginReserveE6 = dollars(j.marginReserveUsd);
  if (j.lostAfterSecs !== undefined) c.lostAfterMs = j.lostAfterSecs * 1000;
  if (j.unhedgedAlarmSecs !== undefined) c.unhedgedAlarmMs = j.unhedgedAlarmSecs * 1000;
  if (j.operatorFeeBps !== undefined) c.operatorFeeBps = j.operatorFeeBps;
  if (j.minLiqDistanceBps !== undefined) c.minLiqDistanceBps = j.minLiqDistanceBps;
  if (j.deleverageLiqDistanceBps !== undefined) c.deleverageLiqDistanceBps = j.deleverageLiqDistanceBps;
  if (j.maxFailures !== undefined) c.maxFailures = j.maxFailures;
  if (j.maxBackoffSecs !== undefined) c.maxBackoffMs = j.maxBackoffSecs * 1000;
  if (j.stressBps !== undefined) c.stressBps = j.stressBps;
  if (j.maxUnexplainedUsd !== undefined) c.maxUnexplainedE6 = dollars(j.maxUnexplainedUsd);
  const bad = problems(c);
  if (bad.length) throw new Error(`bad configuration ${path}: ${bad.join("; ")}`);
  return c;
}
