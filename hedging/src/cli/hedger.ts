// Runs the hedger on the live vaults: the monitor, policy, journal and reconciliation, against
// one venue. It reads the chain and nothing else there: no Solana or X1 key, no transaction.
//
//   --venue mock                 (default, "shadow mode") The hedge is held on a paper account
//                                priced at Percolator's own prices. No venue connection, no money.
//                                The paper account lives in memory and is rebuilt from the journal.
//   --venue hyperliquid-testnet  Hyperliquid's test network: real orders, test money. Needs a key
//                                file (one hex private key; `npm run hl -- new-key` makes one) and,
//                                if that key is an API wallet, --account <address it trades for>.
//
// Hedging starts switched off: `npm run switch -- on --state <dir>` (while this runs, too).
// `--adopt SOL` accepts the venue's position on a symbol as the ledger's, then exits.
//
// One hedger watches one deployment. `--deployment` names a file like app/src/devnet.json (it
// needs "vault_program" and "market"); with RPC that is all that differs between Solana and X1.
//
// Run: RPC=... npm run shadow|testnet -- [--deployment file] [--config file] [--state dir]
//        [--interval secs] [--equity usd] [--key-file file] [--account 0x...] [--adopt SYMBOL] [--once]
import * as fs from "fs";
import { ChainSource } from "../chain-source";
import { defaultConfig, loadConfig, problems } from "../config";
import { HedgeEngine, TickReport } from "../engine";
import { ExposureMonitor, ExposureSource } from "../exposure";
import { HyperliquidVenue } from "../hyperliquid";
import { Journal } from "../journal";
import { MockVenue } from "../mock-venue";
import { adopt } from "../reconcile";
import { writeReport } from "../report";
import { isTrouble } from "../state";
import { mockDefaults } from "../simulator";
import { USD, errorText, qty, systemClock, usd } from "../units";
import { HedgeVenue } from "../venue";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const venueName = arg("venue") ?? "mock";
if (venueName !== "mock" && venueName !== "hyperliquid-testnet") throw new Error(`unknown venue ${venueName}`);
// On the test network HYPE can only be traded with isolated margin, which the adapter does not do.
const config = arg("config") ? loadConfig(arg("config")!) : defaultConfig(venueName === "mock" ? ["SOL", "BTC", "ETH", "DOGE", "HYPE", "PYTH"] : ["SOL", "BTC", "ETH"]);
const bad = problems(config);
if (bad.length) throw new Error(bad.join("; "));
const dir = arg("state") ?? new URL(`../../state/${venueName === "mock" ? "shadow" : venueName}`, import.meta.url).pathname;
const interval = Number(arg("interval") ?? 10) * 1000;
const equity = BigInt(arg("equity") ?? 50_000) * USD;
const once = process.argv.includes("--once");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const clock = systemClock;
const journal = Journal.open(dir, venueName, clock);
const L = journal.ledger;
const deployment = arg("deployment") ? JSON.parse(fs.readFileSync(arg("deployment")!, "utf8")) : {};
const chain = new ChainSource({
  rpc: process.env.RPC ?? "https://api.devnet.solana.com",
  ...(deployment.vault_program && { vaultProgram: deployment.vault_program }),
  ...(deployment.market && { market: deployment.market }),
});
let venue: HedgeVenue, source: ExposureSource = chain, about: string;
if (venueName === "mock") {
  // Lot sizes like a perpetuals venue's (decimals of the size: BTC 5, ETH 4, SOL 2, ...). They are
  // assumptions for the paper account; a real adapter takes them from the venue.
  const lot = (decimals: number) => ({ lotQ: 10n ** BigInt(6 - decimals), minNotionalE6: 10n * USD, tickE6: 1n });
  const meta = { BTC: lot(5), ETH: lot(4), SOL: lot(2), HYPE: lot(2), DOGE: lot(0), PYTH: lot(0) };
  const paper = new MockVenue(clock, { ...mockDefaults, equityE6: equity, meta });
  paper.seed(L.positions, equity + [...L.cashE6.values()].reduce((a, x) => a + x, 0n) - L.feesE6 - L.totalFundingE6(), L.cursor);
  // The paper venue's prices are Percolator's, as of the read the engine is about to act on.
  source = {
    read: async () => {
      const r = await chain.read();
      for (const v of r.vaults) if (v.priceE6 > 0n) paper.setMid(config.symbols[v.symbol]?.venueSymbol ?? v.symbol, v.priceE6);
      return r;
    },
  };
  venue = paper;
  about = `paper account ${usd(equity)}`;
} else {
  const keyFile = arg("key-file") ?? `${process.env.HOME}/.config/hyperliquid/testnet-key`;
  if (!fs.existsSync(keyFile)) {
    journal.close();
    throw new Error(`no key file at ${keyFile} (npm run hl -- new-key)`);
  }
  // A new journal takes the account as it finds it: fills from before it began are not its own.
  const hl = new HyperliquidVenue({ privateKey: fs.readFileSync(keyFile, "utf8").trim(), account: arg("account"), historyFrom: L.openedAt });
  venue = hl;
  about = `Hyperliquid test network, account ${hl.user}${hl.user === hl.signer ? "" : ` (signed by ${hl.signer})`}`;
}
const engine = new HedgeEngine({ config, journal, venue, monitor: new ExposureMonitor(source), clock });
if (arg("adopt")) {
  const q = await adopt(journal, venue, config, arg("adopt")!, process.env.USER ?? "operator");
  console.log(`${arg("adopt")}: the ledger now holds the venue's position, ${qty(q)}. Lift the halt with: npm run status -- --state ${dir} resume ${arg("adopt")}`);
  journal.close();
  process.exit(0);
}

