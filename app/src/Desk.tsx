// The trading desk: one market on one screen. Chart, what the vault can take, the order ticket,
// and the wallet's positions.
//
// There is no order book to show: every order fills against the market's vault at the first
// oracle price published a few seconds after the request. What stands in its place is the vault's
// capacity: how much it can take on each side right now.
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as C from "./chain";
import { T } from "./theme";
import Chart, { DayStats, useDayStats } from "./Chart";
import * as S from "./social";
import { Mark, marksFor, useBoard, useMe, usePictures } from "./Traders";
import { Crowd, Liquidations, PULSE, PULSE_BOARD_MS, Queue, Trades, Whale, marketFills } from "./Pulse";
import { Card, Faucet, Fill, Icon, LiquidityPanel, OpenerPanel, Send, ago, capUnits, entryPrice, explorer, fmt, num, priceDp, px, realizedPnl, short, units, usd, useActivity, useCards, useVault, useWalletFills } from "./shared";

const UP = T.green, DOWN = T.red;
const pct = (x: number, dp = 2) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, dp)}%`;
const money = (x: number, dp = 2) => `$${fmt(x, dp)}`;
const signedMoney = (x: number) => `${x >= 0 ? "+" : "−"}$${fmt(Math.abs(x))}`;
/** An up or down arrow for a gain or a loss. */
const arrow = (x: number) => (x > 0 ? "▲" : x < 0 ? "▼" : "•");

/** One open position with what it is up or down: entry from the wallet's fills on record (its
 *  transaction history, else the last fills its track record keeps), PnL against the mark. */
export type Held = { asset: number; sym: string; size: number; mark: number; value: number; entry?: number; pnl?: number; ret?: number };
function heldPositions(state: C.State, markets: Card[], fills: Fill[], row: S.TraderRow | undefined): Held[] {
  return (state.health?.positions ?? []).map(x => {
    const c = markets.find(m => m.v.assetIndex === x.asset && (m.v.canonical || m.v.key.equals(state.vault.key)));
    const sym = c?.v.feed?.symbol ?? `asset ${x.asset}`;
    const size = num(x.size, 1e6), mark = num(x.price, 1e6);
    const mine = c ? fills.filter(f => f.vault === c.v.key.toBase58()) : [];
    const recent: Fill[] = (row?.stats?.fills ?? []).filter(f => f.asset === x.asset).map(f => ({ sig: "", slot: f.time, vault: "", size: f.size, price: f.price }));
    const entry = entryPrice(mine, size) ?? entryPrice(recent, size);
    const pnl = entry !== undefined ? (mark - entry) * size : undefined;
    return { asset: x.asset, sym, size, mark, value: num(x.notional, 1e6), entry, pnl, ret: pnl !== undefined && entry ? pnl / (Math.abs(size) * entry) : undefined };
  });
}
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
  const allFills = useWalletFills(publicKey, state?.portfolio?.position ?? 0n);
  const fills = useMemo(() => allFills.filter(f => f.vault === vaultKey.toBase58()), [allFills, vaultKey.toBase58()]);
  // The traders this wallet follows or copies: their fills on this market are marked on the chart.
  const { board } = useBoard(tick, Object.values(PULSE).some(Boolean) ? PULSE_BOARD_MS : undefined);
  const me = useMe(board, tick);
  const leaders = useMemo(() => [...new Set([...me.following, ...(me.copy ? [me.copy.leader.toBase58()] : [])])].sort(), [me]);
  const asset = state?.vault.assetIndex ?? -1;
  // (Badge pictures are checked and loaded a moment after the board arrives: the marks follow.)
  const pictures = usePictures();
  const marks = useMemo(() => marksFor(board, leaders, asset), [board, leaders.join(","), asset, pictures]);
  // Every fill on this market by anyone: the trades list, the queue's fills and the chart's whales.
  const marketTrades = useMemo(() => marketFills(board, asset), [board, asset]);

  if (err && !state) return <div className="desk-msg">{err}</div>;
  if (!state) return <div className="desk-msg">Loading market…</div>;

  const v = state.vault, sym = v.feed?.symbol ?? "?";
  const price = num(state.asset.price, 1e6);
  const posN = num(state.portfolio?.position ?? 0n, 1e6);
  const myRow = publicKey ? board?.rows.find(r => r.wallet === publicKey.toBase58()) : undefined;
  const held = heldPositions(state, markets, allFills, myRow);
  const here = held.find(h => h.asset === v.assetIndex);
  const entry = here?.entry;
  const liq = liquidationPrice(state, posN);
  // The position's line on a chart: market, side, size and what it is up or down.
  const posLine = (h: Held) => ({
    price: h.entry!,
    title: `${arrow(h.pnl ?? 0)} ${h.sym} ${h.size > 0 ? "LONG" : "SHORT"} ${fmt(Math.abs(h.size), 4).replace(/\.?0+$/, "")} · ${h.pnl === undefined ? "" : `${signedMoney(h.pnl)} (${pct(h.ret ?? 0)})`}`,
    color: (h.pnl ?? 0) >= 0 ? UP : DOWN,
  });
  const linesOf = (s: string) => held.filter(h => h.sym === s && h.entry).map(posLine);
  const lines = [
    ...(here?.entry ? [posLine(here)] : []),
    ...(liq ? [{ price: liq, title: "Liq.", color: DOWN }] : []),
    ...state.orders.filter(o => o.kind !== C.ORDER.TWAP).map(o => o.kind === C.ORDER.TRAIL
      ? { price: num(o.peak, 1e6) * (1 - o.side * Number(o.trigger) / 10_000), title: "Trail", color: DOWN }
      : { price: num(o.trigger, 1e6), title: o.kind === C.ORDER.STOP ? "SL" : o.kind === C.ORDER.TAKE ? "TP" : o.size > 0n ? "Buy" : "Sell", color: o.kind === C.ORDER.STOP ? DOWN : o.kind === C.ORDER.TAKE ? UP : T.textSecondary }),
  ];

  return (
    <main className="desk">
      <MarketBar state={state} markets={markets} day={day} go={go} />
      <section className="desk-chart panel"><Charts sym={sym} price={price} lines={lines} linesOf={linesOf} marks={marks} whales={PULSE.whales ? marketTrades : undefined} markets={markets} go={go} /></section>
      <section className="desk-book panel"><VaultDepth state={state} tick={tick} board={board} fills={marketTrades} go={go} /></section>
      {PULSE.liqs && <Liquidations board={board} markets={markets} go={go} />}
      <section className="desk-ticket panel">
        <div className="ptabs">
          <button className={panel === "trade" ? "on" : ""} onClick={() => setPanel("trade")}>Trade</button>
          <button className={panel === "earn" ? "on" : ""} onClick={() => setPanel("earn")}>Earn</button>
        </div>
        {panel === "trade" ? <Ticket state={state} send={wrapped} busy={busy} /> : <div className="earn"><LiquidityPanel state={state} send={wrapped} busy={busy} /></div>}
        <div className="ticket-acct"><Account state={state} send={wrapped} busy={busy} held={held} row={myRow} /></div>
      </section>
      <section className="desk-bottom panel"><Bottom state={state} markets={markets} fills={allFills} held={held} liq={liq} send={wrapped} busy={busy} go={go} /></section>
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
function Charts({ sym, price, lines, linesOf, marks, whales, markets, go }: { sym: string; price: number; lines: { price: number; title: string; color: string }[]; linesOf: (sym: string) => { price: number; title: string; color: string }[]; marks: Mark[]; whales?: Whale[]; markets: Card[]; go: (to: string) => void }) {
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
      <Chart symbol={sym} price={price} lines={lines} marks={marks} whales={whales} dense={n > 1} head={<>{picker}{n > 1 && <div className="pane-sym main"><b>{sym}</b></div>}</>} />
      {Array.from({ length: n - 1 }, (_, k) => {
        const i = k + 1, s = paneSym(i);
        return (
          <Chart key={i} slot={i} compact dense symbol={s} price={priceOf(s)} lines={linesOf(s)} head={
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
        <FundingCell state={state} />
        <Cell label={`Liquidity epoch ${v.epoch}`} value={left > 0n ? `${Math.max(1, Math.ceil(Number(left) * C.slotSeconds() / 60))} min left` : v.pendingDeposit > 0n || v.pendingWithdraw > 0n ? "settling" : "no requests"} />
      </div>
    </header>
  );
}

/** Funding: who pays now, how much an hour, and where the rate is heading. The crowded side pays
 *  the other (the vault included, which holds the opposite side), every slot, inside Percolator. */
function FundingCell({ state }: { state: C.State }) {
  const f = state.funding, v = state.vault;
  if (f.capE9 === 0n) return <Cell label="Funding" value="off" sub="switched off on every market for now (see Docs)" />;
  const perHour = C.fundingPerHour(f.rateE9);
  const price = state.asset.price;
  const limit = price > 0n ? C.liveNav(state) * BigInt(C.tierPositionBps(C.tierOfFeed(v.feedHex))) / 10_000n * C.UNIT / price : 0n;
  const target = C.fundingTarget(v.inventory, limit);
  const who = f.rateE9 > 0n ? "longs pay" : f.rateE9 < 0n ? "shorts pay" : "nobody pays";
  const heading = target === f.rateE9 ? "" : ` · heading to ${fmt(Math.abs(C.fundingPerHour(target)) * 100, 4)}%/h${target === 0n ? "" : target > 0n ? " (longs)" : " (shorts)"}`;
  return (
    <div className="cell" title={`Paid every slot by the side the market is crowded on, to the other side (the vault holds the other side of every trade). It follows how full the vault is on one side: nothing under ${(Number((L_FUNDING.free ?? 2000)) / 100)}% of its limit, up to ${fmt(C.fundingPerHour(BigInt(L_FUNDING.max ?? 30)) * 100, 3)}% an hour at the whole limit, and it moves there over about an hour, so one trade cannot set it. It is part of every position's value, so it counts toward margin and liquidation.`}>
      <div className="cell-l">Funding</div>
      <div className={`cell-v mono ${f.rateE9 === 0n ? "" : "down"}`}>{f.rateE9 === 0n ? "0%" : `${fmt(Math.abs(perHour) * 100, 4)}%/h`}<span className="cell-s">{who}, every slot{heading}</span></div>
    </div>
  );
}
const L_FUNDING = { free: (C.LAYOUT.router as any).funding_free_bps as number | undefined, max: (C.LAYOUT.router as any).funding_max_e9 as number | undefined };

