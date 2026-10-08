// Trading bots for a test network: a few wallets that trade around the clock, and check on every
// pass that the markets still behave as they should. They are test traffic and are labelled as
// such on the leaderboard (api/_config.ts SEED_WALLETS).
//
//   trend       buys after the price rose, sells after it fell
//   fade        does the opposite
//   random      opens, flips and closes at random
//   max         always asks for the largest position its margin allows, and closes now and then
//   edge-long   holds the largest long its margin allows and never closes: the account that is
//   edge-short  liquidated first when the price moves about 9% against it (and the same, short)
//   orders      places every kind of standing order (take-profit, limit, TWAP, stop, trailing
//               stop) in a fixed routine and checks what each one does
//   lp          a liquidity provider: deposits into a vault, withdraws, claims, and checks that
//               the shares and the money it gets are its exact part of the epoch's total
//   burst-1..5  five wallets that send an order to one market at the same moment
//   cross       holds positions on every market at once and checks the largest order the page
//               would offer is exactly what the program accepts
//   scalper     opens and closes small positions back to back (each fill's cost is checked)
//   adversary   tries what must be refused: filling or expiring someone's request early,
//               cancelling someone else's order, closing a healthy account, moving a price
//               back. Only simulated, so it costs nothing and touches nobody
//
// Checked, and written to deploy/logs/<network>-bots.jsonl (a failed check also prints CHECK FAILED):
//   - an order ends filled (in full, or cut to what the vault takes) or expired, never half-known;
//   - a fill changes the account's value by its fee and by the price move on what it held, and by
//     nothing else;
//   - each vault's position is the exact opposite of all traders' positions added up, the vault's
//     own record of it agrees, and longs and shorts open on a market are equal;
//   - the collateral Percolator holds covers every account's capital;
//   - a market with positions has a price that is fresh and close to the price on an exchange;
//   - positions are re-valued soon after the price moves (a liquidation needs that);
//   - an account below the liquidation level is closed within three minutes, and nobody can
//     force a healthy account closed;
//   - a standing order (anyone's) whose condition holds is carried out within three minutes;
//   - an order above the margin limit is refused, and margin cannot be withdrawn while a position
//     is open (both only simulated, so they cost nothing).
// Run: NETWORK=x1-testnet npx tsx scripts/bots.ts run [SYMBOL,SYMBOL...]   (default SOL)
//      NETWORK=x1-testnet npx tsx scripts/bots.ts report [hours]           (what the log says)
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction } from "@solana/spl-token";
import * as fs from "fs";
import * as C from "../src/chain";
import L from "../src/layout.json";

// (BOT_LOG, FAUCET_KEY and BOT_NO_EXCHANGE are for a rehearsal on a local chain: its own log, its own
// test USDC, and prices that are made up, so not compared with an exchange.)
const LOG = process.env.BOT_LOG ?? new URL(`../../deploy/logs/${C.NETWORK}-bots.jsonl`, import.meta.url).pathname;
const KEYS = new URL("../../keys/bots", import.meta.url).pathname;
const SYMBOLS = (process.argv[3] ?? process.env.BOT_SYMBOLS ?? "SOL").split(",");
const PACE = Number(process.env.BOT_PACE_SECS ?? 240); // average seconds between one bot's orders
const PASS_SECS = Number(process.env.BOT_PASS_SECS ?? (C.X1 ? 20 : 30));
const LATE_SECS = 180; // how long a liquidation or a due order may take before it counts as missed
// The public devnet RPC is shared with the executor and the keeper on this machine: go slowly.
const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch(C.X1 ? 120 : 260) });
const read = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const note = (o: Record<string, unknown>) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }, (_, v) => (typeof v === "bigint" ? Number(v) : v)) + "\n");
const abs = (q: bigint) => (q < 0n ? -q : q);
const usd = (atoms: bigint) => (Number(atoms) / 1e6).toFixed(2);
process.on("unhandledRejection", e => say("rpc", String((e as any)?.message ?? e).split("\n")[0].slice(0, 100)));

/** Records one check. A failed one is printed too, once per `what` every ten minutes. */
const told = new Map<string, number>();
function check(ok: boolean, what: string, more: Record<string, unknown> = {}) {
  note({ type: "check", what, ok, ...more });
  if (!ok && Date.now() - (told.get(what) ?? 0) > 600_000) {
    told.set(what, Date.now());
    say("CHECK FAILED", what, JSON.stringify(more, (_, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 300));
  }
  return ok;
}

type Kind = "trend" | "fade" | "random" | "max" | "edge-long" | "edge-short" | "orders" | "lp" | "burst" | "cross" | "scalper" | "adversary";
const ROUTINES: Kind[] = ["orders", "lp", "burst", "cross", "adversary"]; // run on their own, not in the trading loop
type Bot = { name: string; kind: Kind; usdc: number; kp: Keypair };
const BOTS: { name: string; kind: Kind; usdc: number }[] = [
  { name: "bot-trend", kind: "trend", usdc: 1_500 },
  { name: "bot-fade", kind: "fade", usdc: 1_500 },
  { name: "bot-random", kind: "random", usdc: 1_000 },
  { name: "bot-max", kind: "max", usdc: 300 },
  { name: "bot-edge-long", kind: "edge-long", usdc: 200 },
  { name: "bot-edge-short", kind: "edge-short", usdc: 200 },
  { name: "bot-orders", kind: "orders", usdc: 1_000 },
  { name: "bot-lp", kind: "lp", usdc: 2_000 },
  { name: "bot-cross", kind: "cross", usdc: 600 },
  { name: "bot-scalper", kind: "scalper", usdc: 500 },
  { name: "bot-adversary", kind: "adversary", usdc: 20 },
  ...[1, 2, 3, 4, 5].map(i => ({ name: `bot-burst-${i}`, kind: "burst" as Kind, usdc: 150 })),
];
const wallet = (name: string) => {
  fs.mkdirSync(KEYS, { recursive: true });
  const p = `${KEYS}/${name}.json`;
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return read(p);
};

async function send(label: string, kp: Keypair, ixs: TransactionInstruction[], extra: Keypair[] = [], tries = 2): Promise<string | true> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp, ...extra]);
      for (let n = 0; n < 40; n++) {
        await sleep(1500);
        const st = (await conn.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
        if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return true;
      }
      throw new Error("not confirmed within 60 s");
    } catch (e: any) {
      last = [String(e.message).split("\n")[0], ...(e.logs ?? []).filter((l: string) => /custom program error/.test(l)).slice(-1)].join(" ").slice(0, 160);
      await sleep(2500);
    }
  }
  say("FAIL", label, last);
  return last;
}
/** Runs a transaction without sending it, and returns its program error code (or "ok"). */
async function wouldFail(kp: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const r = await conn.simulateTransaction(tx, [kp]);
  if (!r.value.err) return "ok";
  return (r.value.logs ?? []).map(l => l.match(/custom program error: (0x[0-9a-f]+)/)?.[1]).filter(Boolean).pop() ?? JSON.stringify(r.value.err);
}

/** Queues a trade for `kp`'s account. */
const trade = (label: string, kp: Keypair, vault: PublicKey, size: bigint) => send(label, kp, [C.requestTrade(kp.publicKey, vault, size)]);

