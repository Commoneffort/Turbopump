// Persistent state. The hedger's whole state is an append-only journal: one JSON line per event,
// flushed to disk before the engine acts on it. The in-memory ledger is that journal folded, so a
// restart rebuilds exactly what was known before it.
//
// An order is written here (`intent`) before it is sent. After a crash, an intent with no outcome
// is looked up at the venue by its id instead of being sent again: nothing is ever placed twice.
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Clock, Side, signed } from "./units";

export type OrderOutcome = "filled" | "cancelled" | "rejected" | "lost";

export type Event =
  /** First line of every journal. A journal belongs to one venue for good. */
  | { type: "open"; journalId: string; venue: string }
  /** The engine is about to send this order. */
  | { type: "intent"; id: string; symbol: string; side: Side; sizeQ: bigint; limitE6: bigint; reduceOnly: boolean; targetQ: bigint; exposureQ: bigint; priceE6: bigint;
      /** The venue's mid price when the order was decided: what its fills are measured against. */
      midE6?: bigint }
  /** Sending it failed in a way that leaves its fate unknown. */
  | { type: "in_doubt"; id: string; error: string }
  /** The venue's final word on an order (`lost`: it never heard of it). */
  | { type: "order"; id: string; status: OrderOutcome; filledQ: bigint; reason?: string }
  /** A fill reported by the venue. `id` is null when no order of this engine produced it. */
  | { type: "fill"; fillId: string; id: string | null; symbol: string; side: Side; sizeQ: bigint; priceE6: bigint; feeE6: bigint; cursor: string }
  /** No orders for `scope` (a symbol, or "*" for all) until an operator resumes it. */
  | { type: "halt"; scope: string; reason: string }
  | { type: "resume"; scope: string; by: string }
  /** Hedging was switched on or off for `scope` (a symbol, or "*" for every symbol without a
   *  setting of its own). `on: null` removes the setting. */
  | { type: "switch"; scope: string; on: boolean | null; by: string }
  /** An operator accepted the venue's position as the ledger's. `priceE6` is the venue's price
   *  then: the difference is booked as if it had been traded there. */
  | { type: "adopt"; symbol: string; positionQ: bigint; by: string; priceE6?: bigint }
  /** Funding the venue charged (positive) or paid (negative) on a position. */
  | { type: "funding"; fundingId: string; symbol: string; amountE6: bigint; cursor: string }
  /** What the hedge account was worth before any of the ledger's fills, fees and funding: the
   *  money put into it. The account's value is checked against this plus the ledger's result. */
  | { type: "baseline"; equityE6: bigint; by: string };
export type Entry = Event & { seq: number; ts: number };

export type Intent = {
  id: string; symbol: string; side: Side; sizeQ: bigint; limitE6: bigint; reduceOnly: boolean; ts: number;
  status: "pending" | "in_doubt" | OrderOutcome;
  /** Sum of this order's fills seen so far. */
  filledQ: bigint;
  midE6?: bigint;
};

export class Ledger {
  journalId = "";
  venue = "";
  /** When the journal was created. */
  openedAt = 0;
  seq = 0;
  /** Hedge position per symbol: every fill the venue reported, plus adoptions. */
  positions = new Map<string, bigint>();
  /** Cash from fills per symbol, before fees (what was received minus what was paid). */
  cashE6 = new Map<string, bigint>();
  feesE6 = 0n;
  /** What the open position cost, per symbol: its size times the prices it was bought or sold
   *  at (signed like the position). The position's value less this is its unrealized result. */
  basisE6 = new Map<string, bigint>();
  feesBySymbol = new Map<string, bigint>();
  /** Funding charged per symbol (negative when it was received). */
  fundingE6 = new Map<string, bigint>();
  fundingIds = new Set<string>();
  fundingCursor: string | null = null;
  /** What fills cost against the venue's mid price when their order was decided, per symbol. */
  slippageE6 = new Map<string, bigint>();
  /** Orders in a row, per symbol, that ended without trading anything. */
  failures = new Map<string, number>();
  /** The latest order per symbol. */
  lastIntent = new Map<string, Intent>();
  baselineE6?: bigint;
  intents = new Map<string, Intent>();
  fills = new Set<string>();
  /** Where the venue's fill history has been read up to. */
  cursor: string | null = null;
  halts = new Map<string, string>();
  switches = new Map<string, boolean>();
  lastOrderMs = new Map<string, number>();
  orderTimes: number[] = [];

