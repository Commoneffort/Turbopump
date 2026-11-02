// Market message bots: our labelled test wallets post a short message about a market now and
// then, so the Messages widget (src/chat.ts) is not empty. Each post is one memo transaction paid
// by the bot (the network fee only). The text is written from the market's real price move (an
// exchange's hourly candles) in the voice of the bot's trading style; the page tags every one of
// these wallets "bot".
// Run: NETWORK=x1-testnet npx tsx scripts/chat-bots.ts run [SOL,BTC,ETH]
//      CHAT_PACE_SECS = average seconds between two posts on the network (default 1500)
//      NETWORK=devnet npx tsx scripts/chat-bots.ts once SOL      (one post now, to try it)
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";
import * as Chat from "../src/chat";
import { exchangeCandles } from "../api/_candles";

const KEYS = new URL("../../keys/bots", import.meta.url).pathname;
const SYMBOLS = (process.argv[3] ?? process.env.CHAT_SYMBOLS ?? "SOL,BTC,ETH").split(",");
const PACE = Number(process.env.CHAT_PACE_SECS ?? 1500);
const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch(C.X1 ? 150 : 400) });
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const read = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${KEYS}/${name}.json`, "utf8"))));

type Mood = { sym: string; price: number; day: number; hour: number; high: number; low: number };
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
const px = (p: number) => (p >= 1000 ? p.toFixed(0) : p >= 10 ? p.toFixed(2) : p.toFixed(4));

/** What each bot says, by its trading style. */
const VOICES: Record<string, (m: Mood) => string[]> = {
  "bot-trend": m => m.day >= 0
    ? [`${m.sym} ${pct(m.day)} on the day. Trend is up, staying long while it holds above ${px(m.low)}.`, `Higher highs on ${m.sym}. Adding a little to the long at ${px(m.price)}.`, `${m.sym} momentum still positive (${pct(m.hour)} this hour). Not fighting it.`]
    : [`${m.sym} ${pct(m.day)} today. Trend is down, short until it reclaims ${px(m.high)}.`, `Lower lows on ${m.sym}. Holding the short at ${px(m.price)}.`, `${m.sym} keeps sliding (${pct(m.hour)} this hour). Following the move, not guessing the bottom.`],
  "bot-fade": m => Math.abs(m.day) > 0.015
    ? [`${m.sym} moved ${pct(m.day)} in a day. Stretched. Fading it here at ${px(m.price)}.`, `Everyone is ${m.day > 0 ? "long" : "short"} ${m.sym} after ${pct(m.day)}. Taking the other side, small size.`, `${m.sym} at ${px(m.price)}: expecting a pullback toward ${px((m.high + m.low) / 2)}.`]
    : [`${m.sym} quiet today (${pct(m.day)}). Waiting for an overreaction to fade.`, `Range on ${m.sym} is ${px(m.low)} to ${px(m.high)}. Buying the bottom, selling the top.`],
  "bot-cross": m => [`Holding positions across markets, ${m.sym} is the one moving today (${pct(m.day)}).`, `Cross margin helps: ${m.sym} ${pct(m.hour)} this hour, the other legs absorb it.`, `Rebalanced my book, ${m.sym} now ${m.day >= 0 ? "my largest long" : "a smaller long"}.`],
  "bot-lp": m => [`Providing liquidity on ${m.sym}. A day like this (${pct(m.day)}) is when the vault earns its fees.`, `Vault side of ${m.sym}: traders ${m.day >= 0 ? "chasing longs" : "piling into shorts"}, the side fee pays depositors.`, `Earn tab on ${m.sym} is quietly paying. Deposited a bit more.`],
  "bot-whale": m => [`Big clip on ${m.sym} at ${px(m.price)}. Watch the trades list.`, `${m.sym} liquidity is fine for my size today. Filled at the oracle price, no slippage.`, `Loading ${m.day >= 0 ? "longs" : "shorts"} on ${m.sym} in size.`],
  "bot-gambler": m => [`${m.sym} ${pct(m.day)} today. Max leverage, let's go.`, `All in on ${m.sym} ${Math.random() < 0.5 ? "long" : "short"}. Either a hero or liquidated by dinner.`, `${m.sym} at ${px(m.price)}, feels like the bottom. (It never is.)`],
  "bot-stopper": m => [`Stop loss set on my ${m.sym} position at ${px(m.day >= 0 ? m.low : m.high)}. Sleep well.`, `Trailing stop on ${m.sym} moved up to lock in some profit.`, `Reminder: set a TP/SL. ${m.sym} moved ${pct(m.day)} today.`],
  "bot-orders": m => [`Limit buy on ${m.sym} resting at ${px(m.low)}.`, `TWAP running on ${m.sym}, slicing in over the next hour.`, `Take profit on ${m.sym} at ${px(m.high)}.`],
};

async function mood(sym: string): Promise<Mood | undefined> {
  const k = await exchangeCandles(sym, 3600, 25).catch(() => []);
  if (k.length < 2) return undefined;
  const last = k[k.length - 1], first = k[0], prev = k[k.length - 2];
  return { sym, price: last[4], day: last[4] / first[1] - 1, hour: last[4] / prev[4] - 1, high: Math.max(...k.map(x => x[2])), low: Math.min(...k.map(x => x[3])) };
}

async function postOnce(sym?: string) {
  const s = sym ?? pick(SYMBOLS);
  const m = await mood(s);
  if (!m) return say("no price for", s);
  for (let tries = 0; tries < 4; tries++) {
    const name = pick(Object.keys(VOICES));
    let kp: Keypair;
    try { kp = read(name); } catch { continue; }
    const bal = await conn.getBalance(kp.publicKey).catch(() => 0);
    if (bal < 0.005 * LAMPORTS_PER_SOL) { say(name, "too little for fees, skipped"); continue; }
    const text = pick(VOICES[name](m));
    const tx = new Transaction().add(...Chat.postIxs(kp.publicKey, s, text));
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(kp);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed").catch(() => undefined);
    return say(`${name} on ${s}: ${text} (${sig.slice(0, 12)}…)`);
  }
}

const mode = process.argv[2] ?? "run";
if (mode === "once") await postOnce(process.argv[3]);
else {
  say(`chat bots on ${C.NETWORK}: ${SYMBOLS.join(",")}, a post every ~${PACE} s`);
  for (;;) {
    await postOnce().catch(e => say("post failed", String(e?.message ?? e).slice(0, 160)));
    await sleep(PACE * 1000 * (0.4 + Math.random() * 1.2));
  }
}
