// Indexer: records the oracle price of every listed market into one-minute candles, and serves
// chart candles from them. Free: it reads the same price service the X1 executor uses (and
// public exchange history for the time before it started). It sends no transaction and needs no key.
//
//   GET /candles?symbol=BTC&res=60&limit=500   -> { source, candles: [[t, o, h, l, c, v], ...] }
//   GET /health                                -> what it is recording, and since when
//
// Candles it recorded itself replace the exchange's for the same minutes; older ones are the
// exchange's. Its own are kept in deploy/indexer/<SYMBOL>.csv (one line per minute).
// It listens on this machine only (127.0.0.1): to serve the public site it has to be put behind
// the web server, and INDEXER_URL set for the site's /api/candles.
// Run: npx tsx scripts/indexer.ts     (SYMBOLS=BTC,ETH,SOL PORT=8791 JACK_URL=... to change)
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { Candle, RESOLUTIONS, aggregate, exchangeCandles } from "../api/_candles";

const JACK = process.env.JACK_URL ?? "http://jack0.x1.xyz:8090";
const JACK_SYMBOL: Record<string, string> = { XAU: "GOLD", XAG: "SILVER" };
const SYMBOLS = (process.env.SYMBOLS ?? "BTC,ETH,SOL").split(",");
const PORT = Number(process.env.PORT ?? 8791);
const DIR = process.env.INDEXER_DIR ?? new URL("../../deploy/indexer", import.meta.url).pathname;
const KEEP = 14 * 24 * 60; // minutes held in memory
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(0, 19), ...a);
fs.mkdirSync(DIR, { recursive: true });

const own = new Map<string, Candle[]>(); // finished minutes, oldest first
const live = new Map<string, Candle>();  // the minute in progress
let lastPriceAt = 0;

for (const s of SYMBOLS) {
  const file = path.join(DIR, `${s}.csv`);
  const rows: Candle[] = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => l.split(",").map(Number) as Candle).filter(c => c.length === 6 && c.every(Number.isFinite))
    : [];
  own.set(s, rows.slice(-KEEP));
}

function record(symbol: string, price: number, atSec: number) {
  const t = atSec - (atSec % 60);
  const cur = live.get(symbol);
  if (cur && cur[0] === t) { cur[2] = Math.max(cur[2], price); cur[3] = Math.min(cur[3], price); cur[4] = price; return; }
  if (cur && t < cur[0]) return; // a late quote for a minute already closed
  if (cur) {
    const list = own.get(symbol)!;
    list.push(cur);
    if (list.length > KEEP) list.shift();
    fs.appendFileSync(path.join(DIR, `${symbol}.csv`), cur.join(",") + "\n");
  }
  live.set(symbol, [t, price, price, price, price, 0]);
}

async function poll() {
  const names = SYMBOLS.map(s => (JACK_SYMBOL[s] ?? s).toLowerCase()).join(",");
  const r = await fetch(`${JACK}/v1/prices?symbols=${names}`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`price service: HTTP ${r.status}`);
  const j: any = await r.json();
  for (const p of j.prices ?? []) {
    if (p.status !== "ok" || !(p.price > 0)) continue; // only prices enough exchanges agree on
    const symbol = SYMBOLS.find(s => (JACK_SYMBOL[s] ?? s) === p.symbol);
    if (!symbol) continue;
    record(symbol, p.price, Math.floor(new Date(p.updatedAt).getTime() / 1000));
    lastPriceAt = Date.now();
  }
}

const cache = new Map<string, { at: number; rows: Candle[] }>();
async function history(symbol: string, res: number, limit: number): Promise<Candle[]> {
  const key = `${symbol}:${res}:${limit}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.rows;
  const rows = await exchangeCandles(symbol, res, limit);
  if (rows.length) cache.set(key, { at: Date.now(), rows });
  return rows.length ? rows : hit?.rows ?? [];
}

async function candles(symbol: string, res: number, limit: number): Promise<{ source: string; candles: Candle[] }> {
  const minutes = [...(own.get(symbol) ?? []), ...(live.has(symbol) ? [live.get(symbol)!] : [])];
  const mine = new Map(aggregate(minutes, res).map(c => [c[0], c]));
  // A bucket the indexer saw the whole of is its own. One it saw only the end of (it started
  // part-way through, or the bucket is still in progress) keeps the exchange's open and takes
  // the indexer's close, with the wider of the two ranges.
  const per = res / 60, count = new Map<number, number>(), lastMinute = new Map<number, number>();
  for (const m of minutes) {
    const t = m[0] - (m[0] % res);
    count.set(t, (count.get(t) ?? 0) + 1);
    lastMinute.set(t, m[0]);
  }
  const now = Math.floor(Date.now() / 1000);
  const merged = new Map<number, Candle>();
  for (const c of await history(symbol, res, limit)) merged.set(c[0], c);
  let used = 0;
  for (const [t, c] of mine) {
    const ex = merged.get(t);
    const toEnd = lastMinute.get(t)! >= Math.min(t + res, now - (now % 60)) - 60;
    if ((count.get(t) ?? 0) >= per || !ex) merged.set(t, [t, c[1], c[2], c[3], c[4], ex?.[5] ?? 0]);
    else if (toEnd) merged.set(t, [t, ex[1], Math.max(ex[2], c[2]), Math.min(ex[3], c[3]), c[4], ex[5]]);
    else continue;
    used++;
  }
  const out = [...merged.values()].sort((a, b) => a[0] - b[0]).slice(-limit);
  return { source: used ? (out.length > used ? "oracle+exchange" : "oracle") : "exchange", candles: out };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "public, max-age=3" }); res.end(JSON.stringify(body)); };
  try {
    if (u.pathname === "/health") {
      return send(200, { symbols: SYMBOLS, lastPriceSecondsAgo: lastPriceAt ? Math.round((Date.now() - lastPriceAt) / 1000) : null, minutes: Object.fromEntries(SYMBOLS.map(s => [s, own.get(s)!.length])), since: Object.fromEntries(SYMBOLS.map(s => [s, own.get(s)![0]?.[0] ?? null])) });
    }
    if (u.pathname === "/candles") {
      const symbol = (u.searchParams.get("symbol") ?? "").toUpperCase(), r = Number(u.searchParams.get("res") ?? 60);
      if (!RESOLUTIONS[r]) return send(400, { error: "unknown resolution" });
      return send(200, await candles(symbol, r, Math.min(Number(u.searchParams.get("limit") ?? 500) || 500, 1000)));
    }
    send(404, { error: "not found" });
  } catch (e: any) {
    send(500, { error: String(e?.message ?? e).slice(0, 120) });
  }
}).listen(PORT, "127.0.0.1", () => log(`indexer on 127.0.0.1:${PORT}, recording ${SYMBOLS.join(" ")} from ${JACK} into ${DIR}`));

let failing = false;
for (;;) {
  try { await poll(); if (failing) log("price service is back"); failing = false; }
  catch (e: any) { if (!failing) log(String(e?.message ?? e).slice(0, 100)); failing = true; }
  await new Promise(r => setTimeout(r, 2_000));
}
