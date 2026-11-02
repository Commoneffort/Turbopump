// Downloads Hyperliquid's public price history and funding rates for the hedge demo.
// Read-only: two public "info" requests, no key, no account, no orders. It lives outside src/
// on purpose: nothing in src/ may name the real exchange (test/chain.test.ts checks that).
//
// Run: npx tsx demo/fetch-hl.ts [days=14]
// Writes demo/data/<COIN>.json = { candles: [t, o, h, l, c][], funding: [t, rate][] }
import * as fs from "fs";

const INFO = "https://api.hyperliquid.xyz/info";
const COINS = ["BTC", "ETH", "SOL"];
const days = Number(process.argv[2] ?? 14);
const end = Date.now();
const start = end - days * 86_400_000;

async function info(body: unknown): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return r.json();
    if (i >= 4) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    await new Promise(res => setTimeout(res, 1000 * 2 ** i));
  }
}

const dir = new URL("./data/", import.meta.url).pathname;
fs.mkdirSync(dir, { recursive: true });
for (const coin of COINS) {
  // Hyperliquid keeps the last 5,000 candles of each interval: 5-minute candles cover 17 days.
  const candles: [number, number, number, number, number][] = [];
  for (let from = start; from < end;) {
    const got: any[] = await info({ type: "candleSnapshot", req: { coin, interval: "5m", startTime: from, endTime: end } });
    if (!got.length) break;
    for (const c of got) if (!candles.length || c.t > candles[candles.length - 1][0]) candles.push([c.t, +c.o, +c.h, +c.l, +c.c]);
    const last = got[got.length - 1].t;
    if (last <= from) break;
    from = last + 1;
  }
  const funding: [number, number][] = [];
  for (let from = start; from < end;) {
    const got: any[] = await info({ type: "fundingHistory", coin, startTime: from, endTime: end });
    if (!got.length) break;
    for (const f of got) funding.push([f.time, +f.fundingRate]);
    const last = got[got.length - 1].time;
    if (last <= from) break;
    from = last + 1;
  }
  // The last candle is still open: drop it.
  if (candles.length && candles[candles.length - 1][0] + 300_000 > end) candles.pop();
  fs.writeFileSync(`${dir}${coin}.json`, JSON.stringify({ coin, interval: "5m", fetchedAt: end, candles, funding }));
  const first = candles[0], last = candles[candles.length - 1];
  console.log(`${coin}: ${candles.length} candles ${new Date(first[0]).toISOString().slice(0, 16)} .. ${new Date(last[0]).toISOString().slice(0, 16)}, ${first[4]} -> ${last[4]}, ${funding.length} funding hours`);
}
