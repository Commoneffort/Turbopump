// Watches one network and tells a person when something needs them, on Telegram. Twice in
// October 2026 a network stood still for a day and more because its paying wallet ran dry and
// nobody noticed; this is the noticing.
//
// Every minute, for NETWORK (x1-testnet | devnet):
//   - the paying wallet (executor, keeper, bots): a warning at a few hours of fees left, an alarm
//     near empty. Below TOPUP_BELOW it is refilled from the platform treasury, which always keeps
//     its RESERVE (for program upgrades) and is never touched below it;
//   - prices: a market with open positions whose mark is more than 5 minutes old;
//   - the price services the X1 executor reads (jack0, and our own copy on 127.0.0.1:8091);
//   - the services and bots are running, and the executor's log is still being written;
//   - new kinds of failed checks in the bots' log (each kind once every 6 hours, with an example);
//   - the money (`money`): Percolator holds the tokens its books say and at least what it owes
//     accounts; each vault's cash covers what it owes now (paid withdrawals, opener fees, queued
//     deposits); no vault's share price fell more than 5% in an hour; no vault holds more than
//     its limit; and a 30% move against a vault's position would not cost it more than it is worth.
// An alert is sent when a problem starts, again every 3 hours while it lasts, and once more when
// it is over. A summary goes out every day at 08:00 UTC.
//
// Telegram: put the bot's token and the chat to send to in ~/.config/percolator/alerts.env
// (read on every send, so no restart is needed after filling it in):
//   TELEGRAM_BOT_TOKEN=123456:ABC...
//   TELEGRAM_CHAT_ID=123456789
// Without them alerts only go to this process's log.
// Run: NETWORK=x1-testnet npx tsx scripts/watchdog.ts      (deploy/x1-services.sh runs it)
//      NETWORK=x1-testnet npx tsx scripts/watchdog.ts chat-id (finds your chat id once you wrote to the bot)
//      NETWORK=x1-testnet npx tsx scripts/watchdog.ts test    (sends one test message and exits)
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";

const HOME = process.env.HOME!;
const ROOT = new URL("../..", import.meta.url).pathname;
const LOGS = `${ROOT}deploy/logs`;
const ENV_FILE = process.env.ALERTS_ENV ?? `${HOME}/.config/percolator/alerts.env`;
const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch(C.X1 ? 0 : 300) });
const read = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const payer = read(process.env.KEYPAIR ?? `${HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
const TREASURY_KEY = process.env.TREASURY_KEY ?? `${HOME}/.config/solana/percolator-treasury.json`;
const coin = (l: number) => `${(l / LAMPORTS_PER_SOL).toFixed(2)} ${C.COIN}`;
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Thresholds, in the chain's coin. X1's services spend about 11 XNT an hour, devnet's ~0.05 SOL a day.
const T = C.X1
  ? { warn: 60, alarm: 15, topupBelow: 80, topupTo: 150, reserve: 20 }
  : { warn: 1.5, alarm: 0.3, topupBelow: 2, topupTo: 4, reserve: 8 };
const SERVICES = C.X1 ? ["price-service", "x1-executor", "x1-keeper", "x1-bots"] : ["devnet-executor", "devnet-keeper", "devnet-bots"];
const EXEC_LOG = `${LOGS}/${C.X1 ? "x1-executor.log" : "executor.log"}`;
const BOT_LOG = `${LOGS}/${C.NETWORK}-bots.jsonl`;
const NAME = C.NETWORK_NAME;

// ---- sending ----
function config() {
  const out: Record<string, string> = {};
  try { for (const l of fs.readFileSync(ENV_FILE, "utf8").split("\n")) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); } } catch { /* not set up yet */ }
  return out;
}
// `money`: runs the money checks once, printing what it finds instead of sending it.
const DRY = process.argv[2] === "money";
async function send(text: string) {
  say("ALERT", text.replace(/\n/g, " | "));
  const c = config();
  if (DRY || !c.TELEGRAM_BOT_TOKEN || !c.TELEGRAM_CHAT_ID) return;
  if (/^@.*bot$/i.test(c.TELEGRAM_CHAT_ID)) { say(`TELEGRAM_CHAT_ID is a bot's name (${c.TELEGRAM_CHAT_ID}); it has to be your chat: run "watchdog.ts chat-id"`); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${c.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: c.TELEGRAM_CHAT_ID, text: `[${NAME}] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) say("telegram answered", r.status, (await r.text()).slice(0, 200));
  } catch (e: any) { say("telegram unreachable:", String(e?.message ?? e).slice(0, 100)); }
}

