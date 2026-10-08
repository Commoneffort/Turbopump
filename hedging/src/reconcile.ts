// Reconciliation: makes the ledger agree with the venue, or stops trading where it cannot.
//
// The venue is the authority on what was traded and what is held. On every pass:
//   1. New fills are read from the venue's history into the ledger. A fill no order of this
//      engine produced is still recorded (the position is what it is), and halts the symbol.
//   2. Every order without a known outcome is looked up by its id. Its outcome is recorded once
//      the fills seen add up to what the venue says it filled. An order the venue has never seen
//      is given up on after `lostAfterMs`; should it turn up later, its fills are still taken in.
//   3. Funding the venue charged or paid is read into the ledger.
//   4. The venue's positions are compared with the ledger's. A difference that the fill history
//      does not explain halts the symbol. A position in a market the engine does not manage
//      halts everything: the account is meant to hold the hedge and nothing else.
//
// A halt only ever stops orders. Nothing here trades to "fix" a difference; an operator looks,
// then adopts the venue's position and resumes.
import { Config } from "./config";
import { Journal } from "./journal";
import { Clock } from "./units";
import { HedgeVenue, VenueAccount } from "./venue";

export class Reconciler {
  private fromVenue = new Map<string, string>();

  constructor(private journal: Journal, private venue: HedgeVenue, private cfg: Config, private clock: Clock) {
    for (const [symbol, c] of Object.entries(cfg.symbols)) this.fromVenue.set(c.venueSymbol, symbol);
  }

  /** One full pass. Throws if the venue cannot be reached; nothing is assumed then. */
  async run(): Promise<VenueAccount> {
    await this.syncFills();
    await this.resolveOrders();
    await this.syncFunding();
    await this.comparePositions();
    return this.venue.account();
  }

  private async syncFunding() {
    const L = this.journal.ledger;
    for (const f of await this.venue.funding(L.fundingCursor)) {
      if (L.fundingIds.has(f.fundingId)) continue;
      this.journal.append({ type: "funding", fundingId: f.fundingId, symbol: this.fromVenue.get(f.symbol) ?? f.symbol, amountE6: f.amountE6, cursor: f.cursor });
    }
  }

  private halt(scope: string, reason: string) {
    if (!this.journal.ledger.halts.has(scope)) this.journal.append({ type: "halt", scope, reason });
  }

  private async syncFills() {
    const L = this.journal.ledger;
    for (const f of await this.venue.fills(L.cursor)) {
      if (L.fills.has(f.fillId)) continue;
      const symbol = this.fromVenue.get(f.symbol);
      const ours = f.clientId !== null && L.intents.has(f.clientId);
      this.journal.append({
        type: "fill", fillId: f.fillId, id: ours ? f.clientId : null, symbol: symbol ?? f.symbol,
        side: f.side, sizeQ: f.sizeQ, priceE6: f.priceE6, feeE6: f.feeE6, cursor: f.cursor,
      });
      if (!ours) this.halt(symbol ?? "*", `fill ${f.fillId} on ${f.symbol} was not placed by this engine`);
    }
  }

  private async resolveOrders() {
    const L = this.journal.ledger;
    for (const it of L.unresolved()) {
      const old = this.clock.now() - it.ts > this.cfg.lostAfterMs;
      let st = await this.venue.order(it.id);
      if (!st) {
        if (old) this.journal.append({ type: "order", id: it.id, status: "lost", filledQ: 0n });
        continue;
      }
      if (st.status !== "open" && st.filledQ !== it.filledQ) {
        // Its fills are not all in the ledger yet: read the history once more.
        await this.syncFills();
        st = (await this.venue.order(it.id)) ?? st;
      }
      if (st.status === "open") {
        if (old) this.halt(it.symbol, `order ${it.id} is still open at the venue`);
      } else if (st.filledQ === it.filledQ) {
        this.journal.append({ type: "order", id: it.id, status: st.status, filledQ: st.filledQ, reason: st.reason });
      } else if (old) {
        this.halt(it.symbol, `order ${it.id}: the venue reports ${st.filledQ} filled, its fill history shows ${it.filledQ}`);
      }
    }
  }

  private async comparePositions() {
    const L = this.journal.ledger;
    const differing = (held: Map<string, bigint>) =>
      Object.entries(this.cfg.symbols).filter(([symbol, c]) => L.unresolved(symbol).length === 0 && (held.get(c.venueSymbol) ?? 0n) !== L.position(symbol));
    let held = await this.venue.positions();
    if (differing(held).length) {
      // A fill may have landed between reading the history and reading the positions.
      await this.syncFills();
      held = await this.venue.positions();
    }
    for (const [symbol, c] of differing(held)) {
      this.halt(symbol, `position mismatch: the venue holds ${held.get(c.venueSymbol) ?? 0n}, the ledger ${L.position(symbol)}`);
    }
    for (const [venueSymbol, q] of held) {
      if (q !== 0n && !this.fromVenue.has(venueSymbol)) this.halt("*", `the account holds ${venueSymbol}, which this engine does not manage`);
    }
  }
}

/** Operator: accept the venue's position on `symbol` as the ledger's. */
export async function adopt(journal: Journal, venue: HedgeVenue, cfg: Config, symbol: string, by: string) {
  const c = cfg.symbols[symbol];
  if (!c) throw new Error(`${symbol} is not configured`);
  if (journal.ledger.unresolved(symbol).length) throw new Error(`${symbol} has an unresolved order; let it resolve first`);
  const positionQ = (await venue.positions()).get(c.venueSymbol) ?? 0n;
  // Booked at the venue's price now. Without one the position is taken over with no cost.
  const priceE6 = await venue.quote(c.venueSymbol).then(q => q.midE6, () => undefined);
  journal.append({ type: "adopt", symbol, positionQ, by, ...(priceE6 !== undefined && { priceE6 }) });
  return positionQ;
}

/** Operator: lift a halt (`scope` is a symbol, or "*"). */
export function resume(journal: Journal, scope: string, by: string) {
  if (!journal.ledger.halts.has(scope)) throw new Error(`${scope} is not halted`);
  journal.append({ type: "resume", scope, by });
}
