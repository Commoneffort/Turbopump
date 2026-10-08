// HedgePolicy: given the vault's position and the hedge held, what order (if any) to send.
// A pure function: no clock, no I/O, no state. Everything it knows is in its input.
//
// The hedge it aims for is the opposite of the vault's position, scaled by the hedge ratio and
// cut down by the limits. Rounding and every limit go toward a smaller hedge: an order never
// takes the hedge past its target, and never to the vault's own side.
import { Config, SymbolConfig } from "./config";
import { Exposure } from "./exposure";
import { Quote, VenueMeta } from "./venue";
import { Side, abs, bmax, bmin, floorTo, notional, sgn, unitsFor } from "./units";

export type PolicyInput = {
  nowMs: number;
  cfg: SymbolConfig;
  limits: Config;
  exposure?: Exposure;
  /** The hedge position held on the venue (positive = long). */
  hedgeQ: bigint;
  /** Dollar value (e6) of the hedges held on the other symbols. */
  grossOtherE6: bigint;
  quote?: Quote;
  meta?: VenueMeta;
  freeMarginE6: bigint;
  /** Hedging is switched on for this symbol. When it is off the hedge is closed: the target is
   *  zero whatever the vault holds, and only reduce-only orders are sent. */
  enabled: boolean;
  /** Set when no order may be sent for this symbol (a halt, or an order still unresolved). */
  blocked?: string;
  lastOrderMs?: number;
  ordersLastHour: number;
  /** Orders in a row on this symbol that traded nothing. Each doubles the wait before the next. */
  failures?: number;
  /** Set while the hedge account is too close to liquidation for the hedge to grow. */
  noIncrease?: string;
  /** Set while the hedge account is being deleveraged: the most this symbol's hedge may be
   *  worth, in dollars (e6). The hedge is cut to it whether or not the vault can be read. */
  hedgeCapE6?: bigint;
};

/** Why nothing was sent. The coordinator's state is told from this, not from the wording. */
export type HoldCode =
  | "blocked" | "off" | "no_reading" | "bad_reading" | "old_reading" | "no_quote" | "old_quote" | "basis"
  | "on_target" | "in_band" | "margin" | "liquidation" | "below_min" | "gap" | "backoff" | "rate_limit";

export type Decision =
  | { action: "hold"; code: HoldCode; reason: string; targetQ?: bigint }
  | { action: "order"; side: Side; sizeQ: bigint; limitE6: bigint; reduceOnly: boolean; targetQ: bigint };

/** The hedge position to aim for, in whole lots. */
export function targetHedge(exposureQ: bigint, priceE6: bigint, cfg: SymbolConfig, limits: Config, grossOtherE6: bigint, lotQ: bigint, hedgeCapE6?: bigint): bigint {
  const want = -exposureQ * BigInt(cfg.hedgeRatioBps) / 10_000n;
  let capE6 = bmin(cfg.maxHedgeE6, bmax(0n, limits.maxGrossE6 - grossOtherE6));
  if (hedgeCapE6 !== undefined) capE6 = bmin(capE6, hedgeCapE6);
  const cap = unitsFor(capE6, priceE6);
  const capped = abs(want) > cap ? (want < 0n ? -cap : cap) : want;
  return floorTo(capped, lotQ);
}