// ---- money for the bots ----
const deployer = () => read(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`);
// Every order carries a bond that goes to whoever fills it (our own executor, so it comes back
// to the wallet that pays this). A bot is topped up for about thirty orders at a time.
// (A request also carries a deposit that comes back when it fills: room for one of $2,000.)
const DEPOSIT_FLOAT = Number(C.expiryDeposit(2_000n * C.UNIT, 1_000_000n));
const GAS_LOW = C.ROUTER_BOND_LAMPORTS * 4 + DEPOSIT_FLOAT, GAS_FILL = C.ROUTER_BOND_LAMPORTS * 30 + DEPOSIT_FLOAT;
// Below this the paying wallet is reported on every pass (PAYER_WARN to change it): about a day
// of what the services were measured to spend (X1 ~270 XNT a day with 19 markets, devnet ~1 SOL).
const PAYER_WARN = Number(process.env.PAYER_WARN ?? (C.X1 ? 300 : 1.5));
async function gas(kp: Keypair) {
  if (await conn.getBalance(kp.publicKey) >= GAS_LOW) return;
  const from = deployer();
  if (await conn.getBalance(from.publicKey) < GAS_FILL + 0.3 * LAMPORTS_PER_SOL) { say(`the paying wallet is low on ${C.COIN}: ${kp.publicKey.toBase58().slice(0, 6)} was not topped up`); return; }
  const r = await send(`fees for ${kp.publicKey.toBase58().slice(0, 6)}`, from, [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: kp.publicKey, lamports: GAS_FILL })]);
  note({ type: "gas", wallet: kp.publicKey.toBase58(), lamports: GAS_FILL, ok: r === true });
}
async function mint(kp: Keypair, usdc: number) {
  const from = deployer();
  const faucetKey = process.env.FAUCET_KEY ?? (C.X1 ? "../keys/x1-faucet.json" : "../keys/faucet.json");
  const faucet = fs.existsSync(faucetKey) ? read(faucetKey) : from;
  const ata = C.ata(kp.publicKey, C.MINT);
  return send(`test USDC for ${kp.publicKey.toBase58().slice(0, 6)}`, from, [createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata, kp.publicKey, C.MINT), createMintToInstruction(C.MINT, ata, faucet.publicKey, BigInt(usdc * C.USDC))], faucet === from ? [] : [faucet]);
}
async function fund(b: Bot) {
  await gas(b.kp);
  if (b.kind === "lp") { // its money stays in its wallet: it deposits into vaults, it does not trade
    const a = await conn.getAccountInfo(C.ata(b.kp.publicKey, C.MINT));
    if (!a || new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) < 300_000_000n) await mint(b.kp, b.usdc);
    return;
  }
  if (await conn.getAccountInfo(C.traderAddress(b.kp.publicKey))) return;
  if ((await mint(b.kp, b.usdc)) !== true) return;
  await send(`open trading account ${b.name}`, b.kp, [C.openTradingAccount(b.kp.publicKey), C.routerDeposit(b.kp.publicKey, BigInt(b.usdc * C.USDC))]);
}
/** A bot that lost most of its margin (a liquidated one, say) and holds nothing gets it back. */
async function refill(b: Bot, s: C.State) {
  const equity = s.health?.equity ?? s.portfolio?.capital ?? 0n;
  if (s.openPositions !== 0 || equity * 10n >= BigInt(b.usdc * C.USDC) * 3n) return false;
  const add = b.usdc - Math.floor(Number(equity) / 1e6);
  if ((await mint(b.kp, add)) !== true) return false;
  const r = await send(`deposit ${add} for ${b.name}`, b.kp, [C.routerDeposit(b.kp.publicKey, BigInt(add * C.USDC))]);
  note({ type: "refill", bot: b.name, equityBefore: equity, added: add, ok: r === true });
  say(`${b.name}: margin was down to $${usd(equity)}, added $${add}`);
  return true;
}

// ---- the markets ----
type Market = { symbol: string; vault: PublicKey; assetIndex: number; lpPortfolio: PublicKey };
let markets: Market[] = [];   // every live market of this deployment (all are checked)
let traded: Market[] = [];    // the ones the bots trade
async function loadMarkets() {
  const all = (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1 && v.feed);
  markets = all.map(v => ({ symbol: v.feed!.symbol, vault: v.key, assetIndex: v.assetIndex, lpPortfolio: v.lpPortfolio }));
  traded = markets.filter(m => SYMBOLS.includes(m.symbol) && all.find(v => v.key.equals(m.vault))!.lastNav > 0n);
}
const history = new Map<string, number[]>(); // symbol -> the last prices seen, one per pass
/** A size step worth about a tenth of a cent to a dollar at this price (a power of ten). */
const stepOf = (price: bigint) => { let s = 1n; while (s * 10n * price <= 1_000_000_000_000n && s < 100_000n) s *= 10n; return s; };

// Prices on an exchange, to compare the on-chain price with (free; skipped when unreachable).
let outside = new Map<string, number>(), outsideAt = 0;
async function outsidePrices() {
  if (Date.now() - outsideAt < 60_000 || process.env.BOT_NO_EXCHANGE === "1") return;
  outsideAt = Date.now();
  try {
    const want = markets.map(m => `"${m.symbol}USDT"`).join(",");
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=[${want}]`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) {
      // One unknown symbol fails the whole list: ask for them one by one instead.
      const got = new Map<string, number>();
      for (const m of markets) {
        const x = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${m.symbol}USDT`, { signal: AbortSignal.timeout(6000) }).then(x => (x.ok ? x.json() : null)).catch(() => null);
        if (x?.price) got.set(m.symbol, Number(x.price));
      }
      outside = got;
      return;
    }
    outside = new Map((await r.json()).map((x: any) => [x.symbol.replace(/USDT$/, ""), Number(x.price)]));
  } catch { outside = new Map(); }
}

const under = new Map<string, { since: number; notional: bigint; equity: bigint }>(); // accounts below the liquidation level
const unsettled = new Map<string, number>(); // portfolio -> since when it has been out of date
const dueOrders = new Map<string, number>(); // order -> since when its condition has held
const outOfSync = new Map<string, number>(); // vault -> since when its own record differs
let lastShare = new Map<string, number>();

/** Every market as a whole: the vault against everyone else, one side against the other, the
 *  price, the accounts near liquidation, and the standing orders that are due. */
async function marketChecks() {
  const now = Date.now();
  const [snap, vaultAccs, bookAccs, traderAccs, orderAccs, percVault] = await Promise.all([
    C.marketSnapshot(conn),
    conn.getMultipleAccountsInfo(markets.map(m => m.vault)),
    conn.getMultipleAccountsInfo(markets.map(m => C.bookAddress(m.vault))),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.TRADER_LEN }] }),
    conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.ORDER_LEN }] }),
    conn.getAccountInfo(C.PERC_VAULT),
  ]);
  await outsidePrices();
  const rates = C.marketRates(snap.market);
  const lps = new Set(markets.map(m => m.lpPortfolio.toBase58()));
  const owners = new Map(traderAccs.map(t => { const d = C.decodeTrader(new Uint8Array(t.account.data)); return [d.portfolio.toBase58(), d] as const; }));
  const byKey = new Map(snap.portfolios.map(p => [p.pubkey.toBase58(), p.data]));

  // 1. Each market: positions add up, the price is fresh and right.
  for (const [i, m] of markets.entries()) {
    if (!vaultAccs[i]) continue;
    const v = C.decodeVault(m.vault, new Uint8Array(vaultAccs[i]!.data));
    const a = C.decodeAsset(snap.market, m.assetIndex);
    const book = bookAccs[i] ? C.decodeBook(new Uint8Array(bookAccs[i]!.data)) : undefined;
    let traders = 0n, lp = 0n, holders = 0;
    for (const p of snap.portfolios) {
      const q = C.decodePortfolio(p.data, m.assetIndex, snap.market).position;
      if (p.pubkey.equals(m.lpPortfolio)) { lp = q; continue; }
      if (q !== 0n) { traders += q; holders++; }
    }
    const closeOnly = C.closeOnly(snap.market, m.assetIndex);
    const ok = lp + traders === 0n && a.oiLong === a.oiShort;
    const price = Number(a.price) / 1e6;
    const h = history.get(m.symbol) ?? history.set(m.symbol, []).get(m.symbol)!;
    h.push(price); if (h.length > 20) h.shift();
    const markAge = book ? Math.round(now / 1000 - book.markPublish) : undefined;
    const out = outside.get(m.symbol);
    const lpData = byKey.get(m.lpPortfolio.toBase58());
    const lpP = lpData ? C.decodePortfolio(lpData, m.assetIndex, snap.market) : undefined;
    note({ type: "market", symbol: m.symbol, ok, vaultPosition: lp, tradersNet: traders, holders, oiLong: a.oiLong, oiShort: a.oiShort, epoch: v.epoch, nav: v.lastNav, price: a.price, mark: book?.markPrice, markAge, outside: out, closeOnly, lpCapital: lpP?.capital, lpPnl: lpP?.pnl });
    if (!ok) check(false, `${m.symbol}: the vault's position is the opposite of all traders'`, { vault: lp, traders, oiLong: a.oiLong, oiShort: a.oiShort });
    // The vault's own record is re-read by the executor after a forced reduction; it may lag a pass or two.
    const k = m.vault.toBase58();
    if (v.inventory !== lp) { if (!outOfSync.has(k)) outOfSync.set(k, now); else if (now - outOfSync.get(k)! > LATE_SECS * 1000) check(false, `${m.symbol}: the vault's record of its position agrees with Percolator`, { recorded: v.inventory, held: lp }); }
    else outOfSync.delete(k);
    if (closeOnly) check(false, `${m.symbol}: market is open for new positions`, { closeOnly });
    if (holders > 0 && markAge !== undefined && markAge > 300) check(false, `${m.symbol}: price is fresh while positions are open`, { markAgeSecs: markAge });
    if (out && book && book.markPrice > 0n && markAge !== undefined && markAge < 120) {
      const off = Math.abs(Number(book.markPrice) / 1e6 / out - 1);
      if (off > 0.01) check(false, `${m.symbol}: price is within 1% of the exchange price`, { mark: Number(book.markPrice) / 1e6, exchange: out, offPct: +(off * 100).toFixed(2) });
    }
  }

  // The wallet that pays the executor, the keeper and the bots' fees. Both networks stood still
  // for a day and more in October 2026 because it ran dry unnoticed: say so a day ahead.
  const payerLeft = await conn.getBalance(deployer().publicKey).catch(() => undefined);
  if (payerLeft !== undefined) {
    note({ type: "payer", lamports: payerLeft });
    if (payerLeft < PAYER_WARN * LAMPORTS_PER_SOL) check(false, `the paying wallet has a day of fees left (${PAYER_WARN} ${C.COIN})`, { wallet: deployer().publicKey.toBase58(), left: +(payerLeft / LAMPORTS_PER_SOL).toFixed(3) });
  }

  // 2. Money: the collateral Percolator holds covers every account's capital.
  if (percVault) {
    const held = new DataView(percVault.data.buffer, percVault.data.byteOffset).getBigUint64(64, true);
    const capital = snap.portfolios.reduce((t, p) => t + C.decodePortfolio(p.data, 0).capital, 0n);
    note({ type: "money", held, capital, spare: held - capital, accounts: snap.portfolios.length });
    if (held < capital) check(false, "the collateral held covers every account's capital", { held, capital });
  }

  // 3. Accounts: out-of-date ones, and the ones below the liquidation level.
  let thinnest = 1e9, liquidatable = 0;
  for (const p of snap.portfolios) {
    const k = p.pubkey.toBase58();
    if (lps.has(k)) continue;
    const h = C.accountHealth(snap.market, p.data);
    if (h.notional === 0n) {
      // An account that was below the level and now holds nothing was closed in full.
      const gone = under.get(k);
      if (gone) {
        under.delete(k);
        note({ type: "liquidation", stage: "closed", portfolio: k, secs: Math.round((now - gone.since) / 1000), notionalBefore: gone.notional, notionalAfter: 0, equityBefore: gone.equity, equityAfter: h.equity, ok: h.equity >= 0n });
        say(`account ${owners.get(k)?.wallet.toBase58().slice(0, 6)}: liquidated in full ${Math.round((now - gone.since) / 1000)} s after it was first seen below the level; $${usd(h.equity)} left of $${usd(gone.equity)}`);
        if (h.equity < 0n) check(false, "a liquidated account is not left owing money", { portfolio: k, equity: h.equity });
      }
      unsettled.delete(k);
      continue;
    }
    const ratio = Number(h.equity * 10_000n / h.notional);
    if (h.settled) { unsettled.delete(k); thinnest = Math.min(thinnest, ratio); }
    else if (!unsettled.has(k)) unsettled.set(k, now);
    else if (now - unsettled.get(k)! > 600_000) check(false, "positions are re-valued within ten minutes of a price move", { portfolio: k, secs: Math.round((now - unsettled.get(k)!) / 1000) });
    const was = under.get(k);
    if (h.liquidatable) {
      liquidatable++;
      const who = owners.get(k)?.wallet.toBase58();
      if (!was) {
        under.set(k, { since: now, notional: h.notional, equity: h.equity });
        note({ type: "liquidation", stage: "below the level", portfolio: k, wallet: who, equity: h.equity, notional: h.notional, ratioBps: ratio });
        say(`account ${who?.slice(0, 6)} is below the liquidation level: $${usd(h.equity)} on $${usd(h.notional)} of positions (${(ratio / 100).toFixed(2)}%)`);
      } else if (now - was.since > LATE_SECS * 1000) check(false, `an account below the liquidation level is closed within ${LATE_SECS} s`, { portfolio: k, wallet: who, secs: Math.round((now - was.since) / 1000), equity: h.equity, notional: h.notional });
      // Percolator's own level is the backstop (it makes the market close-only): the router's
      // liquidation is meant to come first.
      if (BigInt(ratio) < rates.marginBps) check(false, "the router liquidates before Percolator's own level is reached", { portfolio: k, ratioBps: ratio, percolatorBps: rates.marginBps });
    } else if (was) {
      under.delete(k);
      const reduced = h.notional < was.notional;
      note({ type: "liquidation", stage: reduced ? "closed" : "recovered by the price", portfolio: k, secs: Math.round((now - was.since) / 1000), notionalBefore: was.notional, notionalAfter: h.notional, equityBefore: was.equity, equityAfter: h.equity, ok: true });
      say(`account ${k.slice(0, 6)}: ${reduced ? "liquidated" : "back above the level"} after ${Math.round((now - was.since) / 1000)} s; $${usd(h.equity)} left on $${usd(h.notional)}`);
    }
  }
  note({ type: "accounts", thinnestBps: thinnest === 1e9 ? null : thinnest, liquidatable, outOfDate: unsettled.size, liquidationBps: C.LIQUIDATION_BPS });

  // 4. Standing orders, anyone's: one whose condition holds is carried out (or removed) soon.
  const chainNow = Math.floor(now / 1000);
  const seen = new Set<string>();
  for (const acc of orderAccs) {
    const o = C.decodeOrder(acc.pubkey, new Uint8Array(acc.account.data));
    const i = markets.findIndex(m => m.vault.equals(o.vault));
    const pf = byKey.get(C.routerPortfolio(o.wallet).toBase58());
    if (i < 0 || !bookAccs[i] || !pf) continue;
    const book = C.decodeBook(new Uint8Array(bookAccs[i]!.data));
    const held = C.decodePortfolio(pf, markets[i].assetIndex, snap.market).position;
    const what = C.orderAction(o, book.markPrice, held, chainNow);
    const k = acc.pubkey.toBase58();
    const pending = owners.get(C.routerPortfolio(o.wallet).toBase58())?.hasPending;
    // A trail only records a better mark once it is 0.1% better; that is not "due".
    if ((what !== "fire" && what !== "void") || pending || C.closeOnly(snap.market, markets[i].assetIndex)) continue;
    seen.add(k);
    if (!dueOrders.has(k)) dueOrders.set(k, now);
    else if (now - dueOrders.get(k)! > LATE_SECS * 1000) {
      const name = ["stop", "take-profit", "trailing stop", "limit", "TWAP"][o.kind];
      // An order that adds to a position can be refused for margin; that one is the trader's to fix.
      const mayBeMargin = what === "fire" && o.kind >= C.ORDER.LIMIT && !o.reduceOnly;
      if (!mayBeMargin) check(false, `a standing order that is due is carried out within ${LATE_SECS} s`, { order: k, kind: name, wallet: o.wallet.toBase58(), market: markets[i].symbol, action: what, secs: Math.round((now - dueOrders.get(k)!) / 1000), mark: book.markPrice, trigger: o.trigger });
    }
  }
  for (const k of dueOrders.keys()) if (!seen.has(k)) dueOrders.delete(k);
  note({ type: "orders-open", count: orderAccs.length, due: seen.size });
}

