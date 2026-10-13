// What the page shows of the market (not what it signs) is read from /api/state: one copy of every
// public account, a few seconds old, the same for all visitors and served by the CDN. The public
// RPC throttles each visitor's address, and on Solana devnet it refuses most of a page's requests,
// so asking it for every screen left a visitor looking at an empty page.
//
// `view` is a Connection like the wallet's, and the page's readers use it unchanged: a request the
// copy can answer (an account in it, a scan it holds, the slot) is answered from it, and any other
// goes to the RPC as before. So does everything when the copy cannot be had or is too old, and
// for a few seconds after this visitor's own transaction, so that its effect shows at once.
// Transactions are built from the wallet's Connection, which never reads the copy.
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { NETWORK, RPC_URL, X1, politeFetch } from "./chain";

type Account = { data: [string, string]; owner: string; space?: number } | null;
type Copy = { slot: number; samples: unknown[]; lists: { program: string; filters: string[] }[]; accounts: Record<string, Account>; age?: number };
type Held = Copy & { got: number; old: number; bytes: Map<string, Uint8Array> };

const REUSE_MS = 5_000; // a copy answers every request made within this long of its arrival
const TOO_OLD_MS = 30_000; // older than this (the server could not refresh it): ask the RPC instead
const RETRY_MS = 10_000; // after a failure, how long the RPC is asked before the copy is tried again

let held: Held | undefined;
let loading: Promise<void> | undefined;
let failed = 0;
let directUntil = 0;

const take = (c: Copy | null | undefined, old: number) => {
  if (c?.accounts && typeof c.slot === "number") held = { ...c, got: Date.now(), old, bytes: new Map() };
  else failed = Date.now();
};
async function fetchCopy() {
  try {
    const r = await fetch(`/api/state?network=${NETWORK}`, { signal: AbortSignal.timeout(6_000) });
    take(r.ok ? await r.json() : null, 1000 * (Number(r.headers.get("age")) || 0));
  } catch { failed = Date.now(); }
}
// index.html asks for the copy before this script has even arrived; that answer is used first.
const early = (globalThis as any).__state as { net: string; res: Promise<Copy | null> } | undefined;
if (early?.net === NETWORK) loading = early.res.then(c => take(c, c?.age ?? 0)).finally(() => { loading = undefined; });

async function current(): Promise<Held | undefined> {
  if (!held || Date.now() - held.got >= REUSE_MS) {
    if (!loading && Date.now() - failed < RETRY_MS) return undefined;
    await (loading ??= fetchCopy().finally(() => { loading = undefined; }));
  }
  return held && held.old + Date.now() - held.got < TOO_OLD_MS ? held : undefined;
}

/** For the next few seconds the page reads the RPC itself: after the visitor's own transaction. */
export function readDirect(ms = 10_000) { directUntil = Date.now() + ms; }

const plain = (cfg: any) => cfg?.encoding === "base64" && !cfg.dataSlice && !cfg.withContext && cfg.minContextSlot === undefined;
const size = (a: NonNullable<Account>) => a.space ?? Math.floor(a.data[0].length * 3 / 4) - (a.data[0].endsWith("==") ? 2 : a.data[0].endsWith("=") ? 1 : 0);

/** The answer the RPC would give, or undefined when the copy does not hold it. */
function answer(s: Held, method: string, p: any[]): unknown {
  const context = { slot: s.slot };
  if (method === "getSlot") return s.slot;
  if (method === "getRecentPerformanceSamples") return p[0] <= s.samples.length ? s.samples.slice(0, p[0]) : undefined;
  if (method === "getAccountInfo") return plain(p[1]) && p[0] in s.accounts ? { context, value: s.accounts[p[0]] } : undefined;
  if (method === "getMultipleAccounts") return plain(p[1]) && (p[0] as string[]).every(k => k in s.accounts) ? { context, value: (p[0] as string[]).map(k => s.accounts[k]) } : undefined;
  if (method === "getProgramAccounts") {
    if (!plain(p[1])) return undefined;
    const sizes: number[] = [], bytes: [number, Uint8Array][] = [], asked: string[] = [];
    for (const f of p[1].filters ?? []) {
      if (typeof f.dataSize === "number") { sizes.push(f.dataSize); asked.push(`d${f.dataSize}`); }
      else if (f.memcmp && (f.memcmp.encoding ?? "base58") === "base58") { bytes.push([f.memcmp.offset, bs58.decode(f.memcmp.bytes)]); asked.push(`m${f.memcmp.offset}:${f.memcmp.bytes}`); }
      else return undefined;
    }
    // A scan the copy holds whole: the same program, asked for with no more conditions than these.
    if (!s.lists.some(l => l.program === p[0] && l.filters.every(f => asked.includes(f)))) return undefined;
    const out: { pubkey: string; account: Account }[] = [];
    for (const [pubkey, a] of Object.entries(s.accounts)) {
      if (!a || a.owner !== p[0] || sizes.some(n => size(a) !== n)) continue;
      if (bytes.length) {
        let d = s.bytes.get(pubkey);
        if (!d) s.bytes.set(pubkey, d = Uint8Array.from(atob(a.data[0]), c => c.charCodeAt(0)));
        if (bytes.some(([o, want]) => o + want.length > d!.length || want.some((b, i) => d![o + i] !== b))) continue;
      }
      out.push({ pubkey, account: a });
    }
    return out;
  }
  return undefined;
}

const ANSWERED = new Set(["getSlot", "getRecentPerformanceSamples", "getAccountInfo", "getMultipleAccounts", "getProgramAccounts"]);

// The public devnet RPC rate-limits hard; retrying every 429 multiplies the load, so the pages
// keep their last data and try again on their next refresh instead, and requests go out one
// after the other, 120 ms apart. X1's RPC does not throttle: there they all go at once (in a
// line, a visitor far from the RPC waited twenty round trips, one after the other, for one screen).
export const rpcFetch = politeFetch(X1 ? 0 : 120);

const viewFetch: typeof fetch = async (input, init) => {
  if (Date.now() >= directUntil && typeof init?.body === "string") {
    try {
      const q = JSON.parse(init.body);
      const s = !Array.isArray(q) && ANSWERED.has(q.method) ? await current() : undefined;
      const result = s && Date.now() >= directUntil ? answer(s, q.method, q.params ?? []) : undefined;
      if (result !== undefined) return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    } catch { /* not a request this understands: the RPC answers it */ }
  }
  return rpcFetch(input, init);
};

/** Reads for display. See the note at the top of this file. */
export const view = new Connection(RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: viewFetch });
