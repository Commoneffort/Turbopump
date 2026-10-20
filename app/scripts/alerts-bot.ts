// Telegram alerts for traders. Anyone can talk to the bot (the one in ~/.config/percolator/alerts.env):
//   /watch <wallet>    alerts for that wallet's trading account: each fill, a margin running thin, a liquidation
//   /unwatch <wallet>  stop;   /list   what this chat watches;   /help
// It only reads public accounts, holds no keys and cannot trade. Subscriptions are kept in
// deploy/logs/alerts-subs-<network>.json.
//
//   NETWORK=x1-testnet npx tsx scripts/alerts-bot.ts
import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import * as C from "../src/chain";
import * as S from "../src/social";

const ENV_FILE = `${process.env.HOME}/.config/percolator/alerts.env`;
const env = Object.fromEntries((fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "").split("\n").map(l => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map(m => [m![1], m![2]]));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.log(`no TELEGRAM_BOT_TOKEN in ${ENV_FILE}`); process.exit(1); }
const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed" });
const SUBS = `../deploy/logs/alerts-subs-${C.X1 ? "x1" : "devnet"}.json`;
const PAGE = process.env.PAGE_URL ?? "https://turbopumpx.vercel.app";
const THIN = 1.25; // warn when equity is under 1.25x the liquidation level
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

type Subs = { offset: number; chats: Record<string, string[]> };
const subs: Subs = fs.existsSync(SUBS) ? JSON.parse(fs.readFileSync(SUBS, "utf8")) : { offset: 0, chats: {} };
const save = () => fs.writeFileSync(SUBS, JSON.stringify(subs, null, 1));

async function tg(method: string, body: object) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return r.json();
}
const say = (chat: string, text: string) => tg("sendMessage", { chat_id: chat, text, disable_web_page_preview: true }).catch(e => log("send failed", String(e).slice(0, 80)));

const HELP = `Turbopump alerts (${C.NETWORK_NAME}). I read the chain and tell you when something happens to a trading account:\n` +
  `• a fill (market, limit, stop, take-profit, copy)\n• its margin running thin (under ${THIN}x the liquidation level)\n• a liquidation\n\n` +
  `/watch <wallet address>\n/unwatch <wallet address>\n/list\n\nI hold no keys and cannot trade or move money.`;

async function commands() {
  for (;;) {
    try {
      const j: any = await tg("getUpdates", { offset: subs.offset, timeout: 25 });
      for (const u of j?.result ?? []) {
        subs.offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text) continue;
        const chat = String(m.chat.id);
        let [cmd, arg] = m.text.trim().split(/\s+/);
        // The page's link (t.me/<bot>?start=<wallet>) arrives as "/start <wallet>".
        if (cmd === "/start" && arg) cmd = "/watch";
        const list = (subs.chats[chat] ??= []);
        if (cmd === "/watch" || cmd === "/unwatch") {
          let w: PublicKey;
          try { w = new PublicKey(arg); } catch { await say(chat, "That is not a wallet address. Example: /watch 3pevGJPB…"); continue; }
          const k = w.toBase58();
          if (cmd === "/watch") {
            if (list.length >= 10) { await say(chat, "At most 10 wallets per chat."); continue; }
            if (!list.includes(k)) list.push(k);
            await say(chat, `Watching ${k.slice(0, 4)}…${k.slice(-4)}. ${(await conn.getAccountInfo(C.routerPortfolio(w))) ? "" : "It has no trading account yet; alerts start with its first trade."}`);
          } else {
            subs.chats[chat] = list.filter(x => x !== k);
            await say(chat, `Stopped watching ${k.slice(0, 4)}…${k.slice(-4)}.`);
          }
          save();
        } else if (cmd === "/list") {
          await say(chat, list.length ? `Watching:\n${list.join("\n")}` : "Watching nothing. /watch <wallet>");
        } else {
          await say(chat, HELP);
        }
      }
      save();
    } catch (e: any) {
      log("getUpdates", String(e?.message ?? e).slice(0, 100));
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Per wallet: the trade count last seen, and when it was last warned about its margin.
const seen = new Map<string, { trades: number; warnedAt: number; liquidatable: boolean }>();
let symbols = new Map<number, string>(), symbolsAt = 0;

async function check() {
  const wallets = [...new Set(Object.values(subs.chats).flat())];
  if (!wallets.length) return;
  if (Date.now() - symbolsAt > 600_000) {
    symbols = new Map((await C.listVaults(conn)).filter(v => v.canonical).map(v => [v.assetIndex, v.feed?.symbol ?? `#${v.assetIndex}`]));
    symbolsAt = Date.now();
    await C.fetchTiers(conn).catch(() => {});
  }
  const keys = wallets.flatMap(w => [C.routerPortfolio(new PublicKey(w)), C.statsAddress(new PublicKey(w))]);
  const [m, ...accs] = await conn.getMultipleAccountsInfo([C.MARKET, ...keys]);
  if (!m) return;
  const market = new Uint8Array(m.data);
  for (const [i, w] of wallets.entries()) {
    const pf = accs[2 * i], st = accs[2 * i + 1];
    const chats = Object.entries(subs.chats).filter(([, l]) => l.includes(w)).map(([c]) => c);
    const tell = (text: string) => Promise.all(chats.map(c => say(c, `${w.slice(0, 4)}…${w.slice(-4)}: ${text}\n${PAGE}/#/trader/${w}`)));
    const prev = seen.get(w);
    const now = { trades: 0, warnedAt: prev?.warnedAt ?? 0, liquidatable: false };
    if (st) {
      const s = S.decodeStats(new Uint8Array(st.data));
      now.trades = s.trades;
      if (prev && s.trades > prev.trades) {
        const fresh = s.fills.slice(-Math.min(s.trades - prev.trades, 5));
        for (const f of fresh) await tell(`filled ${f.size > 0 ? "buy" : "sell"} ${Math.abs(f.size)} ${symbols.get(f.asset) ?? ""} at $${f.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}`);
      }
    }
    if (pf) {
      const h = C.accountHealth(market, new Uint8Array(pf.data));
      now.liquidatable = h.liquidatable;
      if (h.liquidatable && !prev?.liquidatable) await tell(`below the liquidation level: its positions are being closed (equity $${(Number(h.equity) / 1e6).toFixed(2)})`);
      else if (h.notional > 0n && h.floor > 0n && Number(h.equity) < Number(h.floor) * THIN && Date.now() - now.warnedAt > 30 * 60_000) {
        now.warnedAt = Date.now();
        await tell(`margin thin: equity $${(Number(h.equity) / 1e6).toFixed(2)}, liquidated below $${(Number(h.floor) / 1e6).toFixed(2)}. Add collateral or reduce the position.`);
      }
    }
    seen.set(w, now);
  }
}

log("alerts bot on", C.NETWORK_NAME, "watching", Object.values(subs.chats).flat().length, "wallet(s)");
commands();
for (;;) {
  await check().catch(e => log("check", String(e?.message ?? e).slice(0, 120)));
  await new Promise(r => setTimeout(r, 15_000));
}
