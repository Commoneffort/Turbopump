// The risk model: how much risk the vault still carries after the hedge, and what state the hedge
// account is in. Pure functions of what the engine already knows: the vault reading, the ledger,
// the venue's account and prices. Nothing here sends an order or reads anything.
//
// Per symbol the chain is:
//
//   vault exposure  ->  target exposure  ->  required hedge  ->  hedge held  ->  residual
//   (what it holds)     (what it is meant    (the rest, on        (the venue      (what is open
//                        to keep)             the other side)      position)       beyond target)
//
// "Retained" is the vault's position plus the hedge: what a price move still lands on.
import { Config } from "./config";
import { Exposure } from "./exposure";
import { Ledger } from "./journal";
import { abs } from "./units";
import { Quote, VenueAccount } from "./venue";

export type SymbolRisk = {
  symbol: string;
  /** Percolator's price, or the venue's where the vault has none. 0 if neither is known. */
  priceE6: bigint;
  /** The vault's net position (positive = long). Undefined without a reading of the vault. */
  vaultQ?: bigint;
  vaultNotionalE6?: bigint;
  /** What the vault is meant to keep: its position less the share to be hedged. */
  targetExposureE6?: bigint;
  /** The hedge that would leave exactly the target exposure, before any limit. */
  requiredHedgeQ?: bigint;
  /** The hedge the policy aims for once the limits have cut it down (when it said). */
  limitedHedgeQ?: bigint;
  hedgeQ: bigint;
  hedgeNotionalE6: bigint;
  /** Share of the vault's position the hedge offsets, in basis points. */
  hedgeRatioBps?: number;
  /** Vault position plus hedge, in dollars (e6), signed like a position. */
  retainedE6?: bigint;
  /** Retained less the target exposure: what the hedge still owes. */
  residualE6?: bigint;
  maxUnhedgedE6: bigint;
  overLimit: boolean;
  /** What a move of `stressBps` against the retained position costs. */
  stressLossE6?: bigint;
  /** The venue's price against Percolator's, in basis points. */
  basisBps?: number;
  /** The hedge's result on this symbol: on the open position, on closed trades, and its costs.
   *  `slippageE6` is part of the first two, shown apart: what fills cost against the mid price. */
  unrealizedE6: bigint;
  realizedE6: bigint;
  feesE6: bigint;
  fundingE6: bigint;
  slippageE6: bigint;
  pnlE6: bigint;
  /** The price at which this hedge alone would use up the account's margin. */
  liqPriceE6?: bigint;
};

export type MarginMode = "ok" | "no_increase" | "deleverage";
export type MarginState = {
  grossE6: bigint;
  /** How far every hedged price can move against the account before the venue closes it, in
   *  basis points of the price. Undefined with no hedge open. */
  liqDistanceBps?: number;
  mode: MarginMode;
  /** While deleveraging: the share of each hedge to keep, in basis points. */
  keepBps?: number;
};

export type AccountRisk = VenueAccount & MarginState & {
  /** More hedge, in dollars (e6), that the policy would still open. */
  availableHedgeE6: bigint;
  /** Hedge held per dollar of equity, in basis points (10_000 = 1x). */
  leverageBps?: number;
  /** Equity that the ledger's fills, fees and funding do not explain: money moved in or out of
   *  the account, or a cost the ledger does not see. */
  unexplainedE6?: bigint;
};

export type RiskSnapshot = {
  atMs: number;
  symbols: SymbolRisk[];
  account?: AccountRisk;
  totals: {
    /** Sums of sizes without regard to side: no credit is taken for symbols offsetting. */
    vaultGrossE6: bigint;
    hedgeGrossE6: bigint;
    retainedGrossE6: bigint;
    retainedNetE6: bigint;
    navE6: bigint;
    /** Retained risk as a share of the vault's exposure: 0 = all hedged, 10_000 = none. */
    retainedShareBps?: number;
    /** Loss on what is retained if every price moves `stressBps` the wrong way. */
    stressLossE6: bigint;
    /** The same loss as a share of the vaults' net asset value. */
    stressOfNavBps?: number;
    hedgePnlE6: bigint;
    unrealizedE6: bigint;
    realizedE6: bigint;
    feesE6: bigint;
    fundingE6: bigint;
    slippageE6: bigint;
  };
  /** Vault positions with no hedge market configured: nothing offsets them. */
  uncovered: { symbol: string; notionalE6: bigint }[];
};