const line = (r: TickReport) => r.symbols.map(s => {
  const d = s.decision;
  const what = d.action === "order" ? `${d.side} ${qty(d.sizeQ)}${d.reduceOnly ? " (reduce)" : ""}` : d.reason;
  return `${s.symbol}: vault ${s.exposure ? qty(s.exposure.positionQ) : "?"} hedge ${qty(s.hedgeQ)} open ${s.residualE6 === undefined ? "?" : usd(s.residualE6)} -> ${what}`;
}).join(" | ");

log(`hedger: ${about}, journal ${dir}, ${Object.keys(config.symbols).join(" ")}; hedging is ${[...L.switches].some(([, on]) => on) ? "switched on" : "switched off (npm run switch -- on)"}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// A paper account that holds positions cannot be valued without prices: get them first.
for (; venueName === "mock";) {
  try { await source.read(); await sleep(2_000); break; } catch (e) { log("chain:", errorText(e)); await sleep(interval); }
}
let last = "";
const stop = () => { journal.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (;;) {
  try {
    const r = await engine.tick();
    const text = [r.switchError && `switch.json ignored: ${r.switchError}`, r.venueError && `venue: ${r.venueError}`, r.readError && `chain: ${r.readError}`, line(r),
      r.unhedged.length && `not hedged (no venue market): ${r.unhedged.map(u => `${u.symbol} ${usd(u.notionalE6)}`).join(", ")}`,
      L.halts.size && `HALTED ${[...L.halts].map(([k, v]) => `${k}: ${v}`).join("; ")}`].filter(Boolean).join(" | ");
    if (text !== last) log(text);
    last = text;
    for (const t of r.transitions) {
      // The hedge as a whole is its worst symbol, which has its own line; it gets one only when
      // the account itself is the reason.
      if (t.scope === "*" && r.symbols.some(s => t.reason.startsWith(`${s.symbol}: `))) continue;
      log(`${isTrouble(t.to) ? "ALERT" : "state"} ${t.scope === "*" ? "hedge" : t.scope}: ${t.from ?? "start"} -> ${t.to} (${t.reason})`);
    }
    try { writeReport(dir, r, config.stressBps); } catch (e) { log("report not written:", errorText(e)); }
    for (const s of r.symbols) for (const n of s.exposure?.notes ?? []) if (!last.includes(n)) log(`note ${n}`);
  } catch (e) {
    log("error", errorText(e));
    if (journal.dead) {
      log("the journal could not be written: stopping");
      process.exit(1);
    }
  }
  if (once) stop();
  await sleep(interval);
}