/** Waits for the wallet's queued request to end, and returns the state after it (or undefined
 *  after 150 s). `seen` collects the prices passed on the way. */
async function settledState(kp: Keypair, vault: PublicKey, seen: bigint[]) {
  for (let i = 0; i < 50; i++) {
    await sleep(3000);
    const t = await conn.getAccountInfo(C.traderAddress(kp.publicKey)).catch(() => null);
    if (!t) continue;
    if (C.decodeTrader(new Uint8Array(t.data)).hasPending) {
      if (i % 3 === 2) { const s = await C.fetchVault(conn, vault).catch(() => null); if (s) seen.push(s.asset.price, s.book?.markPrice ?? s.asset.price); }
      continue;
    }
    // The fill re-values the account; wait until what is read is at the current price.
    for (let n = 0; n < 4; n++) {
      const after = await C.fetchVault(conn, vault, kp.publicKey);
      if (after.health?.settled !== false || n === 3) return after;
      await sleep(4000);
    }
  }
  return undefined;
}

/** A fill changes the account's value by its fee and by the price move on what was held before
 *  it, and by nothing else. The fill's own price is not read here, so the check allows for the
 *  range of prices seen between the two readings. */
function accounting(bot: string, symbol: string, before: C.State, after: C.State, got: bigint, feeBps: bigint, seen: bigint[]) {
  if (!before.health || !after.health || !before.health.settled || !after.health.settled || before.openPositions > 1 || after.openPositions > 1) return;
  const held = before.portfolio?.position ?? 0n;
  const pB = before.asset.price, pA = after.asset.price;
  const all = [pB, pA, ...seen].filter(p => p > 0n);
  const span = all.reduce((m, p) => (p > m ? p : m), 0n) - all.reduce((m, p) => (p < m ? p : m), pA);
  const fee = abs(got) * pA / 1_000_000n * feeBps / 10_000n;
  const moved = held * (pA - pB) / 1_000_000n;
  const unexplained = after.health.equity - before.health.equity + fee - moved;
  const allowed = (abs(got) + abs(held)) * span / 1_000_000n + fee / 20n + 20_000n;
  check(abs(unexplained) <= allowed, "a fill changes the account's value by its fee and the price move only", { bot, symbol, got, heldBefore: held, equityBefore: before.health.equity, equityAfter: after.health.equity, fee, priceMove: moved, unexplained, allowed });
}