export function decide(i: PolicyInput): Decision {
  const { cfg, limits, nowMs } = i;
  const hold = (code: HoldCode, reason: string, targetQ?: bigint): Decision => ({ action: "hold", code, reason, targetQ });

  if (i.blocked) return hold("blocked", i.blocked);
  const off = !i.enabled;
  if (off && i.hedgeQ === 0n) return hold("off", "switched off", 0n);
  // Closing the hedge down needs no reading of the vault: its target is zero whatever the vault
  // holds, so a failing chain read cannot keep a switched-off hedge open. The same goes for
  // cutting a hedge the account can no longer carry.
  const e = i.exposure;
  const usable = !!e && e.issues.length === 0 && nowMs - e.observedAtMs <= limits.maxExposureAgeMs;
  const cutting = i.hedgeCapE6 !== undefined;
  const unread = usable ? undefined
    : !e ? hold("no_reading", "no reading of the vault yet")
    : e.issues.length ? hold("bad_reading", `vault reading not usable: ${e.issues[0]}`)
    : hold("old_reading", "vault reading is too old");
  if (!off && !cutting && unread) return unread;
  if (!i.quote || !i.meta || i.quote.midE6 <= 0n) return hold("no_quote", "no venue quote");
  if (nowMs - i.quote.atMs > limits.maxQuoteAgeMs) return hold("old_quote", "venue quote is too old");
  const mid = i.quote.midE6, lot = i.meta.lotQ;
  // A flat vault whose market has no price is sized at the venue's.
  const px = usable && e!.priceE6 > 0n ? e!.priceE6 : mid;
  if (abs(mid - px) * 10_000n > px * BigInt(cfg.maxBasisBps)) return hold("basis", "venue price is too far from Percolator's");

  let targetQ: bigint;
  if (off) targetQ = 0n;
  else if (usable) targetQ = targetHedge(e!.positionQ, px, cfg, limits, i.grossOtherE6, lot, i.hedgeCapE6);
  else {
    // No reading to follow: the hedge is only cut to what the account can carry.
    const cap = floorTo(unitsFor(i.hedgeCapE6!, px), lot);
    targetQ = abs(i.hedgeQ) > cap ? (i.hedgeQ < 0n ? -cap : cap) : i.hedgeQ;
  }
  let delta = targetQ - i.hedgeQ;
  if (!off && unread && (delta === 0n || notional(delta, px) < cfg.bandE6)) return unread;
  if (delta === 0n) return hold("on_target", "on target", targetQ);
  // The band is for following the vault; a switched-off hedge is closed whatever its size.
  if (!off && notional(delta, px) < cfg.bandE6) return hold("in_band", "within band", targetQ);
  // The hedge never changes side in one order: it is closed first, and opened the other way on
  // a later pass, from a position the venue has confirmed flat.
  if (i.hedgeQ !== 0n && sgn(i.hedgeQ + delta) === -sgn(i.hedgeQ)) delta = -i.hedgeQ;
  const reducing = i.hedgeQ !== 0n && sgn(delta) !== sgn(i.hedgeQ);
  if (!reducing && i.noIncrease) return hold("liquidation", i.noIncrease, targetQ);

  let size = bmin(abs(delta), unitsFor(cfg.maxOrderE6, px));
  let short = false;
  if (!reducing) {
    // New exposure must fit in the venue's free margin, less the reserve.
    const spare = i.freeMarginE6 - limits.marginReserveE6;
    const afford = spare > 0n ? unitsFor(spare * 10_000n / BigInt(limits.marginRateBps), bmax(px, mid)) : 0n;
    if (afford < size) { size = afford; short = true; }
  }
  size = floorTo(size, lot);
  if (size === 0n || notional(size, mid) < i.meta.minNotionalE6) {
    return short ? hold("margin", "not enough free margin at the venue", targetQ)
      : hold("below_min", off ? "switched off (what is left is below the venue's minimum)" : "order would be below the venue's minimum", targetQ);
  }
  // Each order in a row that traded nothing doubles the wait: a venue that keeps refusing is not
  // asked every few seconds.
  const failures = i.failures ?? 0;
  const gap = Math.min(cfg.minOrderGapMs * 2 ** Math.min(failures, 20), Math.max(cfg.minOrderGapMs, limits.maxBackoffMs));
  if (i.lastOrderMs !== undefined && nowMs - i.lastOrderMs < gap) {
    return nowMs - i.lastOrderMs < cfg.minOrderGapMs || failures === 0
      ? hold("gap", "waiting between orders", targetQ)
      : hold("backoff", `waiting longer after ${failures} order${failures === 1 ? "" : "s"} that traded nothing`, targetQ);
  }
  if (i.ordersLastHour >= limits.maxOrdersPerHour) return hold("rate_limit", "hourly order limit reached", targetQ);

  const side: Side = delta > 0n ? "buy" : "sell";
  const slip = BigInt(cfg.maxSlippageBps), tick = i.meta.tickE6;
  // The limit is rounded toward the mid, so the order never accepts more slippage than allowed.
  const raw = side === "buy" ? mid * (10_000n + slip) / 10_000n : (mid * (10_000n - slip) + 9_999n) / 10_000n;
  const limitE6 = side === "buy" ? raw - (raw % tick) : raw + ((tick - (raw % tick)) % tick);
  return { action: "order", side, sizeQ: size, limitE6, reduceOnly: reducing, targetQ };
}