function Cell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="cell">
      <div className="cell-l">{label}</div>
      <div className={`cell-v mono ${tone ?? ""}`}>{value}{sub && <span className="cell-s">{sub}</span>}</div>
    </div>
  );
}

// ---------------------------------------------------------------- vault capacity and tape

/** The vault's side of the market (in the bottom panel's "Vault capacity" tab): the largest
 *  orders it takes each way now, where its position sits between its limits, and what it can absorb. */
function VaultCapacity({ state }: { state: C.State }) {
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
  return (
    <div className="vcap">
      <div className="depth">
        <div className="vcap-h"><b>Largest order now</b><span className="hint" title="Every order fills against this market's vault at the oracle price, so there is no order book. These are the largest orders the vault takes right now.">no order book</span></div>
        <div className="depth-head"><span>Side</span><span>Size ({sym})</span><span>Value</span></div>
        <div className="depth-row up"><i style={{ width: `${bar(room.long)}%` }} /><span>Buy / long</span><span className="mono">{units(room.long)}</span><span className="mono">{val(room.long)}</span></div>
        <div className="depth-mid mono">{fmt(price, priceDp(price))}<span>oracle price · same both ways</span></div>
        <div className="depth-row down"><i style={{ width: `${bar(room.short)}%` }} /><span>Sell / short</span><span className="mono">{units(room.short)}</span><span className="mono">{val(room.short)}</span></div>
      </div>
      <div className="vcap-side">
      <div className="skew">
        <div className="skew-l"><span>Vault position</span><b className="mono">{v.inventory === 0n ? "flat" : `${v.inventory > 0n ? "long" : "short"} ${units(abs(v.inventory))} ${sym}`}</b></div>
        <div className="skew-track"><i style={{ left: `${at}%` }} /><em /></div>
        <div className="skew-ends mono"><span>−{units(limit)}</span><span title={`Its limit is ${v.positionNavBps ? fmt(Number(v.positionNavBps) / 10_000, 2).replace(/\.?0+$/, "") : "3"}× the vault's liquidity (3× for BTC and ETH, 1× for the rest). Near 100% used, it only takes trades that bring it back.`}>{PULSE.crowd && limit > 0n ? `${fmt(Math.min(100, Number(abs(v.inventory) * 1000n / limit) / 10), 1)}% of limit used` : `limit ${v.positionNavBps ? fmt(Number(v.positionNavBps) / 10_000, 2).replace(/\.?0+$/, "") : "3"}× liquidity`}</span><span>+{units(limit)}</span></div>
      </div>
      <Stress state={state} />
      </div>
    </div>
  );
}