// ---- problems: start, repeat every 3 hours, end ----
const open = new Map<string, number>(); // problem -> when last sent
async function problem(key: string, bad: boolean, text: string) {
  const last = open.get(key);
  if (bad && (last === undefined || Date.now() - last > 3 * 3_600_000)) { open.set(key, Date.now()); await send(`${last === undefined ? "⚠️" : "⚠️ still:"} ${text}`); }
  else if (!bad && last !== undefined) { open.delete(key); await send(`✅ resolved: ${key}`); }
}

// ---- the checks ----
// The X1 price witness (scripts/witness.ts) spends ~4 XNT a day and may run on another machine:
// it is refilled here by address (no key needed) from the paying wallet, and its prices on chain
// must stay under the router's WITNESS_SECS (30 s) or X1 marks stop moving. Returns what was sent.
const WITNESS = "DQA2FE6ZSPHCRxLVgi4G4fb5X61D9s2phbF589TDdvvZ";
async function witness(): Promise<number> {
  const w = new (await import("@solana/web3.js")).PublicKey(WITNESS);
  let sent = 0;
  const bal = await conn.getBalance(w);
  if (bal < 4 * LAMPORTS_PER_SOL) {
    const amount = 15 * LAMPORTS_PER_SOL - bal;
    try {
      const sig = await conn.sendTransaction(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: w, lamports: amount })), [payer]);
      await conn.confirmTransaction(sig, "confirmed");
      sent = amount;
      await send(`refilled the price witness ${WITNESS.slice(0, 8)}… with ${coin(amount)} (it had ${coin(bal)})`);
    } catch (e: any) { say("witness refill failed:", String(e?.message ?? e).slice(0, 120)); }
  }
  const accs = await conn.getMultipleAccountsInfo(C.FEEDS.map(f => C.witnessAddress(f.id)));
  const now = Math.floor(Date.now() / 1000);
  const stale = C.FEEDS.filter((_, i) => !accs[i] || now - C.decodeReport(new Uint8Array(accs[i]!.data)).publish > 60).map(f => f.symbol);
  await problem("witness silent", stale.length > 0, `the price witness has posted nothing for over 60 s on ${stale.join(", ")}: X1 prices there are frozen. Check the witness machine (journalctl -u witness) or deploy/logs/x1-witness.log.`);
  return sent;
}

async function wallet() {
  let have = await conn.getBalance(payer.publicKey);
  const tk = fs.existsSync(TREASURY_KEY) ? read(TREASURY_KEY) : null;
  // Refill from the treasury, keeping its reserve.
  if (tk && have < T.topupBelow * LAMPORTS_PER_SOL) {
    const t = await conn.getBalance(tk.publicKey);
    const spare = t - T.reserve * LAMPORTS_PER_SOL - 5_000_000;
    const amount = Math.min(spare, T.topupTo * LAMPORTS_PER_SOL - have);
    if (amount > 0.5 * LAMPORTS_PER_SOL * (C.X1 ? 1 : 0.1)) {
      try {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: tk.publicKey, toPubkey: payer.publicKey, lamports: Math.floor(amount) }));
        const sig = await conn.sendTransaction(tx, [tk]);
        await conn.confirmTransaction(sig, "confirmed");
        have += Math.floor(amount);
        await send(`refilled the paying wallet with ${coin(amount)} from the treasury (treasury keeps ${coin(t - amount)}; its reserve is ${T.reserve} ${C.COIN})`);
      } catch (e: any) { say("treasury refill failed:", String(e?.message ?? e).slice(0, 120)); }
    }
  }
  if (C.X1) have -= await witness();
  const hours = C.X1 ? have / LAMPORTS_PER_SOL / 11 : have / LAMPORTS_PER_SOL / 0.05 * 24;
  await problem("paying wallet empty", have < T.alarm * LAMPORTS_PER_SOL, `🚨 paying wallet ${payer.publicKey.toBase58()} has ${coin(have)} left (about ${hours.toFixed(1)} h). Everything stops when it is empty. Send ${C.COIN} to it.`);
  await problem("paying wallet low", have >= T.alarm * LAMPORTS_PER_SOL && have < T.warn * LAMPORTS_PER_SOL, `paying wallet ${payer.publicKey.toBase58()} has ${coin(have)} left (about ${hours.toFixed(1)} h), and the treasury has nothing above its reserve to refill it.`);
  return have;
}