  position(symbol: string) { return this.positions.get(symbol) ?? 0n; }
  /** Orders whose outcome is not known yet. */
  unresolved(symbol?: string): Intent[] {
    return [...this.intents.values()].filter(i => (i.status === "pending" || i.status === "in_doubt") && (!symbol || i.symbol === symbol));
  }
  halted(symbol: string) { return this.halts.get("*") ?? this.halts.get(symbol); }
  /** Whether hedging is switched on for a symbol. Off until someone switches it on. */
  enabled(symbol: string) { return this.switches.get(symbol) ?? this.switches.get("*") ?? false; }
  /** Result of the trades on a symbol that are closed (before fees and funding). */
  realizedE6(symbol: string) { return (this.cashE6.get(symbol) ?? 0n) + (this.basisE6.get(symbol) ?? 0n); }
  totalFundingE6() { let t = 0n; for (const f of this.fundingE6.values()) t += f; return t; }
  /** A change of position at a price: the cash it moves and what the position then cost. */
  private trade(symbol: string, q: bigint, priceE6: bigint) {
    const held = this.position(symbol), basis = this.basisE6.get(symbol) ?? 0n;
    const value = q * priceE6 / 1_000_000n;
    const after = held + q;
    let next: bigint;
    if (held === 0n || (held > 0n) === (q > 0n)) next = basis + value;       // opens or adds
    else if ((after > 0n) === (held > 0n) || after === 0n) next = basis * after / held; // closes part, or all
    else next = after * priceE6 / 1_000_000n;                                 // closes all, opens the other way
    this.positions.set(symbol, after);
    this.basisE6.set(symbol, next);
    this.cashE6.set(symbol, (this.cashE6.get(symbol) ?? 0n) - value);
  }
  ordersSince(ms: number) {
    let n = 0;
    for (let i = this.orderTimes.length - 1; i >= 0 && this.orderTimes[i] >= ms; i--) n++;
    return n;
  }

  apply(e: Entry) {
    this.seq = e.seq;
    switch (e.type) {
      case "open":
        this.journalId = e.journalId;
        this.venue = e.venue;
        this.openedAt = e.ts;
        break;
      case "intent":
        this.intents.set(e.id, { id: e.id, symbol: e.symbol, side: e.side, sizeQ: e.sizeQ, limitE6: e.limitE6, reduceOnly: e.reduceOnly, ts: e.ts, status: "pending", filledQ: 0n, midE6: e.midE6 });
        this.lastIntent.set(e.symbol, this.intents.get(e.id)!);
        this.lastOrderMs.set(e.symbol, e.ts);
        this.orderTimes.push(e.ts);
        break;
      case "in_doubt": {
        const it = this.intents.get(e.id);
        if (it && it.status === "pending") it.status = "in_doubt";
        break;
      }
      case "order": {
        const it = this.intents.get(e.id);
        if (!it) break;
        it.status = e.status;
        // An order that turns up after it was given up on does not count twice.
        if (it.filledQ > 0n) this.failures.delete(it.symbol);
        else if (e.status !== "filled") this.failures.set(it.symbol, (this.failures.get(it.symbol) ?? 0) + 1);
        break;
      }
      case "fill": {
        if (this.fills.has(e.fillId)) break;
        this.fills.add(e.fillId);
        this.trade(e.symbol, signed(e.side, e.sizeQ), e.priceE6);
        this.feesE6 += e.feeE6;
        this.feesBySymbol.set(e.symbol, (this.feesBySymbol.get(e.symbol) ?? 0n) + e.feeE6);
        this.cursor = e.cursor;
        const it = e.id ? this.intents.get(e.id) : undefined;
        if (it) {
          it.filledQ += e.sizeQ;
          this.failures.delete(it.symbol);
          if (it.midE6 !== undefined) {
            const worse = e.side === "buy" ? e.priceE6 - it.midE6 : it.midE6 - e.priceE6;
            this.slippageE6.set(e.symbol, (this.slippageE6.get(e.symbol) ?? 0n) + e.sizeQ * worse / 1_000_000n);
          }
        }
        break;
      }
      case "funding":
        if (this.fundingIds.has(e.fundingId)) break;
        this.fundingIds.add(e.fundingId);
        this.fundingE6.set(e.symbol, (this.fundingE6.get(e.symbol) ?? 0n) + e.amountE6);
        this.fundingCursor = e.cursor;
        break;
      case "baseline":
        this.baselineE6 = e.equityE6;
        break;
      case "halt":
        this.halts.set(e.scope, e.reason);
        break;
      case "resume":
        this.halts.delete(e.scope);
        break;
      case "adopt":
        if (e.priceE6 !== undefined) this.trade(e.symbol, e.positionQ - this.position(e.symbol), e.priceE6);
        else this.positions.set(e.symbol, e.positionQ);
        break;
      case "switch":
        if (e.on === null) this.switches.delete(e.scope);
        else this.switches.set(e.scope, e.on);
        break;
    }
  }
}

