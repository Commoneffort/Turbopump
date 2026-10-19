// Our own exchange-median price service: a stand-in for jack0.x1.xyz:8090, the X1 price service
// the executor reads on X1 (where there is no Pyth). It speaks the same stream format, so the
// executor can switch to it when that one stops answering (as it did for two days in October 2026).
//
//   GET /v1/stream/prices?symbols=eth,btc   server-sent events, one message a second:
//       {"type":"prices","timestamp":..,"data":[{"symbol":"ETH","price":..,"status":"ok",
//        "sourcesUsed":n,"sourcesTotal":m,"updatedAt":..}]}
//   GET /v1/prices?symbols=eth,btc           the same message, once
//   GET /                                    status per symbol and per exchange
//
// Prices are polled from public exchange APIs (no keys). Quotes in USDT are turned into USD with
// the USDT/USD price (USDT trades ~0.1% above USD, which would otherwise bias the median). A quote
// counts when it is under 5 s old and within 1% of the median of all fresh quotes; a price is "ok"
// with at least 3 such quotes.
// Run: PORT=8091 npx tsx scripts/price-service.ts   (listens on 127.0.0.1 only)
import * as http from "http";

const PORT = Number(process.env.PORT ?? 8091);
const FRESH_MS = 5_000, OUTLIER = 0.01, MIN_SOURCES = 3;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

type Quote = { price: number; at: number };
const quotes = new Map<string, Map<string, Quote>>(); // symbol -> exchange -> last quote
const errors = new Map<string, { at: number; what: string }>();
// The symbols polled (SYMBOLS=BTC,ETH,SOL by default).
const wanted = new Set((process.env.SYMBOLS ?? "BTC,ETH,SOL").split(",").map(s => s.toUpperCase()));
let usdt = { price: 1, at: 0 }; // USDT in USD

const get = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { "user-agent": "percolator-price-service" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<any>;
};
const put = (ex: string, symbol: string, price: number, inUsdt: boolean) => {
  if (!(price > 0) || !Number.isFinite(price)) return;
  if (inUsdt) { if (Date.now() - usdt.at > 60_000) return; price *= usdt.price; }
  (quotes.get(symbol) ?? quotes.set(symbol, new Map()).get(symbol)!).set(ex, { price, at: Date.now() });
};