async function prices() {
  const stale: string[] = [];
  for (const v of (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1 && v.lastNav > 0n)) {
    const s = await C.fetchVault(conn, v.key).catch(() => null);
    if (!s?.book) continue;
    // (Slot time on X1: the mark's own times are slots; its age counts from when it was set.)
    const age = Date.now() / 1000 - (C.SLOT_TIME ? s.book.markSet : s.book.markPublish);
    const held = s.asset.oiLong > 0n || s.asset.oiShort > 0n;
    if (held && age > 300) stale.push(`${v.feed?.symbol} ${Math.round(age / 60)} min`);
  }
  await problem("prices stopped", stale.length > 0, `prices are not moving on markets with open positions: ${stale.join(", ")}. Liquidations and fills wait for them. Check the executor and the price services.`);
}

async function up(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok || !r.body) return false;
    const reader = r.body.getReader();
    const { value } = await reader.read(); // one chunk is enough: the service answers
    reader.cancel().catch(() => {});
    return !!value?.length;
  } catch { return false; }
}
async function priceServices() {
  if (!C.X1) return;
  const [jack, ours] = await Promise.all([up("http://jack0.x1.xyz:8090/v1/stream/prices?symbols=btc"), up("http://127.0.0.1:8091/v1/prices?symbols=btc")]);
  await problem("both price services down", !jack && !ours, `🚨 neither price service answers (jack0.x1.xyz:8090 and our backup 127.0.0.1:8091): X1 has no prices.`);
  await problem("jack0 down", !jack && ours, `jack0.x1.xyz:8090 (the X1 team's price service) does not answer; the executor is using our backup.`);
  await problem("backup price service down", jack && !ours, `our backup price service (127.0.0.1:8091) does not answer: X1 has no fallback if jack0 stops.`);
}

function running(name: string) {
  try { process.kill(-Number(fs.readFileSync(`${LOGS}/${name}.pid`, "utf8").trim()), 0); return true; } catch { return false; }
}
async function services() {
  const down = SERVICES.filter(s => !running(s));
  await problem("services down", down.length > 0, `not running: ${down.join(", ")}. Start with deploy/${C.X1 ? "x1" : "devnet"}-services.sh start (bots: deploy/bots.sh ${C.X1 ? "x1" : "devnet"} start).`);
  const quiet = fs.existsSync(EXEC_LOG) ? (Date.now() - fs.statSync(EXEC_LOG).mtimeMs) / 1000 : Infinity;
  await problem("executor silent", quiet > 300, `the executor has written nothing for ${Math.round(quiet / 60)} min.`);
}

// New kinds of failed bot checks. Known noise (an RPC that throttles, prices that stop during an
// outage already alerted above) is left out.
const NOISE = /day of fees|price is fresh|re-valued within ten minutes/;
const toldCheck = new Map<string, number>();
let botPos = fs.existsSync(BOT_LOG) ? fs.statSync(BOT_LOG).size : 0;
async function botChecks() {
  if (!fs.existsSync(BOT_LOG)) return;
  const size = fs.statSync(BOT_LOG).size;
  if (size < botPos) botPos = 0;
  if (size === botPos) return;
  const fd = fs.openSync(BOT_LOG, "r");
  const buf = Buffer.alloc(Math.min(size - botPos, 20_000_000));
  fs.readSync(fd, buf, 0, buf.length, botPos);
  fs.closeSync(fd);
  botPos += buf.length;
  const fresh = new Map<string, { n: number; example: any }>();
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.includes('"ok":false') || !line.includes('"type":"check"')) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (NOISE.test(r.what)) continue;
    const e = fresh.get(r.what) ?? fresh.set(r.what, { n: 0, example: r }).get(r.what)!;
    e.n++;
  }
  for (const [what, e] of fresh) {
    if (Date.now() - (toldCheck.get(what) ?? 0) < 6 * 3_600_000) continue;
    toldCheck.set(what, Date.now());
    const { at, type, what: _w, ok, ...rest } = e.example;
    await send(`bot check failed ${e.n}x: "${what}"\n${JSON.stringify(rest).slice(0, 300)}`);
  }
}