async function act(bot: Bot, m: Market, feeBps: bigint) {
  const kp = bot.kp;
  await gas(kp);
  const s = await C.fetchVault(conn, m.vault, kp.publicKey);
  if (!s.trader) { await fund(bot); return; } // its account was not opened at the start (the RPC refused): try again
  if (!s.book || !s.portfolio) return;
  if (s.trader.hasPending) return; // its last order is still queued
  if (await refill(bot, s)) return; // the account changed: act on it next time
  if (s.closeOnly) { note({ type: "skip", bot: bot.name, symbol: m.symbol, why: "market is close-only" }); return; }
  const held = s.portfolio.position;
  const cap = s.margin ?? 0n;                       // the largest position the margin allows
  const room = C.depth(s);
  const marginMax = (sign: bigint) => (held === 0n || (held > 0n) === (sign > 0n) ? (cap > abs(held) ? cap - abs(held) : 0n) : abs(held) + cap);
  const rnd = Math.random();
  const prices = history.get(m.symbol) ?? [];
  const up = prices.length >= 3 ? prices[prices.length - 1] >= prices[prices.length - 3] : rnd < 0.5;

  // Refusals, simulated: free, and they must fail with exactly these codes.
  if (rnd < 0.15) {
    const sign = held >= 0n ? 1n : -1n;
    const tooMuch = marginMax(sign) * 13n / 10n + 1_000_000n;
    if (tooMuch <= (sign > 0n ? room.long : room.short)) {
      const code = await wouldFail(kp, [C.requestTrade(kp.publicKey, m.vault, tooMuch * sign)]);
      note({ type: "refusal", bot: bot.name, what: "order above the margin limit", code, ok: code === "0x5706" });
      if (code !== "0x5706") say("CHECK FAILED", bot.name, "an order above the margin limit answered", code);
    }
    if (s.openPositions > 0) {
      const code = await wouldFail(kp, [createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, C.ata(kp.publicKey, C.MINT), kp.publicKey, C.MINT), C.routerWithdraw(kp.publicKey, 1_000_000n)]);
      note({ type: "refusal", bot: bot.name, what: "withdrawal with a position open", code, ok: code === "0x13" });
      if (code !== "0x13") say("CHECK FAILED", bot.name, "a withdrawal with a position open answered", code);
    }
    // Nobody can force a healthy account closed (the market is not close-only here).
    if (held !== 0n && s.health && !s.health.liquidatable && s.health.equity * 10_000n > s.health.notional * (C.LIQUIDATION_BPS + 100n)) {
      const code = await wouldFail(kp, [C.requestClose(kp.publicKey, kp.publicKey, m.vault)]);
      note({ type: "refusal", bot: bot.name, what: "forced close of a healthy account", code, ok: code === "0x5710" });
      if (code !== "0x5710") say("CHECK FAILED", bot.name, "a forced close of a healthy account answered", code);
    }
  }

  let want: bigint; // signed size to ask for
  const part = (q: bigint, lo: number, hi: number) => q * BigInt(Math.round((lo + Math.random() * (hi - lo)) * 1000)) / 1000n;
  if (bot.kind === "max") {
    // Rides at the limit: closes when it has a position, else opens as much as it may.
    want = held !== 0n && rnd < 0.4 ? -held : (up ? 1n : -1n) * marginMax(up ? 1n : -1n) * 98n / 100n;
  } else if (bot.kind === "edge-long" || bot.kind === "edge-short") {
    // Sits at the limit on one side and never closes. Adds only when the price went its way
    // far enough to leave real room, so it is always the account nearest to liquidation.
    const sign = bot.kind === "edge-long" ? 1n : -1n;
    const more = marginMax(sign) * 98n / 100n;
    if (held !== 0n && (held > 0n) !== (sign > 0n)) want = -held;
    else if (held !== 0n && more * 8n < abs(held)) return;
    else want = sign * more;
  } else if (bot.kind === "scalper") {
    // In and straight out again, about $60 a time; now and then the smallest size there is.
    const unit = 60_000_000n * 1_000_000n / (s.asset.price > 0n ? s.asset.price : 1n);
    want = held !== 0n ? -held : rnd < 0.08 ? 1n : (Math.random() < 0.5 ? 1n : -1n) * unit;
  } else if (held !== 0n && rnd < 0.3) want = -held;                         // take it off
  else {
    const dir = bot.kind === "trend" ? up : bot.kind === "fade" ? !up : Math.random() < 0.5;
    want = (dir ? 1n : -1n) * part(cap, 0.08, 0.3);
  }
  const sign = want > 0n ? 1n : -1n;
  const vaultRoom = sign > 0n ? room.long : room.short;
  if (abs(want) > marginMax(sign)) want = sign * marginMax(sign);
  const step = stepOf(s.asset.price);
  if (want !== -held && abs(want) !== 1n) want = want / step * step;
  if (want === 0n || vaultRoom === 0n) { note({ type: "skip", bot: bot.name, symbol: m.symbol, why: vaultRoom === 0n ? "the vault takes nothing on that side" : "no margin for an order" }); return; }

  const sentAt = Date.now();
  const r = await trade(`${bot.name} ${Number(want) / 1e6} ${m.symbol}`, kp, m.vault, want);
  if (r !== true) { note({ type: "order", bot: bot.name, symbol: m.symbol, want, outcome: "not accepted", error: r, ok: false }); return; }
  const seen: bigint[] = [];
  const after = await settledState(kp, m.vault, seen);
  if (!after) {
    note({ type: "order", bot: bot.name, symbol: m.symbol, want, outcome: "STILL QUEUED after 150 s", ok: false });
    say("CHECK FAILED", bot.name, "order still queued after 150 s (is the executor running?)");
    return;
  }
  const got = (after.portfolio?.position ?? 0n) - held;
  // The vault cuts an order to what it takes at the fill, which is measured against its value
  // and the price then: a cut is any fill on the right side, smaller than asked, near that room.
  const cut = got !== 0n && (got > 0n) === (want > 0n) && abs(got) < abs(want) && abs(abs(got) - vaultRoom) * 50n <= vaultRoom;
  const outcome = got === 0n ? "expired" : got === want ? "filled" : cut ? "cut to the vault's room" : "UNEXPECTED SIZE";
  const lev = after.health && after.health.equity > 0n ? Number(after.health.notional) / Number(after.health.equity) : 0;
  note({ type: "order", bot: bot.name, symbol: m.symbol, want, got, outcome, secs: Math.round((Date.now() - sentAt) / 1000), price: after.asset.price, equityBefore: s.health?.equity, equityAfter: after.health?.equity, leverage: +lev.toFixed(2), ok: outcome !== "UNEXPECTED SIZE" });
  say(`${bot.name}: ${Number(want) / 1e6} ${m.symbol} -> ${outcome}; position ${Number(after.portfolio?.position ?? 0n) / 1e6}, ${lev.toFixed(1)}x`);
  if (outcome === "UNEXPECTED SIZE") say("CHECK FAILED", bot.name, `asked ${want}, got ${got}, the vault's room was ${vaultRoom}`);
  if (got !== 0n) accounting(bot.name, m.symbol, s, after, got, feeBps, seen);
}

