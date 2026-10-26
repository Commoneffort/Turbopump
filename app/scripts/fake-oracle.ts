// A price service whose prices we set, for the crash drill on a local chain (deploy/crash-drill.sh).
// It speaks the stream format of jack0.x1.xyz (see price-service.ts) on two ports: a "primary"
// and a "backup", so the executor's switch from one to the other can be tested too.
//
//   GET /v1/stream/prices?symbols=sol,btc    the stream (on both ports)
//   GET /v1/prices?symbols=sol,btc           the same message once (both ports; the witness reads the backup's)
//   control, on the primary port only (127.0.0.1):
//   GET /set?symbol=SOL&price=95             jump to a price
//   GET /move?symbol=SOL&pct=-8&secs=120     walk there in a straight line (pct of the current price)
//   GET /silence?secs=90&port=primary|backup|both   send nothing for a while (an outage)
//   GET /down?port=primary|backup&on=1|0     refuse connections (a dead service), or come back
//   GET /prices                              what it serves now
// Run: PORT=18090 BACKUP_PORT=18091 npx tsx scripts/fake-oracle.ts
import * as http from "http";

const PORT = Number(process.env.PORT ?? 18090), BACKUP = Number(process.env.BACKUP_PORT ?? 18091);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const price = new Map<string, number>(Object.entries({ SOL: 100, BTC: 80_000, ETH: 2_400, HYPE: 40, ...JSON.parse(process.env.START_PRICES ?? "{}") }));
const walks = new Map<string, { from: number; to: number; t0: number; ms: number }>();
const silentUntil = { primary: 0, backup: 0 };
const down = { primary: false, backup: false };
const streams = { primary: new Set<http.ServerResponse>(), backup: new Set<http.ServerResponse>() };

function current(sym: string) {
  const w = walks.get(sym);
  if (!w) return price.get(sym);
  const f = Math.min(1, (Date.now() - w.t0) / w.ms);
  const p = w.from + (w.to - w.from) * f;
  if (f >= 1) { walks.delete(sym); price.set(sym, w.to); }
  return p;
}
// A tiny wobble (0.01%) so the price changes every second, as a real one does.
const wobble = (p: number) => p * (1 + (Math.random() - 0.5) * 0.0002);
const message = (symbols: string[]) => JSON.stringify({ type: "prices", timestamp: new Date().toISOString(), data: symbols.map(s => {
  const p = current(s);
  return p === undefined ? { symbol: s, price: 0, status: "no-data" } : { symbol: s, price: wobble(p), status: "ok", sourcesUsed: 8, sourcesTotal: 8, updatedAt: new Date().toISOString() };
}) });

function serve(which: "primary" | "backup", port: number) {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const q = (k: string) => url.searchParams.get(k) ?? "";
    if (url.pathname === "/v1/stream/prices") {
      if (down[which]) { req.socket.destroy(); return; }
      const symbols = q("symbols").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("retry: 3000\n\n");
      streams[which].add(res);
      const tick = setInterval(() => { if (Date.now() >= silentUntil[which]) res.write(`data: ${message(symbols)}\n\n`); }, 1000);
      req.on("close", () => { clearInterval(tick); streams[which].delete(res); });
      return;
    }
    const json = (o: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    // The same message once (what the X1 witness reads): nothing while silent or down.
    if (url.pathname === "/v1/prices") {
      if (down[which]) { req.socket.destroy(); return; }
      const symbols = q("symbols").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      if (Date.now() < silentUntil[which]) return json({ type: "prices", timestamp: new Date().toISOString(), data: [] });
      res.writeHead(200, { "content-type": "application/json" }); res.end(message(symbols)); return;
    }
    if (which !== "primary") { res.writeHead(404); res.end(); return; }
    const sym = q("symbol").toUpperCase();
    if (url.pathname === "/set") { walks.delete(sym); price.set(sym, Number(q("price"))); log(`${sym} set to ${q("price")}`); return json({ ok: true }); }
    if (url.pathname === "/move") {
      const from = current(sym)!, to = from * (1 + Number(q("pct")) / 100);
      walks.set(sym, { from, to, t0: Date.now(), ms: Number(q("secs") || 60) * 1000 });
      log(`${sym} moving ${q("pct")}% to ${to.toFixed(4)} over ${q("secs") || 60} s`);
      return json({ ok: true, from, to });
    }
    if (url.pathname === "/silence") {
      const until = Date.now() + Number(q("secs")) * 1000, p = q("port") || "both";
      if (p !== "backup") silentUntil.primary = until;
      if (p !== "primary") silentUntil.backup = until;
      log(`silent for ${q("secs")} s (${p})`);
      return json({ ok: true });
    }
    if (url.pathname === "/down") {
      const p = q("port") === "backup" ? "backup" : "primary", on = q("on") !== "0";
      down[p] = on;
      if (on) for (const r of streams[p]) r.destroy(); // a dead service drops its streams too
      log(`${p} ${on ? "DOWN" : "back up"}`);
      return json({ ok: true });
    }
    if (url.pathname === "/prices") return json(Object.fromEntries([...price.keys()].map(s => [s, current(s)])));
    res.writeHead(404); res.end();
  });
  srv.listen(port, "127.0.0.1", () => log(`fake oracle (${which}) on 127.0.0.1:${port}`));
}
serve("primary", PORT);
serve("backup", BACKUP);