// ---- the money ----
// Share prices of the last hour, per vault (a share price ignores deposits and withdrawals: only
// gains and losses move it).
const shareHist = new Map<string, { at: number; price: number }[]>();
const usdc = (x: bigint) => `$${(Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
async function money() {
  const m = await C.fetchMarket(conn);
  const dv = new DataView(m.data.buffer, m.data.byteOffset);
  const u128 = (o: number) => dv.getBigUint64(o, true) + (dv.getBigUint64(o + 8, true) << 64n);
  // Percolator's header totals (as the Health page reads them): held, insurance, capital, profit.
  const [held, insurance, capital, profit] = [0, 1, 2, 3].map(i => u128(749 + 16 * i));
  const tok = await conn.getAccountInfo(C.PERC_VAULT);
  const tokens = tok ? new DataView(tok.data.buffer, tok.data.byteOffset).getBigUint64(64, true) : 0n;
  await problem("percolator tokens missing", tokens < held, `🚨 Percolator's token account holds ${usdc(tokens)} but its books say ${usdc(held)}: ${usdc(held - tokens)} is missing.`);
  const owed = capital + insurance + profit;
  await problem("percolator short", held < owed, `🚨 Percolator owes accounts ${usdc(owed)} (capital ${usdc(capital)} + insurance ${usdc(insurance)} + booked profit ${usdc(profit)}) but holds ${usdc(held)}: short by ${usdc(owed - held)}.`);

  const vaults = (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1 && v.lastNav > 0n);
  const cashShort: string[] = [], fell: string[] = [], over: string[] = [], fragile: string[] = [];
  const now = Date.now();
  for (const v of vaults) {
    const s = await C.fetchVault(conn, v.key);
    const name = v.feed?.symbol ?? v.key.toBase58().slice(0, 6);
    const owes = s.vault.reserved + s.vault.pendingDeposit;
    if (s.buffer < owes) cashShort.push(`${name} (cash ${usdc(s.buffer)}, owes ${usdc(owes)})`);
    const value = s.buffer - owes + s.lp.capital + s.lp.pnl;
    if (s.shareSupply > 0n && value > 0n) {
      const price = Number(value) / Number(s.shareSupply);
      const h = (shareHist.get(name) ?? []).filter(x => now - x.at <= 3_600_000);
      h.push({ at: now, price });
      shareHist.set(name, h);
      const top = Math.max(...h.map(x => x.price));
      if (price < top * 0.95) fell.push(`${name} ${((1 - price / top) * 100).toFixed(1)}%`);
    }
    if (s.asset.price > 0n && s.lp.position !== 0n) {
      const units = Math.abs(Number(s.lp.position)) / 1e6;
      const limit = Number(C.liveNav(s)) * C.tierPositionBps(C.tierOfFeed(v.feedHex)) / 10_000 / Number(s.asset.price);
      if (limit > 0 && units > limit * 1.01) over.push(`${name} (${units.toFixed(2)} units, limit ${limit.toFixed(2)})`);
      const loss = Math.abs(C.stress(s, 0.3));
      if (value > 0n && loss >= Number(value) / 1e6) fragile.push(`${name} (a 30% move costs $${loss.toFixed(0)} of ${usdc(value)})`);
    }
  }
  await problem("vault cash short", cashShort.length > 0, `🚨 vault cash does not cover what it owes now: ${cashShort.join(", ")}.`);
  await problem("vault share price fell", fell.length > 0, `a vault's share price fell more than 5% within the hour: ${fell.join(", ")}. Check its position and the price.`);
  await problem("vault over its limit", over.length > 0, `a vault holds more than its position limit: ${over.join(", ")} (Percolator can move it outside a fill: send SyncInventory and check the executor).`);
  await problem("vault fragile", fragile.length > 0, `a 30% move against the vault's position would wipe it out: ${fragile.join(", ")}.`);
  return `${vaults.length} vaults; Percolator holds ${usdc(held)} (tokens ${usdc(tokens)}), owes ${usdc(owed)}`;
}

