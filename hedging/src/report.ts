// What a running hedger leaves for people and other programs to read, beside its journal:
//   risk.json          the latest pass: states, the risk snapshot, the hedge account
//   transitions.jsonl  one line per change of state
// Neither is needed to run or to recover: the journal alone is. A failure to write them is
// reported and otherwise ignored.
import * as fs from "fs";
import * as path from "path";
import { TickReport } from "./engine";
import { decode, encode } from "./journal";
import { RiskSnapshot } from "./risk";
import { HedgeState, isTrouble } from "./state";
import { qty, usd } from "./units";

export const RISK_FILE = "risk.json";
export const TRANSITIONS_FILE = "transitions.jsonl";

export type RiskFile = {
  atMs: number;
  /** The price move the stress loss in `risk` is worked out for. */
  stressBps: number;
  state: HedgeState;
  stateReason: string;
  venueError?: string;
  readError?: string;
  symbols: { symbol: string; state: HedgeState; reason: string; enabled: boolean }[];
  risk: RiskSnapshot;
};

export function writeReport(dir: string, r: TickReport, stressBps: number) {
  const file: RiskFile = {
    atMs: r.atMs, stressBps, state: r.state, stateReason: r.stateReason, venueError: r.venueError, readError: r.readError,
    symbols: r.symbols.map(s => ({ symbol: s.symbol, state: s.state, reason: s.stateReason, enabled: s.enabled })),
    risk: r.risk,
  };
  const tmp = path.join(dir, `${RISK_FILE}.tmp`);
  fs.writeFileSync(tmp, encode(file));
  fs.renameSync(tmp, path.join(dir, RISK_FILE)); // whole or not at all
  if (r.transitions.length) {
    fs.appendFileSync(path.join(dir, TRANSITIONS_FILE), r.transitions.map(t => encode({ atMs: r.atMs, ...t }) + "\n").join(""));
  }
}
export function readReport(dir: string): RiskFile | undefined {
  try { return decode(fs.readFileSync(path.join(dir, RISK_FILE), "utf8")); } catch { return undefined; }
}

const pct = (bps?: number) => (bps === undefined ? "-" : `${(bps / 100).toFixed(1)}%`);
const money = (e6?: bigint) => (e6 === undefined ? "?" : usd(e6));

/** The snapshot as rows a person can read: one per symbol. */
export function riskRows(f: RiskFile) {
  return f.risk.symbols.map(s => {
    const st = f.symbols.find(x => x.symbol === s.symbol);
    return {
      symbol: s.symbol,
      state: st?.state ?? "?",
      "vault holds": money(s.vaultNotionalE6),
      "meant to keep": money(s.targetExposureE6),
      "hedge needed": s.requiredHedgeQ === undefined ? "?" : qty(s.requiredHedgeQ),
      "hedge held": qty(s.hedgeQ),
      hedged: pct(s.hedgeRatioBps),
      "still open": money(s.residualE6),
      "limit": usd(s.maxUnhedgedE6),
      "vault keeps": money(s.retainedE6),
      "hedge result": usd(s.pnlE6),
      "liquidated at": s.liqPriceE6 === undefined ? "-" : usd(s.liqPriceE6),
    };
  });
}

/** The rest of it, as lines. */
export function riskLines(f: RiskFile): string[] {
  const t = f.risk.totals, a = f.risk.account;
  const out = [
    `state ${f.state}${isTrouble(f.state) || f.state === "SUBMITTING" ? ` (${f.stateReason})` : ""}, as of ${new Date(f.atMs).toISOString().slice(0, 19)}Z`,
    `vaults hold ${usd(t.vaultGrossE6)}; hedges ${usd(t.hedgeGrossE6)}; the vaults still carry ${usd(t.retainedGrossE6)} (${pct(t.retainedShareBps)} of what they hold)`,
    `a ${pct(f.stressBps)} move against what is left would cost ${usd(t.stressLossE6)}${t.stressOfNavBps === undefined ? "" : ` (${pct(t.stressOfNavBps)} of the vaults' value)`}`,
    `hedge result ${usd(t.hedgePnlE6)}: open positions ${usd(t.unrealizedE6)}, closed trades ${usd(t.realizedE6)}, fees ${usd(-t.feesE6)}, funding ${usd(-t.fundingE6)} (of which fills cost ${usd(t.slippageE6)} against the mid price)`,
  ];
  if (a) {
    out.push(`hedge account: worth ${usd(a.equityE6)}, margin in use ${usd(a.marginUsedE6)}, free ${usd(a.freeMarginE6)}, room for ${usd(a.availableHedgeE6)} more hedge, ${a.leverageBps === undefined ? "-" : (a.leverageBps / 10_000).toFixed(2)}x`
      + (a.liqDistanceBps === undefined ? "" : `; liquidated if every hedged price moves ${a.liqDistanceBps > 10_000 ? "more than 100%" : pct(a.liqDistanceBps)} against it${a.mode === "ok" ? "" : a.mode === "deleverage" ? " (HEDGES ARE BEING CUT)" : " (the hedge may only shrink)"}`));
    if (a.unexplainedE6 !== undefined && (a.unexplainedE6 >= 10_000n || a.unexplainedE6 <= -10_000n)) out.push(`the account is worth ${usd(a.unexplainedE6)} more than the ledger's fills, fees and funding explain`);
  } else out.push(`hedge account: not readable${f.venueError ? ` (${f.venueError})` : ""}`);
  for (const u of f.risk.uncovered) out.push(`not hedged (no venue market): ${u.symbol} ${usd(u.notionalE6)}`);
  for (const s of f.symbols) if (isTrouble(s.state)) out.push(`${s.state} ${s.symbol}: ${s.reason}`);
  return out;
}
