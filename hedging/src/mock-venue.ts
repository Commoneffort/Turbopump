// A hedge venue that exists only in memory: a perpetual-futures account with a margin balance,
// a taker fee, a spread, and prices set from outside. It also misbehaves on request, in the ways
// a real venue does, so the engine and the reconciliation can be tested against them.
import { Clock, UNIT, abs, bmin, floorTo, notional, signed, unitsFor } from "./units";
import { FundingPayment, HedgeVenue, OrderRequest, OrderState, Quote, VenueAccount, VenueFill, VenueMeta } from "./venue";

export type MockOptions = {
  equityE6: bigint;
  /** Taker fee on every fill. */
  feeBps: number;
  /** Full bid-ask spread: a buy fills half of it above the mid, a sell half below. */
  spreadBps: number;
  /** Margin needed per dollar of position. */
  marginRateBps: number;
  /** Equity per dollar of position below which the venue closes every position itself, at the
   *  mid price and for `liquidationFeeBps` of their value. Half of `marginRateBps` when absent. */
  maintenanceRateBps?: number;
  liquidationFeeBps?: number;
  /** Most one order fills, in dollars (e6); the rest is cancelled. Unlimited when absent. */
  depthE6?: bigint;
  meta?: Record<string, VenueMeta>;
};

/** What goes wrong. Each field stays in force until it is cleared. */
export type Faults = {
  /** Every call fails. */
  down?: boolean;
  /** Orders are refused, with this reason. */
  reject?: string;
  /** `place` fails and the order never arrives. */
  drop?: boolean;
  /** The order is executed, but `place` fails before answering. */
  loseReply?: boolean;
  /** `place` fails; the order arrives and executes this much later. */
  delayMs?: number;
  /** New fills stay out of the fill history for this long (positions show them at once). */
  hideFillsMs?: number;
};

export const defaultMeta: VenueMeta = { lotQ: 10_000n, minNotionalE6: 10_000_000n, tickE6: 1n };

export class MockVenue implements HedgeVenue {
  readonly name = "mock";
  faults: Faults = {};
  /** Each order draws its own fault (for simulations with random failures). */
  chaos?: () => Faults;
  feesE6 = 0n;
  fundingE6 = 0n;
  /** What fills cost against the mid price (half the spread on each). */
  spreadCostE6 = 0n;
  /** Orders that reached the venue. */
  received = 0;
  /** Times the venue closed the account's positions for lack of margin. */
  liquidations = 0;

  private mids = new Map<string, Quote>();
  private pos = new Map<string, bigint>();
  private cash: bigint;
  private orders = new Map<string, OrderState>();
  private history: (VenueFill & { visibleAt: number })[] = [];
  private late: { at: number; o: OrderRequest }[] = [];
  private fillSeq = 0;
  private funded: FundingPayment[] = [];

  constructor(private clock: Clock, private o: MockOptions) {
    this.cash = o.equityE6;
  }

  // ---- driven from outside ----
  setMid(symbol: string, midE6: bigint) { this.mids.set(symbol, { midE6, atMs: this.clock.now() }); }
  /** Charges funding on a symbol's position: longs pay `ratePpb` billionths of its value. */
  fund(symbol: string, ratePpb: bigint) {
    const paid = this.position(symbol) * this.mid(symbol) / UNIT * ratePpb / 1_000_000_000n;
    if (paid === 0n) return;
    this.cash -= paid;
    this.fundingE6 += paid;
    const cursor = String(this.funded.length + 1);
    this.funded.push({ fundingId: `u${cursor}`, symbol, amountE6: paid, atMs: this.clock.now(), cursor });
  }
  /** A trade on the account that the engine did not place (someone else, or a liquidation). */
  externalTrade(symbol: string, side: "buy" | "sell", sizeQ: bigint) {
    this.fill(null, symbol, side, sizeQ, this.mid(symbol));
  }
  /** Changes a position with no fill to show for it. */
  forcePosition(symbol: string, q: bigint) { this.pos.set(symbol, q); }
  /** Starts from a known state (a paper account rebuilt from the journal). */
  seed(positions: Map<string, bigint>, cashE6: bigint, cursor: string | null) {
    this.pos = new Map(positions);
    this.cash = cashE6;
    this.fillSeq = cursor ? Number(cursor) : 0;
  }
  position(symbol: string) { return this.pos.get(symbol) ?? 0n; }
  equity() {
    let e = this.cash;
    for (const [s, q] of this.pos) if (q !== 0n) e += q * this.mid(s) / UNIT;
    return e;
  }

  // ---- HedgeVenue ----
  async meta(symbol: string): Promise<VenueMeta> { this.up(); return this.o.meta?.[symbol] ?? defaultMeta; }
  async quote(symbol: string): Promise<Quote> {
    this.up();
    const q = this.mids.get(symbol);
    if (!q) throw new Error(`no market ${symbol}`);
    return q;
  }
  async account(): Promise<VenueAccount> {
    this.up();
    const equityE6 = this.equity(), marginUsedE6 = this.marginUsed();
    return { equityE6, freeMarginE6: equityE6 - marginUsedE6, marginUsedE6, maintenanceE6: this.maintenance() };
  }
  async positions(): Promise<Map<string, bigint>> {
    this.up();
    return new Map([...this.pos].filter(([, q]) => q !== 0n));
  }
  async place(o: OrderRequest): Promise<OrderState> {
    this.up();
    const f = { ...this.faults, ...this.chaos?.() };
    if (f.drop) throw new Error("request timed out");
    if (f.delayMs) {
      this.late.push({ at: this.clock.now() + f.delayMs, o });
      throw new Error("request timed out");
    }
    const st = this.execute(o, f);
    if (f.loseReply) throw new Error("connection reset");
    return st;
  }
  async order(clientId: string): Promise<OrderState | null> {
    this.up();
    return this.orders.get(clientId) ?? null;
  }
  async fills(cursor: string | null): Promise<VenueFill[]> {
    this.up();
    const after = cursor ? Number(cursor) : 0, now = this.clock.now();
    const out: VenueFill[] = [];
    for (const { visibleAt, ...f } of this.history) {
      if (Number(f.cursor) <= after) continue;
      if (visibleAt > now) break; // history is read in order: nothing after a hidden fill either
      out.push(f);
    }
    return out;
  }