let summaryDay = "";
async function summary(have: number) {
  const now = new Date(), day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== 8 || summaryDay === day) return;
  summaryDay = day;
  const tk = fs.existsSync(TREASURY_KEY) ? read(TREASURY_KEY) : null;
  const t = tk ? await conn.getBalance(tk.publicKey) : 0;
  const problems = [...open.keys()];
  await send(`daily: paying wallet ${coin(have)}, treasury ${coin(t)}. ${problems.length ? `Open problems: ${problems.join(", ")}.` : "No open problems."}`);
}

// `chat-id`: after you send any message to the bot, finds your chat and writes it into the file.
if (process.argv[2] === "chat-id") {
  const c = config();
  if (!c.TELEGRAM_BOT_TOKEN) { console.log(`put TELEGRAM_BOT_TOKEN=... in ${ENV_FILE} first`); process.exit(1); }
  // Waits up to three minutes for a message to the bot (opening its page is not one: press Start
  // or write anything in the chat with it, or in a group it was added to).
  let j: any = null, chats: any[] = [];
  console.log("waiting up to 3 minutes for a message to the bot: open the chat with it in Telegram, press Start (or write anything)");
  for (const end = Date.now() + 180_000; Date.now() < end && !chats.length;) {
    j = await fetch(`https://api.telegram.org/bot${c.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=20`).then(r => r.json()).catch(() => null);
    if (j?.ok === false) { console.log(`Telegram refused the token: ${j.description}`); process.exit(1); }
    chats = [...new Map((j?.result ?? []).map((u: any) => u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat).filter(Boolean).map((ch: any) => [ch.id, ch])).values()] as any[];
  }
  if (!chats.length) { console.log("no message reached the bot in 3 minutes. If another program uses this bot it may be taking its messages: then get your own id from @userinfobot and put it as TELEGRAM_CHAT_ID (a number)."); process.exit(1); }
  for (const ch of chats) console.log(`chat ${ch.id}: ${ch.title ?? [ch.first_name, ch.last_name].filter(Boolean).join(" ") ?? ch.username}`);
  const id = String(chats[chats.length - 1].id);
  const text = fs.readFileSync(ENV_FILE, "utf8");
  fs.writeFileSync(ENV_FILE, /^TELEGRAM_CHAT_ID=.*$/m.test(text) ? text.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${id}`) : `${text.trimEnd()}\nTELEGRAM_CHAT_ID=${id}\n`);
  console.log(`TELEGRAM_CHAT_ID=${id} written to ${ENV_FILE}`);
  process.exit(0);
}
if (DRY) {
  say(await money());
  say(`money checks done: ${open.size ? [...open.keys()].join(", ") : "all fine"}`);
  process.exit(0);
}
if (process.argv[2] === "test") {
  const c = config();
  if (!c.TELEGRAM_BOT_TOKEN || !c.TELEGRAM_CHAT_ID) { console.log(`no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID in ${ENV_FILE}`); process.exit(1); }
  await send("test message: alerts reach you.");
  process.exit(0);
}
say(`watchdog for ${NAME}: paying wallet ${payer.publicKey.toBase58()}, alerts ${config().TELEGRAM_BOT_TOKEN ? "to Telegram" : `only in this log (fill in ${ENV_FILE})`}`);
for (;;) {
  try {
    const have = await wallet();
    await prices();
    await priceServices();
    await services();
    await botChecks();
    await money();
    await summary(have);
  } catch (e: any) { say("check failed:", String(e?.message ?? e).slice(0, 160)); }
  await new Promise(r => setTimeout(r, 60_000));
}
