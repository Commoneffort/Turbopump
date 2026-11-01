// Execution quality, measured from the chain alone: every trade request on each market in a
// recent window, matched to what became of it (filled, refused, expired), and compared with the
// oracle prices posted on chain (X1) and with an outside exchange's one-second prices.
// Used by /api/execution (the Execution page) and by scripts/exec-quality.ts, so anyone with an
// RPC address can check the numbers. Reads only; needs no key.
import L from "./_layout.js";
import { FEED_SYMBOLS, ROUTER, VAULT_PROGRAM } from "./_config.js";
import { EXCHANGE_SYMBOL } from "./_candles.js";

// ---- small readers ----

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = ALPHABET.indexOf(c); if (i < 0) throw new Error("base58"); n = n * 58n + BigInt(i); }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
const hex = (d: Uint8Array) => Array.from(d, b => b.toString(16).padStart(2, "0")).join("");
const u64 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);
const i128 = (d: Uint8Array, o: number) => { const lo = u64(d, o), hi = new DataView(d.buffer, d.byteOffset).getBigInt64(o + 8, true); return (hi << 64n) + lo; };
const u16 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getUint16(o, true);
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export async function rpc(url: string, method: string, params: any[], tries = 3): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
      const j: any = r.status === 429 ? { error: { message: "rate limited" } } : await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await new Promise(ok => setTimeout(ok, 500 * (i + 1)));
    }
  }
}
/** Transactions by signature, several to a request (the X1 RPC refuses large bodies). */
export async function transactions(url: string, sigs: string[], batch: number, parallel: number): Promise<any[]> {
  const out: any[] = new Array(sigs.length);
  const parts: number[] = [];
  for (let i = 0; i < sigs.length; i += batch) parts.push(i);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const start = parts[next++];
      const body = sigs.slice(start, start + batch).map((s, k) => ({ jsonrpc: "2.0", id: k, method: "getTransaction", params: [s, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }));
      for (let t = 0; t < 3; t++) {
        try {
          const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
          if (r.status === 429) throw new Error("rate limited");
          const j: any[] = await r.json();
          for (const x of j) out[start + x.id] = x.result;
          break;
        } catch { await new Promise(ok => setTimeout(ok, 600 * (t + 1))); }
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return out;
}

// ---- what is measured ----

export type Kind = "trade" | "close" | "order" | "copy";
export type Row = {
  market: string; kind: Kind; wallet: string; at: number; sig: string;
  outcome: "filled" | "refused" | "expired" | "open";
  /** Queued by someone else than the trader to close the position: a liquidation. */
  liquidation: boolean;
  doneAt?: number; doneSig?: string; executor?: string;
  /** What traded (units, + = trader bought) and at what price (dollars). */
  traded?: number; price?: number;
  /** The oracle price when the request landed, and the exchange price when the fill's oracle price was published. */
  markAtRequest?: number; exchangeAtFill?: number;
  slipBps?: number; devBps?: number; markout60?: number; markout300?: number;
  /** A standing order: seconds from its price level being reached to its trade being queued, and how far past its level it filled (bps, + = worse). */
  triggerDelay?: number; levelGapBps?: number; orderKind?: number;
  /** Who carried a standing order or copy out (queued its trade). */
  triggeredBy?: string;
  /** A standing order's trade: how many attempts it took to carry it out (failed ones + 1). */
  attempts?: number;
  /** The request account (to match a fill's spare version to its twin). */
  reqKey?: string;
};
/** One executor (whoever signed the router's work): what it did, how often it failed, how fast
 *  its fills were, how much of the time it was at work, and what it was paid for it. */
export type Executor = {
  key: string; fills: number; refused: number; triggers: number; liquidations: number; expiries: number; cleanups: number;
  /** Its transactions rejected on chain for a real reason. */
  failed: number;
  /** Spare versions: a fill goes out in two versions on purpose (one per possible landing slot);
   *  the one that does not fit fails while its twin fills the same request. Not a failure. */
  spare: number;
  medianFillSecs?: number; activeShare: number; firstAt: number; lastAt: number;
  /** Lamports earned: the bonds of its fills, and the router's keeper rewards (logged). */
  rewards: number; rewardsBy: Record<string, number>;
};
export type Stats = {
  requests: number; filled: number; refused: number; expired: number; open: number;
  txs: number; failedTxs: number; volume: number;
  latency?: { median: number; p90: number; n: number };
  /** |fill − exchange| in bps, and the signed mean (+ = fills above the exchange). */
  deviation?: { median: number; p90: number; max: number; mean: number; n: number };
  oracleMatch?: { n: number; mismatches: number };
  slippage?: { mean: number; median: number; p90abs: number; worse: number; n: number };
  markout?: { s60?: number; s300?: number; n60: number; n300: number };
  liquidations: { n: number; medianSecs?: number; meanSlipBps?: number; expired: number };
  triggers: { n: number; medianDelay?: number; p90Delay?: number; medianGapBps?: number; nGap: number };
  /** Conditional-order integrity: of the standing orders carried out, how many filled, traded
   *  nothing or expired; from carrying out to fill; the fill against the order's own price level;
   *  and how many attempts carrying one out took. */
  orders: { n: number; filled: number; refused: number; expired: number; medianToFill?: number; p90ToFill?: number; p90GapAbsBps?: number; meanAttempts?: number; retried: number };
  executors: { key: string; fills: number; triggers: number }[];
};
export type Report = {
  network: string; at: number; delaySecs: number; batchSecs: number;
  priceSource: string; exchangeSource: string;
  markets: { symbol: string; vault: string; from: number; to: number; stats: Stats }[];
  /** Markets the RPC would not list transactions for this time. */
  skipped: string[];
  /** Transactions that could not be read (the counts above leave them out). */
  unread: number;
  total: Stats; recent: Row[];
  /** Every executor seen in the window, network-wide (most fills first). */
  executors: Executor[];
  /** Every forced close that traded in the window: when, what the trader bought (+, a short
   *  closed) or sold (−, a long closed), and at what price. */
  liqFills: { market: string; at: number; size: number; price: number }[];
};

const quantile = (xs: number[], q: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };

function stats(rows: Row[], txs: number, failedTxs: number): Stats {
  const ended = rows.filter(r => r.outcome !== "open");
  const filled = rows.filter(r => r.outcome === "filled");
  const lat = filled.map(r => r.doneAt! - r.at).filter(x => x >= 0);
  const devSigned = filled.flatMap(r => (r.devBps !== undefined ? [r.devBps] : [])), dev = devSigned.map(Math.abs);
  const slip = filled.flatMap(r => (r.slipBps !== undefined ? [r.slipBps] : []));
  // Notional-weighted: what traders gained per dollar traded once the price had moved on.
  const wavg = (key: "markout60" | "markout300") => {
    const xs = filled.filter(r => r[key] !== undefined);
    const w = xs.reduce((t, r) => t + Math.abs(r.traded! * r.price!), 0);
    return { v: w > 0 ? xs.reduce((t, r) => t + r[key]! * Math.abs(r.traded! * r.price!), 0) / w : undefined, n: xs.length };
  };
  const m60 = wavg("markout60"), m300 = wavg("markout300");
  const liq = rows.filter(r => r.liquidation);
  const liqFilled = liq.filter(r => r.outcome === "filled");
  const trig = rows.filter(r => r.triggerDelay !== undefined);
  const gaps = rows.flatMap(r => (r.levelGapBps !== undefined ? [r.levelGapBps] : []));
  const ex = new Map<string, { fills: number; triggers: number }>();
  for (const r of rows) {
    if (r.outcome === "filled" && r.executor) { const e = ex.get(r.executor) ?? { fills: 0, triggers: 0 }; e.fills++; ex.set(r.executor, e); }
    if (r.triggeredBy) { const e = ex.get(r.triggeredBy) ?? { fills: 0, triggers: 0 }; e.triggers++; ex.set(r.triggeredBy, e); }
  }
  return {
    requests: ended.length + rows.filter(r => r.outcome === "open").length,
    filled: filled.length, refused: rows.filter(r => r.outcome === "refused").length, expired: rows.filter(r => r.outcome === "expired").length, open: rows.filter(r => r.outcome === "open").length,
    txs, failedTxs,
    volume: filled.reduce((t, r) => t + Math.abs(r.traded! * r.price!), 0),
    latency: lat.length ? { median: quantile(lat, 0.5), p90: quantile(lat, 0.9), n: lat.length } : undefined,
    deviation: dev.length ? { median: quantile(dev, 0.5), p90: quantile(dev, 0.9), max: Math.max(...dev), mean: devSigned.reduce((a, b) => a + b, 0) / devSigned.length, n: dev.length } : undefined,
    slippage: slip.length ? { mean: slip.reduce((a, b) => a + b, 0) / slip.length, median: quantile(slip, 0.5), p90abs: quantile(slip.map(Math.abs), 0.9), worse: slip.filter(x => x > 0).length / slip.length, n: slip.length } : undefined,
    markout: m60.n || m300.n ? { s60: m60.v, s300: m300.v, n60: m60.n, n300: m300.n } : undefined,
    liquidations: {
      n: liqFilled.length,
      medianSecs: liqFilled.length ? quantile(liqFilled.map(r => r.doneAt! - r.at), 0.5) : undefined,
      meanSlipBps: liqFilled.some(r => r.slipBps !== undefined) ? liqFilled.flatMap(r => (r.slipBps !== undefined ? [r.slipBps] : [])).reduce((a, b, _, xs) => a + b / xs.length, 0) : undefined,
      expired: liq.filter(r => r.outcome === "expired").length,
    },
    triggers: {
      n: trig.length,
      medianDelay: trig.length ? quantile(trig.map(r => r.triggerDelay!), 0.5) : undefined,
      p90Delay: trig.length ? quantile(trig.map(r => r.triggerDelay!), 0.9) : undefined,
      medianGapBps: gaps.length ? quantile(gaps, 0.5) : undefined, nGap: gaps.length,
    },
    executors: [...ex].map(([key, e]) => ({ key, ...e })).sort((a, b) => b.fills - a.fills),
    orders: (() => {
      const o = rows.filter(r => r.kind === "order" && r.outcome !== "open");
      const f = o.filter(r => r.outcome === "filled");
      const toFill = f.map(r => r.doneAt! - r.at).filter(x => x >= 0);
      const at = o.flatMap(r => (r.attempts !== undefined ? [r.attempts] : []));
      return {
        n: o.length, filled: f.length, refused: o.filter(r => r.outcome === "refused").length, expired: o.filter(r => r.outcome === "expired").length,
        medianToFill: toFill.length ? quantile(toFill, 0.5) : undefined, p90ToFill: toFill.length ? quantile(toFill, 0.9) : undefined,
        p90GapAbsBps: gaps.length ? quantile(gaps.map(Math.abs), 0.9) : undefined,
        meanAttempts: at.length ? at.reduce((a, b) => a + b, 0) / at.length : undefined, retried: at.filter(x => x > 1).length,
      };
    })(),
  };
}

/** A price series, oldest first; the price at a time is the last one at or before it. */
class Series {
  t: number[] = []; p: number[] = [];
  constructor(points: [number, number][]) { points.sort((a, b) => a[0] - b[0]); for (const [t, p] of points) { this.t.push(t); this.p.push(p); } }
  at(time: number, maxAge = 30): number | undefined {
    let lo = 0, hi = this.t.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.t[m] <= time) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 && time - this.t[k] <= maxAge ? this.p[k] : undefined;
  }
  get last() { return this.t.length ? this.t[this.t.length - 1] : 0; }
}

/** One-second closes from the exchange for the seconds asked about (in 1,000-second blocks, newest first, at most `cap` blocks). */
async function exchangeSeconds(symbol: string, seconds: number[], cap: number): Promise<Series | undefined> {
  const market = symbol === "USDC" ? "USDCUSDT" : EXCHANGE_SYMBOL[symbol];
  if (!market || !seconds.length) return undefined;
  const blocks = [...new Set(seconds.map(s => Math.floor(s / 1000)))].sort((a, b) => b - a).slice(0, cap);
  const points: [number, number][] = [];
  await Promise.all(blocks.map(async b => {
    for (const host of ["https://data-api.binance.vision", "https://api.binance.com"]) {
      try {
        const r = await fetch(`${host}/api/v3/klines?symbol=${market}&interval=1s&startTime=${b * 1_000_000}&endTime=${(b * 1000 + 999) * 1000}&limit=1000`, { signal: AbortSignal.timeout(8_000) });
        if (!r.ok) continue;
        for (const k of (await r.json()) as any[]) points.push([Math.floor(k[0] / 1000), +k[4]]);
        return;
      } catch { /* next host */ }
    }
  }));
  return points.length ? new Series(points) : undefined;
}

export type Options = { rpc: string; market: string; network: string; x1: boolean; sigsPerMarket?: number; batch?: number; parallel?: number; exchangeBlocks?: number };

/** The open canonical vaults of a market. */
export async function openVaults(url: string, market: string): Promise<{ key: string; feed: string; asset: number; symbol: string }[]> {
  const V: any = (L as any).vault;
  const accs: any[] = await rpc(url, "getProgramAccounts", [VAULT_PROGRAM, { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: (L as any).vault_len }, { memcmp: { offset: V.market, bytes: market } }] }]);
  return accs.map(a => ({ key: a.pubkey as string, d: fromB64(a.account.data[0]) }))
    .filter(v => v.d[V.status] === 1 && v.d[V.vault_kind] === 1)
    .map(v => ({ key: v.key, feed: hex(v.d.slice(V.oracle_feeds, V.oracle_feeds + 32)), asset: u16(v.d, V.asset_index) }))
    .map(v => ({ ...v, symbol: FEED_SYMBOLS[v.feed] ?? `asset ${v.asset}` }));
}