// ---- the orders bot: one routine through every kind of standing order ----
const ORDER_WAIT = Number(process.env.BOT_ORDER_WAIT_SECS ?? 600); // how long to wait for the price to reach a real stop
let cycle = 0;
async function ordersRoutine(bot: Bot, m: Market, feeBps: bigint) {
  const kp = bot.kp, me = kp.publicKey;
  const dir = cycle++ % 2 === 0 ? 1n : -1n; // long one time, short the next
  const side = dir > 0n ? "long" : "short";
  const tag = `orders ${m.symbol} ${side}`;
  const ok = (cond: boolean, what: string, more: Record<string, unknown> = {}) => { check(cond, `${what}`, { bot: bot.name, symbol: m.symbol, side, ...more }); say(`${tag}: ${cond ? "ok  " : "FAIL"} ${what}`); return cond; };
  const state = () => C.fetchVault(conn, m.vault, me);
  const must = async (label: string, ixs: TransactionInstruction[]) => { const r = await send(`${bot.name} ${label}`, kp, ixs); if (r !== true) throw new Error(`${label}: ${r}`); };
  const market = async (label: string, size: bigint) => { const r = await trade(`${bot.name} ${label}`, kp, m.vault, size); if (r !== true) throw new Error(`${label}: ${r}`); };
  /** Polls until `done`, or returns undefined after `secs`. */
  const until = async (done: (s: C.State) => boolean, secs: number, every = 4000, each?: (s: C.State) => void) => {
    for (const end = Date.now() + secs * 1000; Date.now() < end;) {
      const s = await state().catch(() => null);
      if (s) { each?.(s); if (done(s)) return s; }
      await sleep(every);
    }
    return undefined;
  };
  const pos = (s: C.State) => s.portfolio?.position ?? 0n;
  const has = (s: C.State, index: number) => s.orders.some(o => o.index === index);
  const idle = (s: C.State) => !s.trader?.hasPending;

  await gas(kp);
  let s = await state();
  if (!s.trader) { await fund(bot); return; }
  if (!s.book || !s.portfolio) return;
  await refill(bot, s);
  if (s.closeOnly) { note({ type: "skip", bot: bot.name, symbol: m.symbol, why: "market is close-only" }); return; }
  // Start clean: no orders of an earlier run, no position.
  if (s.trader.hasPending) s = (await until(idle, 150)) ?? s;
  for (const o of s.orders) if (!o.queued) await must("clear an old order", [C.cancelOrder(me, m.vault, o.index)]);
  s = await state();
  if (pos(s) !== 0n) { await market("flatten", -pos(s)); s = (await until(x => pos(x) === 0n && idle(x), 150)) ?? await state(); }
  if (pos(s) !== 0n || s.orders.length) { ok(false, "the routine starts with no position and no orders", { position: pos(s), orders: s.orders.length }); return; }

  // The unit: about $60 of the asset, an even number of size steps.
  const px = s.asset.price, step = stepOf(px);
  const q = (60_000_000n * 1_000_000n / px) / (2n * step) * (2n * step);
  const room = C.depth(s);
  if (q === 0n || (dir > 0n ? room.long : room.short) < 6n * q || (dir > 0n ? room.short : room.long) < 6n * q || (s.margin ?? 0n) < 8n * q) {
    note({ type: "skip", bot: bot.name, symbol: m.symbol, why: "the vault or the margin has no room for the routine" });
    return;
  }
  const order = (index: number, kind: number, size: bigint, trigger: bigint, more: Partial<C.OrderParams> = {}) => C.placeOrder(me, m.vault, { index, kind, size, trigger, ...more });
  const pct = (p: bigint, bps: bigint) => p * (10_000n + bps) / 10_000n;
  const equity0 = s.health?.equity ?? s.portfolio!.capital;
  let fills = 0n; // notional traded, for the fee total at the end

  // Refusals with no position: a stop needs a position to protect, and a TWAP or a trail with
  // parameters outside the limits is no order.
  const codes = {
    stop: await wouldFail(kp, [order(6, C.ORDER.STOP, 0n, pct(px, -100n))]),
    twap: await wouldFail(kp, [order(6, C.ORDER.TWAP, q, 0n, { slices: 3, interval: 5 })]),
    trail: await wouldFail(kp, [order(6, C.ORDER.TRAIL, 0n, 5_001n)]),
  };
  ok(codes.stop === "0x5714" && codes.twap === "0x5714" && codes.trail === "0x5714", "orders that make no sense are refused (a stop with no position, a TWAP every 5 s, a 50% trail)", codes);

  // 1. A position to work on: 4 units.
  await market("market order", dir * 4n * q);
  let r = await until(x => pos(x) === dir * 4n * q && idle(x), 150);
  if (!ok(!!r, "market order fills in full", { want: dir * 4n * q, got: pos(r ?? await state()) })) return;
  s = r!; fills += 4n * q;

  // 2. A limit far from the price waits; nobody can carry it out early; its owner can cancel it.
  await must("far limit", [order(7, C.ORDER.LIMIT, dir * q, pct(px, dir > 0n ? -5_000n : 5_000n))]);
  await sleep(40_000);
  s = await state();
  const far = s.orders.find(o => o.index === 7);
  const early = far ? await wouldFail(kp, [C.triggerOrder(me, far)]) : "missing";
  ok(!!far && !far.queued && pos(s) === dir * 4n * q && early === "0x5713", "a limit far from the price waits, and cannot be carried out early", { early });
  await must("cancel", [C.cancelOrder(me, m.vault, 7)]);
  s = await state();
  ok(!has(s, 7), "the owner can cancel a waiting order");

  // 3. Take-profit on 1 unit at a price already reached: carried out at once, then removed.
  let t0 = Date.now();
  await must("take-profit", [order(0, C.ORDER.TAKE, q, pct(s.book!.markPrice, dir > 0n ? -10n : 10n))]);
  r = await until(x => pos(x) === dir * 3n * q && !has(x, 0) && idle(x), 180);
  ok(!!r, "take-profit closes exactly its size and is removed", { secs: Math.round((Date.now() - t0) / 1000), position: pos(r ?? await state()), expected: dir * 3n * q });
  s = r ?? await state(); fills += q;

  // 4. Limit that adds 1 unit, 1% through the price: carried out at once, at the limit or better.
  const limit = pct(s.book!.markPrice, dir > 0n ? 100n : -100n);
  t0 = Date.now();
  await must("limit", [order(1, C.ORDER.LIMIT, dir * q, limit)]);
  r = await until(x => pos(x) === pos(s) + dir * q && !has(x, 1) && idle(x), 180);
  ok(!!r && (dir > 0n ? r.asset.price <= limit : r.asset.price >= limit), "limit order fills its size at its price or better", { secs: Math.round((Date.now() - t0) / 1000), limit, price: r?.asset.price });
  s = r ?? await state(); fills += q;

  // 5. TWAP: take 1.5 units off in three slices, 20 seconds apart, reduce-only.
  const start = pos(s);
  const steps = new Set<string>();
  t0 = Date.now();
  await must("TWAP", [order(2, C.ORDER.TWAP, -dir * (q / 2n) * 3n, 0n, { slices: 3, interval: 20, reduceOnly: true })]);
  r = await until(x => pos(x) === start - dir * (q / 2n) * 3n && !has(x, 2) && idle(x), 300, 3000, x => steps.add(pos(x).toString()));
  const took = Math.round((Date.now() - t0) / 1000);
  ok(!!r && took >= 40, "TWAP trades its total in slices spread over time, and is removed", { secs: took, positionsSeen: [...steps], expected: start - dir * (q / 2n) * 3n, got: pos(r ?? await state()) });
  s = r ?? await state(); fills += (q / 2n) * 3n;

  // 6. A real bracket: stop 0.15% against the position, take-profit 0.15% in its favour, both
  //    for all of it. Neither may fire before the price is there; when one does, it closes the
  //    position and the other is removed with it.
  if (pos(s) !== 0n) {
    const mark0 = s.book!.markPrice;
    const stopAt = pct(mark0, dir > 0n ? -15n : 15n), takeAt = pct(mark0, dir > 0n ? 15n : -15n);
    await must("stop and take-profit", [order(4, C.ORDER.STOP, 0n, stopAt), order(5, C.ORDER.TAKE, 0n, takeAt)]);
    let lo = mark0, hi = mark0;
    t0 = Date.now();
    r = await until(x => pos(x) === 0n && idle(x), ORDER_WAIT, 5000, x => { const k = x.book!.markPrice; if (k < lo) lo = k; if (k > hi) hi = k; });
    if (r) {
      // The price the routine saw may be a few seconds off the one the program acted on, so the
      // far side of the bracket is what is checked: it was never reached.
      const reachedStop = dir > 0n ? lo <= stopAt : hi >= stopAt, reachedTake = dir > 0n ? hi >= takeAt : lo <= takeAt;
      fills += abs(pos(s));
      ok(true, `a stop or a take-profit closes the whole position (${reachedStop && !reachedTake ? "the stop" : reachedTake && !reachedStop ? "the take-profit" : "one of them"} fired)`, { secs: Math.round((Date.now() - t0) / 1000), stopAt, takeAt, lowest: lo, highest: hi });
      const swept = await until(x => x.orders.length === 0, 180);
      ok(!!swept, "the order left over when its position closed is removed");
      s = swept ?? await state();
    } else {
      s = await state();
      const waiting = has(s, 4) && has(s, 5) && pos(s) !== 0n;
      const reached = dir > 0n ? lo <= stopAt || hi >= takeAt : hi >= stopAt || lo <= takeAt;
      ok(waiting && !reached, "a stop and a take-profit wait while the price is between them", { secs: ORDER_WAIT, stopAt, takeAt, lowest: lo, highest: hi });
      for (const o of s.orders) if (!o.queued) await must("cancel", [C.cancelOrder(me, m.vault, o.index)]);
      s = await state();
    }
  }

  // 7. Trailing stop of 0.10%: follows the best price, fires once the price comes back that far.
  if (pos(s) === 0n) {
    await market("market order", dir * 2n * q);
    s = (await until(x => pos(x) === dir * 2n * q && idle(x), 150)) ?? await state();
    fills += abs(pos(s));
  }
  if (pos(s) !== 0n) {
    await must("trailing stop", [order(3, C.ORDER.TRAIL, 0n, 10n)]);
    s = await state();
    const placed = s.orders.find(o => o.index === 3);
    ok(!!placed && placed.peak > 0n, "a trailing stop starts from the price it was placed at", { peak: placed?.peak, mark: s.book!.markPrice });
    let best = placed?.peak ?? 0n;
    t0 = Date.now();
    const held = pos(s);
    r = await until(x => pos(x) === 0n && idle(x), ORDER_WAIT, 5000, x => { const o = x.orders.find(o => o.index === 3); if (o && (dir > 0n ? o.peak > best : o.peak < best)) best = o.peak; });
    if (r) {
      fills += abs(held);
      ok(!has(r, 3), "trailing stop closes the position once the price comes back by its distance, and is removed", { secs: Math.round((Date.now() - t0) / 1000), bestRecorded: best, priceAfter: r.asset.price });
    } else {
      // The price never came back 0.10% in the wait: not a failure. A stop on the wrong side of
      // the price (already reached) closes the position instead, and the trail goes with it.
      s = await state();
      note({ type: "note", bot: bot.name, symbol: m.symbol, what: "the trailing stop was still waiting", bestRecorded: best, mark: s.book!.markPrice });
      await must("stop", [order(4, C.ORDER.STOP, 0n, pct(s.book!.markPrice, dir > 0n ? 10n : -10n))]);
      r = await until(x => pos(x) === 0n && idle(x), 180);
      ok(!!r, "a stop whose price is already reached closes the position at once");
      if (r) fills += abs(held);
    }
    r = await until(x => x.orders.length === 0, 180);
    ok(!!r, "no order outlives its position");
  }

  // The whole routine cost its fees, plus or minus what the price did meanwhile (small: the
  // position was about $240 for a few minutes). More than 3% of the largest position would not be that.
  s = await state();
  const fees = fills * px / 1_000_000n * feeBps / 10_000n;
  const change = (s.health?.equity ?? s.portfolio!.capital) - equity0;
  ok(abs(change + fees) <= 4n * q * px / 1_000_000n * 3n / 100n + 100_000n, "the routine cost its fees and the price moves, nothing more", { equityChange: change, fees, traded: fills * px / 1_000_000n });
}

