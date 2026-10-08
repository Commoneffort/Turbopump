// HedgeEngine: one pass = reconcile with the venue, read the vaults, decide, send at most one
// order per symbol. It runs beside Percolator, never inside it: it reads the vaults' positions
// and trades its own account on the venue. It holds no Percolator key and sends no transaction.
//
// The hedge trails the vault. A trade fills on Percolator first; the engine sees the new position
// on a later pass and then moves the hedge, so for a while the vault is hedged too little or too
// much. Nothing in Percolator waits for, or depends on, the hedge.
import { Config } from "./config";
import { Exposure, ExposureMonitor } from "./exposure";
import * as fs from "fs";
import * as path from "path";
import { Journal, clientId } from "./journal";
import { Decision, decide } from "./policy";
import { Reconciler } from "./reconcile";
import { MarginState, RiskSnapshot, assess, ledgerPnl, marginState } from "./risk";
import { HedgeState, classify, severity } from "./state";
import { Clock, abs, errorText, notional, usd } from "./units";
import { HedgeVenue, Quote, VenueAccount, VenueMeta } from "./venue";

export type SymbolReport = {
  symbol: string;
  exposure?: Exposure;
  hedgeQ: bigint;
  /** Dollar value (e6) of what the hedge leaves open: the vault's position, scaled by the hedge
   *  ratio, plus the hedge. Signed like the vault's position. Undefined without a reading. */
  residualE6?: bigint;
  /** How long the residual has been outside the band without a break. */
  outsideBandMs: number;
  decision: Decision;
  /** The order sent on this pass, if any. */
  sent?: string;
  /** Hedging is switched on for this symbol. */
  enabled: boolean;
  /** Where the symbol stands after this pass (see state.ts), and why. */
  state: HedgeState;
  stateReason: string;
};
export type Transition = { scope: string; from?: HedgeState; to: HedgeState; reason: string };
export type TickReport = {
  atMs: number;
  /** Set when the venue could not be reached: nothing was sent from then on. */
  venueError?: string;
  /** Set when switch.json exists but could not be understood (the switches stay as they were). */
  switchError?: string;
  /** Why the latest vault read was not used, if it was not. */
  readError?: string;
  account?: VenueAccount;
  symbols: SymbolReport[];
  /** Vault positions on symbols with no hedge market configured: dollar value (e6), signed. */
  unhedged: { symbol: string; notionalE6: bigint }[];
  /** How much risk the vaults still carry after the hedge, and the hedge account's condition. */
  risk: RiskSnapshot;
  /** The worst of the symbols' states, or worse if the account itself is in trouble. */
  state: HedgeState;
  stateReason: string;
  /** States that changed on this pass ("*" is the hedge as a whole). */
  transitions: Transition[];
};

export const SWITCH_FILE = "switch.json";

/** Writes the wanted switches for a running (or stopped) engine to pick up on its next pass. */
export function writeSwitches(dir: string, switches: Record<string, "on" | "off">, by: string) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${SWITCH_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...switches, by }, null, 1));
  fs.renameSync(tmp, path.join(dir, SWITCH_FILE)); // whole or not at all
}
export function readSwitchFile(dir: string): Record<string, "on" | "off"> {
  try {
    const { by, ...rest } = JSON.parse(fs.readFileSync(path.join(dir, SWITCH_FILE), "utf8"));
    return rest;
  } catch {
    return {};
  }
}

export class HedgeEngine {
  private reconciler: Reconciler;
  private metas = new Map<string, VenueMeta>();
  private outsideSince = new Map<string, number>();
  private overSince = new Map<string, number>();
  /** The chain has been read in full at least once. From then on a symbol that has never had a
   *  vault is known to have none, also on a pass whose read failed. */
  private readOnce = false;
  private unexplainedLastPass = false;
  private deleveraging = false;
  private states = new Map<string, HedgeState>();

  constructor(private o: { config: Config; journal: Journal; venue: HedgeVenue; monitor: ExposureMonitor; clock: Clock }) {
    this.reconciler = new Reconciler(o.journal, o.venue, o.config, o.clock);
  }

  /** A venue failure is survivable (the pass stops, the next one reconciles). A failed journal
   *  write is not: it is passed on, and the process must stop. */
  private venueError(e: unknown): string {
    if (this.o.journal.dead) throw this.o.journal.dead;
    return errorText(e);
  }

  /** Takes the switches from `switch.json` in the journal's directory, if it is there: the file
   *  is the whole wanted state ({"*": "on", "SOL": "off"}). It can be written while the engine
   *  runs. Each change is journaled, so the switches survive a restart and a deleted file. */
  private readSwitches(): string | undefined {
    const { journal } = this.o;
    let text: string;
    try {
      text = fs.readFileSync(path.join(journal.dir, SWITCH_FILE), "utf8");
    } catch {
      return undefined; // no file: nothing to change
    }
    let want: Map<string, boolean>, by: string;
    try {
      const j = JSON.parse(text);
      by = typeof j.by === "string" ? j.by : SWITCH_FILE;
      want = new Map(Object.entries(j).filter(([k]) => k !== "by").map(([k, v]) => {
        if (v !== "on" && v !== "off") throw new Error(`"${k}" must be "on" or "off"`);
        if (k !== "*" && !this.o.config.symbols[k]) throw new Error(`"${k}" is not a configured symbol`);
        return [k, v === "on"];
      }));
    } catch (e) {
      return errorText(e);
    }
    const have = journal.ledger.switches;
    for (const [scope, on] of want) if (have.get(scope) !== on) journal.append({ type: "switch", scope, on, by });
    for (const scope of [...have.keys()]) if (!want.has(scope)) journal.append({ type: "switch", scope, on: null, by });
    return undefined;
  }

