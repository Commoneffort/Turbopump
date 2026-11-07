// The local RPC relay for our X1 services (2026-11-07). X1's public RPC limits each IP address
// (docs.x1.xyz/build-on-x1/rpc-rate-limits, and the X-RateLimit-* headers it sends): on testnet
// 400 requests in 5 s, 40 "heavy" ones (sendTransaction, simulateTransaction) in 5 s, and 15
// connections at once. With some twenty service processes on this server, each opening its own
// connections, the connection cap alone turned requests away. Every service sends to this relay
// instead (deploy/x1-services.sh sets RPC), and the relay:
//   - keeps ONE HTTP/2 connection to the RPC (requests share it as streams), reopened if it drops;
//   - paces what it forwards under the caps (SHORT_MAX and HEAVY_MAX per 5 s, read from the
//     RPC's own headers when it sends them), queueing the rest in order, transactions first;
//   - waits out a 429's Retry-After (retrying early lengthens the throttle) and retries the request;
//   - passes websockets (port + 1, as the RPC library expects) through, one upstream each.
//   RPC_UPSTREAM=https://rpc.testnet.x1.xyz PORT=18899 npx tsx scripts/rpc-relay.ts
import * as http from "http";
import * as http2 from "http2";
import { WebSocket, WebSocketServer } from "ws";

const UP = process.env.RPC_UPSTREAM ?? "https://rpc.testnet.x1.xyz";
const PORT = Number(process.env.PORT ?? 18899);
const WINDOW_MS = 5_000;
let SHORT_MAX = Number(process.env.SHORT_MAX ?? 360), HEAVY_MAX = Number(process.env.HEAVY_MAX ?? 36);
const HEAVY = new Set(["sendTransaction", "simulateTransaction"]);
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

let session: http2.ClientHttp2Session | undefined;
function up(): http2.ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session;
  session = http2.connect(UP);
  session.on("error", e => { say("upstream error", String(e?.message ?? e)); session?.destroy(); session = undefined; });
  session.on("goaway", () => { session?.close(); session = undefined; });
  return session;
}

// What was sent in the last 5 s, and when the RPC asked us to hold off until.
const sent: { at: number; heavy: number; n: number }[] = [];
let holdUntil = 0;
const used = () => { const t = Date.now() - WINDOW_MS; while (sent.length && sent[0].at < t) sent.shift(); return sent.reduce((a, x) => ({ n: a.n + x.n, heavy: a.heavy + x.heavy }), { n: 0, heavy: 0 }); };

type Job = { body: Buffer; n: number; heavy: number; res: http.ServerResponse; tries: number };
const queue: Job[] = [];
let stats = { forwarded: 0, throttled: 0, queuedMax: 0 };

function pump() {
  while (queue.length && Date.now() >= holdUntil) {
    const u = used();
    // Transactions first: they are what a waiting trade needs.
    const i = queue.findIndex(j => j.heavy > 0 && u.heavy + j.heavy <= HEAVY_MAX && u.n + j.n <= SHORT_MAX);
    const k = i >= 0 ? i : queue.findIndex(j => j.heavy === 0 && u.n + j.n <= SHORT_MAX);
    if (k < 0) break;
    const [job] = queue.splice(k, 1);
    sent.push({ at: Date.now(), heavy: job.heavy, n: job.n });
    forward(job);
  }
  if (queue.length) setTimeout(pump, Math.max(25, holdUntil - Date.now()));
}

function forward(job: Job) {
  let req: http2.ClientHttp2Stream;
  try {
    req = up().request({ ":method": "POST", ":path": "/", "content-type": "application/json" });
  } catch (e: any) {
    return retry(job, 500, String(e?.message ?? e));
  }
  const chunks: Buffer[] = [];
  let status = 0, headers: http2.IncomingHttpHeaders = {};
  req.on("response", h => { headers = h; status = Number(h[":status"]); });
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    // The RPC's own figures, when it sends them, are the caps to keep under.
    const ls = Number(headers["x-ratelimit-limit-short"]), lh = Number(headers["x-ratelimit-limit-heavy"]);
    if (ls > 0) SHORT_MAX = Math.floor(ls * 0.9);
    if (lh > 0) HEAVY_MAX = Math.floor(lh * 0.9);
    if (status === 429) {
      stats.throttled++;
      const wait = (Number(headers["retry-after"]) || 5) * 1000;
      holdUntil = Math.max(holdUntil, Date.now() + wait);
      return retry(job, wait, "429");
    }
    stats.forwarded++;
    job.res.writeHead(status || 502, { "content-type": String(headers["content-type"] ?? "application/json") }).end(Buffer.concat(chunks));
  });
  req.on("error", e => retry(job, 300, String(e?.message ?? e)));
  req.setTimeout(30_000, () => { req.close(); retry(job, 300, "timeout"); });
  req.end(job.body);
}

function retry(job: Job, wait: number, why: string) {
  if (job.res.writableEnded) return;
  if (++job.tries > 4) {
    job.res.writeHead(why === "429" ? 429 : 502, { "content-type": "application/json", "retry-after": "5" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32005, message: `relay: ${why}` } }));
    return;
  }
  setTimeout(() => { queue.unshift(job); pump(); }, wait);
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ relay: UP, queued: queue.length, ...used(), caps: { SHORT_MAX, HEAVY_MAX }, ...stats }));
  const chunks: Buffer[] = [];
  let size = 0;
  // (Only local processes reach the relay; still, a body is never more than 2 MB.)
  req.on("data", c => { size += c.length; if (size > 2_000_000) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
  req.on("end", () => {
    if (size > 2_000_000) return;
    const body = Buffer.concat(chunks);
    let calls: any[] = [];
    try { const j = JSON.parse(body.toString()); calls = Array.isArray(j) ? j : [j]; } catch { /* forwarded as is */ }
    queue.push({ body, n: Math.max(1, calls.length), heavy: calls.filter(c => HEAVY.has(c?.method)).length, res, tries: 0 });
    stats.queuedMax = Math.max(stats.queuedMax, queue.length);
    pump();
  });
});
server.keepAliveTimeout = 60_000;
server.listen(PORT, "127.0.0.1", () => say(`relay to ${UP} on 127.0.0.1:${PORT}, websockets on :${PORT + 1}`));

// Websockets: the RPC library opens one at the HTTP port + 1 for subscriptions.
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT + 1 });
wss.on("connection", client => {
  const upstream = new WebSocket(UP.replace(/^http/, "ws"));
  const pending: (string | Buffer)[] = [];
  upstream.on("open", () => { for (const m of pending.splice(0)) upstream.send(m); });
  upstream.on("message", (m, binary) => client.readyState === WebSocket.OPEN && client.send(m, { binary }));
  client.on("message", (m, binary) => { const d = binary ? (m as Buffer) : m.toString(); upstream.readyState === WebSocket.OPEN ? upstream.send(d) : pending.push(d); });
  const end = () => { try { client.close(); } catch { /* closed */ } try { upstream.close(); } catch { /* closed */ } };
  upstream.on("close", end); upstream.on("error", end);
  client.on("close", end); client.on("error", end);
});

setInterval(() => say("forwarded", stats.forwarded, "throttled", stats.throttled, "queued now", queue.length, "most queued", stats.queuedMax, "caps", SHORT_MAX, HEAVY_MAX), 60_000);