// ---- the liquidity provider ----
const u64at = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true);
/** One step per call on one vault: claim what an epoch that has rolled owes it (and check the
 *  amount against that epoch's record), otherwise ask for a deposit or a withdrawal. */
async function lpRoutine(bot: Bot, m: Market) {
  const kp = bot.kp, me = kp.publicKey;
  await fund(bot);
  const s = await C.fetchVault(conn, m.vault, me);
  const v = s.vault, t = s.ticket;
  const waiting = t && (t.deposit > 0n || t.withdraw > 0n);
  if (waiting && t!.epoch < v.epoch) {
    const rec = await conn.getAccountInfo(C.epochAddress(v.key, t!.epoch));
    if (!rec) { check(false, "an epoch that rolled has a record to claim against", { symbol: m.symbol, epoch: t!.epoch }); return; }
    const d = new Uint8Array(rec.data), E = L.epoch_record;
    const [deposits, minted, withdrawn, paid, refunded] = [u64at(d, E.deposit_assets), u64at(d, E.shares_minted), u64at(d, E.withdraw_shares), u64at(d, E.assets_out), d[E.deposits_refunded] === 1];
    const r = await send(`${bot.name} claim ${m.symbol} epoch ${t!.epoch}`, kp, [createAssociatedTokenAccountIdempotentInstruction(me, C.ata(me, v.shareMint), me, v.shareMint), C.claim(v, me, t!.epoch)]);
    if (r !== true) { check(false, "a liquidity provider can claim after its epoch rolled", { symbol: m.symbol, epoch: t!.epoch, error: r }); return; }
    const after = await C.fetchVault(conn, m.vault, me);
    const gotShares = after.userShares - s.userShares, gotUsdc = after.userCollateral - s.userCollateral;
    // Its exact part of the epoch: shares for its deposit (or the deposit back, if the epoch
    // refunded deposits), and money for the shares it handed in.
    const wantShares = t!.deposit > 0n && !refunded && deposits > 0n ? t!.deposit * minted / deposits : 0n;
    const wantUsdc = (t!.withdraw > 0n && withdrawn > 0n ? t!.withdraw * paid / withdrawn : 0n) + (t!.deposit > 0n && refunded ? t!.deposit : 0n);
    const near = (a: bigint, b: bigint) => abs(a - b) <= 2n + b / 1_000_000n;
    check(near(gotShares, wantShares) && near(gotUsdc, wantUsdc), "a claim pays exactly the provider's part of its epoch", { symbol: m.symbol, epoch: t!.epoch, deposit: t!.deposit, withdrawShares: t!.withdraw, gotShares, wantShares, gotUsdc, wantUsdc, refunded });
    // A share is worth what the vault is worth: the price deposits got is the price withdrawals got.
    if (t!.deposit > 0n && !refunded && minted > 0n && withdrawn > 0n && paid > 0n) {
      const inPrice = Number(deposits) / Number(minted), outPrice = Number(paid) / Number(withdrawn);
      check(Math.abs(inPrice / outPrice - 1) < 0.02, "deposits and withdrawals of one epoch get the same share price (within its high-low range)", { symbol: m.symbol, epoch: t!.epoch, inPrice, outPrice });
    }
    say(`${bot.name}: claimed ${m.symbol} epoch ${t!.epoch}: ${Number(gotShares) / 1e9} shares, $${usd(gotUsdc)}`);
    return;
  }
  if (waiting) return; // its epoch has not rolled yet
  if (v.needsFlat) { note({ type: "skip", bot: bot.name, symbol: m.symbol, why: "the vault is closing its position before it pays withdrawals" }); return; }
  if (v.frozenUntil * 1000 >= Date.now() - 5_000) { note({ type: "skip", bot: bot.name, symbol: m.symbol, why: "the epoch is being settled: new requests wait for the roll" }); return; }
  if (s.userShares > 0n && Math.random() < 0.5) {
    const shares = Math.random() < 0.3 ? s.userShares : s.userShares / 2n;
    const r = await send(`${bot.name} withdraw from ${m.symbol}`, kp, [C.requestWithdraw(v, me, shares)]);
    note({ type: "lp", bot: bot.name, symbol: m.symbol, what: "withdraw", shares, ok: r === true, error: r === true ? undefined : r });
  } else {
    const amount = BigInt(100 + Math.floor(Math.random() * 200)) * 1_000_000n;
    if (s.userCollateral < amount) return;
    const r = await send(`${bot.name} deposit into ${m.symbol}`, kp, [C.requestDeposit(v, me, amount)]);
    note({ type: "lp", bot: bot.name, symbol: m.symbol, what: "deposit", amount, ok: r === true, error: r === true ? undefined : r });
  }
}

// ---- five orders to one market at the same moment ----
async function burstRoutine(group: Bot[], m: Market) {
  for (const b of group) await gas(b.kp);
  const before = await Promise.all(group.map(b => C.fetchVault(conn, m.vault, b.kp.publicKey)));
  if (before.some(s => !s.trader)) { for (const b of group) await fund(b); return; }
  if (before.some(s => s.trader!.hasPending) || before[0].closeOnly) return;
  const px = before[0].asset.price, step = stepOf(px);
  const unit = (30_000_000n * 1_000_000n / px) / step * step;
  if (unit === 0n) return;
  // Whoever holds a position closes it; the others open one, alternating sides.
  const sizes = before.map((s, i) => (s.portfolio!.position !== 0n ? -s.portfolio!.position : (i % 2 ? -1n : 1n) * unit));
  const sentAt = Date.now();
  const sent = await Promise.all(group.map((b, i) => send(`${b.name} ${Number(sizes[i]) / 1e6} ${m.symbol}`, b.kp, [C.requestTrade(b.kp.publicKey, m.vault, sizes[i])], [], 1)));
  check(sent.every(r => r === true), "orders sent to one market at the same moment are all accepted", { symbol: m.symbol, accepted: sent.filter(r => r === true).length, of: group.length, errors: sent.filter(r => r !== true).slice(0, 2) });
  let after = before;
  for (let i = 0; i < 60; i++) {
    await sleep(4000);
    after = await Promise.all(group.map(b => C.fetchVault(conn, m.vault, b.kp.publicKey)));
    if (after.every(s => !s.trader!.hasPending)) break;
  }
  const secs = Math.round((Date.now() - sentAt) / 1000);
  const filled = after.filter((s, i) => sent[i] === true && s.portfolio!.position - before[i].portfolio!.position === sizes[i]).length;
  const odd = after.filter((s, i) => { const got = s.portfolio!.position - before[i].portfolio!.position; return got !== 0n && got !== sizes[i]; }).length;
  check(after.every(s => !s.trader!.hasPending) && odd === 0, "a burst of orders all end filled or expired, none half-done", { symbol: m.symbol, secs, filled, expired: sent.filter(r => r === true).length - filled, odd });
  note({ type: "burst", symbol: m.symbol, secs, filled, sent: sent.filter(r => r === true).length });
  say(`burst on ${m.symbol}: ${filled} of ${group.length} filled in ${secs} s`);
}