  async tick(): Promise<TickReport> {
    const { config, journal, venue, monitor, clock } = this.o;
    const L = journal.ledger;
    const report = { atMs: clock.now(), symbols: [], unhedged: [], transitions: [] } as unknown as TickReport;
    report.switchError = this.readSwitches();

    // Nothing is decided on a ledger that has not just been checked against the venue.
    let account: VenueAccount | undefined;
    try {
      account = await this.reconciler.run();
    } catch (e) {
      report.venueError = this.venueError(e);
    }
    const exposures = await monitor.observe();
    report.readError = monitor.lastError;

    const quotes = new Map<string, Quote>();
    if (account) {
      for (const [symbol, cfg] of Object.entries(config.symbols)) {
        try {
          quotes.set(symbol, await venue.quote(cfg.venueSymbol));
          if (!this.metas.has(symbol)) this.metas.set(symbol, await venue.meta(cfg.venueSymbol));
        } catch {
          // no quote: the policy holds this symbol
        }
      }
    }
    const value = (symbol: string) => {
      const px = quotes.get(symbol)?.midE6 ?? exposures.get(symbol)?.priceE6 ?? 0n;
      return notional(L.position(symbol), px);
    };
    const gross = () => Object.keys(config.symbols).reduce((g, s) => g + value(s), 0n);
    // The account's standing at its worst on this pass: a pass that had to cut hedges says so,
    // even if the cut put things right.
    let worst: MarginState | undefined;
    const margin = (): MarginState | undefined => {
      if (!account) return undefined;
      const m = marginState(account, gross(), config, this.deleveraging);
      this.deleveraging = m.mode === "deleverage";
      if (!worst || (m.liqDistanceBps ?? Infinity) < (worst.liqDistanceBps ?? Infinity)) worst = m;
      return m;
    };
    const pct = (b?: number) => `${((b ?? 0) / 100).toFixed(1)}%`;

    const targets = new Map<string, bigint | undefined>();
    for (const [symbol, cfg] of Object.entries(config.symbols)) {
      const now = clock.now();
      const exposure = exposures.get(symbol);
      const pending = L.unresolved(symbol)[0];
      const halt = L.halted(symbol);
      let grossOtherE6 = 0n;
      for (const other of Object.keys(config.symbols)) if (other !== symbol) grossOtherE6 += value(other);
      // The account's standing is taken afresh for each symbol: an order just sent changed it.
      const m = margin();

      const decision: Decision = !account || !m
        ? { action: "hold", code: "blocked", reason: `venue: ${report.venueError}` }
        : decide({
          nowMs: now, cfg, limits: config, exposure, hedgeQ: L.position(symbol), grossOtherE6, enabled: L.enabled(symbol),
          quote: quotes.get(symbol), meta: this.metas.get(symbol), freeMarginE6: account.freeMarginE6,
          blocked: halt ? `halted: ${halt}` : pending ? `order ${pending.id} is unresolved` : undefined,
          lastOrderMs: L.lastOrderMs.get(symbol), ordersLastHour: L.ordersSince(now - 3_600_000),
          failures: L.failures.get(symbol) ?? 0,
          noIncrease: m.mode === "ok" ? undefined : `the hedge account is ${pct(m.liqDistanceBps)} from liquidation`,
          hedgeCapE6: m.mode === "deleverage" ? value(symbol) * BigInt(m.keepBps!) / 10_000n : undefined,
        });
      targets.set(symbol, decision.targetQ);

      const row = { symbol, exposure, hedgeQ: L.position(symbol), outsideBandMs: 0, decision, enabled: L.enabled(symbol) } as SymbolReport;
      report.symbols.push(row);
      if (decision.action === "order") {
        // Written before it is sent: after a crash the order is looked up, never sent again.
        const id = clientId(L.journalId, L.seq + 1);
        journal.append({
          type: "intent", id, symbol, side: decision.side, sizeQ: decision.sizeQ, limitE6: decision.limitE6,
          reduceOnly: decision.reduceOnly, targetQ: decision.targetQ, exposureQ: exposure?.positionQ ?? 0n, priceE6: exposure?.priceE6 ?? 0n,
          midE6: quotes.get(symbol)!.midE6,
        });
        row.sent = id;
        try {
          await venue.place({ clientId: id, symbol: cfg.venueSymbol, side: decision.side, sizeQ: decision.sizeQ, limitE6: decision.limitE6, reduceOnly: decision.reduceOnly });
        } catch (e) {
          journal.append({ type: "in_doubt", id, error: this.venueError(e) });
        }
        // The outcome is taken from the venue's records, not from the reply.
        try {
          account = await this.reconciler.run();
        } catch (e) {
          // Nothing more is sent on this pass: the symbols that follow are held.
          report.venueError = this.venueError(e);
          account = undefined;
        }
        row.hedgeQ = L.position(symbol);
      }

      if (exposure) {
        const px = exposure.priceE6 > 0n ? exposure.priceE6 : quotes.get(symbol)?.midE6 ?? 0n;
        row.residualE6 = (exposure.positionQ * BigInt(cfg.hedgeRatioBps) / 10_000n + row.hedgeQ) * px / 1_000_000n;
        // A hedge that is switched off leaves the vault open on purpose: no alarm for that.
        const since = (clocks: Map<string, number>, on: boolean) => {
          if (!on) { clocks.delete(symbol); return 0; }
          if (!clocks.has(symbol)) clocks.set(symbol, now);
          return now - clocks.get(symbol)!;
        };
        row.outsideBandMs = since(this.outsideSince, row.enabled && abs(row.residualE6) >= cfg.bandE6);
        since(this.overSince, row.enabled && abs(row.residualE6) >= cfg.maxUnhedgedE6);
      }
    }

    const m = margin();
    const now = clock.now();
    report.account = account;
    report.risk = assess({ nowMs: now, config, ledger: L, exposures, quotes, account, margin: m, targets });
    report.unhedged = report.risk.uncovered;
    // The first time the account can be valued, what was put into it is written down: from then
    // on its value is checked against that plus what the ledger says was made or lost.
    if (account && L.baselineE6 === undefined) {
      const pnl = ledgerPnl(L, s => quotes.get(s)?.midE6);
      if (pnl !== undefined) {
        journal.append({ type: "baseline", equityE6: account.equityE6 - pnl, by: "engine" });
        report.risk.account!.unexplainedE6 = 0n;
      }
    }

    if (exposures.size > 0 && !report.readError) this.readOnce = true;
    for (const row of report.symbols) {
      const cfg = config.symbols[row.symbol];
      const s = classify({
        nowMs: now, enabled: row.enabled, hedgeQ: row.hedgeQ, decision: row.decision, halt: L.halted(row.symbol), venueError: report.venueError,
        pending: L.unresolved(row.symbol)[0], last: L.lastIntent.get(row.symbol),
        failures: L.failures.get(row.symbol) ?? 0, maxFailures: config.maxFailures, lostAfterMs: config.lostAfterMs,
        margin: worst?.mode ?? "ok", liqDistanceBps: worst?.liqDistanceBps,
        noVault: !row.exposure && (this.readOnce || (exposures.size > 0 && !report.readError)),
        residualE6: row.residualE6, bandE6: cfg.bandE6, maxUnhedgedE6: cfg.maxUnhedgedE6,
        outsideBandMs: row.outsideBandMs, overLimitMs: this.overSince.has(row.symbol) ? now - this.overSince.get(row.symbol)! : 0,
        alarmMs: config.unhedgedAlarmMs,
      });
      row.state = s.state;
      row.stateReason = s.reason;
    }

    // The hedge as a whole: its worst symbol, unless the account itself has something to say.
    let whole: { state: HedgeState; reason: string } = { state: "OFF", reason: "no symbols" };
    for (const row of report.symbols) {
      if (whole.reason === "no symbols" || severity(row.state) > severity(whole.state)) whole = { state: row.state, reason: `${row.symbol}: ${row.stateReason}` };
    }
    const degraded = (reason: string) => { if (severity("DEGRADED") > severity(whole.state)) whole = { state: "DEGRADED", reason }; };
    const unexplained = report.risk.account?.unexplainedE6;
    // The account's value and the prices the ledger is valued at are read a moment apart, so a
    // price jump in between shows as a difference for one pass. Only one that is still there on
    // the next pass is reported.
    const off = unexplained !== undefined && abs(unexplained) > config.maxUnexplainedE6;
    if (off && this.unexplainedLastPass) {
      degraded(`the hedge account is worth ${usd(abs(unexplained!))} ${unexplained! > 0n ? "more" : "less"} than the ledger explains: money moved in or out, or a cost the ledger does not see`);
    }
    this.unexplainedLastPass = off;
    if (report.switchError) degraded(`switch.json ignored: ${report.switchError}`);
    if (report.unhedged.length) degraded(`${report.unhedged.map(u => u.symbol).join(", ")}: a vault position with no hedge market`);
    report.state = whole.state;
    report.stateReason = whole.reason;

    const moved = (scope: string, to: HedgeState, reason: string) => {
      const from = this.states.get(scope);
      if (from !== to) report.transitions.push({ scope, from, to, reason });
      this.states.set(scope, to);
    };
    for (const row of report.symbols) moved(row.symbol, row.state, row.stateReason);
    moved("*", report.state, report.stateReason);
    return report;
  }
}
