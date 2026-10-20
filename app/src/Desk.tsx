// The trading desk: one market on one screen. Chart, what the vault can take, the order ticket,
// and the wallet's positions.
//
// There is no order book to show: every order fills against the market's vault at the first
// oracle price published a few seconds after the request. What stands in its place is the vault's
// capacity: how much it can take on each side right now.
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as C from "./chain";
import Chart, { DayStats, useDayStats } from "./Chart";
import * as S from "./social";
import { Mark, marksFor, useBoard, useMe, usePictures } from "./Traders";
import { Card, Faucet, Icon, LiquidityPanel, OpenerPanel, Send, ago, capUnits, entryPrice, explorer, fmt, num, priceDp, px, short, units, usd, useActivity, useCards, useFills, useVault } from "./shared";

const UP = "#48E160", DOWN = "#E15A48";
const pct = (x: number, dp = 2) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, dp)}%`;
const money = (x: number, dp = 2) => `$${fmt(x, dp)}`;
const signedMoney = (x: number) => `${x >= 0 ? "+" : "−"}$${fmt(Math.abs(x))}`;
const abs = (q: bigint) => (q < 0n ? -q : q);
const e6 = (x: number) => BigInt(Math.round(x * 1e6));
const ORDER_NAME = ["Stop loss", "Take profit", "Trailing stop", "Limit", "TWAP"];
/** The first of the wallet's order slots on this market that is free (or as many as asked). */
const freeSlots = (state: C.State, n = 1) => Array.from({ length: C.MAX_ORDERS }, (_, i) => i).filter(i => !state.orders.some(o => o.index === i)).slice(0, n);

export default function Desk({ route, send, busy, tick, go }: { route: string[]; send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const { cards, err } = useCards(tick);
  const live = useMemo(() => (cards ?? []).filter(c => c.v.status === 1 && c.v.feed).sort((a, b) => Number(b.v.canonical) - Number(a.v.canonical)), [cards]);
  // #/trade/SOL, or #/m/<vault address>; with neither, the first of SOL, BTC, ETH that is open.
  const chosen = useMemo(() => {
    if (route[0] === "m" && route[1]) { try { return new PublicKey(route[1]); } catch { return undefined; } }
    const want = route[0] === "trade" ? route[1]?.toUpperCase() : undefined;
    const pick = (sym?: string) => live.find(c => c.v.canonical && c.v.feed!.symbol === sym);
    return (pick(want) ?? pick("SOL") ?? pick("BTC") ?? pick("ETH") ?? live[0])?.v.key;
  }, [route.join("/"), live]);
  const symbols = useMemo(() => [...new Set(live.map(c => c.v.feed!.symbol))], [live]);
  const day = useDayStats(symbols);

  if (err && !cards) return <div className="desk-msg">Cannot reach the network: {err}</div>;
  if (!cards) return <div className="desk-msg">Loading markets…</div>;
  if (!chosen) {
    return (
      <div className="desk-msg">
        No market is open on {C.NETWORK_NAME} yet.
        <button className="btn primary" onClick={() => go("/launch")}>Open the first market</button>
      </div>
    );
  }
  return <DeskInner key={chosen.toString()} vaultKey={chosen} markets={live} day={day} send={send} busy={busy} tick={tick} go={go} />;
}

function DeskInner({ vaultKey, markets, day, send, busy, tick, go }: { vaultKey: PublicKey; markets: Card[]; day: Record<string, DayStats>; send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const { state, err, reload } = useVault(vaultKey, tick);
  const [panel, setPanel] = useState<"trade" | "earn">("trade");
  const wrapped: Send = async (l, ixs) => { const r = await send(l, ixs); reload(); return r; };
  const fills = useFills(publicKey, vaultKey, state?.portfolio?.position ?? 0n);
  // The traders this wallet follows or copies: their fills on this market are marked on the chart.
  const { board } = useBoard(tick);
  const me = useMe(board, tick);
  const leaders = useMemo(() => [...new Set([...me.following, ...(me.copy ? [me.copy.leader.toBase58()] : [])])].sort(), [me]);
  const asset = state?.vault.assetIndex ?? -1;
  // (Badge pictures are checked and loaded a moment after the board arrives: the marks follow.)
  const pictures = usePictures();
  const marks = useMemo(() => marksFor(board, leaders, asset), [board, leaders.join(","), asset, pictures]);

  if (err && !state) return <div className="desk-msg">{err}</div>;
  if (!state) return <div className="desk-msg">Loading market…</div>;

  const v = state.vault, sym = v.feed?.symbol ?? "?";
  const price = num(state.asset.price, 1e6);
  const posN = num(state.portfolio?.position ?? 0n, 1e6);
  const entry = entryPrice(fills, posN);
  const liq = liquidationPrice(state, posN);
  const lines = [
    ...(entry ? [{ price: entry, title: "Entry", color: "#F4F4F4" }] : []),
    ...(liq ? [{ price: liq, title: "Liq.", color: DOWN }] : []),
    ...state.orders.filter(o => o.kind !== C.ORDER.TWAP).map(o => o.kind === C.ORDER.TRAIL
      ? { price: num(o.peak, 1e6) * (1 - o.side * Number(o.trigger) / 10_000), title: "Trail", color: DOWN }
      : { price: num(o.trigger, 1e6), title: o.kind === C.ORDER.STOP ? "SL" : o.kind === C.ORDER.TAKE ? "TP" : o.size > 0n ? "Buy" : "Sell", color: o.kind === C.ORDER.STOP ? DOWN : o.kind === C.ORDER.TAKE ? UP : "#8A8A8A" }),
  ];

  return (
    <main className="desk">
      <MarketBar state={state} markets={markets} day={day} go={go} />
      <section className="desk-chart panel"><Charts sym={sym} price={price} lines={lines} marks={marks} markets={markets} go={go} /></section>
      <section className="desk-book panel"><VaultDepth state={state} tick={tick} /></section>
      <section className="desk-ticket panel">
        <div className="ptabs">
          <button className={panel === "trade" ? "on" : ""} onClick={() => setPanel("trade")}>Trade</button>
          <button className={panel === "earn" ? "on" : ""} onClick={() => setPanel("earn")}>Earn</button>
        </div>
        {panel === "trade" ? <Ticket state={state} send={wrapped} busy={busy} /> : <div className="earn"><LiquidityPanel state={state} send={wrapped} busy={busy} /></div>}
      </section>
      <section className="desk-bottom panel"><Bottom state={state} markets={markets} fills={fills} entry={entry} liq={liq} send={wrapped} busy={busy} go={go} /></section>
      <section className="desk-account panel"><Account state={state} send={wrapped} busy={busy} /></section>
    </main>
  );
}

// ---------------------------------------------------------------- chart windows

/** One, two or four chart windows. The first is always the market being traded (with the
 *  wallet's lines, the drawing tools and followed traders' fills); the others show any market. */
const LAYOUTS: [id: string, label: string, panes: number, icon: string][] = [
  ["1", "One chart", 1, "M2.5 2.5h11v11h-11z"],
  ["2h", "Two charts side by side", 2, "M2.5 2.5h11v11h-11zM8 2.5v11"],
  ["2v", "Two charts, one over the other", 2, "M2.5 2.5h11v11h-11zM2.5 8h11"],
  ["4", "Four charts", 4, "M2.5 2.5h11v11h-11zM8 2.5v11M2.5 8h11"],
];
function Charts({ sym, price, lines, marks, markets, go }: { sym: string; price: number; lines: { price: number; title: string; color: string }[]; marks: Mark[]; markets: Card[]; go: (to: string) => void }) {
  const [layout, setLayout] = useState(() => { const l = localStorage.getItem("pv:chart-layout"); return LAYOUTS.some(x => x[0] === l) ? l! : "1"; });
  const [others, setOthers] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem("pv:chart-panes") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } });
  const n = LAYOUTS.find(l => l[0] === layout)?.[2] ?? 1;
  const syms = useMemo(() => [...new Set(markets.filter(c => c.v.canonical).map(c => c.v.feed!.symbol))], [markets]);
  const rest = syms.filter(s => s !== sym);
  // A window keeps the market it was given; until then it shows the next one that is not on screen.
  const paneSym = (i: number) => (others[i - 1] && syms.includes(others[i - 1]) ? others[i - 1] : rest[(i - 1) % Math.max(1, rest.length)] ?? sym);
  const priceOf = (s: string) => num(markets.find(c => c.v.canonical && c.v.feed!.symbol === s)?.asset.price ?? 0n, 1e6);
  const choose = (l: string) => { setLayout(l); try { localStorage.setItem("pv:chart-layout", l); } catch { /* storage unavailable */ } };
  const setPane = (i: number, s: string) => {
    const next = Array.from({ length: 3 }, (_, k) => (k === i - 1 ? s : paneSym(k + 1)));
    setOthers(next);
    try { localStorage.setItem("pv:chart-panes", JSON.stringify(next)); } catch { /* storage unavailable */ }
  };
  const picker = (
    <div className="layouts" role="group" aria-label="Chart windows">
      {LAYOUTS.map(([id, label, , icon]) => (
        <button key={id} title={label} aria-label={label} className={id === layout ? "on" : ""} onClick={() => choose(id)}>
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d={icon} fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
      ))}
    </div>
  );
  return (
    <div className={`charts l-${layout}`}>
      <Chart symbol={sym} price={price} lines={lines} marks={marks} dense={n > 1} head={<>{picker}{n > 1 && <div className="pane-sym main"><b>{sym}</b></div>}</>} />
      {Array.from({ length: n - 1 }, (_, k) => {
        const i = k + 1, s = paneSym(i);
        return (
          <Chart key={i} slot={i} compact dense symbol={s} price={priceOf(s)} lines={[]} head={
            <div className="pane-sym">
              <select value={s} aria-label="Market in this window" onChange={e => setPane(i, e.target.value)}>{syms.map(x => <option key={x} value={x}>{x}-PERP</option>)}</select>
              <button title={`Trade ${s}`} onClick={() => go(`/trade/${s}`)}>Trade</button>
            </div>
          } />
        );
      })}
    </div>
  );
}

/** The price at which the account's equity falls to the liquidation level if this market's
 *  position were `posN`, with the account's other positions unchanged. */
function liquidationPrice(state: C.State, posN: number): number | undefined {
  const h = state.health;
  if (!h || posN === 0) return undefined;
  // Each position has its own liquidation level (its tier's); the others' part of the floor stays.
  const level = Number(state.levels.liq) / 10_000, priceN = num(state.asset.price, 1e6);
  const heldN = num(state.portfolio?.position ?? 0n, 1e6);
  const otherFloor = num(h.floor, 1e6) - Math.abs(heldN) * priceN * level;
  // Equity as it would be with the position marked from the current price.
  const x = (otherFloor - num(h.equity, 1e6) + posN * priceN) / (posN - level * Math.abs(posN));
  return x > 0 && Number.isFinite(x) ? x : undefined;
}

// ---------------------------------------------------------------- market bar

function MarketBar({ state, markets, day, go }: { state: C.State; markets: Card[]; day: Record<string, DayStats>; go: (to: string) => void }) {
  const v = state.vault, sym = v.feed?.symbol ?? "?";
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const price = num(state.asset.price, 1e6);
  const before = useRef(price);
  const dir = price > before.current ? "up" : price < before.current ? "down" : "";
  useEffect(() => { before.current = price; }, [price]);
  const d = day[sym];
  // The day's change is measured to this market's own price, not the history's last candle.
  const change = d && d.last > 0 ? (price / (d.last / (1 + d.change))) - 1 : undefined;
  const oiUsd = num(state.asset.oiLong, 1e6) * price;
  const age = state.pyth ? Date.now() / 1000 - state.pyth.publish : undefined;
  const end = v.epochStart + v.epochLen, left = end > state.slot ? end - state.slot : 0n;
  const dp = priceDp(price);
  return (
    <header className="mbar">
      <div className="msel" ref={box}>
        <button className="msel-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <Icon symbol={sym} />
          <span className="msel-sym">{sym}-PERP</span>
          <span className="msel-lev">{fmt(10_000 / Number(state.levels.open), 0)}×</span>
          <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        {open && (
          <div className="msel-menu">
            <div className="msel-head"><span>Market</span><span>Price</span><span>24h</span><span>Liquidity</span></div>
            {markets.map(c => {
              const s = c.v.feed!.symbol, ds = day[s], p = num(c.asset.price, 1e6);
              const ch = ds && ds.last > 0 ? p / (ds.last / (1 + ds.change)) - 1 : undefined;
              return (
                <button key={c.v.key.toString()} className={c.v.key.equals(v.key) ? "msel-row on" : "msel-row"} onClick={() => { setOpen(false); go(c.v.canonical ? `/trade/${s}` : `/m/${c.v.key.toString()}`); }}>
                  <span className="msel-name"><Icon symbol={s} />{s}-PERP{!c.v.canonical && <em>earlier vault</em>}</span>
                  <span className="mono">{px(c.asset.price)}</span>
                  <span className={`mono ${ch === undefined ? "" : ch >= 0 ? "up" : "down"}`}>{ch === undefined ? "—" : pct(ch)}</span>
                  <span className="mono">{usd(c.nav, 0)}</span>
                </button>
              );
            })}
            <button className="msel-all" onClick={() => { setOpen(false); go("/markets"); }}>All markets</button>
          </div>
        )}
      </div>
      <div className={`mbar-price mono ${dir}`}>{fmt(price, dp)}</div>
      <div className="mbar-stats">
        <Cell label="24h change" value={change === undefined ? "—" : pct(change)} tone={change === undefined ? undefined : change >= 0 ? "up" : "down"} />
        <Cell label="24h high" value={d ? fmt(Math.max(d.high, price), dp) : "—"} />
        <Cell label="24h low" value={d ? fmt(Math.min(d.low, price), dp) : "—"} />
        <Cell label="Open interest" value={money(oiUsd, 0)} sub={`${units(state.asset.oiLong)} ${sym}`} />
        <Cell label="Vault liquidity" value={usd(C.navOf(state), 0)} />
        <Cell label="Oracle" value={C.X1 ? "Jack's oracle" : "Pyth"} sub={age !== undefined ? ago(age) : undefined} />
        <Cell label="Fee" value={C.TRADE_FEE_PCT} sub="no spread, no price impact" />
        <Cell label={`Liquidity epoch ${v.epoch}`} value={left > 0n ? `${Math.max(1, Math.ceil(Number(left) * C.slotSeconds() / 60))} min left` : v.pendingDeposit > 0n || v.pendingWithdraw > 0n ? "settling" : "no requests"} />
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

// ---------------------------------------------------------------- vault capacity and tape

function VaultDepth({ state, tick }: { state: C.State; tick: number }) {
  const v = state.vault, sym = v.feed?.symbol ?? "";
  const price = num(state.asset.price, 1e6);
  const room = C.depth(state);
  const nav = C.navOf(state);
  const limit = v.positionNavBps ? capUnits(nav, v.positionNavBps, state.asset.price) : v.maxInventory;
  const most = room.long > room.short ? room.long : room.short;
  const bar = (q: bigint) => (most > 0n ? Math.max(2, Number(q * 100n / most)) : 0);
  const val = (q: bigint) => money(num(q, 1e6) * price, 0);
  // Where the vault's position sits between its two limits (0 = fully short, 100 = fully long).
  const at = limit > 0n ? Math.min(100, Math.max(0, 50 + Number(v.inventory * 50n / limit))) : 50;
  const rows = useActivity(v, tick);
  return (
    <>
      <div className="ph">
        <h3>Vault capacity</h3>
        <span className="hint" title="Every order fills against this market's vault at the oracle price, so there is no order book. These are the largest orders the vault takes right now.">no order book</span>
      </div>
      <div className="depth">
        <div className="depth-head"><span>Side</span><span>Size ({sym})</span><span>Value</span></div>
        <div className="depth-row up"><i style={{ width: `${bar(room.long)}%` }} /><span>Buy / long</span><span className="mono">{units(room.long)}</span><span className="mono">{val(room.long)}</span></div>
        <div className="depth-mid mono">{fmt(price, priceDp(price))}<span>oracle price · same both ways</span></div>
        <div className="depth-row down"><i style={{ width: `${bar(room.short)}%` }} /><span>Sell / short</span><span className="mono">{units(room.short)}</span><span className="mono">{val(room.short)}</span></div>
      </div>
      <div className="skew">
        <div className="skew-l"><span>Vault position</span><b className="mono">{v.inventory === 0n ? "flat" : `${v.inventory > 0n ? "long" : "short"} ${units(abs(v.inventory))} ${sym}`}</b></div>
        <div className="skew-track"><i style={{ left: `${at}%` }} /><em /></div>
        <div className="skew-ends mono"><span>−{units(limit)}</span><span>limit 3× liquidity</span><span>+{units(limit)}</span></div>
      </div>
      <div className="ph tape-h"><h3>Market activity</h3></div>
      <div className="tape">
        {!rows ? <div className="quiet">Loading…</div> : rows.length === 0 ? <div className="quiet">No activity yet.</div> : rows.map(r => (
          <a key={r.sig} className="tape-row" href={explorer("tx", r.sig)} target="_blank" rel="noreferrer">
            <span className={/^Long/.test(r.what) ? "up" : /^Short/.test(r.what) ? "down" : ""}>{r.what.replace(" vs vault", "")}</span>
            <span className="mono">{r.when ? ago(Date.now() / 1000 - r.when) : ""}</span>
          </a>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- order ticket

function Ticket({ state, send, busy }: { state: C.State & { readFor?: string }; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  // The wallet's coins: an order takes a bond and a deposit (0.1% of its value) in the chain's
  // coin, and without enough of them the transaction is refused with a bare "0x1".
  const [coins, setCoins] = useState<number>();
  useEffect(() => {
    if (!publicKey) { setCoins(undefined); return; }
    let live = true;
    const read = () => connection.getBalance(publicKey).then(b => { if (live) setCoins(b); }).catch(() => {});
    read();
    const id = setInterval(read, 15_000);
    return () => { live = false; clearInterval(id); };
  }, [publicKey?.toBase58(), busy]);
  const [side, setSide] = useState<1n | -1n>(1n);
  const [text, setText] = useState("");
  const [unit, setUnit] = useState<"coin" | "usd">("coin");
  const [mode, setMode] = useState<"market" | "limit" | "protect" | "twap">("market");
  // Whether what is shown includes this wallet's own accounts yet (the market itself shows first).
  const mine = !publicKey || state.readFor === undefined || state.readFor === publicKey.toBase58();
  const v = state.vault, p = state.portfolio, sym = v.feed?.symbol ?? "";
  const priceN = num(state.asset.price, 1e6);
  const dp = priceDp(priceN);
  const typed = Number(text || 0);
  const sizeN = unit === "coin" ? typed : priceN > 0 ? typed / priceN : 0;
  const want = BigInt(Math.max(0, Math.round((Number.isFinite(sizeN) ? sizeN : 0) * 1e6)));
  const notional = num(want, 1e6) * priceN;

  const pendingHere = state.pending;
  const locked = !!state.trader?.hasPending;
  // The largest order each way that the router's margin check accepts. Shrinking a position is
  // always accepted; past zero, the new position has to fit the margin.
  const held = p?.position ?? 0n, cap = state.margin ?? 0n;
  const room = C.depth(state, held);
  const marginMax = (s: 1n | -1n) => (held === 0n || (held > 0n) === (s > 0n) ? (cap > abs(held) ? cap - abs(held) : 0n) : abs(held) + cap);
  const vaultMax = side > 0n ? room.long : room.short;
  const most = marginMax(side) < vaultMax ? marginMax(side) : vaultMax;
  const sent = want > vaultMax ? vaultMax : want; // an order above what the vault takes is cut to it
  // (No shares outstanding and no position: every deposit was withdrawn. Such a market is not serviced, so an
  // order sent to it would wait until it expired, and block the wallet's other trades meanwhile.)
  const noLiquidity = v.lastNav === 0n || (state.shareSupply === 0n && v.inventory === 0n);
  const reduceOnly = state.slot >= v.epochStart + v.epochLen && v.needsFlat;
  const after = num(held + sent * side, 1e6);
  const liqAfter = liquidationPrice(state, after);

  // Say what became of a queued trade once it leaves the queue (the fill is sent by an executor,
  // not by this page, so there is no confirmation of its own to show).
  const watched = useRef<{ size: bigint; position: bigint } | null>(null);
  const [outcome, setOutcome] = useState<string>();
  useEffect(() => {
    const position = p?.position ?? 0n;
    if (pendingHere) { watched.current ??= { size: pendingHere.size, position }; setOutcome(undefined); return; }
    const w = watched.current;
    if (!w) return;
    watched.current = null;
    const got = position - w.position;
    setOutcome(w.size === 0n
      ? (position === 0n ? `Your ${sym} position was closed out at the oracle price.` : `The close-out of your ${sym} position expired without closing it.`)
      : got === 0n
      ? `Your ${w.size > 0n ? "long" : "short"} of ${units(abs(w.size))} ${sym} left the queue without trading (it expired, or the vault could not take it).`
      : `Filled: ${got > 0n ? "bought" : "sold"} ${units(abs(got))} ${sym}${got !== w.size ? ` of the ${units(abs(w.size))} requested` : ""}.`);
  }, [pendingHere?.id, p?.position]);

  // Deposit + bond + a little for the fee.
  const coinsNeeded = Number(C.expiryDeposit(sent, state.asset.price)) + C.ROUTER_BOND_LAMPORTS + 1_000_000;
  // The one thing that stops this order, if anything does.
  const blockerBase = !publicKey || !state.trader || !state.book || locked || state.closeOnly || noLiquidity || vaultMax === 0n;
  const blocker = !publicKey ? "Connect a wallet to trade"
    : !state.trader ? "Create a trading account first"
    : !state.book ? "This market's queue is not open yet"
    : locked ? (pendingHere ? "Your queued order has to fill or expire first" : "You have an order queued on another market")
    : state.closeOnly ? "This market is close-only until its remaining positions are closed"
    : noLiquidity ? "This market has no liquidity yet"
    : vaultMax === 0n ? (reduceOnly ? "The vault is settling an epoch: it only takes orders that reduce its position or close yours" : `The vault is at its limit for ${side > 0n ? "longs" : "shorts"}`)
    : want <= 0n ? "Enter a size"
    : sent > marginMax(side) ? `Your margin covers at most ${units(marginMax(side))} ${sym} here: add margin or lower the size`
    : coins !== undefined && coins < coinsNeeded ? `This order needs ${(coinsNeeded / 1e9).toFixed(3)} ${C.COIN} in your wallet for its deposit and bond (they come back when it fills); the wallet has ${(coins / 1e9).toFixed(3)}`
    : undefined;

  // Leverage is not a setting here: there is one margin account for all markets, and leverage is
  // what its positions are worth against its equity. The slider picks the order that brings the
  // account to a chosen leverage; the top of its range is the most the margin rule allows.
  const h = state.health;
  const equityN = num(h?.equity ?? p?.capital ?? 0n, 1e6);
  const otherN = num(h?.notional ?? 0n, 1e6) - num(abs(held), 1e6) * priceN;
  const levOf = (posUnits: number) => (equityN > 0 ? (Math.abs(posUnits) * priceN + otherN) / equityN : 0);
  const sameSide = held === 0n || (held > 0n) === (side > 0n);
  const reach = num(sameSide ? abs(held) + most : most > abs(held) ? most - abs(held) : 0n, 1e6); // largest position on this side
  const levMax = levOf(reach), levNow = levOf(num(held, 1e6)), levAfter = levOf(after);
  const setLeverage = (x: number) => {
    const target = Math.max(0, (x * equityN - otherN) / priceN);          // position size on this side
    const order = sameSide ? target - num(abs(held), 1e6) : target + num(abs(held), 1e6);
    setUnit("coin");
    setText(order > 0 ? String(Math.min(+order.toFixed(4), num(most, 1e6))) : "");
  };

  const setShare = (bps: bigint) => {
    const q = most * bps / 10_000n;
    setUnit("coin");
    setText(q > 0n ? String(Number(q) / 1e6) : "");
  };
  const submit = () => {
    if (!publicKey || !state.book || blocker) return;
    send(`${side > 0n ? "Long" : "Short"} ${units(sent)} ${sym}`, [C.requestTrade(publicKey, v.key, sent * side)]);
  };
  const closeAll = () => {
    if (!publicKey || !state.book || held === 0n) return;
    // A close-only market has no counterparty for a close: the position is closed out instead.
    if (state.closeOnly) send("Close position", [C.requestClose(publicKey, publicKey, v.key)]);
    else send("Close position", [C.requestTrade(publicKey, v.key, -held)]);
  };

  return (
    <div className="ticket">
      <div className="otabs">
        {([["market", "Market"], ["limit", "Limit"], ["protect", "TP / SL"], ["twap", "TWAP"]] as const).map(([m, label]) => (
          <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{label}</button>
        ))}
      </div>
      {mode !== "protect" && (
        <div className="side">
          <button className={side > 0n ? "on up" : ""} onClick={() => setSide(1n)}>{mode === "market" ? "Long" : "Buy"}</button>
          <button className={side < 0n ? "on down" : ""} onClick={() => setSide(-1n)}>{mode === "market" ? "Short" : "Sell"}</button>
        </div>
      )}
      {mode !== "market" ? <StandingForm mode={mode} side={side} state={state} send={send} busy={busy} /> : <>
      <div className="otype"><span>Market order</span><span className="hint" title="It fills at the first oracle price published a few seconds after it lands, with no spread and no price impact.">fills at the oracle price</span></div>

      <label className="inp">
        <span>Size</span>
        <input value={text} onChange={e => setText(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" inputMode="decimal" />
        <button className="unit" onClick={() => { setText(typed > 0 && priceN > 0 ? String(unit === "coin" ? +(typed * priceN).toFixed(2) : +(typed / priceN).toFixed(6)) : ""); setUnit(unit === "coin" ? "usd" : "coin"); }} title="Switch between the asset and dollars">{unit === "coin" ? sym : "USD"}</button>
      </label>
      <div className="quick">
        {[2_500n, 5_000n, 7_500n, 10_000n].map(b => <button key={String(b)} disabled={most === 0n} onClick={() => setShare(b)}>{b === 10_000n ? "Max" : `${b / 100n}%`}</button>)}
      </div>

      {state.trader && (
        <div className="lev">
          <div className="lev-l">
            <span className="hint" title="One margin account covers every market, so leverage is the account's: what all its positions are worth, divided by its equity. Each market has its own maximum (20× on BTC and ETH, 10× on the others); the slider stops at what your margin allows here.">Account leverage</span>
            <b className="mono">{want > 0n ? `${fmt(levNow, 1)}× → ${fmt(levAfter, 1)}×` : `${fmt(levNow, 1)}×`}<i>max {fmt(Math.max(levMax, levNow), 1)}×</i></b>
          </div>
          <input type="range" min={0} max={Math.max(levMax, 0.1)} step={0.1} value={Math.min(want > 0n ? levAfter : levNow, Math.max(levMax, 0.1))} disabled={most === 0n || !!blockerBase} onChange={e => setLeverage(Number(e.target.value))} className={side > 0n ? "up" : "down"} />
        </div>
      )}

      <div className="sum">
        <div><span>Order value</span><b className="mono">{money(notional)}</b></div>
        <div><span>Margin used ({fmt(10_000 / Number(state.levels.open), 0)}×)</span><b className="mono">{money(notional * Number(state.levels.open) / 10_000)}</b></div>
        <div><span>Fee ({C.TRADE_FEE_PCT})</span><b className="mono">{money(notional * C.TRADE_FEE_BPS / 10_000)}</b></div>
        <div><span>Position after</span><b className="mono">{after === 0 ? "flat" : `${after > 0 ? "long" : "short"} ${fmt(Math.abs(after), 4).replace(/\.?0+$/, "")} ${sym}`}</b></div>
        <div><span>Est. liquidation price</span><b className="mono">{liqAfter && want > 0n ? fmt(liqAfter, dp) : "—"}</b></div>
        <div><span>Largest order now</span><b className="mono">{state.trader ? `${units(most)} ${sym}` : `${units(vaultMax)} ${sym}`}</b></div>
      </div>

      {!publicKey ? <div className="connect"><WalletMultiButton /></div>
        : !mine ? <button className="submit neutral" disabled>Reading your account…</button>
        : !state.trader ? <button className="submit neutral" disabled={!!busy} onClick={() => send("Create trading account", [C.openTradingAccount(publicKey), S.openStats(publicKey, publicKey)])}>Create trading account</button>
        : <button className={`submit ${side > 0n ? "up" : "down"}`} disabled={!!blocker || !!busy} onClick={submit}>{busy ? `${busy}…` : `${side > 0n ? "Long" : "Short"} ${want > 0n ? `${units(sent)} ` : ""}${sym}`}</button>}
      {state.trader && held !== 0n && (
        <button className="closepos" disabled={locked || !!busy} onClick={closeAll}>
          Close {held > 0n ? "long" : "short"} {units(abs(held))} {sym}
        </button>
      )}
      {blocker && publicKey && <div className="why">{blocker}</div>}
      {!blocker && want > vaultMax && <div className="why">The vault takes {units(vaultMax)} {sym} on this side right now, so the order is cut to that.</div>}
      {!state.trader && publicKey && mine && <div className="why">One account covers every market. It belongs to a program address derived from your wallet: only the router can trade it, and withdrawals only go back to this wallet. About 0.07 test {C.COIN} of rent.</div>}

      </>}
      {pendingHere && <Pending r={pendingHere} sym={sym} send={send} busy={busy} />}
      {!pendingHere && outcome && <div className="outcome" onClick={() => setOutcome(undefined)}>{outcome}</div>}
      <p className="fine">
        Orders fill at the first oracle price published {C.ROUTER_DELAY_SECS} seconds after the request lands. Nobody can know that price
        when the order is sent, so nobody can trade ahead of it. An order cannot be cancelled; unfilled after {C.ROUTER_GRACE_SECS} s, it expires.
        {want > 0n && <> A deposit of {(Number(C.expiryDeposit(sent, state.asset.price)) / 1e9).toFixed(4)} {C.COIN} ({C.EXPIRY_DEPOSIT_BPS / 100}% of the order, at most {Number(C.EXPIRY_DEPOSIT_CAP) / 1e9} {C.COIN}) goes with it and comes back when it fills; it is kept only if the order's price arrived and the order still expired while the market was current.</>}
      </p>
    </div>
  );
}

/** Limit, TP / SL / trailing stop, and TWAP: orders the wallet signs once and the executor
 *  carries out later, when their condition holds. */
function StandingForm({ mode, side, state, send, busy }: { mode: "limit" | "protect" | "twap"; side: 1n | -1n; state: C.State; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const v = state.vault, sym = v.feed?.symbol ?? "";
  const priceN = num(state.asset.price, 1e6), dp = priceDp(priceN);
  const held = state.portfolio?.position ?? 0n, long = held > 0n;
  const [size, setSize] = useState("");
  const [limit, setLimit] = useState("");
  const [reduce, setReduce] = useState(false);
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [trail, setTrail] = useState("");
  const [slices, setSlices] = useState("6");
  const [minutes, setMinutes] = useState("30");
  const n = (t: string) => { const x = Number(t); return Number.isFinite(x) && x > 0 ? x : 0; };
  const digits = (set: (t: string) => void) => (e: { target: { value: string } }) => set(e.target.value.replace(/[^0-9.]/g, ""));
  const ready = !!publicKey && !!state.trader;
  const need = !publicKey ? "Connect a wallet first" : !state.trader ? "Create a trading account first (Market tab)" : undefined;
  const free = freeSlots(state, 3);

  if (mode === "limit") {
    const q = e6(n(size)) * side, px = n(limit);
    // A limit on the wrong side of the price is carried out at once, like a market order.
    const marketable = px > 0 && (side > 0n ? px >= priceN : px <= priceN);
    const why = need ?? (!free.length ? "All 8 order slots on this market are in use: cancel one first" : !n(size) ? "Enter a size" : !px ? "Enter a limit price" : undefined);
    return (
      <div className="sform">
        <label className="inp"><span>Limit price</span><input value={limit} onChange={digits(setLimit)} placeholder={fmt(priceN, dp)} inputMode="decimal" /><button className="unit" onClick={() => setLimit(String(+priceN.toFixed(dp)))}>Mark</button></label>
        <label className="inp"><span>Size</span><input value={size} onChange={digits(setSize)} placeholder="0.00" inputMode="decimal" /><em>{sym}</em></label>
        <label className="check"><input type="checkbox" checked={reduce} onChange={e => setReduce(e.target.checked)} />Reduce only (never opens or flips a position)</label>
        <div className="sum">
          <div><span>Order value</span><b className="mono">{money(n(size) * (px || priceN))}</b></div>
          <div><span>Carried out when the price is</span><b className="mono">{px ? `${side > 0n ? "≤" : "≥"} ${fmt(px, dp)}` : "—"}</b></div>
        </div>
        <button className={`submit ${side > 0n ? "up" : "down"}`} disabled={!!why || !!busy || !ready} onClick={() => publicKey && send(`Limit ${side > 0n ? "buy" : "sell"} ${size} ${sym} at ${limit}`, [C.placeOrder(publicKey, v.key, { index: free[0], kind: C.ORDER.LIMIT, reduceOnly: reduce, size: q, trigger: e6(px) })])}>
          {busy ? `${busy}…` : `Place limit ${side > 0n ? "buy" : "sell"}`}
        </button>
        {why && <div className="why">{why}</div>}
        {!why && marketable && <div className="why">The price is already {side > 0n ? "at or below" : "at or above"} this limit, so the order is carried out right away.</div>}
        <p className="fine">A limit order waits until the oracle price reaches your limit. It is then queued and fills at the next oracle price, but only if that price is your limit or better; otherwise it trades nothing and keeps waiting. Margin is checked when it is carried out.</p>
      </div>
    );
  }

  if (mode === "protect") {
    const t = n(tp), s = n(sl), tr = n(trail);
    const count = (t ? 1 : 0) + (s ? 1 : 0) + (tr ? 1 : 0);
    // A stop on the wrong side of the price, or a take-profit that is already reached, fires at once.
    const slNow = s > 0 && (long ? s >= priceN : s <= priceN), tpNow = t > 0 && (long ? t <= priceN : t >= priceN);
    const why = need ?? (held === 0n ? `Open a ${sym} position first: these orders protect a position you hold` : !count ? "Enter a take-profit price, a stop price or a trail" : free.length < count ? "Not enough free order slots on this market: cancel an order first" : tr > 50 ? "A trail can be at most 50%" : undefined);
    const place = () => {
      if (!publicKey) return;
      const ixs = [];
      let i = 0;
      if (t) ixs.push(C.placeOrder(publicKey, v.key, { index: free[i++], kind: C.ORDER.TAKE, size: 0n, trigger: e6(t) }));
      if (s) ixs.push(C.placeOrder(publicKey, v.key, { index: free[i++], kind: C.ORDER.STOP, size: 0n, trigger: e6(s) }));
      if (tr) ixs.push(C.placeOrder(publicKey, v.key, { index: free[i++], kind: C.ORDER.TRAIL, size: 0n, trigger: BigInt(Math.round(tr * 100)) }));
      send("Set TP / SL", ixs);
    };
    const pnl = (x: number) => (x && held !== 0n ? signedMoney((x - priceN) * num(held, 1e6)) : "—");
    return (
      <div className="sform">
        <div className="otype"><span>{held === 0n ? "No position" : `Protects your ${long ? "long" : "short"} ${units(abs(held))} ${sym}`}</span><span className="hint" title="Each closes the whole position. When one fills, the others are removed.">closes the whole position</span></div>
        <label className="inp"><span>Take profit</span><input value={tp} onChange={digits(setTp)} placeholder={fmt(priceN * (long ? 1.05 : 0.95), dp)} inputMode="decimal" /><em>{pnl(t)}</em></label>
        <label className="inp"><span>Stop loss</span><input value={sl} onChange={digits(setSl)} placeholder={fmt(priceN * (long ? 0.95 : 1.05), dp)} inputMode="decimal" /><em>{pnl(s)}</em></label>
        <label className="inp"><span>Trailing stop</span><input value={trail} onChange={digits(setTrail)} placeholder="2.0" inputMode="decimal" /><em>% back from the best price</em></label>
        <button className="submit neutral" disabled={!!why || !!busy || !ready} onClick={place}>{busy ? `${busy}…` : count > 1 ? `Set ${count} orders` : "Set order"}</button>
        {why && <div className="why">{why}</div>}
        {!why && (slNow || tpNow) && <div className="why">{slNow ? "The price is already past this stop" : "The price has already reached this take-profit"}, so it is carried out right away.</div>}
        <p className="fine">When the oracle price reaches a level, the close is queued and fills at the next oracle price, which can differ a little from the level. A trailing stop follows the best price the market's mark has shown since you set it; the mark moves when the oracle price is posted on chain, not on every tick in between.</p>
      </div>
    );
  }

  const total = n(size), k = Math.floor(n(slices)), mins = n(minutes);
  const interval = k > 0 ? Math.round(mins * 60 / k) : 0;
  const why = need ?? (!free.length ? "All 8 order slots on this market are in use: cancel one first" : !total ? "Enter a size" : k < 2 || k > 500 ? "Between 2 and 500 slices" : interval < 10 ? "Slices must be at least 10 seconds apart: use fewer slices or a longer time" : undefined);
  return (
    <div className="sform">
      <label className="inp"><span>Total size</span><input value={size} onChange={digits(setSize)} placeholder="0.00" inputMode="decimal" /><em>{sym}</em></label>
      <div className="two">
        <label className="inp"><span>Slices</span><input value={slices} onChange={digits(setSlices)} inputMode="numeric" /></label>
        <label className="inp"><span>Over</span><input value={minutes} onChange={digits(setMinutes)} inputMode="decimal" /><em>min</em></label>
      </div>
      <label className="check"><input type="checkbox" checked={reduce} onChange={e => setReduce(e.target.checked)} />Reduce only</label>
      <div className="sum">
        <div><span>Each slice</span><b className="mono">{k >= 2 && total ? `${fmt(total / k, 4).replace(/\.?0+$/, "")} ${sym} (${money(total / k * priceN)})` : "—"}</b></div>
        <div><span>One slice every</span><b className="mono">{interval ? (interval >= 120 ? `${fmt(interval / 60, 1)} min` : `${interval} s`) : "—"}</b></div>
        <div><span>Total value</span><b className="mono">{money(total * priceN)}</b></div>
      </div>
      <button className={`submit ${side > 0n ? "up" : "down"}`} disabled={!!why || !!busy || !ready} onClick={() => publicKey && send(`TWAP ${side > 0n ? "buy" : "sell"} ${size} ${sym}`, [C.placeOrder(publicKey, v.key, { index: free[0], kind: C.ORDER.TWAP, reduceOnly: reduce, size: e6(total) * side, trigger: 0n, interval, slices: k })])}>
        {busy ? `${busy}…` : `Start TWAP ${side > 0n ? "buy" : "sell"}`}
      </button>
      {why && <div className="why">{why}</div>}
      <p className="fine">The order is split into equal slices. Each slice is a market order queued when it is due, so each fills at its own oracle price. A slice the vault cannot take in full leaves the rest for later slices. Margin is checked for each slice.</p>
    </div>
  );
}

function Pending({ r, sym, send, busy }: { r: C.RouterRequest; sym: string; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), 250); return () => clearInterval(id); }, []);
  const left = r.target - now;
  const done = Math.min(100, Math.max(0, (1 - left / C.ROUTER_DELAY_SECS) * 100));
  // Nobody filled it in time (the executor is down or far behind). Anyone may then remove it, so
  // the wallet does not have to wait for the executor to come back before it can trade again.
  // (A few seconds are allowed for the chain's clock running behind this one.)
  const expiresIn = r.target + C.ROUTER_GRACE_SECS - now;
  const late = expiresIn < -5;
  return (
    <div className="pending">
      <div className="pending-t">
        <b>{r.size === 0n ? `Close-out of ${sym}` : `${r.size > 0n ? "Long" : "Short"} ${units(abs(r.size))} ${sym}`}</b>
        <span className="mono">{left > 0 ? `price set in ${Math.ceil(left)} s` : late ? "not filled in time" : left > -20 ? "filling…" : `still waiting, expires in ${Math.max(1, Math.ceil(expiresIn))} s`}</span>
      </div>
      <div className="pending-bar"><i style={{ width: `${done}%` }} /></div>
      {late && <div className="fine">This order was not filled within {C.ROUTER_GRACE_SECS} s and has traded nothing. Remove it to place a new one.</div>}
      {late && publicKey && <button className="btn tiny" disabled={!!busy} onClick={() => send("Remove expired order", [C.expireRequest(publicKey, r)])}>Remove it</button>}
    </div>
  );
}

// ---------------------------------------------------------------- account

/** The invitation that brought this visitor, kept from the link (`?ref=<wallet>`) until it is confirmed. */
const invitedBy = (): PublicKey | undefined => {
  try {
    const q = new URLSearchParams(window.location.search).get("ref");
    if (q) localStorage.setItem("pv:ref", q);
    const r = localStorage.getItem("pv:ref");
    return r ? new PublicKey(r) : undefined;
  } catch { return undefined; }
};

/** A wallet's invitation link, and the one-time confirmation of who invited it. */
function Invite({ me, send, busy, tick }: { me: PublicKey; send: Send; busy?: string; tick: number }) {
  const { connection } = useConnection();
  const [by, setBy] = useState<PublicKey | null>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let on = true;
    connection.getAccountInfo(S.referralAddress(me)).then(a => on && setBy(a && a.data.length === S.REFERRAL_LEN ? S.decodeReferral(new Uint8Array(a.data)).referrer : null)).catch(() => undefined);
    return () => { on = false; };
  }, [connection, me.toBase58(), tick]);
  const offer = invitedBy();
  const link = `${window.location.origin}/?network=${C.NETWORK_PARAM}&ref=${me.toBase58()}`;
  return (
    <div className="fine">
      Invite traders: you earn {Math.round(S.REBATE.referrerShare * 100)}% of the trading fees they pay, paid weekly by the platform.{" "}
      <a href={link} onClick={e => { e.preventDefault(); navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "Copied" : "Copy your link"}</a>
      {by ? <> · Invited by <span className="mono">{short(by)}</span></>
        : by === null && offer && !offer.equals(me) && <> · <a href="#" onClick={e => { e.preventDefault(); if (!busy) send("Confirm invitation", [S.setReferrer(me, offer)]); }}>Confirm you were invited by <span className="mono">{short(offer)}</span></a> (once, it cannot be changed)</>}
    </div>
  );
}

function Account({ state, send, busy }: { state: C.State; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const [amount, setAmount] = useState("100");
  const p = state.portfolio, h = state.health;
  const atoms = BigInt(Math.max(0, Math.floor(Number(amount || 0) * C.USDC)));
  const locked = !!state.trader?.hasPending;
  // A gain is booked as profit first; with no position open it is turned into capital in the
  // same transaction as the withdrawal (Percolator wants the account looked at first: its own
  // crank), so winnings come out with the margin.
  const profit = p && p.pnl > 0n && state.openPositions === 0 ? p.pnl : 0n;
  const equity = h?.equity ?? p?.capital ?? 0n;
  const ratio = h && h.notional > 0n ? num(h.equity, 1e6) / num(h.notional, 1e6) : undefined;
  // How full the margin is: 0 with no position, 100 at the liquidation level (each position's own).
  const used = ratio === undefined || !h ? 0 : Math.min(100, Math.max(0, num(h.floor, 1e6) / Math.max(num(h.equity, 1e6), 1e-9) * 100));
  const ata = (u: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(u, C.ata(u, C.MINT), u, C.MINT);
  return (
    <>
      <div className="ph"><h3>Account{h && h.notional > 0n && <span className="lev mono">{fmt(num(h.notional, 1e6) / Math.max(num(h.equity, 1e6), 0.01), 1)}×</span>}</h3><Faucet compact /></div>
      {!publicKey ? <div className="quiet">Connect a wallet to see your account.</div> : (
        <div className="acct">
          <div className="acct-row"><span>Equity</span><b className="mono">{usd(equity)}</b></div>
          <div className="acct-row"><span>In positions</span><b className="mono">{usd(h?.notional ?? 0n)}</b></div>
          <div className="acct-row"><span>Wallet test USDC</span><b className="mono">{usd(state.userCollateral)}</b></div>
          <div className="health">
            <div className="health-l"><span>Margin health</span><b className={`mono ${used > 75 ? "down" : ""}`}>{ratio === undefined ? "no position" : `${fmt(ratio * 100, 1)}% · liquidated below ${fmt((h && h.notional > 0n ? num(h.floor, 1e6) / num(h.notional, 1e6) : 0) * 100, 1)}%`}</b></div>
            <div className="health-bar"><i className={used > 75 ? "bad" : ""} style={{ width: `${used}%` }} /></div>
          </div>
          {state.trader && (
            <>
              <div className="move">
                <label className="inp small"><span>USDC</span><input value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" /></label>
                <button className="btn" disabled={!!busy || atoms <= 0n || atoms > state.userCollateral} onClick={() => send("Add margin", [ata(publicKey), C.routerDeposit(publicKey, atoms)])}>Deposit</button>
                <button className="btn" disabled={!!busy || locked || state.openPositions > 0 || atoms <= 0n || atoms > (p?.capital ?? 0n) + profit} onClick={() => send("Withdraw margin", [ata(publicKey), ...(profit > 0n ? [C.crank(publicKey, C.routerPortfolio(publicKey), [state.vault.assetIndex]), C.routerConvertPnl(publicKey)] : []), C.routerWithdraw(publicKey, atoms)])}>Withdraw</button>
              </div>
              {locked ? <div className="fine">Withdrawals are paused while an order is queued.</div>
                : state.openPositions > 0 && <div className="fine">Margin can be withdrawn once no position is open on any market. Deposits always work.</div>}
              <Invite me={publicKey} send={send} busy={busy} tick={Math.floor(Number(state.slot) / 300)} />
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- positions, history, market

function Bottom({ state, markets, fills, entry, liq, send, busy, go }: {
  state: C.State; markets: Card[]; fills: ReturnType<typeof useFills>; entry?: number; liq?: number; send: Send; busy?: string; go: (to: string) => void;
}) {
  const { publicKey } = useWallet();
  const [tab, setTab] = useState<"positions" | "orders" | "history" | "market">("positions");
  const v = state.vault, sym = v.feed?.symbol ?? "";
  const positions = state.health?.positions ?? [];
  const byAsset = new Map(markets.filter(c => c.v.canonical || c.v.key.equals(v.key)).map(c => [c.v.assetIndex, c]));
  const locked = !!state.trader?.hasPending;
  const close = () => {
    const p = state.portfolio;
    if (!publicKey || !state.book || !p || p.position === 0n) return;
    // A close-only market has no counterparty for a close: the position is closed out instead.
    if (state.closeOnly) send("Close position", [C.requestClose(publicKey, publicKey, v.key)]);
    else send("Close position", [C.requestTrade(publicKey, v.key, -p.position)]);
  };
  const nav = C.navOf(state);
  return (
    <>
      <div className="ptabs wide">
        <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>Positions{positions.length ? <em>{positions.length}</em> : null}</button>
        <button className={tab === "orders" ? "on" : ""} onClick={() => setTab("orders")}>Open orders{state.orders.length ? <em>{state.orders.length}</em> : null}</button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>Trade history</button>
        <button className={tab === "market" ? "on" : ""} onClick={() => setTab("market")}>Market details</button>
      </div>
      <div className="bottom-body">
        {tab === "positions" && (!publicKey ? <div className="quiet">Connect a wallet to see your positions.</div> : positions.length === 0 ? <div className="quiet">No open positions.</div> : (
          <table className="tbl">
            <thead><tr><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Value</th><th className="r">Entry price</th><th className="r">Mark price</th><th className="r">PnL</th><th className="r">Liq. price</th><th /></tr></thead>
            <tbody>
              {positions.map(x => {
                const here = x.asset === v.assetIndex;
                const c = byAsset.get(x.asset), s = c?.v.feed?.symbol ?? `asset ${x.asset}`;
                const size = num(x.size, 1e6), mark = num(x.price, 1e6);
                const e = here ? entry : undefined;
                const pnl = e !== undefined ? (mark - e) * size : undefined;
                return (
                  <tr key={x.asset}>
                    <td><button className="link" onClick={() => c && go(c.v.canonical ? `/trade/${s}` : `/m/${c.v.key.toString()}`)}>{s}-PERP</button></td>
                    <td className={size > 0 ? "up" : "down"}>{size > 0 ? "Long" : "Short"}</td>
                    <td className="r mono">{units(abs(x.size))}</td>
                    <td className="r mono">{usd(x.notional)}</td>
                    <td className="r mono">{e !== undefined ? fmt(e, priceDp(mark)) : "—"}</td>
                    <td className="r mono">{fmt(mark, priceDp(mark))}</td>
                    <td className={`r mono ${pnl === undefined ? "" : pnl >= 0 ? "up" : "down"}`}>{pnl === undefined ? "—" : `${signedMoney(pnl)} (${pct(pnl / (Math.abs(size) * e! / 10), 1)})`}</td>
                    <td className="r mono">{here && liq ? fmt(liq, priceDp(mark)) : "—"}</td>
                    <td className="r">{here ? <button className="btn tiny" disabled={locked || !!busy} onClick={close}>Close</button> : <button className="btn tiny ghost" onClick={() => c && go(`/trade/${s}`)}>Open</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
        {tab === "orders" && (!publicKey ? <div className="quiet">Connect a wallet to see your orders.</div> : state.orders.length === 0 ? <div className="quiet">No open orders on {sym}-PERP. Limit, TP / SL, trailing stop and TWAP orders are placed from the order ticket.</div> : (
          <table className="tbl">
            <thead><tr><th>Market</th><th>Type</th><th>Side</th><th className="r">Size</th><th className="r">Trigger</th><th className="r">Mark price</th><th>Status</th><th /></tr></thead>
            <tbody>
              {state.orders.map(o => {
                const protective = o.kind <= C.ORDER.TRAIL;
                const buys = protective ? o.side < 0 : o.size > 0n;
                const mark = num(state.asset.price, 1e6), dpp = priceDp(mark);
                const trig = o.kind === C.ORDER.TRAIL ? `${fmt(Number(o.trigger) / 100, 2)}% from ${fmt(num(o.peak, 1e6), dpp)}`
                  : o.kind === C.ORDER.TWAP ? `${units(o.slice)} every ${o.interval >= 120 ? `${fmt(o.interval / 60, 1)} min` : `${o.interval} s`}`
                  : `${o.kind === C.ORDER.LIMIT ? (buys ? "≤ " : "≥ ") : ""}${fmt(num(o.trigger, 1e6), dpp)}`;
                return (
                  <tr key={o.index}>
                    <td>{sym}-PERP</td>
                    <td>{ORDER_NAME[o.kind]}{o.reduceOnly && !protective ? " · reduce only" : ""}</td>
                    <td className={buys ? "up" : "down"}>{buys ? "Buy" : "Sell"}</td>
                    <td className="r mono">{protective ? (o.size === 0n ? "whole position" : units(o.size)) : `${units(abs(o.size))} left`}</td>
                    <td className="r mono">{trig}</td>
                    <td className="r mono">{fmt(mark, dpp)}</td>
                    <td>{o.queued ? "queued: filling at the next price" : o.kind === C.ORDER.TWAP ? `next slice ${o.nextTime * 1000 <= Date.now() ? "due" : `in ${Math.max(1, Math.round((o.nextTime * 1000 - Date.now()) / 1000))} s`}` : "waiting"}</td>
                    <td className="r"><button className="btn tiny" disabled={o.queued || !!busy} title={o.queued ? "Its queued request has to fill or expire first" : undefined} onClick={() => publicKey && send(`Cancel ${ORDER_NAME[o.kind].toLowerCase()}`, [C.cancelOrder(publicKey, v.key, o.index)])}>Cancel</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
        {tab === "history" && (!publicKey ? <div className="quiet">Connect a wallet to see your trades.</div> : fills.length === 0 ? <div className="quiet">No trades on {sym}-PERP from this wallet yet.</div> : (
          <table className="tbl">
            <thead><tr><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Price</th><th className="r">Value</th><th className="r">Fee</th><th className="r">Transaction</th></tr></thead>
            <tbody>
              {[...fills].reverse().map(f => (
                <tr key={f.sig}>
                  <td>{sym}-PERP</td>
                  <td className={f.size > 0 ? "up" : "down"}>{f.size > 0 ? "Buy" : "Sell"}</td>
                  <td className="r mono">{fmt(Math.abs(f.size), 4).replace(/\.?0+$/, "")}</td>
                  <td className="r mono">{fmt(f.price, priceDp(f.price))}</td>
                  <td className="r mono">{money(Math.abs(f.size) * f.price)}</td>
                  <td className="r mono">{money(Math.abs(f.size) * f.price * C.feeBpsAt(f.slot) / 10_000)}</td>
                  <td className="r"><a href={explorer("tx", f.sig)} target="_blank" rel="noreferrer">{short(f.sig)}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {tab === "market" && (
          <div className="mkt">
            <div className="kv">
              <div><span>Leverage</span><b>up to {fmt(10_000 / Number(state.levels.open), 0)}×</b></div>
              <div><span>Trading fee</span><b>{C.TRADE_FEE_PCT} per trade</b></div>
              <div><span>Price</span><b>{C.X1 ? "exchange median, posted by the router's reporter" : "Pyth, verified on chain"}</b></div>
              <div><span>Fill</span><b>first oracle price {C.ROUTER_DELAY_SECS} s after the request</b></div>
              <div><span>Liquidation</span><b>below {fmt(Number(state.levels.liq) / 100, 1)}% margin</b></div>
              <div><span>Funding</span><b>none</b></div>
            </div>
            <div className="kv">
              <div><span>Vault liquidity</span><b>{usd(nav)}</b></div>
              <div><span>Vault position limit</span><b>{units(v.positionNavBps ? capUnits(nav, v.positionNavBps, state.asset.price) : v.maxInventory)} {sym} (3× liquidity)</b></div>
              <div><span>Largest new exposure per order</span><b>{units(v.positionNavBps ? capUnits(nav, v.fillNavBps, state.asset.price) : v.maxFill)} {sym}</b></div>
              <div><span>Fees earned</span><b>{usd(v.feesHarvested + state.asset.insurance)}</b></div>
              <div><span>Insurance kept for traders</span><b>{usd(v.insuranceFloor, 0)}</b></div>
              <div><span>Fills</span><b>{String(v.totalFills)}</b></div>
            </div>
            <div className="kv">
              <div><span>Vault</span><b><a href={explorer("address", v.key.toString())} target="_blank" rel="noreferrer">{short(v.key)}</a></b></div>
              {v.canonical && <div><span>Opened by</span><b><a href={explorer("address", v.creator.toString())} target="_blank" rel="noreferrer">{short(v.creator)}</a></b></div>}
              <div><span>Network</span><b>{C.NETWORK_NAME}</b></div>
              <div><span>Status</span><b>{state.closeOnly ? "close-only" : "open"}</b></div>
            </div>
            <OpenerPanel state={state} send={send} busy={busy} />
          </div>
        )}
      </div>
    </>
  );
}