const bps = (num: bigint, den: bigint) => Number(num * 10_000n / den);

/** Where the hedge account stands against liquidation, and what the engine must do about it. */
export function marginState(account: VenueAccount, grossE6: bigint, cfg: Config, wasDeleveraging: boolean): MarginState {
  if (grossE6 <= 0n) return { grossE6, mode: "ok" };
  const liqDistanceBps = bps(account.equityE6 - account.maintenanceE6, grossE6);
  // Once cutting has begun it goes on until the distance is back at the minimum (less a little:
  // the fees of the cuts themselves leave it just short).
  const restored = cfg.minLiqDistanceBps - Math.floor(cfg.minLiqDistanceBps / 20);
  const cut = cfg.deleverageLiqDistanceBps > 0 && (liqDistanceBps < cfg.deleverageLiqDistanceBps || (wasDeleveraging && liqDistanceBps < restored));
  if (!cut) return { grossE6, liqDistanceBps, mode: liqDistanceBps < cfg.minLiqDistanceBps ? "no_increase" : "ok" };
  // The largest hedge that leaves the minimum distance: equity / (distance + maintenance rate).
  const perDollar = BigInt(cfg.minLiqDistanceBps) + account.maintenanceE6 * 10_000n / grossE6;
  const allowed = account.equityE6 > 0n ? account.equityE6 * 10_000n / perDollar : 0n;
  return { grossE6, liqDistanceBps, mode: "deleverage", keepBps: allowed >= grossE6 ? 10_000 : bps(allowed, grossE6) };
}

/** What the ledger's fills, fees and funding add up to at these prices, or undefined if a
 *  position has no price. */
export function ledgerPnl(L: Ledger, mid: (symbol: string) => bigint | undefined): bigint | undefined {
  let total = -L.feesE6 - L.totalFundingE6();
  for (const [symbol, cash] of L.cashE6) {
    const q = L.position(symbol);
    let value = 0n;
    if (q !== 0n) {
      const px = mid(symbol);
      if (px === undefined) return undefined;
      value = q * px / 1_000_000n;
    }
    total += cash + value;
  }
  return total;
}

