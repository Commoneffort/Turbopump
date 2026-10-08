// The coordinator's states. Each symbol is in exactly one, and so is the hedge as a whole (the
// worst of its symbols).
//
// The state is not stored. It is worked out on every pass from the journal (orders, fills,
// halts, switches) and from what was just read. A stored state would be a second record that
// could disagree with the journal after a crash; this way a restart lands in the right state
// with nothing to repair.
//
//   on the way:   NORMAL -> HEDGE_REQUIRED -> SUBMITTING -> PARTIALLY_FILLED -> HEDGED
//   switched off: CLOSING -> OFF
//   trouble:      STALE      the vault or the venue's price cannot be read; nothing is sent
//                 DEGRADED   hedging, but a limit keeps the hedge from where it should be
//                 FAILED     orders keep trading nothing; retried ever more slowly
//                 UNKNOWN    an order's outcome, or the venue itself, cannot be seen; nothing is
//                            sent until it can
//                 EMERGENCY  halted, being deleveraged, or too much left open for too long:
//                            a person is needed
import { Intent } from "./journal";
import { Decision } from "./policy";
import { MarginMode } from "./risk";
import { abs, usd } from "./units";

export const STATES = ["OFF", "NORMAL", "HEDGED", "CLOSING", "HEDGE_REQUIRED", "PARTIALLY_FILLED", "SUBMITTING", "DEGRADED", "STALE", "FAILED", "UNKNOWN", "EMERGENCY"] as const;
export type HedgeState = typeof STATES[number];
/** Later in the list is worse. */
export const severity = (s: HedgeState) => STATES.indexOf(s);
export const isTrouble = (s: HedgeState) => severity(s) >= severity("DEGRADED");

export type StateInput = {
  nowMs: number;
  enabled: boolean;
  hedgeQ: bigint;
  decision: Decision;
  halt?: string;
  /** The venue could not be reached on this pass. */
  venueError?: string;
  /** The symbol's order whose outcome is not known yet, and the latest one it sent. */
  pending?: Intent;
  last?: Intent;
  failures: number;
  maxFailures: number;
  lostAfterMs: number;
  margin: MarginMode;
  liqDistanceBps?: number;
  /** What the hedge leaves open beyond its target, in dollars (e6). */
  residualE6?: bigint;
  bandE6: bigint;
  maxUnhedgedE6: bigint;
  /** For how long it has been outside the band, and past the limit. */
  outsideBandMs: number;
  overLimitMs: number;
  alarmMs: number;
  /** The vaults were read and none trades this symbol. */
  noVault?: boolean;
};

export function classify(i: StateInput): { state: HedgeState; reason: string } {
  const is = (state: HedgeState, reason: string) => ({ state, reason });
  const d = i.decision;
  const open = i.residualE6 === undefined ? 0n : abs(i.residualE6);
  const outside = i.enabled && open >= i.bandE6;
  const pct = (b?: number) => `${((b ?? 0) / 100).toFixed(1)}%`;

  if (i.halt) return is("EMERGENCY", `halted: ${i.halt}`);
  if (i.venueError) return is("UNKNOWN", `the venue cannot be reached: ${i.venueError}`);
  if (i.pending) {
    const lost = i.pending.status === "in_doubt" || i.nowMs - i.pending.ts > i.lostAfterMs;
    return lost ? is("UNKNOWN", `the outcome of order ${i.pending.id} is not known`) : is("SUBMITTING", `order ${i.pending.id} is at the venue`);
  }
  if (i.margin === "deleverage") return is("EMERGENCY", `the hedge account is ${pct(i.liqDistanceBps)} from liquidation: hedges are being cut`);
  if (i.enabled && open >= i.maxUnhedgedE6 && i.overLimitMs >= i.alarmMs) {
    return is("EMERGENCY", `${usd(open)} has been open for ${Math.round(i.overLimitMs / 1000)} s, past the limit of ${usd(i.maxUnhedgedE6)}`);
  }
  if (i.failures >= i.maxFailures) return is("FAILED", `${i.failures} orders in a row traded nothing${i.last?.status ? ` (the last: ${i.last.status})` : ""}`);
  if (!i.enabled) return i.hedgeQ === 0n ? is("OFF", "switched off") : is("CLOSING", "switched off: the hedge is being closed");

  if (i.noVault && i.hedgeQ === 0n) return is("NORMAL", "no vault trades this symbol");
  // A flat vault with no hedge needs no venue price: a market that is closed has none.
  if (d.action === "hold" && (d.code === "no_quote" || d.code === "old_quote") && i.hedgeQ === 0n && i.residualE6 === 0n) return is("NORMAL", "nothing to hedge");
  if (d.action === "hold") {
    switch (d.code) {
      case "no_reading": case "bad_reading": case "old_reading": case "no_quote": case "old_quote":
        return is("STALE", d.reason);
      case "basis": case "margin": case "liquidation": case "rate_limit": case "backoff":
        return is("DEGRADED", d.reason);
    }
  }
  if (i.margin === "no_increase" && i.hedgeQ !== 0n) return is("DEGRADED", `the hedge account is ${pct(i.liqDistanceBps)} from liquidation: the hedge may only shrink`);
  if (open >= i.maxUnhedgedE6) return is("DEGRADED", `${usd(open)} is open, past the limit of ${usd(i.maxUnhedgedE6)}`);
  if (outside && i.outsideBandMs >= i.alarmMs) return is("DEGRADED", `outside the band for ${Math.round(i.outsideBandMs / 1000)} s (${usd(open)} open)`);
  if (outside) {
    // The policy is content, and yet more is open than the band allows: a limit holds it back.
    if (d.action === "hold" && (d.code === "on_target" || d.code === "in_band" || d.code === "below_min")) {
      return is("DEGRADED", `a limit keeps the hedge short of what the vault needs (${usd(open)} open)`);
    }
    const l = i.last;
    if (l && l.filledQ > 0n && l.filledQ < l.sizeQ) return is("PARTIALLY_FILLED", `the last order filled in part; ${usd(open)} still open`);
    return is("HEDGE_REQUIRED", `${usd(open)} open`);
  }
  return i.hedgeQ === 0n ? is("NORMAL", "nothing to hedge") : is("HEDGED", "on target");
}