/** The middle column: the long/short crowd, the queue, and the trades tape. */
function VaultDepth({ state, tick, board, fills, go }: { state: C.State; tick: number; board?: S.Board; fills: Whale[]; go: (to: string) => void }) {
  const v = state.vault, sym = v.feed?.symbol ?? "";
  const rows = useActivity(v, tick);
  const [list, setList] = useState<"trades" | "vault">(PULSE.tape ? "trades" : "vault");
  return (
    <>
      {PULSE.crowd && <Crowd state={state} board={board} />}
      {PULSE.queue && <Queue state={state} fills={fills} board={board} go={go} />}
      {PULSE.tape ? (
        <div className="ph tape-h tape-tabs">
          <button className={list === "trades" ? "on" : ""} onClick={() => setList("trades")}>Trades</button>
          <button className={list === "vault" ? "on" : ""} onClick={() => setList("vault")}>Vault events</button>
        </div>
      ) : <div className="ph tape-h"><h3>Market activity</h3></div>}
      <div className="tape">
        {list === "trades" ? <Trades fills={fills} board={board} sym={sym} go={go} /> : !rows ? <div className="quiet">Loading…</div> : rows.length === 0 ? <div className="quiet">No activity yet.</div> : rows.map(r => (
          <a key={r.sig} className="tape-row" href={explorer("tx", r.sig)} target="_blank" rel="noreferrer">
            <span className={/^Long/.test(r.what) ? "up" : /^Short/.test(r.what) ? "down" : ""}>{r.what.replace(" vs vault", "")}</span>
            <span className="mono">{r.when ? ago(Date.now() / 1000 - r.when) : ""}</span>
          </a>
        ))}
      </div>
    </>
  );
}