// ---- positions on every market at once ----
async function crossRoutine(bot: Bot, feeBps: bigint) {
  const kp = bot.kp, me = kp.publicKey;
  await gas(kp);
  let closing = false;
  for (const m of traded) {
    let s = await C.fetchVault(conn, m.vault, me);
    if (!s.trader) { await fund(bot); return; }
    if (!s.portfolio || s.trader.hasPending || s.closeOnly) continue;
    if (await refill(bot, s)) return;
    const held = s.portfolio.position;
    if (m === traded[0]) closing = s.openPositions >= traded.length; // all open: this pass takes them off
    // The largest order the page would offer on this market, given the positions on the others,
    // is what the program accepts: a little less passes, clearly more is refused for margin.
    const room = C.depth(s), cap = s.margin ?? 0n;
    const side = held >= 0n ? 1n : -1n;
    const most = cap > abs(held) ? cap - abs(held) : 0n;
    if (most > stepOf(s.asset.price) * 100n && most * 14n / 10n < (side > 0n ? room.long : room.short)) {
      const under = await wouldFail(kp, [C.requestTrade(me, m.vault, side * most * 97n / 100n)]);
      const over = await wouldFail(kp, [C.requestTrade(me, m.vault, side * (most * 13n / 10n + 1_000_000n))]);
      check(under === "ok" && over === "0x5706", "with positions on several markets, the largest order shown is what the program accepts", { symbol: m.symbol, positions: s.openPositions, most, under, over });
    }
    const step = stepOf(s.asset.price);
    const want = closing ? -held : held !== 0n ? 0n : (Math.random() < 0.5 ? 1n : -1n) * ((cap / 4n) / step * step);
    if (want === 0n) continue;
    const r = await trade(`${bot.name} ${Number(want) / 1e6} ${m.symbol}`, kp, m.vault, want);
    if (r !== true) { note({ type: "order", bot: bot.name, symbol: m.symbol, want, outcome: "not accepted", error: r, ok: false }); continue; }
    const seen: bigint[] = [];
    const after = await settledState(kp, m.vault, seen);
    if (!after) { check(false, "an order ends within 150 s", { bot: bot.name, symbol: m.symbol }); return; }
    const got = (after.portfolio?.position ?? 0n) - held;
    note({ type: "order", bot: bot.name, symbol: m.symbol, want, got, outcome: got === want ? "filled" : got === 0n ? "expired" : "cut to the vault's room", positions: after.openPositions, ok: true });
    say(`${bot.name}: ${Number(want) / 1e6} ${m.symbol} -> ${got === want ? "filled" : got === 0n ? "expired" : "cut"}; ${after.openPositions} market(s) open`);
    if (got !== 0n) accounting(bot.name, m.symbol, s, after, got, feeBps, seen);
  }
}

// ---- what must be refused (simulated only) ----
async function adversaryRoutine(bot: Bot) {
  const kp = bot.kp, me = kp.publicKey;
  await gas(kp);
  if (!(await conn.getAccountInfo(C.traderAddress(me)))) { await fund(bot); return; }
  // The chain's own clock: it is what the router compares a request's time with, and on a test
  // network it can be several seconds away from this machine's.
  const clock = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  const now = clock ? Number(new DataView(clock.data.buffer, clock.data.byteOffset).getBigInt64(32, true)) : Math.floor(Date.now() / 1000);
  const expect = (code: string, want: string[], what: string, more: Record<string, unknown> = {}) => {
    note({ type: "refusal", bot: bot.name, what, code, ok: want.includes(code) });
    if (!want.includes(code)) check(false, `refused: ${what}`, { code, expected: want, ...more });
  };
  const vaults = (await C.listVaults(conn)).filter(v => v.canonical && v.status === 1 && markets.some(m => m.vault.equals(v.key)));
  const marketData = new Uint8Array((await conn.getAccountInfo(C.MARKET))!.data);
  for (const v of vaults) {
    const ba = await conn.getAccountInfo(C.bookAddress(v.key));
    if (!ba) continue;
    const book = C.decodeBook(new Uint8Array(ba.data));
    // Someone's queued request: it cannot be filled before its price is the mark, and it cannot
    // be expired while it still has time.
    for (const r of (book.pending.length ? await C.pendingRequests(conn, v.key) : []).filter(r => !r.settle && !r.wallet.equals(me)).slice(0, 2)) {
      const atMark = book.markPrev < r.target && r.target <= book.markPublish;
      if (!atMark) { // (refused by the router; or, if its price arrived between the two reads, by Percolator for want of the cranks a real fill carries)
        const code = await wouldFail(kp, [C.fillRequest(me, v, r)]);
        note({ type: "refusal", bot: bot.name, what: "filling a request before its price has arrived", code, ok: code !== "ok" });
        if (code === "ok") check(false, "refused: filling a request before its price has arrived", { code });
      }
      // The clock and the queue are read again right before the attempt: on a throttled RPC the
      // reads above take many seconds, and by then a request "with time left" has run out of it
      // (that made this check fail on devnet when nothing was wrong).
      const [c2, b2] = await conn.getMultipleAccountsInfo([SYSVAR_CLOCK_PUBKEY, C.bookAddress(v.key)]);
      if (!c2 || !b2) continue;
      const now2 = Number(new DataView(c2.data.buffer, c2.data.byteOffset).getBigInt64(32, true));
      const book2 = C.decodeBook(new Uint8Array(b2.data));
      const atMark2 = book2.markPrev < r.target && r.target <= book2.markPublish;
      const stalled = atMark2 && book2.markSet > 0 && now2 > book2.markSet + C.ROUTER_STALL_SECS - 8;
      if (now2 < r.target + C.ROUTER_GRACE_SECS - 10 && !stalled) expect(await wouldFail(kp, [C.expireRequest(me, r)]), ["0x570b", "0x5701"], "expiring a request that still has time", { secsLeft: r.target + C.ROUTER_GRACE_SECS - now2, atMark: atMark2, markHeldSecs: book2.markSet ? now2 - book2.markSet : undefined }); // 0x5701: it was filled between the two reads, the account is gone
    }
    // The price cannot be moved to one that is not newer than the mark. (The price account and
    // the mark are read together, right before the attempt, for the same reason as above.)
    const [pa, b3] = await conn.getMultipleAccountsInfo([v.oracle, C.bookAddress(v.key)]);
    // (Refused by the router; or, if a newer price arrived between the two reads, by Percolator for want of cranks.)
    if (pa && b3 && C.decodePrice(new Uint8Array(pa.data)).publish <= C.decodeBook(new Uint8Array(b3.data)).markPublish) {
      const code = await wouldFail(kp, [C.advanceMark(v, v.oracle, marketData)]);
      note({ type: "refusal", bot: bot.name, what: "moving the price to one that is not newer", code, ok: code !== "ok" });
      if (code === "ok") check(false, "refused: moving the price to one that is not newer", { code });
    }
    // An order with no size.
    expect(await wouldFail(kp, [C.requestTrade(me, v.key, 0n)]), ["0x5700"], "an order of size zero");
  }
  // Someone else's standing order: only its wallet can cancel it, and nobody can carry it out early.
  const orders = (await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.ORDER_LEN }] })).map(a => C.decodeOrder(a.pubkey, new Uint8Array(a.account.data))).filter(o => !o.wallet.equals(me)).slice(0, 3);
  for (const o of orders) {
    const cancel = new TransactionInstruction({ programId: C.ROUTER, keys: [{ pubkey: me, isSigner: true, isWritable: true }, { pubkey: o.key, isSigner: false, isWritable: true }], data: Buffer.from([13]) });
    expect(await wouldFail(kp, [cancel]), ["0x5701"], "cancelling someone else's order");
  }
  // A healthy account cannot be forced closed, and nobody can withdraw more than they have.
  const snap = await C.marketSnapshot(conn);
  const traders = (await conn.getProgramAccounts(C.ROUTER, { filters: [{ dataSize: C.TRADER_LEN }] })).map(t => C.decodeTrader(new Uint8Array(t.account.data)));
  for (const t of traders.filter(t => !t.hasPending && !t.wallet.equals(me)).slice(0, 40)) {
    const d = snap.portfolios.find(p => p.pubkey.equals(t.portfolio))?.data;
    if (!d) continue;
    const h = C.accountHealth(snap.market, d);
    if (!h.settled || h.positions.length === 0 || h.equity * 10_000n < h.notional * (C.LIQUIDATION_BPS + 200n)) continue;
    const v = vaults.find(x => x.assetIndex === h.positions[0].asset);
    if (!v || C.closeOnly(snap.market, v.assetIndex)) continue;
    expect(await wouldFail(kp, [C.requestClose(me, t.wallet, v.key)]), ["0x5710"], "forcing a healthy account closed", { wallet: t.wallet.toBase58() });
    break;
  }
  const over = await wouldFail(kp, [createAssociatedTokenAccountIdempotentInstruction(me, C.ata(me, C.MINT), me, C.MINT), C.routerWithdraw(me, 1_000_000_000_000n)]);
  note({ type: "refusal", bot: bot.name, what: "withdrawing more than the account holds", code: over, ok: over !== "ok" });
  if (over === "ok") check(false, "refused: withdrawing more than the account holds", { code: over });
}