  async funding(cursor: string | null): Promise<FundingPayment[]> {
    this.up();
    return this.funded.slice(cursor ? Number(cursor) : 0);
  }

  // ---- internals ----
  private up() {
    if (this.faults.down) throw new Error("venue unreachable");
    const now = this.clock.now();
    const due = this.late.filter(l => l.at <= now);
    this.late = this.late.filter(l => l.at > now);
    for (const l of due) this.execute(l.o, {});
    this.liquidate();
  }
  private maintenance() {
    const rate = BigInt(this.o.maintenanceRateBps ?? Math.floor(this.o.marginRateBps / 2));
    let m = 0n;
    for (const [s, q] of this.pos) if (q !== 0n && this.mids.has(s)) m += notional(q, this.mid(s)) * rate / 10_000n;
    return m;
  }
  /** The venue's own doing: once equity is under the maintenance margin it closes everything. */
  private liquidate() {
    const need = this.maintenance();
    if (need === 0n || [...this.pos].some(([s, q]) => q !== 0n && !this.mids.has(s)) || this.equity() >= need) return;
    this.liquidations++;
    for (const [s, q] of [...this.pos]) {
      if (q === 0n) continue;
      const mid = this.mid(s);
      this.fill(null, s, q > 0n ? "sell" : "buy", abs(q), mid, 0, notional(q, mid) * BigInt(this.o.liquidationFeeBps ?? 50) / 10_000n);
    }
  }
  private mid(symbol: string) {
    const q = this.mids.get(symbol);
    if (!q) throw new Error(`no market ${symbol}`);
    return q.midE6;
  }
  private marginUsed() {
    let m = 0n;
    for (const [s, q] of this.pos) if (q !== 0n) m += notional(q, this.mid(s)) * BigInt(this.o.marginRateBps) / 10_000n;
    return m;
  }

  private execute(o: OrderRequest, f: Faults): OrderState {
    const known = this.orders.get(o.clientId);
    if (known) return known; // the same order sent twice trades once
    this.received++;
    const done = (status: OrderState["status"], filledQ: bigint, reason?: string) => {
      const st: OrderState = { clientId: o.clientId, status, filledQ, reason };
      this.orders.set(o.clientId, st);
      return st;
    };
    const meta = this.o.meta?.[o.symbol] ?? defaultMeta;
    const mid = this.mids.get(o.symbol)?.midE6;
    if (!mid) return done("rejected", 0n, "unknown market");
    if (f.reject) return done("rejected", 0n, f.reject);
    if (o.sizeQ <= 0n || o.sizeQ % meta.lotQ !== 0n) return done("rejected", 0n, "size is not a whole number of lots");
    if (o.limitE6 % meta.tickE6 !== 0n) return done("rejected", 0n, "price is not on the tick");
    if (notional(o.sizeQ, mid) < meta.minNotionalE6) return done("rejected", 0n, "order below minimum value");

    const half = BigInt(this.o.spreadBps);
    const px = o.side === "buy" ? mid * (20_000n + half) / 20_000n : mid * (20_000n - half) / 20_000n;
    if (o.side === "buy" ? px > o.limitE6 : px < o.limitE6) return done("cancelled", 0n, "no liquidity inside the limit");

    const held = this.position(o.symbol), move = signed(o.side, o.sizeQ);
    let size = o.sizeQ;
    if (o.reduceOnly) {
      const closes = held !== 0n && (held > 0n) !== (move > 0n) ? bmin(size, abs(held)) : 0n;
      if (closes === 0n) return done("rejected", 0n, "reduce-only order would open a position");
      size = closes;
    }
    if (this.o.depthE6 !== undefined) size = bmin(size, floorTo(unitsFor(this.o.depthE6, px), meta.lotQ));
    if (size === 0n) return done("cancelled", 0n, "no liquidity");
    const after = held + signed(o.side, size);
    const added = notional(after, mid) - notional(held, mid);
    if (added > 0n && added * BigInt(this.o.marginRateBps) / 10_000n > this.equity() - this.marginUsed()) {
      return done("rejected", 0n, "insufficient margin");
    }
    this.fill(o.clientId, o.symbol, o.side, size, px, f.hideFillsMs);
    return done(size === o.sizeQ ? "filled" : "cancelled", size, size === o.sizeQ ? undefined : "partly filled");
  }

  private fill(clientId: string | null, symbol: string, side: "buy" | "sell", sizeQ: bigint, priceE6: bigint, hideMs = 0, fee?: bigint) {
    const q = signed(side, sizeQ);
    const feeE6 = fee ?? notional(sizeQ, priceE6) * BigInt(this.o.feeBps) / 10_000n;
    this.pos.set(symbol, this.position(symbol) + q);
    this.cash -= q * priceE6 / UNIT + feeE6;
    this.feesE6 += feeE6;
    if (clientId !== null) this.spreadCostE6 += notional(sizeQ, abs(priceE6 - this.mid(symbol)));
    const cursor = String(++this.fillSeq);
    const atMs = this.clock.now();
    this.history.push({ fillId: `f${cursor}`, clientId, symbol, side, sizeQ, priceE6, feeE6, atMs, cursor, visibleAt: atMs + hideMs });
  }
}