/** What the vault can actually absorb, next to what it lets traders open: its value now, its
 *  insurance, and what it would lose on a move of 10, 20 or 30% against the position it holds. */
function Stress({ state }: { state: C.State }) {
  const v = state.vault;
  const value = num(C.liveNav(state), 1e6), insurance = num(v.insuranceFloor, 1e6);
  const moves = [0.1, 0.2, 0.3];
  // A long vault loses when the price falls, a short one when it rises.
  const loss = (m: number) => Math.abs(C.stress(state, m));
  const tier = C.tierOfFeed(v.feedHex);
  return (
    <div className="stress" title={`The vault's value now (its money in Percolator plus its cash), and what it would lose if the price moved against the position it holds now. Its insurance pays traders' bad debt first. This market's tier: ${C.TIER_NAME[tier]} (the vault holds at most ${C.tierPositionBps(tier) / 10_000}x its value).`}>
      <div className="stress-l"><span>Can absorb</span><b className="mono">{money(value, 0)}<em> + {money(insurance, 0)} insurance</em></b></div>
      <div className="stress-l"><span>Loss on a move against it</span><b className="mono">{v.inventory === 0n ? "none (flat)" : moves.map(m => `${m * 100}%: ${money(loss(m), 0)}`).join(" · ")}</b></div>
      {v.inventory !== 0n && value > 0 && loss(0.3) >= value * 0.5 && <div className="stress-warn">A 30% move would cost the vault {fmt(loss(0.3) / value * 100, 0)}% of its value.</div>}
    </div>
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
  // An order that only shrinks the trader's own position may use the vault's whole limit (the
  // last 20% is kept for such closes and for liquidations); anything else uses 80% of it.
  const shrinks = held !== 0n && (held > 0n) !== (side > 0n) && want <= abs(held);
  const closeRoom = shrinks ? C.depth(state, held, true) : room;
  const vaultMax = side > 0n ? closeRoom.long : closeRoom.short;
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

  // Leverage is chosen per order, as on other exchanges: the order's value is the margin you put
  // behind it times the leverage. Percolator itself only asks for the market's opening margin
  // (5% on BTC and ETH: 20×), so a lower leverage just means using less of what the account could
  // open. One margin account covers every market: the liquidation price shown is the account's.
  const openRate = Number(state.levels.open) / 10_000, maxLev = Math.max(1, Math.floor(1 / openRate));
  const savedLev = () => { let x = 0; try { x = Number(localStorage.getItem(`pv:lev:${sym}`)); } catch { /* storage unavailable */ } return x >= 1 ? x : Math.min(5, maxLev); };
  const [share, setShareState] = useState<number>(); // the last quick share chosen, re-applied when the leverage changes
  const [levPick, setLevPick] = useState<number>(savedLev);
  useEffect(() => { setLevPick(savedLev()); setShareState(undefined); }, [sym]);
  const lev = Math.min(Math.max(1, Math.round(levPick)), maxLev);
  const sameSide = held === 0n || (held > 0n) === (side > 0n);
  const reduces = !sameSide; // an order against the position shrinks it first
  // Margin free for new positions, in dollars: what the margin rule leaves at the market's maximum leverage.
  const newRoom = sameSide ? (cap > abs(held) ? cap - abs(held) : 0n) : cap;
  const freeMargin = num(newRoom, 1e6) * priceN * openRate;
  const orderMargin = notional / lev;
  const h = state.health;
  const equityN = num(h?.equity ?? p?.capital ?? 0n, 1e6);
  const otherN = num(h?.notional ?? 0n, 1e6) - num(abs(held), 1e6) * priceN;
  const levOf = (posUnits: number) => (equityN > 0 ? (Math.abs(posUnits) * priceN + otherN) / equityN : 0);
  const levNow = levOf(num(held, 1e6)), levAfter = levOf(after);
  const sizeFor = (f: number, l: number) => (reduces ? num(abs(held), 1e6) * f : Math.min(num(most, 1e6), freeMargin * f * l / Math.max(priceN, 1e-12)));
  const setShare = (f: number) => {
    setShareState(f);
    const q = sizeFor(f, lev);
    setUnit("coin");
    setText(q > 0 ? String(+q.toFixed(6)) : "");
  };
  const chooseLev = (x: number) => {
    const l = Math.min(Math.max(1, Math.round(x)), maxLev);
    setLevPick(l);
    try { localStorage.setItem(`pv:lev:${sym}`, String(l)); } catch { /* storage unavailable */ }
    if (share !== undefined && !reduces) { const q = sizeFor(share, l); setUnit("coin"); setText(q > 0 ? String(+q.toFixed(6)) : ""); }
  };
  // An opening order whose margin at the chosen leverage is more than the account has free.
  const overLev = !reduces && want > 0n && !shrinks && orderMargin > freeMargin * 1.0001 && lev < maxLev;

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
    : overLev ? `At ${lev}× this order needs ${money(orderMargin)} of margin and ${money(freeMargin)} is free: raise the leverage or lower the size`
    : coins !== undefined && coins < coinsNeeded ? `This order needs ${(coinsNeeded / 1e9).toFixed(3)} ${C.COIN} in your wallet for its deposit and bond (they come back when it fills); the wallet has ${(coins / 1e9).toFixed(3)}`
    : undefined;

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
        <input value={text} onChange={e => { setShareState(undefined); setText(e.target.value.replace(/[^0-9.]/g, "")); }} placeholder="0.00" inputMode="decimal" />
        <button className="unit" onClick={() => { setText(typed > 0 && priceN > 0 ? String(unit === "coin" ? +(typed * priceN).toFixed(2) : +(typed / priceN).toFixed(6)) : ""); setUnit(unit === "coin" ? "usd" : "coin"); }} title="Switch between the asset and dollars">{unit === "coin" ? sym : "USD"}</button>
      </label>
      {state.trader && !reduces && (
        <div className="lev">
          <div className="lev-l">
            <span className="hint" title={`How many times the margin you put behind this order it is worth. ${maxLev}× is the most this market allows. A lower leverage uses less of your free margin for the same size: the quick buttons size the order from your free margin times this leverage.`}>Leverage</span>
            <b className="mono">{lev}×<i>max {maxLev}×</i></b>
          </div>
          <div className="lev-track" style={{ "--fill": `${maxLev > 1 ? (lev - 1) / (maxLev - 1) * 100 : 100}%`, "--now": "0%" } as CSSProperties}>
            <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={e => chooseLev(Number(e.target.value))} className={side > 0n ? "up" : "down"} aria-label="Leverage" />
            <div className="lev-ticks abs mono">{[...new Set((maxLev >= 20 ? [1, 5, 10, maxLev] : [1, 2, 5, maxLev]).filter(x => x <= maxLev))].map(x => <button key={x} type="button" className={x === lev ? "on" : ""} style={{ left: `${maxLev > 1 ? (x - 1) / (maxLev - 1) * 100 : 0}%` }} onClick={() => chooseLev(x)}>{x}×</button>)}</div>
          </div>
        </div>
      )}
      <div className="quick">
        {[0.25, 0.5, 0.75, 1].map(f => <button key={f} disabled={reduces ? held === 0n : most === 0n} onClick={() => setShare(f)} title={reduces ? `${f * 100}% of your ${held > 0n ? "long" : "short"}` : `${f * 100}% of your free margin (${money(freeMargin)}) at ${lev}×`}>{f === 1 ? (reduces ? "Close" : "Max") : `${f * 100}%`}</button>)}
      </div>
      {state.trader && reduces && <div className="fine">You hold a {held > 0n ? "long" : "short"} of {units(abs(held))} {sym}: this {side > 0n ? "buy" : "sell"} reduces it first. The buttons pick a share of the position.</div>}

      <div className="sum">
        <div><span>Order value</span><b className="mono">{money(notional)}</b></div>
        {!reduces && <div title={`The order's value divided by your leverage (${lev}×), out of ${money(freeMargin)} of free margin`}><span>Margin for this order ({lev}×)</span><b className={`mono ${overLev ? "down" : ""}`}>{money(orderMargin)}<i className="muted"> of {money(freeMargin)} free</i></b></div>}
        {state.trader && <div title="What all your positions are worth divided by your equity, now and after this order (one account covers every market)"><span>Account leverage</span><b className="mono">{want > 0n ? `${fmt(levNow, 1)}× → ${fmt(levAfter, 1)}×` : `${fmt(levNow, 1)}×`}</b></div>}
        <div><span>Fee ({C.TRADE_FEE_PCT})</span><b className="mono">{money(notional * C.TRADE_FEE_BPS / 10_000)}</b></div>
        <div><span>Position after</span><b className="mono">{after === 0 ? "flat" : `${after > 0 ? "long" : "short"} ${fmt(Math.abs(after), 4).replace(/\.?0+$/, "")} ${sym}`}</b></div>
        <div><span>Est. liquidation price</span><b className="mono">{liqAfter && want > 0n ? fmt(liqAfter, dp) : "—"}</b></div>
        {state.funding.capE9 > 0n && (() => {
          // What the position after this order pays (or receives) in funding a day, at today's rate.
          const day = C.fundingCostPerHour(state.funding.rateE9, after, Math.abs(after) * num(state.asset.price, 1e6)) * 24;
          return <div title="At the current rate, which follows how one-sided the market is and can change"><span>Funding a day (est.)</span><b className={`mono ${day > 0 ? "down" : day < 0 ? "up" : ""}`}>{after === 0 || day === 0 ? "—" : `${day > 0 ? "you pay " : "you receive "}${money(Math.abs(day), 2)}`}</b></div>;
        })()}
        <div><span>Largest order now</span><b className="mono">{state.trader ? `${units(most)} ${sym}` : `${units(vaultMax)} ${sym}`}</b></div>
      </div>

      <div className="ticket-go">
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
      </div>
      {!blocker && want > vaultMax && <div className="why">The vault takes {units(vaultMax)} {sym} on this side right now, so the order is cut to that.</div>}
      {!state.trader && publicKey && mine && <div className="why">One account covers every market. It belongs to a program address derived from your wallet: only the router can trade it, and withdrawals only go back to this wallet. About 0.07 test {C.COIN} of rent.</div>}

      </>}
      {pendingHere && <Pending r={pendingHere} sym={sym} send={send} busy={busy} />}
      {!pendingHere && outcome && <div className="outcome" onClick={() => setOutcome(undefined)}>{outcome}</div>}
      <p className="fine">
        Orders fill at the first oracle price published at least {C.ROUTER_DELAY_SECS} seconds after the request lands, on the next {C.ROUTER_BATCH_SECS}-second mark (orders sent close together share that price). Nobody can know that price
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

function Account({ state, send, busy, held, row }: { state: C.State; send: Send; busy?: string; held: Held[]; row?: S.TraderRow }) {
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
          {(() => {
            // What the open positions are up or down now, today's result and the account's whole
            // record (equity against everything paid in and out: fees and closed trades included).
            const open = held.filter(x => x.pnl !== undefined), unknown = held.length - open.length;
            const upNow = open.reduce((t, x) => t + x.pnl!, 0);
            const today = row?.days.length && row.days[row.days.length - 1].day === Math.floor(Date.now() / 86_400_000) ? row.days[row.days.length - 1].pnl : undefined;
            const big = (x: number) => <b className={`mono pnl ${x > 0 ? "up" : x < 0 ? "down" : ""}`}>{arrow(x)} {signedMoney(x)}</b>;
            return (
              <>
                {held.length > 0 && <div className="acct-row" title={unknown ? `${unknown} position(s) without a known entry price are left out` : "Against the average entry price of each open position, before fees"}><span>Open PnL{unknown ? " *" : ""}</span>{big(upNow)}</div>}
                {today !== undefined && <div className="acct-row" title="Today's change in equity (UTC day), from the account's track record"><span>Today</span>{big(today)}</div>}
                {row?.stats && <div className="acct-row" title={`Equity now minus everything deposited, plus everything withdrawn, since ${new Date(row.stats.startTime * 1000).toLocaleDateString()}: closed and open trades, after fees`}><span>All-time PnL</span>{big(row.pnl)}</div>}
              </>
            );
          })()}
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
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- positions, history, market

function Bottom({ state, markets, fills, held, liq, send, busy, go }: {
  state: C.State; markets: Card[]; fills: Fill[]; held: Held[]; liq?: number; send: Send; busy?: string; go: (to: string) => void;
}) {
  const { publicKey } = useWallet();
  const [tab, setTab] = useState<"positions" | "orders" | "history" | "vault" | "market">("positions");
  const v = state.vault, sym = v.feed?.symbol ?? "";
  const positions = held;
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
        <button className={tab === "vault" ? "on" : ""} onClick={() => setTab("vault")}>Vault capacity</button>
        <button className={tab === "market" ? "on" : ""} onClick={() => setTab("market")}>Market details</button>
      </div>
      <div className="bottom-body">
        {tab === "positions" && (!publicKey ? <div className="quiet">Connect a wallet to see your positions.</div> : positions.length === 0 ? <div className="quiet">No open positions.</div> : (
          <table className="tbl">
            <thead><tr><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Value</th><th className="r">Entry price</th><th className="r">Mark price</th><th className="r">PnL</th><th className="r">Liq. price</th><th /></tr></thead>
            <tbody>
              {positions.map(x => {
                const here = x.asset === v.assetIndex;
                const c = byAsset.get(x.asset), s = x.sym;
                const { size, mark, entry: e, pnl } = x;
                return (
                  <tr key={x.asset} className={here ? "here" : ""}>
                    <td><button className="link" onClick={() => c && go(c.v.canonical ? `/trade/${s}` : `/m/${c.v.key.toString()}`)}>{s}-PERP</button></td>
                    <td className={size > 0 ? "up" : "down"}>{size > 0 ? "Long" : "Short"}</td>
                    <td className="r mono">{fmt(Math.abs(size), 4).replace(/\.?0+$/, "")} {s}</td>
                    <td className="r mono">{money(x.value)}</td>
                    <td className="r mono">{e !== undefined ? fmt(e, priceDp(mark)) : "—"}</td>
                    <td className="r mono">{fmt(mark, priceDp(mark))}</td>
                    <td className={`r mono pnl ${pnl === undefined ? "" : pnl >= 0 ? "up" : "down"}`} title={pnl === undefined ? "The entry price is not known: this wallet's earlier fills on this market are not on record" : "Against the average entry price, before fees; the percentage is the price move in your favour"}>{pnl === undefined ? "—" : <>{arrow(pnl)} {signedMoney(pnl)} <i>({pct(x.ret ?? 0)})</i></>}</td>
                    <td className="r mono">{here && liq ? fmt(liq, priceDp(mark)) : "—"}</td>
                    <td className="r">{here ? <button className="btn tiny" disabled={locked || !!busy} onClick={close}>Close</button> : <button className="btn tiny ghost" onClick={() => c && go(`/trade/${s}`)}>Open</button>}</td>
                  </tr>
                );
              })}
              {positions.length > 1 && (() => {
                const known = positions.filter(x => x.pnl !== undefined), total = known.reduce((t, x) => t + x.pnl!, 0);
                return <tr className="total"><td colSpan={3}>Total</td><td className="r mono">{money(positions.reduce((t, x) => t + x.value, 0))}</td><td colSpan={2} /><td className={`r mono pnl ${total >= 0 ? "up" : "down"}`}>{known.length ? <>{arrow(total)} {signedMoney(total)}</> : "—"}</td><td colSpan={2} /></tr>;
              })()}
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
        {tab === "history" && (!publicKey ? <div className="quiet">Connect a wallet to see your trades.</div> : fills.length === 0 ? <div className="quiet">No trades from this wallet on record yet.</div> : (() => {
          const symOf = (vault: string) => markets.find(c => c.v.key.toBase58() === vault)?.v.feed?.symbol ?? "?";
          // Positions now, by vault: the history is worked out backwards from them.
          const now = new Map(held.flatMap(x => { const c = byAsset.get(x.asset); return c ? [[c.v.key.toBase58(), x.size] as [string, number]] : []; }));
          const rows = realizedPnl(fills, now);
          const fee = (f: Fill) => Math.abs(f.size) * f.price * C.feeBpsAt(f.slot) / 10_000;
          const booked = rows.reduce((t, f) => t + f.realized, 0), fees = rows.reduce((t, f) => t + fee(f), 0);
          return (
            <>
              <div className="hist-sum">
                <span title="Only trades whose position is known from flat are counted: older fills of this wallet may not be on record">Closed PnL on {rows.filter(f => f.known).length} of these {rows.length} trades</span><b className={`mono pnl ${booked >= 0 ? "up" : "down"}`}>{arrow(booked)} {signedMoney(booked)}</b>
                <span>fees</span><b className="mono">{money(fees)}</b>
                <span>after fees</span><b className={`mono pnl ${booked - fees >= 0 ? "up" : "down"}`}>{signedMoney(booked - fees)}</b>
              </div>
              <table className="tbl">
                <thead><tr><th>Time</th><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Price</th><th className="r">Value</th><th className="r">Fee</th><th className="r" title="What the trade booked when it reduced or closed a position: (price - average entry) x size closed, before fees">Closed PnL</th><th className="r">Transaction</th></tr></thead>
                <tbody>
                  {[...rows].reverse().map(f => (
                    <tr key={f.sig}>
                      <td className="mono muted">{ago(Math.max(0, (Number(state.slot) - f.slot) * C.slotSeconds()))}</td>
                      <td>{symOf(f.vault)}-PERP</td>
                      <td className={f.size > 0 ? "up" : "down"}>{f.size > 0 ? "Buy" : "Sell"}</td>
                      <td className="r mono">{fmt(Math.abs(f.size), 4).replace(/\.?0+$/, "")}</td>
                      <td className="r mono">{fmt(f.price, priceDp(f.price))}</td>
                      <td className="r mono">{money(Math.abs(f.size) * f.price)}</td>
                      <td className="r mono">{money(fee(f))}</td>
                      <td className={`r mono pnl ${f.realized > 0 ? "up" : f.realized < 0 ? "down" : "muted"}`}>{f.realized !== 0 ? <>{arrow(f.realized)} {signedMoney(f.realized)}</> : f.known ? "opened" : "—"}</td>
                      <td className="r"><a href={explorer("tx", f.sig)} target="_blank" rel="noreferrer">{short(f.sig)}</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          );
        })())}
        {tab === "vault" && <VaultCapacity state={state} />}
        {tab === "market" && (
          <div className="mkt">
            <div className="kv">
              <div><span>Leverage</span><b>up to {fmt(10_000 / Number(state.levels.open), 0)}×</b></div>
              <div><span>Trading fee</span><b>{C.TRADE_FEE_PCT} per trade</b></div>
              <div><span>Price</span><b>{C.X1 ? "exchange median, posted by the router's reporter" : "Pyth, verified on chain"}</b></div>
              <div><span>Fill</span><b>first oracle price {C.ROUTER_DELAY_SECS}–{C.ROUTER_DELAY_SECS + C.ROUTER_BATCH_SECS - 1} s after the request</b></div>
              <div><span>Liquidation</span><b>below {fmt(Number(state.levels.liq) / 100, 1)}% margin</b></div>
              <div><span>Funding</span><b>{state.funding.capE9 > 0n ? `${fmt(Math.abs(C.fundingPerHour(state.funding.rateE9)) * 100, 4)}%/h now, ${state.funding.rateE9 > 0n ? "longs pay" : state.funding.rateE9 < 0n ? "shorts pay" : "nobody pays"}; up to ${fmt(C.fundingPerHour(BigInt(L_FUNDING.max ?? 30)) * 100, 3)}%/h, by how one-sided the vault is` : "off on this market"}</b></div>
            </div>
            <div className="kv">
              <div><span>Vault liquidity</span><b>{usd(nav)}</b></div>
              <div><span>Vault position limit</span><b>{units(v.positionNavBps ? capUnits(nav, v.positionNavBps, state.asset.price) : v.maxInventory)} {sym}{v.positionNavBps ? ` (${fmt(Number(v.positionNavBps) / 10_000, 2).replace(/\.?0+$/, "")}× liquidity)` : ""}</b></div>
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
