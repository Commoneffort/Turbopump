// The one seam to the outside: the venue the hedge is held on. The engine needs nothing from a
// venue beyond this interface. The mock and Hyperliquid's test network implement it.
//
// Sizes are in Percolator position units, prices in e6 dollars; an adapter converts. Every order
// is an immediate-or-cancel limit order: it fills at once, wholly or partly, or not at all, so
// the engine never has resting orders to manage.
import { Side } from "./units";

export type VenueMeta = {
  /** Sizes must be a multiple of this. */
  lotQ: bigint;
  /** Smallest order the venue accepts, in dollars (e6). */
  minNotionalE6: bigint;
  /** Prices must be a multiple of this. */
  tickE6: bigint;
};
export type Quote = { midE6: bigint; atMs: number };
export type VenueAccount = {
  equityE6: bigint;
  freeMarginE6: bigint;
  /** Margin the venue holds against the open positions. */
  marginUsedE6: bigint;
  /** The equity below which the venue closes the positions itself. */
  maintenanceE6: bigint;
};
/** Funding charged on (positive) or paid to (negative) the account for holding a position. */
export type FundingPayment = {
  fundingId: string;
  symbol: string;
  amountE6: bigint;
  atMs: number;
  /** Passing this to `funding` returns the payments after this one. */
  cursor: string;
};
export type OrderRequest = { clientId: string; symbol: string; side: Side; sizeQ: bigint; limitE6: bigint; reduceOnly: boolean };
/** `cancelled` with `filledQ > 0` is a partial fill whose rest was cancelled. */
export type OrderState = { clientId: string; status: "open" | "filled" | "cancelled" | "rejected"; filledQ: bigint; reason?: string };
export type VenueFill = {
  fillId: string;
  /** The id of the order that produced it, or null for a fill the account got some other way. */
  clientId: string | null;
  symbol: string;
  side: Side;
  sizeQ: bigint;
  priceE6: bigint;
  feeE6: bigint;
  atMs: number;
  /** Passing this to `fills` returns the fills after this one. */
  cursor: string;
};

export interface HedgeVenue {
  readonly name: string;
  meta(symbol: string): Promise<VenueMeta>;
  quote(symbol: string): Promise<Quote>;
  account(): Promise<VenueAccount>;
  /** Open positions by venue symbol (positive = long). Flat symbols may be left out. */
  positions(): Promise<Map<string, bigint>>;
  /** Sends an order. A second order with a `clientId` the venue has seen must not trade again.
   *  If this throws, the order may or may not have reached the venue. */
  place(o: OrderRequest): Promise<OrderState>;
  /** The state of an order by its client id, or null if the venue has never seen it. */
  order(clientId: string): Promise<OrderState | null>;
  /** The account's fills after `cursor` (all of them for null), oldest first. */
  fills(cursor: string | null): Promise<VenueFill[]>;
  /** The account's funding payments after `cursor` (all of them for null), oldest first. */
  funding(cursor: string | null): Promise<FundingPayment[]>;
}