function report() {
  let rows = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  const hours = Number(process.argv[3] ?? 0);
  if (hours > 0) rows = rows.filter(r => r.at > Date.now() - hours * 3_600_000);
  if (!rows.length) return console.log("nothing logged yet");
  const of = (t: string) => rows.filter(r => r.type === t);
  const orders = of("order"), market = of("market"), refusals = of("refusal"), checks = of("check"), liq = of("liquidation"), accounts = of("accounts"), money = of("money");
  const count = (xs: any[], k: string) => xs.reduce((m, x) => ((m[x[k]] = (m[x[k]] ?? 0) + 1), m), {} as Record<string, number>);
  const filled = orders.filter(o => o.secs !== undefined && o.got !== 0);
  console.log(`${C.NETWORK_NAME}: since ${new Date(rows[0].at).toISOString().slice(0, 16)}Z, ${((rows[rows.length - 1].at - rows[0].at) / 3_600_000).toFixed(1)} h`);
  console.log("orders:", orders.length, count(orders, "outcome"));
  console.log("by bot:", count(orders, "bot"));
  if (filled.length) console.log(`seconds from sending to filled: median ${filled.map(o => o.secs).sort((a, b) => a - b)[filled.length >> 1]}, slowest ${Math.max(...filled.map(o => o.secs))}`);
  console.log("highest leverage seen after a fill:", Math.max(0, ...orders.map(o => o.leverage ?? 0)));
  console.log(`market passes (vault = minus all traders; longs = shorts): ${market.length}, failed ${market.filter(m => !m.ok).length}`);
  console.log(`refusals checked: ${refusals.length}, wrong ${refusals.filter(r => !r.ok).length}`, count(refusals, "what"));
  const thin = accounts.map(a => a.thinnestBps).filter((x: any) => typeof x === "number");
  if (thin.length) console.log(`thinnest account seen: ${(Math.min(...thin) / 100).toFixed(2)}% of its positions (liquidation at ${(accounts[0].liquidationBps / 100).toFixed(2)}%)`);
  console.log("liquidations:", count(liq, "stage"), liq.filter(l => l.secs !== undefined).length ? `slowest ${Math.max(...liq.filter(l => l.secs !== undefined).map(l => l.secs))} s` : "");
  if (money.length) console.log(`collateral held minus accounts' capital: $${(money[money.length - 1].spare / 1e6).toFixed(2)} (never negative: ${money.every(m => m.spare >= 0)})`);
  const by = new Map<string, { ok: number; bad: number; last?: any }>();
  for (const c of checks) { const e = by.get(c.what) ?? by.set(c.what, { ok: 0, bad: 0 }).get(c.what)!; if (c.ok) e.ok++; else { e.bad++; e.last = c; } }
  console.log(`checks: ${checks.filter(c => c.ok).length} passed, ${checks.filter(c => !c.ok).length} failed`);
  for (const [what, e] of [...by].sort((a, b) => b[1].bad - a[1].bad)) {
    console.log(`  ${e.bad ? "FAIL" : "ok  "} ${String(e.ok).padStart(4)} ok ${String(e.bad).padStart(3)} failed  ${what}`);
    if (e.last) { const { at, type, what: _w, ok: _o, ...rest } = e.last; console.log(`         last failure ${new Date(at).toISOString().slice(5, 16)}Z ${JSON.stringify(rest).slice(0, 260)}`); }
  }
  const bySymbol = new Map<string, any[]>();
  for (const m of market) (bySymbol.get(m.symbol ?? "SOL") ?? bySymbol.set(m.symbol ?? "SOL", []).get(m.symbol ?? "SOL")!).push(m);
  for (const [sym, ms] of bySymbol) console.log(`${sym} vault: epoch ${ms[0].epoch} -> ${ms[ms.length - 1].epoch} | value $${(ms[0].nav / 1e6).toFixed(2)} -> $${(ms[ms.length - 1].nav / 1e6).toFixed(2)} | position now ${ms[ms.length - 1].vaultPosition / 1e6}`);
}

if (process.argv[2] === "report") report();
else if (process.argv[2] === "run") {
  const bots: Bot[] = BOTS.map(b => ({ ...b, kp: wallet(b.name) }));
  // The first reads are retried: a public RPC that throttles or drops a connection at that
  // moment must not leave the network without its bots.
  const patiently = async <T,>(what: string, f: () => Promise<T>): Promise<T> => {
    for (;;) {
      try { return await f(); } catch (e: any) { say("error", `start: ${what}:`, String(e?.cause?.message ?? e?.message ?? e).split("\n")[0].slice(0, 120), "(trying again in 30 s)"); await sleep(30_000); }
    }
  };
  await patiently("markets", loadMarkets);
  if (!traded.length) throw new Error(`none of ${SYMBOLS.join(", ")} is a live market with liquidity on ${C.NETWORK_NAME}`);
  say(`bots on ${traded.map(m => m.symbol).join(", ")} (${C.NETWORK_NAME}), checking ${markets.map(m => m.symbol).join(", ")}:`, bots.map(b => `${b.name} ${b.kp.publicKey.toBase58()}`).join(", "));
  for (const b of bots) await fund(b).catch(e => say("error", "fund", b.name, String(e?.message ?? e).slice(0, 120)));
  const feeBps = await patiently("fee rate", async () => C.marketRates(new Uint8Array((await conn.getAccountInfo(C.MARKET))!.data)).feeBps);
  const pick = () => traded[Math.floor(Math.random() * traded.length)];

  // The orders bot runs its routine on its own, one market after the other.
  const ob = bots.find(b => b.kind === "orders")!;
  (async () => {
    await sleep(15_000);
    for (let n = 0; ; n++) {
      const m = traded[n % traded.length];
      await ordersRoutine(ob, m, feeBps).catch(e => { check(false, "the orders routine runs to its end", { symbol: m.symbol, error: String(e?.message ?? e).slice(0, 200) }); });
      await sleep(PACE * 1000);
    }
  })();

  // The other routines, each on its own clock; a failure in one stops none of the others.
  const every = (secs: number, first: number, what: string, run: (n: number) => Promise<unknown>) => (async () => {
    await sleep(first * 1000);
    for (let n = 0; ; n++) {
      await run(n).catch(e => say("error", what, String(e?.message ?? e).split("\n")[0].slice(0, 140)));
      await sleep(secs * 1000);
    }
  })();
  const one = (k: Kind) => bots.find(b => b.kind === k)!;
  every(PACE, 40, "lp", n => lpRoutine(one("lp"), traded[n % traded.length]));
  every(PACE * 2, 70, "burst", n => burstRoutine(bots.filter(b => b.kind === "burst"), traded[n % traded.length]));
  every(PACE * 1.5, 100, "cross", () => crossRoutine(one("cross"), feeBps));
  every(PACE, 130, "adversary", () => adversaryRoutine(one("adversary")));

  const next = new Map(bots.map((b, i) => [b.name, Date.now() + i * 20_000]));
  let marketsAt = Date.now();
  for (;;) {
    try {
      if (Date.now() - marketsAt > 600_000) { await loadMarkets(); marketsAt = Date.now(); }
      await marketChecks();
      for (const b of bots) {
        if (ROUTINES.includes(b.kind) || Date.now() < next.get(b.name)!) continue;
        next.set(b.name, Date.now() + PACE * 1000 * (0.5 + Math.random()));
        // The edge bots stay on the first market, so each is one position riding at the limit.
        await act(b, b.kind.startsWith("edge") ? traded[0] : pick(), feeBps).catch(e => say("error", b.name, String(e?.message ?? e).slice(0, 120)));
      }
    } catch (e: any) {
      say("error", String(e?.message ?? e).slice(0, 120));
    }
    await sleep(PASS_SECS * 1000);
  }
} else console.log("usage: bots.ts run [SYMBOL,SYMBOL...] | report [hours]");
