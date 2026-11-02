// Collects the latest posts of the X accounts in deploy/xfeed-handles.txt, one account every 40 s
// (X's public embed timelines allow about 30 reads per 15 minutes from one address, and refuse
// Vercel's shared addresses outright), and serves them merged at GET /xfeed.json on XFEED_PORT
// (default 8788). The site's /api/xfeed reads that (Vercel env XFEED_URL) and the CDN keeps it.
// Run: npx tsx scripts/xfeed-collector.ts      (deploy/xfeed.sh start|stop|status)
import * as fs from "fs";
import * as http from "http";
import { readHandle, XPost } from "../api/xfeed";

const FILE = new URL("../../deploy/xfeed-handles.txt", import.meta.url).pathname;
const SAVE = new URL("../../deploy/logs/xfeed.json", import.meta.url).pathname;
const PORT = Number(process.env.XFEED_PORT ?? 8788);
const GAP = Number(process.env.XFEED_GAP_SECS ?? 40) * 1000;
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const handles = () => fs.readFileSync(FILE, "utf8").split("\n").map(l => l.replace(/#.*/, "").trim().replace(/^@/, "")).filter(h => /^[A-Za-z0-9_]{1,15}$/.test(h));

const byHandle = new Map<string, { at: number; posts: XPost[] }>();
try { for (const [h, v] of Object.entries(JSON.parse(fs.readFileSync(SAVE, "utf8")).byHandle ?? {})) byHandle.set(h, v as { at: number; posts: XPost[] }); } catch { /* first run */ }
let body = "{}";
function rebuild() {
  const list = handles().map(h => h.toLowerCase());
  const seen = new Set<string>();
  const posts = list.flatMap(h => byHandle.get(h)?.posts ?? []).filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true))).sort((a, b) => b.time - a.time).slice(0, 400);
  body = JSON.stringify({ at: Math.floor(Date.now() / 1000), handles: list, posts });
  fs.writeFileSync(SAVE, JSON.stringify({ byHandle: Object.fromEntries(byHandle) }));
}
rebuild();

http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/xfeed.json")) { res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" }); res.end(body); }
  else { res.writeHead(404); res.end(); }
}).listen(PORT, () => say(`serving /xfeed.json on :${PORT}`));

let i = 0, pause = 0;
for (;;) {
  const list = handles();
  const h = list[i++ % list.length];
  const r = await readHandle(h, true);
  if (r.err) { say(h, r.err); if (/429/.test(r.err)) pause = Math.min(pause + 1, 6); }
  else { pause = 0; byHandle.set(h.toLowerCase(), { at: Date.now(), posts: r.posts }); rebuild(); say(h, r.posts.length, "posts"); }
  await new Promise(ok => setTimeout(ok, GAP * (1 + pause)));
}