// bigints are written as {"$n":"123"}.
export const encode = (e: unknown) => JSON.stringify(e, (_, v) => (typeof v === "bigint" ? { $n: v.toString() } : v));
export const decode = (s: string) => JSON.parse(s, (_, v) => (v && typeof v === "object" && typeof v.$n === "string" && Object.keys(v).length === 1 ? BigInt(v.$n) : v));

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

export type JournalOptions = {
  /** Flush every line to disk before returning (default). Simulations turn it off for speed. */
  fsync?: boolean;
  /** Tests: called before and after each line is written; throwing stands for a crash there. */
  hook?: (e: Entry, when: "before" | "after") => void;
};

export class Journal {
  readonly ledger = new Ledger();
  private fd: number;
  private lock: string;
  /** Set when a write failed (or the process "died" in a test). The ledger in memory may then
   *  differ from the file, so the journal accepts nothing more: the process must restart. */
  dead?: unknown;

  private constructor(readonly dir: string, private clock: Clock, private opts: JournalOptions) {
    fs.mkdirSync(dir, { recursive: true });
    this.lock = path.join(dir, "lock");
    this.acquire();
    const file = path.join(dir, "journal.jsonl");
    try {
      this.fd = fs.openSync(file, "a+");
      this.replay(file);
    } catch (e) {
      fs.rmSync(this.lock, { force: true });
      throw e;
    }
  }

  /** Opens (or creates) the journal in `dir` for `venue`. Only one process may hold it: two
   *  engines on one account would each hedge the same position. */
  static open(dir: string, venue: string, clock: Clock, opts: JournalOptions = {}): Journal {
    const j = new Journal(dir, clock, opts);
    if (j.ledger.seq === 0) j.append({ type: "open", journalId: crypto.randomBytes(8).toString("hex"), venue });
    if (j.ledger.venue !== venue) {
      const was = j.ledger.venue;
      j.close();
      throw new Error(`journal in ${dir} belongs to venue "${was}", not "${venue}"`);
    }
    return j;
  }

  private acquire() {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(this.lock, String(process.pid), { flag: "wx" });
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = Number(fs.readFileSync(this.lock, "utf8"));
        if (attempt > 0 || (pid && alive(pid))) throw new Error(`journal in ${this.dir} is in use by process ${pid}`);
        fs.rmSync(this.lock, { force: true }); // left by a process that died
      }
    }
  }

  private replay(file: string) {
    let text = fs.readFileSync(file, "utf8");
    // A line is written whole and ends with a newline, so text after the last newline is a write
    // that a crash cut short: its event never took effect, and it is dropped.
    const end = text.lastIndexOf("\n") + 1;
    if (end < text.length) {
      fs.truncateSync(file, Buffer.byteLength(text.slice(0, end)));
      text = text.slice(0, end);
    }
    const lines = text.split("\n");
    lines.pop();
    lines.forEach((line, i) => {
      let e: Entry;
      try { e = decode(line); } catch { throw new Error(`journal ${file} is damaged at line ${i + 1}`); }
      if (e.seq !== this.ledger.seq + 1) throw new Error(`journal ${file} skips from event ${this.ledger.seq} to ${e.seq} at line ${i + 1}`);
      this.ledger.apply(e);
    });
  }

  append(ev: Event): Entry {
    if (this.dead) throw this.dead;
    const e = { ...ev, seq: this.ledger.seq + 1, ts: this.clock.now() } as Entry;
    try {
      this.opts.hook?.(e, "before");
      fs.writeSync(this.fd, encode(e) + "\n");
      if (this.opts.fsync !== false) fs.fsyncSync(this.fd);
      this.ledger.apply(e);
      this.opts.hook?.(e, "after");
    } catch (err) {
      this.dead = err;
      throw err;
    }
    return e;
  }

  close() {
    fs.closeSync(this.fd);
    fs.rmSync(this.lock, { force: true });
  }
}

/** Reads a journal without taking it over (it may be in use): the ledger and every event. */
export function readJournal(dir: string): { ledger: Ledger; entries: Entry[] } {
  const ledger = new Ledger(), entries: Entry[] = [];
  const text = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8");
  for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
    if (!line) continue;
    const e: Entry = decode(line);
    ledger.apply(e);
    entries.push(e);
  }
  return { ledger, entries };
}

/** The id an order carries at the venue: fixed by the journal and the event number, so the same
 *  intent always maps to the same order (0x + 32 hex digits, the form Hyperliquid accepts). */
export const clientId = (journalId: string, seq: number) =>
  "0x" + crypto.createHash("sha256").update(`${journalId}:${seq}`).digest("hex").slice(0, 32);
