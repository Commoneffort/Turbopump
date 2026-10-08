// Units shared by every module. Sizes are in Percolator position units (1e6 per whole token);
// prices and dollar amounts are in millionths of a dollar. Everything is a bigint, so nothing is
// rounded except where the code says so.
export const UNIT = 1_000_000n;
export const USD = 1_000_000n;

export type Side = "buy" | "sell";
export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };

export const abs = (x: bigint) => (x < 0n ? -x : x);
export const sgn = (x: bigint) => (x > 0n ? 1 : x < 0n ? -1 : 0);
export const bmin = (a: bigint, b: bigint) => (a < b ? a : b);
export const bmax = (a: bigint, b: bigint) => (a > b ? a : b);
export const signed = (side: Side, q: bigint) => (side === "buy" ? q : -q);
/** Dollar value (e6) of a size at a price. Rounded down. */
export const notional = (q: bigint, priceE6: bigint) => abs(q) * priceE6 / UNIT;
/** The size a dollar amount (e6) buys at a price. Rounded down. */
export const unitsFor = (notionalE6: bigint, priceE6: bigint) => notionalE6 * UNIT / priceE6;
/** Rounds a signed size toward zero to a multiple of `lot`. */
export const floorTo = (q: bigint, lot: bigint) => q - (q % lot);

export const usd = (e6: bigint) => `${e6 < 0n ? "-" : ""}$${(Number(abs(e6)) / 1e6).toFixed(2)}`;
export const qty = (q: bigint) => (Number(q) / 1e6).toString();
export const errorText = (e: unknown) => String((e as any)?.message ?? e).split("\n")[0].slice(0, 200);
