// Price history for the charts, at no cost: public exchange candles (no key, no account).
// The price a market trades at is its oracle's (Pyth on Solana, the exchange-median service on
// X1), which stays within a few hundredths of a percent of these; the page draws the last
// candle from the market's own price, and the indexer (scripts/indexer.ts), where it runs,
// replaces these with candles of the oracle price it recorded.
export type Candle = [t: number, o: number, h: number, l: number, c: number, v: number]; // t: unix seconds

export const RESOLUTIONS: Record<number, string> = { 60: "1m", 300: "5m", 900: "15m", 3600: "1h", 14400: "4h", 86400: "1d" };
/** The exchange market that tracks each symbol. Symbols not listed have no history to borrow. */
export const EXCHANGE_SYMBOL: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", DOGE: "DOGEUSDT", PYTH: "PYTHUSDT", ZEC: "ZECUSDT", XAU: "PAXGUSDT", EUR: "EURUSDT",
};
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
/** Markets the first exchange does not list, on a second one (USD pairs, its last 720 candles). */
export const SECOND_EXCHANGE_PAIR: Record<string, string> = { FARTCOIN: "FARTCOINUSD", HYPE: "HYPEUSD" };
/** Whether any exchange history can be borrowed for a symbol. */
export const hasHistory = (symbol: string) => !!(EXCHANGE_SYMBOL[symbol] || SECOND_EXCHANGE_PAIR[symbol]);

async function secondExchangeCandles(symbol: string, res: number, limit: number, f: typeof fetch): Promise<Candle[]> {
  const pair = SECOND_EXCHANGE_PAIR[symbol];
  if (!pair) return [];
  try {
    const r = await f(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${res / 60}`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return [];
    const j: any = await r.json();
    const key = Object.keys(j.result ?? {}).find(k => k !== "last");
    const rows: any[] = key ? j.result[key] : [];
    return rows.map(k => [k[0], +k[1], +k[2], +k[3], +k[4], +k[6]] as Candle).slice(-limit);
  } catch { return []; }
}

export async function exchangeCandles(symbol: string, res: number, limit = 500, f: typeof fetch = fetch): Promise<Candle[]> {
  const market = EXCHANGE_SYMBOL[symbol], interval = RESOLUTIONS[res];
  if (!interval) return [];
  if (!market) return secondExchangeCandles(symbol, res, limit, f);
  for (const host of HOSTS) {
    try {
      const r = await f(`${host}/api/v3/klines?symbol=${market}&interval=${interval}&limit=${Math.min(Math.max(limit, 1), 1000)}`, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) continue;
      const rows: any[] = await r.json();
      return rows.map(k => [Math.floor(k[0] / 1000), +k[1], +k[2], +k[3], +k[4], +k[5]]);
    } catch { /* next host */ }
  }
  return [];
}

/** Rolls candles up into wider ones (`res` seconds each). */
export function aggregate(candles: Candle[], res: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = c[0] - (c[0] % res);
    const last = out[out.length - 1];
    if (last && last[0] === t) {
      last[2] = Math.max(last[2], c[2]); last[3] = Math.min(last[3], c[3]); last[4] = c[4]; last[5] += c[5];
    } else out.push([t, c[1], c[2], c[3], c[4], c[5]]);
  }
  return out;
}