export function assess(i: {
  nowMs: number;
  config: Config;
  ledger: Ledger;
  exposures: Map<string, Exposure>;
  quotes: Map<string, Quote>;
  account?: VenueAccount;
  margin?: MarginState;
  /** The hedge each symbol's policy aimed for on this pass, where it said. */
  targets?: Map<string, bigint | undefined>;
}): RiskSnapshot {
  const { config, ledger: L } = i;
  const symbols: SymbolRisk[] = [];
  const t = { vaultGrossE6: 0n, hedgeGrossE6: 0n, retainedGrossE6: 0n, retainedNetE6: 0n, navE6: 0n, stressLossE6: 0n, hedgePnlE6: 0n, unrealizedE6: 0n, realizedE6: 0n, feesE6: 0n, fundingE6: 0n, slippageE6: 0n };
  const headroom = i.account ? i.account.equityE6 - i.account.maintenanceE6 : undefined;

  for (const [symbol, cfg] of Object.entries(config.symbols)) {
    const e = i.exposures.get(symbol);
    const mid = i.quotes.get(symbol)?.midE6;
    const priceE6 = e && e.priceE6 > 0n ? e.priceE6 : mid ?? 0n;
    const hedgeQ = L.position(symbol);
    // The hedge is valued where it is held; the vault, and what is left open, at Percolator's price.
    const mark = mid ?? priceE6;
    const hedgeNotionalE6 = hedgeQ * mark / 1_000_000n;
    const unrealizedE6 = hedgeNotionalE6 - (L.basisE6.get(symbol) ?? 0n);
    const realizedE6 = L.realizedE6(symbol);
    const feesE6 = L.feesBySymbol.get(symbol) ?? 0n, fundingE6 = L.fundingE6.get(symbol) ?? 0n;
    const r: SymbolRisk = {
      symbol, priceE6, hedgeQ, hedgeNotionalE6, maxUnhedgedE6: cfg.maxUnhedgedE6, overLimit: false,
      unrealizedE6, realizedE6, feesE6, fundingE6, slippageE6: L.slippageE6.get(symbol) ?? 0n,
      pnlE6: unrealizedE6 + realizedE6 - feesE6 - fundingE6,
      limitedHedgeQ: i.targets?.get(symbol),
    };
    if (e && e.priceE6 > 0n && mid !== undefined) r.basisBps = bps(mid - e.priceE6, e.priceE6);
    if (e) {
      for (const v of e.vaults) t.navE6 += v.navE6;
      const ratio = BigInt(cfg.hedgeRatioBps);
      r.vaultQ = e.positionQ;
      r.vaultNotionalE6 = e.positionQ * priceE6 / 1_000_000n;
      r.requiredHedgeQ = -e.positionQ * ratio / 10_000n;
      r.targetExposureE6 = (e.positionQ + r.requiredHedgeQ) * priceE6 / 1_000_000n;
      r.retainedE6 = (e.positionQ + hedgeQ) * priceE6 / 1_000_000n;
      r.residualE6 = (hedgeQ - r.requiredHedgeQ) * priceE6 / 1_000_000n;
      if (e.positionQ !== 0n) r.hedgeRatioBps = bps(-hedgeQ, e.positionQ);
      r.stressLossE6 = abs(r.retainedE6) * BigInt(config.stressBps) / 10_000n;
      r.overLimit = abs(r.residualE6) >= cfg.maxUnhedgedE6;
      t.vaultGrossE6 += abs(r.vaultNotionalE6);
      t.retainedGrossE6 += abs(r.retainedE6);
      t.retainedNetE6 += r.retainedE6;
      t.stressLossE6 += r.stressLossE6;
    }
    if (headroom !== undefined && hedgeQ !== 0n && mark > 0n) {
      // A long hedge loses as the price falls, a short one as it rises.
      const move = headroom > 0n ? headroom * 1_000_000n / abs(hedgeQ) : 0n;
      // Only a price within reach is worth showing: past a doubling (or a fall to nothing) this
      // hedge cannot be closed out by its own price alone.
      if (move < mark) r.liqPriceE6 = hedgeQ < 0n ? mark + move : mark - move;
    }
    t.hedgeGrossE6 += abs(hedgeNotionalE6);
    t.unrealizedE6 += unrealizedE6; t.realizedE6 += realizedE6; t.feesE6 += feesE6; t.fundingE6 += fundingE6;
    t.slippageE6 += r.slippageE6; t.hedgePnlE6 += r.pnlE6;
    symbols.push(r);
  }

  const uncovered: RiskSnapshot["uncovered"] = [];
  for (const e of i.exposures.values()) {
    if (config.symbols[e.symbol]) continue;
    for (const v of e.vaults) t.navE6 += v.navE6;
    if (e.positionQ === 0n) continue;
    const n = e.positionQ * e.priceE6 / 1_000_000n;
    uncovered.push({ symbol: e.symbol, notionalE6: n });
    t.vaultGrossE6 += abs(n); t.retainedGrossE6 += abs(n); t.retainedNetE6 += n;
    t.stressLossE6 += abs(n) * BigInt(config.stressBps) / 10_000n;
  }

  let account: AccountRisk | undefined;
  if (i.account) {
    const a = i.account;
    const margin = i.margin ?? marginState(a, t.hedgeGrossE6, config, false);
    const spare = a.freeMarginE6 - config.marginReserveE6;
    const pnl = ledgerPnl(L, s => i.quotes.get(s)?.midE6);
    account = {
      ...a, ...margin,
      availableHedgeE6: margin.mode === "ok" && spare > 0n ? spare * 10_000n / BigInt(config.marginRateBps) : 0n,
      leverageBps: a.equityE6 > 0n ? bps(t.hedgeGrossE6, a.equityE6) : undefined,
      unexplainedE6: L.baselineE6 !== undefined && pnl !== undefined ? a.equityE6 - L.baselineE6 - pnl : undefined,
    };
  }
  return {
    atMs: i.nowMs, symbols, account, uncovered,
    totals: {
      ...t,
      retainedShareBps: t.vaultGrossE6 > 0n ? bps(t.retainedGrossE6, t.vaultGrossE6) : undefined,
      stressOfNavBps: t.navE6 > 0n ? bps(t.stressLossE6, t.navE6) : undefined,
    },
  };
}
