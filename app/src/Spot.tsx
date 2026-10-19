// Spot trading: real tokens bought and sold on xDEX pools through the router's Swap (swap.ts),
// on the same screen as the Trade page: the pair and its day, the chart, the pool's depth and
// latest swaps, the order ticket, and the wallet. Our own coin/USDC pool comes first, so coin can
// be turned into trading margin in one transaction.
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as C from "./chain";
import Chart, { useDayStats } from "./Chart";
import * as S from "./swap";
import { Faucet, Icon, Send, ago, explorer, fmt, priceDp, short } from "./shared";

const SLIPPAGES = [50, 100, 300];
const MOVES = [0.05, 0.02, 0.01, 0.005];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const pct = (x: number, dp = 2) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, dp)}%`;
/** A number for reading: millions and billions shortened, the very small in powers of ten. */
const big = (x: number) => (x >= 1e9 ? `${fmt(x / 1e9, 2)}B` : `${fmt(x / 1e6, 2)}M`);
const tiny = (x: number) => x.toPrecision(3);
/** A token amount: fewer decimals the larger it is. */
const amt = (x: number) => (!Number.isFinite(x) ? "—" : x === 0 ? "0" : x >= 1e6 ? big(x) : x > 0 && x < 1e-4 ? tiny(x) : fmt(x, x >= 1000 ? 2 : x >= 1 ? 4 : priceDp(x || 1)));
/** A price. */
const prc = (x: number) => (!(x > 0) || !Number.isFinite(x) ? "—" : x >= 1e6 ? big(x) : x < 1e-4 ? tiny(x) : fmt(x, priceDp(x)));
const show = (a: bigint, dp: number) => amt(Number(a) / 10 ** dp);

function tokenName(mint: PublicKey | string, listed?: S.ListedPool): string {
  const m = mint.toString();
  if (m === NATIVE_MINT.toBase58()) return C.COIN;
  if (m === C.MINT.toBase58()) return "USDC";
  const s = listed ? (listed.a.mint === m ? listed.a.symbol : listed.b.mint === m ? listed.b.symbol : "") : "";
  return s && s !== "Unknown" ? s : short(m);
}
const known = (mint: PublicKey) => mint.equals(NATIVE_MINT) || mint.equals(C.MINT);

/** `text` as atoms of a token with `dp` decimals (undefined when it is not a number). */
function atoms(text: string, dp: number): bigint | undefined {
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return undefined;
  const [w, f = ""] = text.split(".");
  return BigInt(w || "0") * 10n ** BigInt(dp) + BigInt((f + "0".repeat(dp)).slice(0, dp) || "0");
}

/** A listed pool as a pair: its name, and xDEX's price, day's volume and liquidity for it, all
 *  in the quote token (xDEX's own values are in a unit that differs between networks). */
function listedPair(l: S.ListedPool) {
  const { base, quote } = S.pairOf([l.a.mint, l.b.mint], [l.a.symbol, l.b.symbol]);
  const side = [l.a, l.b], q = side[quote];
  const name = (i: 0 | 1) => tokenName(side[i].mint, l);
  return { name: `${name(base)}/${name(quote)}`, quote: name(quote), price: q.price > 0 ? side[base].price / q.price : 0, volume: q.volume, liquidity: q.price > 0 ? l.tvl / q.price : 0 };
}
// (A pool list cached from before a field was added has none of it.)
/** Our own pool first, then pairs priced in the chain's coin or USDC, then the rest. */
function byInterest(list: S.ListedPool[]) {
  const ours = S.USDC_POOL.toBase58(), main = [NATIVE_MINT.toBase58(), C.MINT.toBase58()];
  const rank = (l: S.ListedPool) => (l.pool === ours ? 0 : main.includes(l.a.mint) || main.includes(l.b.mint) ? 1 : 2);
  return [...list].sort((x, y) => rank(x) - rank(y));
}
const inQuote = (x: number | undefined, quote: string) => (Number.isFinite(x) ? `${amt(x!)} ${quote}` : "—");

export default function SpotDesk({ route, send, busy, tick, go }: { route: string[]; send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const { connection } = useConnection();
  const [list, setList] = useState<S.ListedPool[]>();
  const poolKey = route[1] && B58.test(route[1]) ? route[1] : S.USDC_POOL.toBase58();
  const [pool, setPool] = useState<S.Pool | null>();
  const [err, setErr] = useState<string>();

  useEffect(() => {
    let live = true;
    const load = () => S.listPools().then(l => live && setList(l)).catch(() => live && setList(l => l ?? []));
    load();
    const id = setInterval(load, 60_000);
    return () => { live = false; clearInterval(id); };
  }, []);
  // The pool is read again every few seconds while the page is looked at: its price is the market.
  useEffect(() => {
    let live = true;
    setPool(undefined);
    const read = () => document.hidden || S.readPool(connection, new PublicKey(poolKey))
      .then(p => { if (live) { setPool(p); setErr(undefined); } })
      // Only a pool that is not there is shown as missing; a busy network is asked again.
      .catch(e => { if (live) { const m = String(e?.message ?? e); setErr(m); if (m === S.NOT_A_POOL) setPool(p => p ?? null); } });
    read();
    const id = setInterval(read, 6_000);
    return () => { live = false; clearInterval(id); };
  }, [connection, poolKey, tick]);

  if (pool === undefined) return <div className="desk-msg">Reading the pool…{err && <span className="small">The network is busy ({err.slice(0, 80)}); trying again.</span>}</div>;
  if (!pool) {
    return (
      <div className="desk-msg">
        {poolKey === S.USDC_POOL.toBase58() ? `The ${C.COIN}/USDC pool is not open on ${C.NETWORK_NAME} yet.` : `Cannot read this pool: ${err}`}
        {poolKey !== S.USDC_POOL.toBase58() && <button className="btn primary" onClick={() => go("/spot")}>{C.COIN}/USDC</button>}
      </div>
    );
  }
  return <SpotInner key={poolKey} pool={pool} list={list} send={send} busy={busy} tick={tick} go={go} />;
}

/** The wallet's balances of a pool's two tokens and of the chain's coin, and whether it has a
 *  trading account (USDC bought can then go straight into margin). */
function useWalletTokens(pool: S.Pool, tick: number) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [b, setB] = useState<{ tokens: [bigint, bigint]; coin: bigint; trader: boolean }>();
  useEffect(() => {
    if (!publicKey) return setB(undefined);
    let live = true;
    const read = async () => {
      const keys = [0, 1].map(i => getAssociatedTokenAddressSync(pool.mints[i], publicKey, true, pool.programs[i]));
      const [a0, a1, tr] = await connection.getMultipleAccountsInfo([...keys, C.traderAddress(publicKey)]);
      const coin = BigInt(await connection.getBalance(publicKey));
      const bal = (i: 0 | 1, a: typeof a0) => (pool.mints[i].equals(NATIVE_MINT) ? coin : a && a.data.length >= 72 ? Buffer.from(a.data).readBigUInt64LE(64) : 0n);
      if (live) setB({ tokens: [bal(0, a0), bal(1, a1)], coin, trader: !!tr });
    };
    read().catch(() => {});
    const id = setInterval(() => document.hidden || read().catch(() => {}), 15_000);
    return () => { live = false; clearInterval(id); };
  }, [connection, publicKey, pool.key.toBase58(), tick]);
  return b;
}

/** A pool's latest swaps (only the wallet's when `mine`), read again every few seconds. */
function useTrades(pool: PublicKey, signer: PublicKey | null | undefined, tick: number) {
  const [rows, setRows] = useState<S.SpotTrade[]>();
  useEffect(() => {
    if (signer === null) return setRows(undefined);
    let live = true;
    const read = () => S.spotTrades(pool, signer).then(r => live && setRows(r)).catch(() => live && setRows(r => r ?? []));
    read();
    const id = setInterval(() => document.hidden || read(), signer ? 20_000 : 8_000);
    return () => { live = false; clearInterval(id); };
  }, [pool.toBase58(), signer?.toBase58(), tick]);
  return rows;
}

type Pair = { pool: S.Pool; listed?: S.ListedPool; base: 0 | 1; quote: 0 | 1; baseName: string; quoteName: string; price: number };

function SpotInner({ pool, list, send, busy, tick, go }: { pool: S.Pool; list?: S.ListedPool[]; send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const listed = list?.find(l => l.pool === pool.key.toBase58());
  const { base, quote } = S.pairOf(pool.mints, listed && [
    listed.a.mint === pool.mints[0].toBase58() ? listed.a.symbol : listed.b.symbol,
    listed.a.mint === pool.mints[1].toBase58() ? listed.a.symbol : listed.b.symbol,
  ]);
  const pair: Pair = { pool, listed, base, quote, baseName: tokenName(pool.mints[base], listed), quoteName: tokenName(pool.mints[quote], listed), price: S.poolPrice(pool, base) };
  const symbol = S.spotSymbol(pool.mints[base], pool.mints[quote]);
  const label = `${pair.baseName}/${pair.quoteName}`;
  const day = useDayStats([symbol])[symbol];
  const wallet = useWalletTokens(pool, tick);
  const trades = useTrades(pool.key, undefined, tick);
  const mine = useTrades(pool.key, publicKey, tick);

  return (
    <main className="desk spot">
      <SpotBar pair={pair} list={list} day={day} go={go} />
      <section className="desk-chart panel"><Chart symbol={symbol} label={label} price={pair.price} lines={[]} /></section>
      <section className="desk-book panel"><PoolDepth pair={pair} trades={trades} /></section>
      <section className="desk-ticket panel">
        <div className="ptabs"><button className="on">Spot</button></div>
        <SpotTicket pair={pair} wallet={wallet} send={send} busy={busy} />
      </section>
      <section className="desk-bottom panel"><SpotBottom pair={pair} list={list} mine={mine} go={go} /></section>
      <section className="desk-account panel"><WalletPanel pair={pair} wallet={wallet} go={go} /></section>
    </main>
  );
}

// ---------------------------------------------------------------- pair bar

function SpotBar({ pair, list, day, go }: { pair: Pair; list?: S.ListedPool[]; day?: { last: number; change: number; high: number; low: number }; go: (to: string) => void }) {
  const { pool, listed, base, quote, baseName, quoteName, price } = pair;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const before = useRef(price);
  const dir = price > before.current ? "up" : price < before.current ? "down" : "";
  useEffect(() => { before.current = price; }, [price]);
  // The day's change is measured to the pool's own price, not the history's last candle.
  const change = day && day.last > 0 ? price / (day.last / (1 + day.change)) - 1 : undefined;
  const dp = priceDp(price);
  const res = (i: 0 | 1) => Number(pool.reserves[i]) / 10 ** pool.decimals[i];
  const ours = S.USDC_POOL.toBase58();
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const all = byInterest(list ?? []).filter(l => l.pool !== ours);
    return (s ? all.filter(l => [l.a.symbol, l.b.symbol, l.a.mint, l.b.mint, l.pool].some(x => x.toLowerCase().includes(s))) : all).slice(0, 60);
  }, [list, search]);
  const pick = (p: string) => { setOpen(false); setSearch(""); go(p === ours ? "/spot" : `/spot/${p}`); };
  const ourListed = list?.find(l => l.pool === ours);
  const row = (l: S.ListedPool | undefined, key: string, note?: string) => {
    const lp = l ? listedPair(l) : undefined;
    const name = lp?.name ?? `${C.COIN}/USDC`;
    return (
      <button key={key} className={key === pool.key.toBase58() ? "msel-row on" : "msel-row"} onClick={() => pick(key)}>
        <span className="msel-name"><Icon symbol={name.split("/")[0]} />{name}{note && <em>{note}</em>}</span>
        <span className="mono">{lp ? prc(lp.price) : "—"}</span>
        <span className="mono">{lp ? inQuote(lp.volume, lp.quote) : "—"}</span>
        <span className="mono">{lp ? inQuote(lp.liquidity, lp.quote) : "—"}</span>
      </button>
    );
  };
  return (
    <header className="mbar">
      <div className="msel" ref={box}>
        <button className="msel-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <Icon symbol={baseName} />
          <span className="msel-sym">{baseName}/{quoteName}</span>
          <span className="msel-lev">SPOT</span>
          <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        {open && (
          <div className="msel-menu spot-menu">
            <label className="inp small spot-find"><span>Find</span><input autoFocus value={search} placeholder="symbol or address" onChange={e => setSearch(e.target.value)} /></label>
            <div className="msel-head"><span>Pair</span><span>Price</span><span>24h volume</span><span>Liquidity</span></div>
            <div className="spot-list">
              {row(ourListed, ours, "into margin")}
              {!list ? <div className="quiet">Loading xDEX pools…</div> : rows.length === 0 ? <div className="quiet">No pools found.</div> : rows.map(l => row(l, l.pool))}
            </div>
            <div className="fine spot-menu-note">Pools as listed by xDEX. Anyone can open a pool under any name: check a token's address before you trade it.</div>
          </div>
        )}
      </div>
      <div className={`mbar-price mono ${dir}`}>{price > 0 && price < 1e-4 ? tiny(price) : price > 0 ? fmt(price, dp) : "—"}</div>
      <div className="mbar-stats">
        <Cell label="24h change" value={change === undefined ? "—" : pct(change)} tone={change === undefined ? undefined : change >= 0 ? "up" : "down"} />
        <Cell label="24h high" value={day ? fmt(Math.max(day.high, price), dp) : "—"} />
        <Cell label="24h low" value={day ? fmt(Math.min(day.low, price), dp) : "—"} />
        <Cell label="24h volume" value={listed ? inQuote(listed.a.mint === pool.mints[quote].toBase58() ? listed.a.volume : listed.b.volume, quoteName) : "—"} sub={listed ? `${listed.txns} swaps` : undefined} />
        <Cell label="Pool holds" value={`${amt(res(base))} ${baseName}`} sub={`${amt(res(quote))} ${quoteName}`} />
        <Cell label="Fee" value={`${Number(S.SWAP_FEE_BPS) / 100}% + ${fmt(Number(pool.feeRate) / 10_000, 2)}%`} sub="platform + pool" />
        <Cell label="Venue" value="xDEX" sub={pool.status === 0 ? "open" : "paused"} />
      </div>
    </header>
  );
}

function Cell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="cell">
      <div className="cell-l">{label}</div>
      <div className={`cell-v mono ${tone ?? ""}`}>{value}{sub && <span className="cell-s">{sub}</span>}</div>
    </div>
  );
}

// ---------------------------------------------------------------- pool depth and swaps

/** What stands in for an order book on a pool: how much it takes to move its price by a little
 *  or a lot, each way (fees aside), and the latest swaps on it. */
function PoolDepth({ pair, trades }: { pair: Pair; trades?: S.SpotTrade[] }) {
  const { pool, base, quote, baseName, quoteName, price } = pair;
  const rq = Number(pool.reserves[quote]) / 10 ** pool.decimals[quote];
  const levels = (sign: 1 | -1) => MOVES.map(m => ({
    move: sign * m,
    size: Math.abs(S.depthAt(pool, base, sign * m)),
    // The quote paid in (to buy) or taken out (to sell) on the way to that price.
    value: sign > 0 ? rq * (Math.sqrt(1 + m) - 1) : rq * (1 - Math.sqrt(1 - m)),
  }));
  // Furthest from the price at the top and bottom, nearest next to it.
  const buys = levels(1), sells = levels(-1).reverse();
  const most = Math.max(...buys.map(l => l.value), ...sells.map(l => l.value), 1e-12);
  const dp = priceDp(price);
  const baseMint = pool.mints[base].toBase58();
  const row = (l: { move: number; size: number; value: number }) => (
    <div key={l.move} className={`depth-row ${l.move > 0 ? "up" : "down"}`}>
      <i style={{ width: `${Math.max(2, (l.value / most) * 100)}%` }} />
      <span className="mono">{fmt(price * (1 + l.move), dp)} <em>{pct(l.move, l.move === 0.005 || l.move === -0.005 ? 1 : 0)}</em></span>
      <span className="mono">{amt(l.size)}</span>
      <span className="mono">{amt(l.value)}</span>
    </div>
  );
  return (
    <>
      <div className="ph">
        <h3>Pool depth</h3>
        <span className="hint" title="An xDEX pool has no order book: every swap trades against the pool, and the price moves along its curve with the size of the swap. Each row is how much buying (green) or selling (red) moves the price that far.">no order book</span>
      </div>
      <div className="depth spot-depth">
        <div className="depth-head"><span>Price</span><span>Size ({baseName})</span><span>Total ({quoteName})</span></div>
        {buys.map(row)}
        <div className="depth-mid mono">{fmt(price, dp)}<span>pool price · each swap moves it</span></div>
        {sells.map(row)}
      </div>
      <div className="ph tape-h"><h3>Latest swaps</h3></div>
      <div className="tape">
        {!trades ? <div className="quiet">Loading…</div> : trades.length === 0 ? <div className="quiet">No swaps recorded yet.</div> : trades.map(t => {
          const sell = t.inMint === baseMint;
          const size = sell ? t.inAmount : t.outAmount, paid = sell ? t.outAmount : t.inAmount;
          return (
            <a key={t.sig} className="tape-row spot-tape" href={explorer("tx", t.sig)} target="_blank" rel="noreferrer">
              <span className={sell ? "down" : "up"}>{sell ? "Sell" : "Buy"} {amt(size)}</span>
              <span className="mono">{size > 0 ? fmt(paid / size, dp) : "—"}</span>
              <span className="mono">{t.time ? ago(Date.now() / 1000 - t.time) : ""}</span>
            </a>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- order ticket

function SpotTicket({ pair, wallet, send, busy }: { pair: Pair; wallet?: ReturnType<typeof useWalletTokens>; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const { pool, base, quote, baseName, quoteName } = pair;
  const [side, setSide] = useState<"buy" | "sell">(() => (pool.mints[base].equals(NATIVE_MINT) ? "sell" : "buy"));
  const [text, setText] = useState("");
  const [slippage, setSlippage] = useState(100);
  const [deposit, setDeposit] = useState(true);
  const from = side === "buy" ? quote : base, to = (1 - from) as 0 | 1;
  const fromName = from === base ? baseName : quoteName, toName = to === base ? baseName : quoteName;
  const amountIn = atoms(text, pool.decimals[from]);
  const q = amountIn && amountIn > 0n ? S.quote(pool, from, amountIn, slippage) : undefined;
  // Keep enough coin for fees and new token accounts.
  const reserve = pool.mints[from].equals(NATIVE_MINT) ? (C.X1 ? 50_000_000n : 10_000_000n) : 0n;
  const balance = wallet?.tokens[from] ?? 0n;
  const spendable = balance > reserve ? balance - reserve : 0n;
  const intoMargin = pool.mints[to].equals(C.MINT) && !!wallet?.trader && deposit;
  const problem = pool.unsupported ? `This pool's token ${pool.unsupported}: the page does not trade it.`
    : pool.status !== 0 ? "xDEX has paused this pool."
    : pool.openTime > Date.now() / 1000 ? "This pool is not open yet."
    : pool.reserves[0] === 0n || pool.reserves[1] === 0n ? "This pool is empty."
    : undefined;
  const short_ = (amountIn ?? 0n) > spendable;
  const setShare = (bps: bigint) => setText(spendable > 0n ? (Number(spendable * bps / 10_000n) / 10 ** pool.decimals[from]).toString() : "");
  // The fill's price, in quote per base, fees included.
  const avg = q && q.out > 0n ? (side === "buy"
    ? (Number(q.amountIn) / 10 ** pool.decimals[quote]) / (Number(q.out) / 10 ** pool.decimals[base])
    : (Number(q.out) / 10 ** pool.decimals[quote]) / (Number(q.amountIn) / 10 ** pool.decimals[base])) : undefined;
  const go = () => {
    if (!publicKey || !q) return;
    const ixs = S.swapInstructions(publicKey, pool, from, q);
    if (intoMargin) ixs.push(C.routerDeposit(publicKey, q.minOut));
    send(`${side === "buy" ? "Buy" : "Sell"} ${baseName}${intoMargin ? " into margin" : ""}`, ixs).then(sig => sig && setText(""));
  };
  return (
    <div className="ticket">
      <div className="side">
        <button className={side === "buy" ? "on up" : ""} onClick={() => { setSide("buy"); setText(""); }}>Buy {baseName}</button>
        <button className={side === "sell" ? "on down" : ""} onClick={() => { setSide("sell"); setText(""); }}>Sell {baseName}</button>
      </div>
      <div className="otype"><span>Market swap</span><span className="hint" title="It trades against the xDEX pool at its price when the transaction lands, moved by the swap's own size. If the price has moved more than the slippage limit by then, the swap is refused and nothing is spent.">fills at the pool's price</span></div>

      <label className="inp">
        <span>Pay</span>
        <input value={text} onChange={e => setText(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" inputMode="decimal" />
        <span className="unit static">{fromName}</span>
      </label>
      <div className="quick">
        {[2_500n, 5_000n, 7_500n, 10_000n].map(b => <button key={String(b)} disabled={spendable === 0n} onClick={() => setShare(b)}>{b === 10_000n ? "Max" : `${b / 100n}%`}</button>)}
      </div>

      <div className="sum">
        <div><span>Available</span><b className="mono">{publicKey ? `${show(balance, pool.decimals[from])} ${fromName}` : "—"}</b></div>
        <div><span>You receive (estimated)</span><b className="mono">{q ? `${show(q.out, pool.decimals[to])} ${toName}` : "—"}</b></div>
        <div><span>Average price</span><b className="mono">{avg ? `${fmt(avg, priceDp(avg))} ${quoteName}` : "—"}</b></div>
        <div><span>Price impact</span><b className={`mono ${q && q.impactBps > 500 ? "down" : ""}`}>{q ? `${fmt(q.impactBps / 100, 2)}%` : "—"}</b></div>
        <div><span>Platform fee ({Number(S.SWAP_FEE_BPS) / 100}%)</span><b className="mono">{q ? `${show(q.platformFee, pool.decimals[from])} ${fromName}` : "—"}</b></div>
        <div><span>Pool fee ({fmt(Number(pool.feeRate) / 10_000, 2)}%)</span><b className="mono">{q ? `${show(q.poolFee, pool.decimals[from])} ${fromName}` : "—"}</b></div>
        <div><span>Least you receive</span><b className="mono">{q ? `${show(q.minOut, pool.decimals[to])} ${toName}` : "—"}</b></div>
        <div><span>Slippage limit</span>
          <span className="spot-slip">{SLIPPAGES.map(s => <button key={s} className={s === slippage ? "on" : ""} onClick={() => setSlippage(s)}>{s / 100}%</button>)}</span>
        </div>
      </div>

      {pool.mints[to].equals(C.MINT) && publicKey && wallet && (
        wallet.trader
          ? <label className="check spot-check"><input type="checkbox" checked={deposit} onChange={e => setDeposit(e.target.checked)} /> Deposit the USDC as trading margin (the least you receive goes in; any extra stays in your wallet)</label>
          : <div className="why">Open a trading account on the Trade page to sell straight into margin.</div>
      )}

      {!publicKey ? <div className="connect"><WalletMultiButton /></div>
        : <button className={`submit ${side === "buy" ? "up" : "down"}`} disabled={!!busy || !q || q.out === 0n || !!problem || short_} onClick={go}>
            {busy ? `${busy}…` : short_ ? `Not enough ${fromName}` : `${side === "buy" ? "Buy" : "Sell"} ${baseName}${intoMargin ? " into margin" : ""}`}
          </button>}
      {problem && <div className="why">{problem}</div>}
      {q && q.impactBps > 500 && <div className="why">This swap moves the pool's price by {fmt(q.impactBps / 100, 1)}%: the pool is small for this amount.</div>}
      <p className="fine">
        Real tokens, in your wallet: spot has no leverage and no liquidation. The swap goes through Turbopump's router to xDEX, X1's
        exchange; the router takes a {Number(S.SWAP_FEE_BPS) / 100}% platform fee from what you pay in, and the pool charges its own fee on top.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- wallet

function WalletPanel({ pair, wallet, go }: { pair: Pair; wallet?: ReturnType<typeof useWalletTokens>; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const { pool, base, quote, baseName, quoteName, price } = pair;
  const has = (i: 0 | 1) => Number(wallet?.tokens[i] ?? 0n) / 10 ** pool.decimals[i];
  const coinInPair = pool.mints[0].equals(NATIVE_MINT) || pool.mints[1].equals(NATIVE_MINT);
  return (
    <>
      <div className="ph"><h3>Wallet</h3><Faucet compact /></div>
      {!publicKey ? <div className="quiet">Connect a wallet to see its tokens.</div> : !wallet ? <div className="quiet">Reading…</div> : (
        <div className="acct">
          <div className="acct-row"><span>{baseName}</span><b className="mono">{amt(has(base))}</b></div>
          <div className="acct-row"><span>{quoteName}</span><b className="mono">{amt(has(quote))}</b></div>
          {!coinInPair && <div className="acct-row"><span>{C.COIN} (for fees)</span><b className="mono">{amt(Number(wallet.coin) / 1e9)}</b></div>}
          <div className="acct-row"><span>Together, in {quoteName}</span><b className="mono">{amt(has(base) * price + has(quote))}</b></div>
          <div className="acct-row"><span>Trading account</span><b>{wallet.trader ? "open" : <button className="link" onClick={() => go("/")}>open one on Trade</button>}</b></div>
          <p className="fine">{wallet.trader ? `Selling ${C.COIN} for USDC here can put the USDC straight into your trading margin.` : `With a trading account, ${C.COIN} sold for USDC here can go straight into margin.`}</p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- swaps, pairs, pool

function SpotBottom({ pair, list, mine, go }: { pair: Pair; list?: S.ListedPool[]; mine?: S.SpotTrade[]; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const [tab, setTab] = useState<"mine" | "pairs" | "pool">("mine");
  const { pool, listed, base, baseName, quoteName, price } = pair;
  const baseMint = pool.mints[base].toBase58();
  const ours = S.USDC_POOL.toBase58();
  const link = (k: PublicKey | string) => <a href={explorer("address", k.toString())} target="_blank" rel="noreferrer">{short(k)}</a>;
  return (
    <>
      <div className="ptabs wide">
        <button className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")}>My swaps{mine?.length ? <em>{mine.length}</em> : null}</button>
        <button className={tab === "pairs" ? "on" : ""} onClick={() => setTab("pairs")}>All pairs{list?.length ? <em>{list.length}</em> : null}</button>
        <button className={tab === "pool" ? "on" : ""} onClick={() => setTab("pool")}>Pool details</button>
      </div>
      <div className="bottom-body">
        {tab === "mine" && (!publicKey ? <div className="quiet">Connect a wallet to see your swaps.</div> : !mine ? <div className="quiet">Loading…</div> : mine.length === 0 ? <div className="quiet">No swaps on {baseName}/{quoteName} from this wallet yet.</div> : (
          <table className="tbl">
            <thead><tr><th>Pair</th><th>Side</th><th className="r">Size ({baseName})</th><th className="r">Price</th><th className="r">Total ({quoteName})</th><th className="r">When</th><th className="r">Transaction</th></tr></thead>
            <tbody>
              {mine.map(t => {
                const sell = t.inMint === baseMint, size = sell ? t.inAmount : t.outAmount, paid = sell ? t.outAmount : t.inAmount;
                return (
                  <tr key={t.sig}>
                    <td>{baseName}/{quoteName}</td>
                    <td className={sell ? "down" : "up"}>{sell ? "Sell" : "Buy"}</td>
                    <td className="r mono">{amt(size)}</td>
                    <td className="r mono">{size > 0 ? fmt(paid / size, priceDp(price)) : "—"}</td>
                    <td className="r mono">{amt(paid)}</td>
                    <td className="r mono">{t.time ? ago(Date.now() / 1000 - t.time) : ""}</td>
                    <td className="r"><a href={explorer("tx", t.sig)} target="_blank" rel="noreferrer">{short(t.sig)}</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
        {tab === "pairs" && (!list ? <div className="quiet">Loading xDEX pools…</div> : (
          <table className="tbl">
            <thead><tr><th>Pair</th><th className="r">Price</th><th className="r">24h volume</th><th className="r">24h swaps</th><th className="r">Liquidity</th><th className="r">Pool</th><th /></tr></thead>
            <tbody>
              {byInterest(list).slice(0, 100).map(l => {
                const lp = listedPair(l);
                return (
                  <tr key={l.pool}>
                    <td><button className="link" onClick={() => go(l.pool === ours ? "/spot" : `/spot/${l.pool}`)}>{lp.name}</button>{l.pool === ours && <span className="muted small"> · into margin</span>}</td>
                    <td className="r mono">{prc(lp.price)}</td>
                    <td className="r mono">{inQuote(lp.volume, lp.quote)}</td>
                    <td className="r mono">{l.txns}</td>
                    <td className="r mono">{inQuote(lp.liquidity, lp.quote)}</td>
                    <td className="r">{link(l.pool)}</td>
                    <td className="r">{l.pool === pool.key.toBase58() ? <span className="muted small">shown</span> : <button className="btn tiny ghost" onClick={() => go(l.pool === ours ? "/spot" : `/spot/${l.pool}`)}>Trade</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
        {tab === "pool" && (
          <div className="mkt">
            <div className="kv">
              <div><span>Venue</span><b><a href="https://xdex.xyz" target="_blank" rel="noreferrer">xDEX</a>, through Turbopump's router</b></div>
              <div><span>Platform fee</span><b>{Number(S.SWAP_FEE_BPS) / 100}% of what you pay in</b></div>
              <div><span>Pool fee</span><b>{fmt(Number(pool.feeRate) / 10_000, 2)}%, kept by the pool's liquidity</b></div>
              <div><span>Price</span><b>the pool's own: its two balances</b></div>
              <div><span>Leverage</span><b>none: real tokens</b></div>
            </div>
            <div className="kv">
              <div><span>Pool</span><b>{link(pool.key)}</b></div>
              <div><span>{baseName}</span><b>{link(pool.mints[base])}</b></div>
              <div><span>{quoteName}</span><b>{link(pool.mints[1 - base])}</b></div>
              <div><span>Status</span><b>{pool.status === 0 ? "open" : "paused by xDEX"}</b></div>
              <div><span>24h swaps</span><b>{listed ? listed.txns : "—"}</b></div>
            </div>
            {(!known(pool.mints[0]) || !known(pool.mints[1])) && <p className="fine">Anyone can open an xDEX pool under any name: check the token's address before you trade it.</p>}
          </div>
        )}
      </div>
    </>
  );
}