// Each source: how often, and how to read every wanted symbol from it.
type Source = { name: string; every: number; poll: (symbols: string[]) => Promise<void> };
const each = (f: (s: string) => Promise<void>) => async (symbols: string[]) => { await Promise.all(symbols.map(s => f(s).catch(() => {}))); };
const SOURCES: Source[] = [
  { name: "coinbase", every: 1000, poll: each(async s => put("coinbase", s, Number((await get(`https://api.exchange.coinbase.com/products/${s}-USD/ticker`)).price), false)) },
  // (one pair per request: Kraken fails a whole list for one unknown pair)
  { name: "kraken", every: 2000, poll: each(async s => put("kraken", s, Number((Object.values<any>((await get(`https://api.kraken.com/0/public/Ticker?pair=${s === "BTC" ? "XBT" : s}USD`)).result ?? {})[0])?.c?.[0]), false)) },
  { name: "bitstamp", every: 1500, poll: each(async s => put("bitstamp", s, Number((await get(`https://www.bitstamp.net/api/v2/ticker/${s.toLowerCase()}usd/`)).last), false)) },
  { name: "gemini", every: 3000, poll: each(async s => put("gemini", s, Number((await get(`https://api.gemini.com/v1/pubticker/${s.toLowerCase()}usd`)).last), false)) },
  { name: "bitfinex", every: 2000, poll: async symbols => {
    const j = await get(`https://api-pub.bitfinex.com/v2/tickers?symbols=${symbols.map(s => `t${s}USD`).join(",")}`);
    for (const row of j) { const s = symbols.find(x => row[0] === `t${x}USD`); if (s) put("bitfinex", s, Number(row[7]), false); }
  } },
  { name: "okx", every: 1000, poll: each(async s => put("okx", s, Number((await get(`https://www.okx.com/api/v5/market/ticker?instId=${s}-USDT`)).data?.[0]?.last), true)) },
  { name: "bybit", every: 1000, poll: each(async s => put("bybit", s, Number((await get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${s}USDT`)).result?.list?.[0]?.lastPrice), true)) },
  { name: "kucoin", every: 1000, poll: each(async s => put("kucoin", s, Number((await get(`https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${s}-USDT`)).data?.price), true)) },
  { name: "mexc", every: 1000, poll: each(async s => put("mexc", s, Number((await get(`https://api.mexc.com/api/v3/ticker/price?symbol=${s}USDT`)).price), true)) },
];

/** USDT/USD from two USD venues (median of what answered). */
async function pollUsdt() {
  const got = (await Promise.all([
    get("https://api.exchange.coinbase.com/products/USDT-USD/ticker").then(j => Number(j.price)).catch(() => 0),
    get("https://api.kraken.com/0/public/Ticker?pair=USDTZUSD").then(j => Number((Object.values<any>(j.result ?? {})[0])?.c?.[0])).catch(() => 0),
    get("https://www.bitstamp.net/api/v2/ticker/usdtusd/").then(j => Number(j.last)).catch(() => 0),
  ])).filter(x => x > 0.9 && x < 1.1);
  if (got.length) usdt = { price: median(got), at: Date.now() };
}

function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; }

/** The service's view of one symbol, in jack0's format. */
function priceOf(symbol: string) {
  const now = Date.now();
  const all = [...(quotes.get(symbol) ?? new Map<string, Quote>()).values()];
  const fresh = all.filter(q => now - q.at < FRESH_MS);
  if (!fresh.length) return { symbol, price: 0, status: "no-data", sourcesUsed: 0, sourcesTotal: all.length, updatedAt: new Date(now).toISOString() };
  const m0 = median(fresh.map(q => q.price));
  const kept = fresh.filter(q => Math.abs(q.price / m0 - 1) <= OUTLIER);
  const price = median(kept.map(q => q.price));
  return { symbol, price, status: kept.length >= MIN_SOURCES ? "ok" : "too-few-sources", sourcesUsed: kept.length, sourcesTotal: SOURCES.length, updatedAt: new Date(Math.max(...kept.map(q => q.at))).toISOString() };
}
const message = (symbols: string[]) => JSON.stringify({ type: "prices", timestamp: new Date().toISOString(), data: symbols.map(priceOf) });
const symbolsOf = (url: URL) => (url.searchParams.get("symbols") ?? [...wanted].join(",")).split(",").map(s => s.trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s));

// Polling loops: one per source, each on its own clock; a failing exchange stops none of the others.
for (const src of SOURCES) (async () => {
  for (;;) {
    const t0 = Date.now();
    await src.poll([...wanted]).then(() => errors.delete(src.name)).catch(e => { if (!errors.has(src.name)) log(src.name, "failing:", String(e?.message ?? e).slice(0, 80)); errors.set(src.name, { at: Date.now(), what: String(e?.message ?? e).slice(0, 80) }); });
    await new Promise(r => setTimeout(r, Math.max(200, src.every - (Date.now() - t0))));
  }
})();
(async () => { for (;;) { await pollUsdt(); await new Promise(r => setTimeout(r, 15_000)); } })();

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const symbols = symbolsOf(url);
  // Only the SYMBOLS given at start are polled (asking for others gives "no-data"): each symbol
  // costs every exchange a request a second or two, and they rate-limit.
  if (url.pathname === "/v1/stream/prices") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    const tick = setInterval(() => res.write(`data: ${message(symbols)}\n\n`), 1000);
    req.on("close", () => clearInterval(tick));
    return;
  }
  if (url.pathname === "/v1/prices") { res.writeHead(200, { "content-type": "application/json" }); res.end(message(symbols)); return; }
  if (url.pathname === "/") {
    const now = Date.now();
    const out = { usdt: usdt.price, symbols: [...wanted].map(s => ({ ...priceOf(s), quotes: Object.fromEntries([...(quotes.get(s) ?? [])].map(([ex, q]) => [ex, { price: q.price, ageMs: now - q.at }])) })), failing: Object.fromEntries(errors) };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out, null, 1)); return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, "127.0.0.1", () => log(`price service on 127.0.0.1:${PORT}, ${SOURCES.length} exchanges, symbols ${[...wanted].join(",")}`));