export async function measure(o: Options): Promise<Report> {
  const now = Math.floor(Date.now() / 1000);
  const R: any = (L as any).router;
  const vaults = await openVaults(o.rpc, o.market);
  const bySymbol = new Map(vaults.map(v => [v.key, v.symbol]));
  const feedSymbol = (f: string) => FEED_SYMBOLS[f];

  // Each market's recent transactions (a transaction can touch several markets: read once).
  const limit = o.sigsPerMarket ?? (o.x1 ? 1000 : 300);
  // One market at a time where the RPC is strict (public Solana devnet); a market it refuses is left out.
  const lists: any[][] = [];
  const skipped: string[] = [];
  for (const v of vaults) {
    try { lists.push(await rpc(o.rpc, "getSignaturesForAddress", [v.key, { limit, commitment: "confirmed" }], 4)); }
    catch { lists.push([]); skipped.push(v.symbol); }
  }
  const window = new Map<string, { from: number; to: number; txs: number; failed: number }>();
  const sigs = new Map<string, number>();
  vaults.forEach((v, i) => {
    const l: any[] = lists[i] ?? [];
    window.set(v.symbol, { from: l.length ? l[l.length - 1].blockTime ?? now : now, to: l.length ? l[0].blockTime ?? now : now, txs: l.length, failed: l.filter(s => s.err).length });
    for (const s of l) sigs.set(s.signature, s.slot);
  });
  const order = [...sigs.keys()].sort((a, b) => sigs.get(a)! - sigs.get(b)!);
  const txs = (await transactions(o.rpc, order, o.batch ?? (o.x1 ? 20 : 10), o.parallel ?? (o.x1 ? 6 : 2))).map((tx, i) => ({ tx, sig: order[i] })).filter(x => x.tx);

  // Walk them in order: requests opened, standing orders placed, oracle prices posted, fills, expiries.
  const rows: Row[] = [];
  const open = new Map<string, Row>();
  const placed = new Map<string, { at: number; kind: number; size: bigint; trigger: number }>();
  const oracle = new Map<string, [number, number][]>();
  const fillPublish = new Map<Row, number>();
  const triggerAt = new Map<Row, { orderKey: string; at: number }>();
  // Executors: by key, what each did; failed attempts to carry each order out since its last success.
  const exec = new Map<string, Executor & { buckets: Set<number> }>();
  const ex = (k: string, at: number) => {
    let e = exec.get(k);
    if (!e) { e = { key: k, fills: 0, refused: 0, triggers: 0, liquidations: 0, expiries: 0, cleanups: 0, failed: 0, spare: 0, activeShare: 0, firstAt: at, lastAt: at, rewards: 0, rewardsBy: {}, buckets: new Set() }; exec.set(k, e); }
    e.firstAt = Math.min(e.firstAt, at); e.lastAt = Math.max(e.lastAt, at);
    return e;
  };
  const allBuckets = new Set<number>();
  const BUCKET = 600;
  const failedTries = new Map<string, number>();
  const failedFills: { payer: string; at: number; reqs: string[]; markets: string[] }[] = [];
  const spareIn = new Map<string, number>();
  const bond: number = o.x1 ? 20_000_000 : R.bond_lamports;
  for (const { tx, sig } of txs) {
    const msg = tx.transaction.message, meta = tx.meta;
    const keys: string[] = [...msg.accountKeys, ...(meta?.loadedAddresses?.writable ?? []), ...(meta?.loadedAddresses?.readonly ?? [])];
    const at: number = tx.blockTime ?? 0;
    const routerIxs = msg.instructions.filter((ix: any) => keys[ix.programIdIndex] === ROUTER);
    if (!routerIxs.length) continue;
    // A failed transaction: counted against whoever paid for it, and, for an attempt to carry an
    // order out, against that order. Nothing else in it happened.
    if (meta?.err) {
      // (Only executor work: fills, expiries, forced closes, carrying out orders and copies. A
      // trader's own refused request is not an executor's failure.)
      // A failed fill is matched with its twin below (it may be a spare version).
      const fills = routerIxs.filter((ix: any) => b58(ix.data)[0] === 6);
      if (fills.length) failedFills.push({ payer: keys[0], at, reqs: fills.map((ix: any) => keys[ix.accounts[1]]), markets: [...new Set(fills.map((ix: any) => bySymbol.get(keys[ix.accounts[5]])).filter(Boolean))] as string[] });
      else if (routerIxs.some((ix: any) => [7, 8, 14, 21].includes(b58(ix.data)[0]))) ex(keys[0], at).failed++;
      for (const ix of routerIxs) if (b58(ix.data)[0] === 14) { const k = keys[ix.accounts[1]]; failedTries.set(k, (failedTries.get(k) ?? 0) + 1); }
      continue;
    }
    { const e = ex(keys[0], at); e.buckets.add(Math.floor(at / BUCKET)); allBuckets.add(Math.floor(at / BUCKET)); }
    for (const l of (meta?.logMessages ?? []) as string[]) {
      const m = /^Program log: reward (\w+) (\d+)$/.exec(l);
      if (m) { const e = ex(keys[0], at); e.rewards += +m[2]; e.rewardsBy[m[1]] = (e.rewardsBy[m[1]] ?? 0) + +m[2]; if (m[1] === "cleanup") e.cleanups++; }
    }
    const fillLogs = (meta?.logMessages ?? []).filter((l: string) => l.startsWith("Program log: fill ")).map((l: string) => l.split(" ").slice(3).map(Number));
    let fillN = 0;
    const created = (i: number) => !!meta && meta.preBalances[i] === 0 && meta.postBalances[i] > 0;
    let publishedHere: number | undefined;
    for (const ix of msg.instructions) {
      if (keys[ix.programIdIndex] !== ROUTER) continue;
      const d = b58(ix.data), a = (k: number) => keys[ix.accounts[k]];
      const tag = d[0];
      if (tag === 11 && d.length >= 49) {
        const sym = feedSymbol(hex(d.slice(1, 33)));
        const publish = Number(u64(d, 41)), price = Number(u64(d, 33)) / 1e6;
        if (sym) (oracle.get(sym) ?? oracle.set(sym, []).get(sym)!).push([publish, price]);
        publishedHere = publish;
      } else if (tag === 12 && (d.length === 48 || d.length === 56)) {
        placed.set(a(4), { at, kind: d[2], size: i128(d, 4), trigger: Number(u64(d, 20)) / 1e6 });
      } else if (tag === 4 || tag === 8 || tag === 14 || tag === 21) {
        const reqIdx = tag === 4 ? 4 : tag === 8 ? 5 : 6;
        if (!created(ix.accounts[reqIdx])) continue; // a trail noting a better price, or nothing queued
        const vault = tag === 4 ? a(2) : tag === 8 ? a(3) : a(4);
        const market = bySymbol.get(vault);
        if (!market) continue;
        const wallet = tag === 4 ? a(0) : tag === 8 ? a(2) : a(3);
        const row: Row = { market, kind: tag === 4 ? "trade" : tag === 8 ? "close" : tag === 14 ? "order" : "copy", wallet, at, sig, outcome: "open", liquidation: tag === 8 && a(0) !== wallet };
        row.reqKey = a(reqIdx);
        open.set(a(reqIdx), row);
        rows.push(row);
        if (tag === 14) {
          triggerAt.set(row, { orderKey: a(1), at });
          row.attempts = 1 + (failedTries.get(a(1)) ?? 0);
          failedTries.delete(a(1));
          ex(a(0), at).triggers++;
        }
        if (tag === 21) ex(a(0), at).triggers++;
        if (tag === 14 || tag === 21) row.triggeredBy = a(0);
        if (row.liquidation) ex(a(0), at).liquidations++;
      } else if (tag === 6) {
        const row = open.get(a(1));
        const log = fillLogs[fillN++];
        if (!row || !log) continue;
        open.delete(a(1));
        const [, traded, price] = log;
        row.doneAt = at; row.doneSig = sig; row.executor = a(0);
        { const e = ex(a(0), at); e.rewards += bond; e.rewardsBy.fill = (e.rewardsBy.fill ?? 0) + bond; if (traded === 0) e.refused++; else e.fills++; }
        if (traded === 0) { row.outcome = "refused"; continue; }
        row.outcome = "filled"; row.traded = traded / 1e6; row.price = price / 1e6;
        if (publishedHere !== undefined) fillPublish.set(row, publishedHere);
      } else if (tag === 7) {
        const row = open.get(a(1));
        if (!row) continue;
        open.delete(a(1));
        row.outcome = "expired"; row.doneAt = at; row.doneSig = sig;
        ex(a(0), at).expiries++;
      }
    }
  }

  // A failed fill whose request the same executor filled within 20 s is the spare version of
  // that fill (sent on purpose, see `Executor.spare`); any other is a failure.
  const filledBy = new Map<string, Row[]>();
  for (const r of rows) if (r.reqKey && r.doneAt && r.executor && r.outcome !== "expired") (filledBy.get(r.reqKey) ?? filledBy.set(r.reqKey, []).get(r.reqKey)!).push(r);
  for (const f of failedFills) {
    const twin = f.reqs.every(q => (filledBy.get(q) ?? []).some(r => r.executor === f.payer && Math.abs(r.doneAt! - f.at) <= 20));
    if (twin) { ex(f.payer, f.at).spare++; for (const m of f.markets) spareIn.set(m, (spareIn.get(m) ?? 0) + 1); } else ex(f.payer, f.at).failed++;
  }

  // Prices: the oracle's as posted on chain (X1), and the exchange's one-second closes.
  const oracleSeries = new Map([...oracle].map(([s, p]) => [s, new Series(p)]));
  const exchange = new Map<string, Series | undefined>();
  // The exchange quotes in USDT, which is not exactly a dollar: its prices are turned into
  // dollars with its USDC/USDT rate of the same second (USDC is redeemable for a dollar).
  const needed = (sym?: string) => rows.filter(r => (!sym || r.market === sym) && r.outcome === "filled").flatMap(r => [r.at, fillPublish.get(r) ?? r.doneAt! - 1, r.doneAt! + 60, r.doneAt! + 300]).filter(t => t < now - 2);
  const usdt = await exchangeSeconds("USDC", needed(), (o.exchangeBlocks ?? 14) * 2);
  await Promise.all(vaults.map(async v => {
    const raw = await exchangeSeconds(v.symbol, needed(v.symbol), o.exchangeBlocks ?? 14);
    if (!raw || !usdt) { exchange.set(v.symbol, undefined); return; }
    const pts: [number, number][] = [];
    raw.t.forEach((t, i) => { const r = usdt.at(t, 60); if (r) pts.push([t, raw.p[i] / r]); });
    exchange.set(v.symbol, pts.length ? new Series(pts) : undefined);
  }));
  // The price traders are measured against: the oracle where it is on chain, else the exchange.
  const ref = (sym: string) => oracleSeries.get(sym) ?? exchange.get(sym);
  const mismatch = { n: 0, bad: 0 };
  for (const r of rows) {
    const s = ref(r.market), ex = exchange.get(r.market);
    if (r.outcome === "filled" || r.liquidation) r.markAtRequest = s?.at(r.at);
    if (r.outcome !== "filled") continue;
    const side = Math.sign(r.traded!), p = r.price!;
    if (r.markAtRequest) r.slipBps = side * (p - r.markAtRequest) / r.markAtRequest * 1e4;
    const pub = fillPublish.get(r) ?? r.doneAt! - 1;
    const exP = ex?.at(pub, 3);
    if (exP) { r.exchangeAtFill = exP; r.devBps = (p - exP) / exP * 1e4; }
    // The fill price should be exactly an oracle price that was posted.
    // (Some price posted on chain between the request and its fill must be exactly this price.)
    const os = oracleSeries.get(r.market);
    if (os) {
      mismatch.n++;
      let ok = false;
      for (let k = 0; k < os.t.length && !ok; k++) if (os.t[k] >= r.at - 10 && os.t[k] <= r.doneAt! && Math.abs(os.p[k] - p) <= 1e-6 * p) ok = true;
      if (!ok) mismatch.bad++;
    }
    const later = (h: number) => { if (r.doneAt! + h > (s?.last ?? 0)) return undefined; const q = s!.at(r.doneAt! + h, 60); return q ? side * (q - p) / p * 1e4 : undefined; };
    r.markout60 = later(60); r.markout300 = later(300);
  }
  // Standing orders: how long after its level was reached each was carried out, and how far past it the fill came.
  for (const [r, t] of triggerAt) {
    const pl = placed.get(t.orderKey);
    if (!pl || pl.at > t.at) continue;
    r.orderKind = pl.kind;
    if (r.outcome === "filled" && pl.kind <= 3 && pl.kind !== 2) r.levelGapBps = Math.sign(r.traded!) * (r.price! - pl.trigger) / pl.trigger * 1e4;
    const s = oracleSeries.get(r.market);
    if (!s || pl.kind === 2 || pl.kind > 3 || r.outcome !== "filled") continue;
    // The order's side: a protective order closes (sells a long), a limit trades its own size.
    const buys = r.traded! > 0;
    const hit = (p: number) => (pl.kind === 3 ? (pl.size > 0n ? p <= pl.trigger : p >= pl.trigger)
      : pl.kind === 0 ? (buys ? p >= pl.trigger : p <= pl.trigger) : (buys ? p <= pl.trigger : p >= pl.trigger));
    for (let k = 0; k < s.t.length; k++) {
      if (s.t[k] < pl.at - 30 || s.t[k] > t.at) continue;
      if (hit(s.p[k])) { r.triggerDelay = Math.max(0, t.at - Math.max(s.t[k], pl.at)); break; }
    }
  }

  const markets = vaults.map(v => {
    const w = window.get(v.symbol)!;
    const mine = rows.filter(r => r.market === v.symbol && r.at >= w.from);
    // (A fill's spare version is not counted as a failed transaction: see `Executor.spare`.)
    const spare = spareIn.get(v.symbol) ?? 0;
    return { symbol: v.symbol, vault: v.key, from: w.from, to: w.to, stats: stats(mine, w.txs - spare, Math.max(0, w.failed - spare)) };
  });
  const total = stats(rows.filter(r => r.at >= (window.get(r.market)?.from ?? 0)), markets.reduce((t, m) => t + m.stats.txs, 0), markets.reduce((t, m) => t + m.stats.failedTxs, 0));
  if (mismatch.n) total.oracleMatch = { n: mismatch.n, mismatches: mismatch.bad };
  return {
    network: o.network, at: now, delaySecs: R.delay_secs, batchSecs: R.batch_secs ?? 1,
    priceSource: oracleSeries.size ? "oracle prices posted on chain" : "exchange one-second prices",
    exchangeSource: "Binance one-second closes, in dollars through its USDC/USDT rate",
    markets: markets.filter(m => !skipped.includes(m.symbol)), total, skipped, unread: order.length - txs.length,
    recent: rows.filter(r => r.outcome !== "open").slice(-60).reverse().map(({ reqKey, ...r }) => r),
    liqFills: rows.filter(r => r.liquidation && r.outcome === "filled").map(r => ({ market: r.market, at: r.doneAt!, size: r.traded!, price: r.price! })),
    executors: [...exec.values()].map(({ buckets, ...e }) => {
      const lat = rows.filter(r => r.outcome === "filled" && r.executor === e.key).map(r => r.doneAt! - r.at).filter(x => x >= 0);
      return { ...e, activeShare: allBuckets.size ? buckets.size / allBuckets.size : 0, medianFillSecs: lat.length ? quantile(lat, 0.5) : undefined };
    }).filter(e => e.fills + e.refused + e.triggers + e.liquidations + e.expiries + e.cleanups > 0).sort((a, b) => b.fills - a.fills || b.triggers - a.triggers),
  };
}
