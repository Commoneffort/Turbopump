// The operator's dashboard: one page that shows every hedger on this machine. It reads what the
// hedgers leave beside their journals (risk.json, transitions.jsonl) and the journals themselves.
// It changes nothing: no button on it sends an order, lifts a halt or flips a switch.
//
// It listens on this machine only (127.0.0.1). From elsewhere, forward the port over SSH:
//   ssh -L 8792:127.0.0.1:8792 <this machine>     then open http://127.0.0.1:8792
// Run: npm run dashboard -- [--port 8792] [--state <folder that holds the state folders>]
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { decode, readJournal } from "../journal";
import { RiskFile, TRANSITIONS_FILE, readReport, riskLines, riskRows } from "../report";
import { isTrouble } from "../state";
import { qty, usd } from "../units";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const ROOT = arg("state") ?? new URL("../../state", import.meta.url).pathname;
const PORT = Number(arg("port") ?? 8792);
const dollars = (e6?: bigint) => (e6 === undefined ? null : Number(e6) / 1e6);

function hedger(name: string) {
  const dir = path.join(ROOT, name);
  const out: any = { name };
  try {
    const { ledger: L, entries } = readJournal(dir);
    out.venue = L.venue;
    out.orders = L.intents.size;
    out.halts = [...L.halts].map(([scope, reason]) => ({ scope, reason }));
    out.unresolved = L.unresolved().map(i => ({ symbol: i.symbol, side: i.side, size: qty(i.sizeQ), status: i.status, id: i.id }));
    out.switches = Object.fromEntries([...L.switches].map(([k, on]) => [k, on ? "on" : "off"]));
    out.lastOrders = entries.filter(e => e.type === "intent").slice(-12).reverse().map((e: any) => {
      const it = L.intents.get(e.id)!;
      return { at: e.ts, symbol: e.symbol, side: e.side, size: qty(e.sizeQ), filled: qty(it.filledQ), status: it.status, reduceOnly: e.reduceOnly };
    });
  } catch (e: any) {
    out.error = `journal: ${String(e?.message ?? e).slice(0, 120)}`;
  }
  const f: RiskFile | undefined = readReport(dir);
  if (f) {
    const t = f.risk.totals, a = f.risk.account;
    out.report = {
      at: f.atMs, ageSecs: Math.round((Date.now() - f.atMs) / 1000), state: f.state, reason: f.stateReason, trouble: isTrouble(f.state),
      venueError: f.venueError, readError: f.readError, lines: riskLines(f).slice(1), rows: riskRows(f),
      symbols: f.symbols.map(s => ({ ...s, trouble: isTrouble(s.state) })),
      totals: {
        vault: dollars(t.vaultGrossE6), hedge: dollars(t.hedgeGrossE6), retained: dollars(t.retainedGrossE6), retainedShare: t.retainedShareBps ?? null,
        stress: dollars(t.stressLossE6), stressOfNav: t.stressOfNavBps ?? null, stressBps: f.stressBps, pnl: dollars(t.hedgePnlE6), nav: dollars(t.navE6),
        fees: dollars(t.feesE6), funding: dollars(t.fundingE6), slippage: dollars(t.slippageE6),
      },
      account: a && {
        equity: dollars(a.equityE6), marginUsed: dollars(a.marginUsedE6), free: dollars(a.freeMarginE6), room: dollars(a.availableHedgeE6),
        leverage: a.leverageBps === undefined ? null : a.leverageBps / 10_000, liqDistance: a.liqDistanceBps ?? null, mode: a.mode,
        unexplained: dollars(a.unexplainedE6), unexplainedText: a.unexplainedE6 === undefined ? null : usd(a.unexplainedE6),
      },
    };
  }
  try {
    const lines = fs.readFileSync(path.join(dir, TRANSITIONS_FILE), "utf8").trim().split("\n").slice(-40);
    out.transitions = lines.filter(Boolean).map(l => decode(l)).reverse().map((t: any) => ({ ...t, trouble: isTrouble(t.to) }));
  } catch { out.transitions = []; }
  return out;
}

const data = () => ({
  at: Date.now(), root: ROOT,
  hedgers: (fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []).filter(n => fs.existsSync(path.join(ROOT, n, "journal.jsonl"))).sort().map(hedger),
});

const page = fs.readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
http.createServer((req, res) => {
  try {
    if (req.url === "/data") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(data()));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
  } catch (e: any) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e?.message ?? e));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`hedge dashboard: http://127.0.0.1:${PORT} (reading ${ROOT})`));
