// The trading desk: one market on one screen. Chart, what the vault can take, the order ticket,
// and the wallet's positions.
//
// There is no order book to show: every order fills against the market's vault at the first
// oracle price published a few seconds after the request. What stands in its place is the vault's
// capacity: how much it can take on each side right now.
import { CSSProperties, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { OneClickPanel, SetupCard, useTradingKey } from "./OneClick";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as C from "./chain";
import { readDirect } from "./view";
import { T } from "./theme";
import Chart, { DayStats, HeatLevel, Trade, useDayStats } from "./Chart";
import * as S from "./social";
import { Mark, marksFor, useBoard, useMe, useNotes, usePictures } from "./Traders";
import { Liquidations, PULSE, PULSE_BOARD_MS, Whale, marketFills, useVolume } from "./Pulse";
import { WidgetPanel, liqLevels } from "./Widgets";
import { CloseSlider } from "./PositionTools";
import { AcctView, Card, Faucet, Fill, Icon, LiquidityPanel, OpenerPanel, Send, ago, capUnits, entryPrice, explorer, fmt, num, priceDp, px, realizedPnl, short, units, usd, useAccounts, useActivity, useCards, useDeepFills, useFillsBySub, useVault, useWalletFills } from "./shared";
import { BurnerName } from "./burner";

const UP = T.green, DOWN = T.red;
const pct = (x: number, dp = 2) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, dp)}%`;
const money = (x: number, dp = 2) => `$${fmt(x, dp)}`;
const compact = (x: number) => (x >= 1e9 ? `$${fmt(x / 1e9, 2)}B` : x >= 1e6 ? `$${fmt(x / 1e6, 2)}M` : x >= 1e3 ? `$${fmt(x / 1e3, 1)}k` : `$${fmt(x, 0)}`);
const signedMoney = (x: number) => `${x >= 0 ? "+" : "−"}$${fmt(Math.abs(x))}`;
/** An up or down arrow for a gain or a loss. */
const arrow = (x: number) => (x > 0 ? "▲" : x < 0 ? "▼" : "•");

/** One open position with what it is up or down: entry from the wallet's fills on record (its
 *  transaction history, else the last fills its track record keeps), PnL against the mark. */
export type Held = {
  asset: number; sym: string; q: bigint; size: number; mark: number; value: number; entry?: number; pnl?: number; ret?: number;
  /** Which of the wallet's accounts holds it (0 the main, cross-margin one), and that account's health. */
  sub: number; acct?: AcctView;
};
/** The wallet's position on an asset as the chain has it now (not as last drawn). A close is
 *  sized from this: a position the page shows can be seconds old, and a stop or take-profit that
 *  filled meanwhile would turn a close of the old size into a new position the other way. */
async function heldNow(conn: Connection, wallet: PublicKey, asset: number, sub = 0): Promise<bigint> {
  const [pf, m] = await conn.getMultipleAccountsInfo([C.routerPortfolio(wallet, sub), C.activeMarket()], "confirmed");
  if (!pf || !m) return 0n;
  return C.decodePortfolio(new Uint8Array(pf.data), asset, new Uint8Array(m.data)).position;
}
/** The trade that closes `share`% of a position, never more than is held now (0n: nothing to close). */
async function closeSize(conn: Connection, wallet: PublicKey, asset: number, share: number, sub = 0): Promise<bigint> {
  readDirect();
  const now = await heldNow(conn, wallet, asset, sub);
  if (now === 0n) return 0n;
  return -(share >= 100 ? now : now * BigInt(Math.round(share)) / 100n);
}

export function heldPositions(state: C.State, markets: Card[], fills: Fill[], row: S.TraderRow | undefined): Held[] {
  return heldIn(state.health, state.sub, markets, fills, row, state.vault.key);
}
/** The positions of one of the wallet's accounts. `fills`: that account's fills (entries come from
 *  them; for the main account, from its track record's last fills too). */
export function heldIn(health: ReturnType<typeof C.accountHealth> | undefined, sub: number, markets: Card[], fills: Fill[], row: S.TraderRow | undefined, here?: PublicKey, acct?: AcctView): Held[] {
  return (health?.positions ?? []).map(x => {
    const c = markets.find(m => m.v.assetIndex === x.asset && (m.v.canonical || (here && m.v.key.equals(here))));
    const sym = c?.v.feed?.symbol ?? `asset ${x.asset}`;
    const size = num(x.size, 1e6), mark = num(x.price, 1e6);
    const mine = c ? fills.filter(f => f.vault === c.v.key.toBase58() && (f.sub ?? 0) === sub) : [];
    const recent: Fill[] = sub ? [] : (row?.stats?.fills ?? []).filter(f => f.asset === x.asset).map(f => ({ sig: "", slot: f.time, vault: "", size: f.size, price: f.price }));
    const entry = entryPrice(mine, size) ?? entryPrice(recent, size);
    const pnl = entry !== undefined ? (mark - entry) * size : undefined;
    return { asset: x.asset, sym, q: x.size, size, mark, value: num(x.notional, 1e6), entry, pnl, ret: pnl !== undefined && entry ? pnl / (Math.abs(size) * entry) : undefined, sub, acct };
  });
}
/** Every position the wallet holds, in every one of its accounts. */
export function heldEverywhere(accounts: AcctView[], markets: Card[], fills: Fill[], row: S.TraderRow | undefined): Held[] {
  return accounts.flatMap(a => heldIn(a.health, a.sub, markets, fills, row, undefined, a));
}
/** Each fill with what it booked (see `realizedPnl`), worked out for each account on its own
 *  (the same market can be held in several), then merged in time order. `now`: positions held
 *  now, by account and vault (key "<sub>:<vault>"). */
export function realizedAll(fills: Fill[], now: Map<string, number>) {
  const subs = [...new Set(fills.map(f => f.sub ?? 0))];
  return subs.flatMap(n => {
    const mine = fills.filter(f => (f.sub ?? 0) === n);
    const pos = new Map([...now].filter(([k]) => k.startsWith(`${n}:`)).map(([k, v]) => [k.slice(k.indexOf(":") + 1), v] as [string, number]));
    return realizedPnl(mine, pos);
  }).sort((a, b) => a.slot - b.slot);
}
/** Liquidation price of one position in an account, everything else there staying as it is. */
export function liqIn(h: ReturnType<typeof C.accountHealth>, market: Uint8Array, asset: number, sizeN: number, priceN: number): number | undefined {
  if (sizeN === 0) return undefined;
  const level = Number(C.levels(market, asset).liq) / 10_000;
  const otherFloor = num(h.floor, 1e6) - Math.abs(sizeN) * priceN * level;
  const x = (otherFloor - num(h.equity, 1e6) + sizeN * priceN) / (sizeN - level * Math.abs(sizeN));
  return x > 0 && Number.isFinite(x) ? x : undefined;
}
/** Everything that brings an account's money back to the wallet, read from the chain now: its
 *  released profit turned into capital, what it owes the vaults paid, the rest withdrawn. Only for
 *  an account with no position (the router allows nothing else). */
export async function returnMargin(conn: Connection, wallet: PublicKey, sub: number, vaults: C.Vault[]): Promise<TransactionInstruction[]> {
  const [pf, led, m] = await conn.getMultipleAccountsInfo([C.routerPortfolio(wallet, sub), C.ledgerAddress(wallet, sub), C.activeMarket()], "confirmed");
  if (!pf || !m) return [];
  const p = C.decodePortfolio(new Uint8Array(pf.data), 0, new Uint8Array(m.data));
  const owed = C.decodeLedger(led ? new Uint8Array(led.data) : null).filter(o => o.owed > 0n);
  const vaultOf = (asset: number) => vaults.find(x => x.assetIndex === asset && x.canonical) ?? vaults.find(x => x.assetIndex === asset);
  const total = owed.reduce((t, o) => t + o.owed, 0n);
  const profit = p.pnl > 0n ? p.pnl : 0n;
  const out = p.capital + profit - total;
  if (out <= 0n) return [];
  return [
    createAssociatedTokenAccountIdempotentInstruction(wallet, C.ata(wallet, C.MINT), wallet, C.MINT),
    ...(profit > 0n && vaults[0] ? [C.crank(wallet, C.routerPortfolio(wallet, sub), [vaults[0].assetIndex]), C.routerConvertPnl(wallet, sub)] : []),
    ...owed.flatMap(o => { const x = vaultOf(o.asset); return x ? [C.payFees(x, wallet, sub)] : []; }),
    C.routerWithdraw(wallet, out, sub),
  ];
}
const abs = (q: bigint) => (q < 0n ? -q : q);
const e6 = (x: number) => BigInt(Math.round(x * 1e6));
const ORDER_NAME = ["Stop loss", "Take profit", "Trailing stop", "Limit", "TWAP"];
/** The first of the wallet's order slots on this market that is free (or as many as asked). */
const freeSlots = (state: C.State, n = 1) => Array.from({ length: C.MAX_ORDERS }, (_, i) => i).filter(i => !state.orders.some(o => o.index === i)).slice(0, n);

/** Cross or isolated margin, chosen per market and kept in this browser. Cross: the wallet's main
 *  account, whose money stands behind every position it holds. Isolated: a separate account for
 *  this market alone (router `OpenAccount` with a number), holding only the margin put into it. */
export type MarginMode = "cross" | "isolated";
const MARGIN_KEY = (vault: PublicKey) => `pv:margin:${C.NETWORK}:${vault.toBase58()}`;
export function savedMargin(vault: PublicKey): MarginMode { try { return localStorage.getItem(MARGIN_KEY(vault)) === "isolated" ? "isolated" : "cross"; } catch { return "cross"; } }
export function saveMargin(vault: PublicKey, m: MarginMode) { try { localStorage.setItem(MARGIN_KEY(vault), m); } catch { /* storage unavailable */ } }

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
  const [margin, setMarginState] = useState<MarginMode>(() => savedMargin(vaultKey));
  const setMargin = (m: MarginMode) => { setMarginState(m); saveMargin(vaultKey, m); };
  const assetHere = markets.find(c => c.v.key.equals(vaultKey))?.v.assetIndex;
  const sub = margin === "isolated" && assetHere !== undefined ? C.isolatedSub(assetHere) : 0;
  const { state, err, reload } = useVault(vaultKey, tick, sub);
  const { accounts } = useAccounts(markets, tick);
  const [panel, setPanel] = useState<"trade" | "earn">("trade");
  const [wgHidden, setWgHidden] = useState(() => { try { return localStorage.getItem("pv:widgets-hidden") !== "0"; } catch { return true; } });
  const wrapped: Send = async (l, ixs) => { const r = await send(l, ixs); reload(); return r; };
  // Fills of every account: the main one's (its whole history for each position it holds, from
  // the server) and each isolated account's that holds a position or is on screen.
  const mainAcct = accounts.find(a => a.sub === 0);
  const mainKey = (mainAcct?.health.positions ?? []).map(x => `${x.asset}:${x.size}`).join(",");
  const recentFills = useWalletFills(publicKey, BigInt(mainKey.length + Math.floor(tick / 3)), 0);
  const need = useMemo(() => (mainAcct?.health.positions ?? []).map(x => {
    const c = markets.find(m => m.v.assetIndex === x.asset && m.v.canonical);
    return c ? `${c.v.key.toBase58()}:${x.size}` : "";
  }).filter(Boolean).sort().join(","), [mainKey, markets]);
  const mainFills = useDeepFills(publicKey, need, recentFills);
  const isoFills = useFillsBySub(publicKey, [...accounts.filter(a => a.sub && a.health.positions.length).map(a => a.sub), sub], tick);
  const allFills = useMemo(() => [...mainFills.map(f => ({ ...f, sub: 0 })), ...[...isoFills.values()].flat()].sort((a, b) => a.slot - b.slot), [mainFills, isoFills]);
  // This account's fills on this market (the chart's dots).
  const fills = useMemo(() => allFills.filter(f => f.vault === vaultKey.toBase58() && (f.sub ?? 0) === sub), [allFills, vaultKey.toBase58(), sub]);
  // The traders this wallet follows or copies: their fills on this market are marked on the chart.
  const { board } = useBoard(tick, Object.values(PULSE).some(Boolean) ? PULSE_BOARD_MS : undefined);
  const me = useMe(board, tick);
  const leaders = useMemo(() => [...new Set([...me.following, ...(me.copy ? [me.copy.leader.toBase58()] : [])])].sort(), [me]);
  const asset = state?.vault.assetIndex ?? -1;
  // (Badge pictures are checked and loaded a moment after the board arrives: the marks follow.)
  const pictures = usePictures();
  const notes = useNotes(leaders, tick);
  const copied = me.copy?.leader.toBase58();
  const marks = useMemo(() => marksFor(board, leaders, asset, notes, copied), [board, leaders.join(","), asset, pictures, notes, copied]);
  // Every fill on this market by anyone: the trades list, the queue's fills and the chart's whales.
  const marketTrades = useMemo(() => marketFills(board, asset), [board, asset]);
  // This wallet's own fills on this market (green and red dots on the chart): its track record's,
  // plus any newer ones read from its own transactions.
  const mine = useMemo((): Trade[] => {
    if (!publicKey) return [];
    const rec = board?.rows.find(r => r.wallet === publicKey.toBase58())?.stats?.fills.filter(f => f.asset === asset) ?? [];
    const out: Trade[] = rec.map(f => ({ key: `r:${f.time}:${f.size}`, time: f.time, price: f.price, size: f.size }));
    const same = (a: Trade, f: { size: number; price: number; time?: number }) => Math.abs(a.size - f.size) < 1e-6 && Math.abs(a.price - f.price) < 1e-6 && Math.abs(a.time - (f.time ?? 0)) < 120;
    for (const f of fills) if (f.time && !out.some(a => same(a, f))) out.push({ key: f.sig, time: f.time, price: f.price, size: f.size });
    return out;
  }, [board, publicKey?.toBase58(), asset, fills]);

  if (err && !state) return <div className="desk-msg">{err}</div>;
  if (!state) return <div className="desk-msg">Loading market…</div>;

  const v = state.vault, sym = v.feed?.symbol ?? "?";
  const price = num(state.asset.price, 1e6);
  const posN = num(state.portfolio?.position ?? 0n, 1e6);
  const myRow = publicKey ? board?.rows.find(r => r.wallet === publicKey.toBase58()) : undefined;
  const held = heldPositions(state, markets, allFills, myRow);
  // Every position in every account, for the positions table (until the accounts are read: this one's).
  const heldAll = accounts.length ? heldEverywhere(accounts, markets, allFills, myRow) : held;
  const here = held.find(h => h.asset === v.assetIndex);
  const entry = here?.entry;
  const liq = liquidationPrice(state, posN);
  // The position's line on a chart: market, side, size and what it is up or down.
  const posLine = (h: Held) => ({
    price: h.entry!,
    title: `${arrow(h.pnl ?? 0)} ${h.sym} ${h.size > 0 ? "LONG" : "SHORT"} ${fmt(Math.abs(h.size), 4).replace(/\.?0+$/, "")} · ${h.pnl === undefined ? "" : `${signedMoney(h.pnl)} (${pct(h.ret ?? 0)})`}`,
    color: T.blue,
  });
  const linesOf = (s: string) => held.filter(h => h.sym === s && h.entry).map(posLine);
  const lines = [
    ...(here?.entry ? [posLine(here)] : []),
    ...(liq ? [{ price: liq, title: "Liq.", color: T.orange }] : []),
    ...state.orders.filter(o => o.kind !== C.ORDER.TWAP).map(o => o.kind === C.ORDER.TRAIL
      ? { price: num(o.peak, 1e6) * (1 - o.side * Number(o.trigger) / 10_000), title: "Trail", color: T.purple }
      : { price: num(o.trigger, 1e6), title: o.kind === C.ORDER.STOP ? "SL" : o.kind === C.ORDER.TAKE ? "TP" : o.size > 0n ? "Buy" : "Sell", color: o.kind === C.ORDER.STOP ? DOWN : o.kind === C.ORDER.TAKE ? UP : T.textSecondary }),
  ];

  const heat = board ? liqLevels(state, board).map(x => ({ price: x.liq, value: x.value })) : undefined;
  const hideWidgets = (on: boolean) => { setWgHidden(on); try { localStorage.setItem("pv:widgets-hidden", on ? "1" : "0"); } catch { /* storage unavailable */ } };

  return (
    <main className={`desk${wgHidden ? " nowg" : ""}`}>
      <MarketBar state={state} markets={markets} day={day} go={go} tick={tick} showWidgets={wgHidden ? () => hideWidgets(false) : undefined} />
      <section className="desk-chart panel"><Charts sym={sym} price={price} lines={lines} linesOf={linesOf} compare={publicKey ? held.map(h => ({ sym: h.sym, long: h.size > 0 })) : undefined} marks={marks} mine={mine} whales={PULSE.whales ? marketTrades : undefined} heat={heat} markets={markets} go={go} /></section>
      {!wgHidden && <section className="desk-book panel"><WidgetPanel state={state} tick={tick} board={board} fills={marketTrades} markets={markets} go={go} send={wrapped} busy={busy} onHide={() => hideWidgets(true)} /></section>}
      {PULSE.liqs && <Liquidations board={board} markets={markets} go={go} />}
      <section className="desk-ticket panel">
        <div className="ptabs">
          <button className={panel === "trade" ? "on" : ""} onClick={() => setPanel("trade")}>Trade</button>
          <button className={panel === "earn" ? "on" : ""} onClick={() => setPanel("earn")}>Earn</button>
        </div>
        {panel === "trade" ? <Ticket state={state} send={wrapped} busy={busy} vaults={markets.map(c => c.v)} margin={margin} setMargin={setMargin} copying={me.copy && !state.sub ? { leader: me.copy.leader.toBase58(), name: board?.profiles.get(me.copy.leader.toBase58())?.name ?? short(me.copy.leader.toBase58()) } : undefined} /> : <div className="earn"><LiquidityPanel state={state} send={wrapped} busy={busy} /></div>}
        <button className="portfolio-btn" onClick={() => go("/portfolio")} title="Your positions, results and trading statistics across every market">
          <span>Portfolio</span><b aria-hidden>→</b>
        </button>
        <div className="ticket-acct"><Account state={state} send={wrapped} busy={busy} held={held} row={myRow} vaults={markets.map(c => c.v)} accounts={accounts} /></div>
      </section>
      <section className="desk-bottom panel"><Bottom state={state} markets={markets} fills={allFills} held={heldAll} liq={liq} send={wrapped} busy={busy} go={go} tick={tick} accounts={accounts} setMargin={setMargin} /></section>
    </main>
  );
}

// ---------------------------------------------------------------- chart windows

/** One, two or four chart windows. The first is always the market being traded (with the
 *  wallet's lines, the drawing tools and followed traders' fills); the others show any market. */
const LAYOUTS: [id: string, label: string, panes: number, icon: string][] = [
  ["1", "One chart", 1, "M2.5 2.5h11v11h-11z"],
  ["2h", "Two charts side by side", 2, "M2.5 2.5h11v11h-11zM8 2.5v11"],
  ["2v", "Two charts stacked", 2, "M2.5 2.5h11v11h-11zM2.5 8h11"],
  ["4", "Four charts", 4, "M2.5 2.5h11v11h-11zM8 2.5v11M2.5 8h11"],
];
/** The chart-windows choice: one button with the current layout's icon, the others in its menu. */
function LayoutPick({ layout, choose }: { layout: string; choose: (l: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const glyph = (d: string) => <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
  const [, label, , icon] = LAYOUTS.find(l => l[0] === layout) ?? LAYOUTS[0];
  return (
    <div className="layouts studies" ref={box}>
      <button className={`kind-pick${open ? " on" : ""}`} title={`Chart windows: ${label}`} aria-label={`Chart windows: ${label}`} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {glyph(icon)}
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden><path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="studies-menu kinds-menu layouts-menu">
          {LAYOUTS.map(([id, text, , d]) => <button key={id} className={id === layout ? "on" : ""} onClick={() => { choose(id); setOpen(false); }}>{glyph(d)}{text}<i /></button>)}
        </div>
      )}
    </div>
  );
}
function Charts({ sym, price, lines, linesOf, compare, marks, mine, whales, heat, markets, go }: { sym: string; price: number; heat?: HeatLevel[]; lines: { price: number; title: string; color: string }[]; linesOf: (sym: string) => { price: number; title: string; color: string }[]; compare?: { sym: string; long: boolean }[]; marks: Mark[]; mine: Trade[]; whales?: Whale[]; markets: Card[]; go: (to: string) => void }) {
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
  const picker = <LayoutPick layout={layout} choose={choose} />;
  return (
    <div className={`charts l-${layout}`}>
      <Chart symbol={sym} price={price} lines={lines} compare={compare} marks={marks} mine={mine} whales={whales} heat={heat} dense={n > 1} head={<>{picker}{n > 1 && <div className="pane-sym main"><b>{sym}</b></div>}</>} />
      {Array.from({ length: n - 1 }, (_, k) => {
        const i = k + 1, s = paneSym(i);
        return (
          <Chart key={i} slot={i} compact dense symbol={s} price={priceOf(s)} lines={linesOf(s)} head={
            <div className="pane-sym">
              <select value={s} aria-label="Market in this window" onChange={e => setPane(i, e.target.value)}>{syms.map(x => <option key={x} value={x}>{x}</option>)}</select>
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

/** `liquidationPrice` for any market the account holds (its own liquidation level and price). */
function liquidationPriceOf(state: C.State, asset: number, sizeN: number, priceN: number): number | undefined {
  const h = state.health;
  if (!h || sizeN === 0 || !state.marketData) return undefined;
  const level = Number(C.levels(state.marketData, asset).liq) / 10_000;
  const otherFloor = num(h.floor, 1e6) - Math.abs(sizeN) * priceN * level;
  const x = (otherFloor - num(h.equity, 1e6) + sizeN * priceN) / (sizeN - level * Math.abs(sizeN));
  return x > 0 && Number.isFinite(x) ? x : undefined;
}
/** The leverage chosen in the ticket for a market (remembered per market), at most the market's. */
function leverageOf(state: C.State, sym: string, asset: number): number {
  const most = state.marketData ? Math.max(1, Math.floor(C.maxLeverage(state.marketData, asset))) : 1;
  let x = 0;
  try { x = Number(localStorage.getItem(`pv:lev:${sym}`)); } catch { /* storage unavailable */ }
  return Math.min(x >= 1 ? Math.round(x) : Math.min(5, most), most);
}

// ---------------------------------------------------------------- market bar

function MarketBar({ state, markets, day, go, tick, showWidgets }: { state: C.State; markets: Card[]; day: Record<string, DayStats>; go: (to: string) => void; tick: number; showWidgets?: () => void }) {
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
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const id = setInterval(() => document.hidden || setNow(Date.now() / 1000), 1000); return () => clearInterval(id); }, []);
  const b = state.book;
  // The newest oracle price on chain: the feed's own account, or the router's mark if that is newer.
  const feedNewer = !!state.pyth && state.pyth.e6 > 0n && state.pyth.publish >= (b?.markPublish ?? 0);
  const mark = feedNewer ? num(state.pyth!.e6, 1e6) : b && b.markPrice > 0n ? num(b.markPrice, 1e6) : price;
  const published = (feedNewer ? state.pyth!.publish : b?.markPublish) || undefined;
  const age = published ? Math.max(0, now - published) : undefined;
  const queued = b?.pending.length ?? 0;
  const vol = useVolume();
  const dp = priceDp(price);
  return (
    <header className="mbar">
      <div className="msel" ref={box}>
        <button className="msel-btn" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <Icon symbol={sym} />
          <span className="msel-sym">{sym}</span>
          <span className="msel-lev">{fmt(10_000 / Number(state.levels.open), 0)}×</span>
          <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        {open && (
          <div className="msel-menu">
            <div className="msel-head"><span>Market</span><span>Price</span><span>24h</span><span>24h volume</span><span>Liquidity</span></div>
            {markets.map(c => {
              const s = c.v.feed!.symbol, ds = day[s], p = num(c.asset.price, 1e6);
              const ch = ds && ds.last > 0 ? p / (ds.last / (1 + ds.change)) - 1 : undefined;
              return (
                <button key={c.v.key.toString()} className={c.v.key.equals(v.key) ? "msel-row on" : "msel-row"} onClick={() => { setOpen(false); go(c.v.canonical ? `/trade/${s}` : `/m/${c.v.key.toString()}`); }}>
                  <span className="msel-name"><Icon symbol={s} />{s}{!c.v.canonical && <em>earlier vault</em>}</span>
                  <span className="mono">{px(c.asset.price)}</span>
                  <span className={`mono ${ch === undefined ? "" : ch >= 0 ? "up" : "down"}`}>{ch === undefined ? "—" : pct(ch)}</span>
                  <span className="mono">{c.v.canonical && vol?.markets[s] ? compact(vol.markets[s].volume) : "—"}</span>
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
        <Cell label="24h volume" value={vol?.markets[sym] && v.canonical ? compact(vol.markets[sym].volume) : "—"} title="Everything traded on this market in the last 24 hours, counted from its fills on chain (refreshed every ten minutes)" />
        <Cell label="Open interest" value={money(oiUsd, 0)} />
        <Cell label="Vault liquidity" value={usd(C.navOf(state), 0)} title="What the vault, which takes the other side of every trade, is worth now" />
        <Cell label="Oracle price" value={`$${fmt(mark, dp)}`} sub={age === undefined ? undefined : age < 1.5 ? "just now" : `${Math.round(age)}s ago`} tone={age !== undefined && age > 30 && queued > 0 ? "down" : undefined} title={`Every fill is at this price: the first oracle price after a request's target time. ${C.X1 ? "On X1 a new price is put on chain when a trade, order or liquidation needs one, so on a quiet market its age grows; it is late only if a trade is waiting." : "Published by Pyth and put on chain."}`} />
      </div>
      {showWidgets && <button className="wg-show" onClick={showWidgets} title="Bring back the widgets column">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>Widgets
      </button>}
    </header>
  );
}

const L_FUNDING = { free: (C.LAYOUT.router as any).funding_free_bps as number | undefined, max: (C.LAYOUT.router as any).funding_max_e9 as number | undefined };

function Cell({ label, value, sub, tone, title }: { label: string; value: string; sub?: string; tone?: "up" | "down"; title?: string }) {
  return (
    <div className="cell" title={title}>
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
        <div className="skew-ends mono"><span>−{units(limit)}</span><span title={`Its limit is ${fmt(Math.min(Number(v.positionNavBps || 20_000), C.tierPositionBps(C.tierOfFeed(v.feedHex))) / 10_000, 2).replace(/\.?0+$/, "")}× the vault's liquidity (2× for BTC and ETH, 1× for the rest). Near 100% used, it only takes trades that bring it back.`}>{PULSE.crowd && limit > 0n ? `${fmt(Math.min(100, Number(abs(v.inventory) * 1000n / limit) / 10), 1)}% of limit used` : `limit ${v.positionNavBps ? fmt(Number(v.positionNavBps) / 10_000, 2).replace(/\.?0+$/, "") : "3"}× liquidity`}</span><span>+{units(limit)}</span></div>
      </div>
      <Stress state={state} />
      </div>
    </div>
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

function Ticket({ state, send, busy, copying, margin, setMargin, vaults }: { state: C.State & { readFor?: string; readErr?: string }; send: Send; busy?: string; copying?: { leader: string; name: string }; margin: MarginMode; setMargin: (m: MarginMode) => void; vaults: C.Vault[] }) {
  const { publicKey, wallet } = useWallet();
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
  // An optional note for the trader's followers, sent with the trade (see S.tradeNote).
  const [note, setNote] = useState("");
  const withNote = (ixs: TransactionInstruction[]) => (publicKey && S.cleanNote(note) ? [...ixs, S.tradeNote(publicKey, note)] : ixs);
  const sendNoted = async (l: string, ixs: TransactionInstruction[]) => { const r = await send(l, withNote(ixs)); if (r) setNote(""); return r; };
  const [unit, setUnit] = useState<"coin" | "usd">("coin");
  const [mode, setMode] = useState<"market" | "limit" | "protect" | "twap">("market");
  // Whether what is shown includes this wallet's own accounts yet (the market itself shows first).
  const v = state.vault, p = state.portfolio, sym = v.feed?.symbol ?? "";
  const sub = state.sub;
  // (And that what is shown is the account the margin switch names.)
  const mine = (!publicKey || state.readFor === undefined || state.readFor === publicKey.toBase58()) && (sub !== 0) === (margin === "isolated");
  const priceN = num(state.asset.price, 1e6);
  const dp = priceDp(priceN);
  const typed = Number(text || 0);
  const sizeN = unit === "coin" ? typed : priceN > 0 ? typed / priceN : 0;
  const want = BigInt(Math.max(0, Math.round((Number.isFinite(sizeN) ? sizeN : 0) * 1e6)));
  const notional = num(want, 1e6) * priceN;

  const pendingHere = state.pending;
  const locked = !!state.trader?.hasPending;
  // One-click trading (OneClick.tsx): while the wallet's trading key is approved, trades sign with
  // it instead of the wallet. Notes are the wallet's own signature, so they go with wallet trades only.
  const ok = useTradingKey(busy ? 1 : 0);
  const actor = ok.active && ok.key ? ok.key.publicKey : undefined;
  const keyOpts = ok.active && ok.key ? { key: ok.key } : undefined;
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
  const iso = sub !== 0;
  // (An isolated order brings its own margin from the wallet: only the vault limits its size.)
  const most = iso ? vaultMax : marginMax(side) < vaultMax ? marginMax(side) : vaultMax;
  const sent = want > vaultMax ? vaultMax : want; // an order above what the vault takes is cut to it
  // (No shares outstanding and no position: every deposit was withdrawn. Such a market is not serviced, so an
  // order sent to it would wait until it expired, and block the wallet's other trades meanwhile.)
  const noLiquidity = v.lastNav === 0n || (state.shareSupply === 0n && v.inventory === 0n);
  const reduceOnly = state.slot >= v.epochStart + v.epochLen && v.needsFlat;
  const after = num(held + sent * side, 1e6);
  const liqAfter = liquidationPrice(state, after);
  // Owed to the vault on top of the fee (router `carry`): on the part of the order that makes the
  // vault's position bigger, unless it only closes the trader's own position.
  const vaultNow = v.inventory, vaultAfter = vaultNow - sent * side;
  const grows = !shrinks && abs(vaultAfter) > abs(vaultNow) ? abs(vaultAfter) - abs(vaultNow) : 0n;
  const sideFee = num(grows, 1e6) * priceN * C.CARRY.sideFeeBps / 10_000;
  // The holding fee the side the vault is against owes now (it follows how one-sided the market is).
  const holdRate = state.carry?.rateE12 ?? 0n;
  const paysHold = after !== 0 && holdRate !== 0n && (after > 0) === (holdRate > 0n);

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
  // While the router's risk dial is up, opening needs that many times the margin (see `C.riskDial`).
  const dial = state.risk.dial;
  const openRate = Math.min(1, Number(state.levels.open) * dial / 10_000), maxLev = Math.max(1, Math.floor(1 / openRate));
  const savedLev = () => { let x = 0; try { x = Number(localStorage.getItem(`pv:lev:${sym}`)); } catch { /* storage unavailable */ } return x >= 1 ? x : Math.min(5, maxLev); };
  const [share, setShareState] = useState<number>(); // the last quick share chosen, re-applied when the leverage changes
  const [levPick, setLevPick] = useState<number>(savedLev);
  useEffect(() => { setLevPick(savedLev()); setShareState(undefined); }, [sym]);
  const lev = Math.min(Math.max(1, Math.round(levPick)), maxLev);
  const sameSide = held === 0n || (held > 0n) === (side > 0n);
  const reduces = !sameSide; // an order against the position shrinks it first
  // Margin free for new positions, in dollars: what the margin rule leaves at the market's maximum leverage.
  const newRoom = sameSide ? (cap > abs(held) ? cap - abs(held) : 0n) : cap;
  // Isolated: what the account holds plus what the wallet could move into it.
  const freeMargin = iso ? num((state.health?.equity ?? 0n) + state.userCollateral, 1e6) : num(newRoom, 1e6) * priceN * openRate;
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
  const overLev = !iso && !reduces && want > 0n && !shrinks && orderMargin > freeMargin * 1.0001 && lev < maxLev;
  // Isolated: the margin the account needs after this order (the larger of the chosen leverage's
  // and what the router asks, plus 1% and the fee), less what it holds, moves from the wallet in
  // the same transaction. An order that only shrinks the position moves nothing.
  const isoTopUp = (() => {
    if (!iso || shrinks || sent === 0n || !state.marketData) return 0n;
    const afterQ = held + sent * side;
    const byLev = abs(afterQ) * state.asset.price / C.UNIT / BigInt(lev);
    const byRule = C.isolatedNeed(state.marketData, v.assetIndex, afterQ);
    const fee = sent * state.asset.price / C.UNIT * BigInt(C.TRADE_FEE_BPS) / 10_000n;
    const target = (byLev > byRule ? byLev : byRule) * 101n / 100n + fee;
    const has = state.health?.equity ?? 0n;
    return target > has ? ((target - has + 9_999n) / 10_000n) * 10_000n : 0n;
  })();

  // Deposit + bond + a little for the fee.
  // (Once the router pays liquidators, the first trade also tops up the account's keeper deposit.)
  const coinsNeeded = Number(C.expiryDeposit(sent, state.asset.price)) + C.ROUTER_BOND_LAMPORTS + 1_000_000 + (C.KEEPER_REWARDS ? C.KEEPER_DEPOSIT : 0);
  // The one thing that stops this order, if anything does.
  const blocker = !publicKey ? "Connect a wallet to trade"
    : !state.trader && !iso ? "Create a trading account first"
    : !state.book ? "This market's queue is not open yet"
    : locked ? (pendingHere ? "Your queued order has to fill or expire first" : "You have an order queued on another market")
    : state.closeOnly ? "This market is close-only until its remaining positions are closed"
    : noLiquidity ? "This market has no liquidity yet"
    : vaultMax === 0n ? (reduceOnly ? "The vault is settling an epoch: it only takes orders that reduce its position or close yours" : `The vault is at its limit for ${side > 0n ? "longs" : "shorts"}`)
    : want <= 0n ? "Enter a size"
    : iso && isoTopUp > state.userCollateral ? `This order moves ${money(num(isoTopUp, 1e6))} of margin from your wallet, which has ${money(num(state.userCollateral, 1e6))} of test USDC`
    : !iso && sent > marginMax(side) ? `Your margin covers at most ${units(marginMax(side))} ${sym} here: add margin or lower the size`
    : overLev ? `At ${lev}× this order needs ${money(orderMargin)} of margin and ${money(freeMargin)} is free: raise the leverage or lower the size`
    : actor && ok.lamports < coinsNeeded ? `The one-click trading key needs ${(coinsNeeded / 1e9).toFixed(3)} ${C.COIN} for this order's deposit and bond (they come back to your wallet when it fills); it has ${(ok.lamports / 1e9).toFixed(3)}: add ${C.COIN} to it below`
    : !actor && coins !== undefined && coins < coinsNeeded ? `This order needs ${(coinsNeeded / 1e9).toFixed(3)} ${C.COIN} in your wallet for its deposit and bond (they come back when it fills); the wallet has ${(coins / 1e9).toFixed(3)}`
    : undefined;

  const submit = () => {
    if (!publicKey || !state.book || blocker) return;
    // An account opened before the fee ledgers existed gets one with its first trade (it can only
    // reduce without one). An isolated account is opened by its first order, and each order
    // brings the margin it needs from the wallet.
    const open = iso && !state.trader ? [C.openTradingAccount(publicKey, sub), C.openLedger(publicKey, publicKey, sub)] : [];
    const ledger = state.trader && !state.trader.hasLedger ? [C.openLedger(publicKey, publicKey, sub)] : [];
    const fund = isoTopUp > 0n ? [createAssociatedTokenAccountIdempotentInstruction(publicKey, C.ata(publicKey, C.MINT), publicKey, C.MINT), C.routerDeposit(publicKey, isoTopUp, sub)] : [];
    const label = `${side > 0n ? "Long" : "Short"} ${units(sent)} ${sym}${iso ? ` isolated${isoTopUp > 0n ? `, ${money(num(isoTopUp, 1e6))} margin` : ""}` : ""}`;
    const queued = [...open, ...ledger, ...fund, C.requestTrade(publicKey, v.key, sent * side, { sub })];
    // An account ready to trade takes a maker's quote when one is offered: it fills in the slot
    // the transaction lands in. Otherwise (or a new account, margin to move) the queue.
    if (C.QUOTES_ON && !open.length && !ledger.length && !fund.length) {
      send(label, async conn => {
        // (The burner wallet signs at once; a wallet that asks its user needs the quote longer.)
        const q = await C.quotedTrade(conn, v, publicKey, sub, sent * side, quoteLife, 1_500, true, actor).catch(() => null);
        const ixs = q ? [ComputeBudgetProgram.setComputeUnitLimit({ units: q.units }), ...q.ixs] : actor ? [C.requestTrade(publicKey, v.key, sent * side, { sub, actor })] : queued;
        return actor ? ixs : withNote(ixs);
      }, keyOpts).then(r => { if (r) setNote(""); });
      return;
    }
    sendNoted(label, queued);
  };
  // A quote for the order as it stands, fetched ahead and kept fresh, so a click signs at once
  // (C.prefetchQuote). Only while it could be used: a market order an account ready to trade
  // can send now.
  const instantWallet = wallet?.adapter?.name === BurnerName || !!actor;
  const quoteLife = instantWallet ? 6 : 30;
  const quotable = C.QUOTES_ON && mode === "market" && !!publicKey && mine && !blocker && !busy && !!state.trader && state.trader.hasLedger && !(iso && isoTopUp > 0n) && sent > 0n;
  const quoteSize = quotable ? sent * side : 0n;
  useEffect(() => {
    if (!quoteSize || !publicKey) return;
    const fetchAhead = () => { if (!document.hidden) C.prefetchQuote(connection, v, publicKey, sub, quoteSize, quoteLife, 1_500, actor); };
    // (Typing settles first; then a fresh one well inside each quote's life.)
    const first = setTimeout(fetchAhead, 250);
    const id = setInterval(fetchAhead, instantWallet ? 900 : 2_500);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [quoteSize.toString(), publicKey?.toBase58(), v.key.toBase58(), sub, quoteLife, actor?.toBase58()]);
  // Close all of the position, or a share of it (a smaller trade the other way).
  const closeAll = (share = 100) => {
    if (!publicKey || !state.book || held === 0n) return;
    // A close-only market has no counterparty for a close: the position is closed out instead (whole only).
    if (state.closeOnly) sendNoted("Close position", [C.requestClose(publicKey, publicKey, v.key, sub)]);
    else closeSize(connection, publicKey, v.assetIndex, share, sub).then(q => {
      // Close only: the router itself refuses to let it open or flip a position.
      const label = share >= 100 ? "Close position" : `Close ${share}% (${units(abs(q))} ${sym})`;
      if (q !== 0n) { if (keyOpts) send(label, [C.requestTrade(publicKey, v.key, q, { sub, closeOnly: true, actor })], keyOpts); else sendNoted(label, [C.requestTrade(publicKey, v.key, q, { sub, closeOnly: true })]); }
    });
  };
  const [closePct, setClosePct] = useState(100);
  useEffect(() => setClosePct(100), [sym]);
  // Close a slid size (coins), never more than is held.
  const closePart = (n: number) => {
    if (!publicKey || !state.book || held === 0n) return;
    heldNow(connection, publicKey, v.assetIndex, sub).then(now => {
      let part = BigInt(Math.round(n * 1e6));
      if (part >= abs(now)) part = abs(now);
      if (part <= 0n) return;
      const ix = C.requestTrade(publicKey, v.key, now > 0n ? -part : part, { sub, closeOnly: true, actor });
      if (keyOpts) send(`Close ${units(part)} ${sym}`, [ix], keyOpts); else sendNoted(`Close ${units(part)} ${sym}`, [ix]);
    });
  };

  return (
    <div className="ticket">
      <div className="mmode" role="group" aria-label="Margin mode">
        <button className={margin === "cross" ? "on" : ""} onClick={() => setMargin("cross")} title={`Cross margin: your main account. All of its money stands behind every position you hold in it, on every market, so a gain on one market supports another, and a loss on one can use margin you put in for another. One account for every market; it is the one copy trading and the leaderboard count. It belongs to a program address derived from your wallet: only the router can trade it, and withdrawals only go back to this wallet. Opening it costs about 0.07 test ${C.COIN} of rent.`}>Cross</button>
        <button className={margin === "isolated" ? "on" : ""} onClick={() => setMargin("isolated")} title={`Isolated margin: a separate account for ${sym} alone, holding only the margin you deposit into it. If this position goes wrong it can lose that margin and nothing else; your other positions cannot be touched, and it cannot use their money either. It holds one market at a time and has its own orders and queue place. Like your main account, only the router can trade it and withdrawals only go back to this wallet. Opening it costs about 0.07 test ${C.COIN} of rent. Copy trading and the leaderboard count your main account only.`}>Isolated</button>
      </div>
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
      <CurrentPosition held={held} sym={sym} />

      <label className="inp">
        <span>Size</span>
        <input value={text} onChange={e => { setShareState(undefined); setText(e.target.value.replace(/[^0-9.]/g, "")); }} placeholder="0.00" inputMode="decimal" />
        <button className="unit" onClick={() => { setText(typed > 0 && priceN > 0 ? String(unit === "coin" ? +(typed * priceN).toFixed(2) : +(typed / priceN).toFixed(6)) : ""); setUnit(unit === "coin" ? "usd" : "coin"); }} title="Switch between the asset and dollars">{unit === "coin" ? sym : "USD"}</button>
      </label>
      {(state.trader || iso) && !reduces && (
        <div className="lev">
          <div className="lev-l">
            <span className="hint" title={`How many times the margin you put behind this order it is worth. ${maxLev}× is the most this market allows. A lower leverage uses less of your free margin for the same size: the quick buttons size the order from your free margin times this leverage.`}>Leverage</span>
            <b className="mono">{lev}×<i title={dial > 1 ? `Lowered for now: ${state.risk.why}. New positions get ${dial}x less leverage and the vault takes ${dial}x less new risk until it passes. Closing is never limited.` : undefined}>max {maxLev}×{dial > 1 ? " (lowered)" : ""}</i></b>
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

      <div className="sum">
        <div><span>Order value</span><b className="mono">{money(notional)}</b></div>
        {!reduces && !iso && <div title={`The order's value divided by your leverage (${lev}×), out of ${money(freeMargin)} of free margin`}><span>Margin for this order ({lev}×)</span><b className={`mono ${overLev ? "down" : ""}`}>{money(orderMargin)}<i className="muted"> of {money(freeMargin)} free</i></b></div>}
        {!reduces && iso && <div title={`Isolated: this position's own margin. What it needs at ${lev}× (or the market's minimum, if more), less what its account already holds, moves from your wallet with the order. A loss can take only this margin.`}><span>Margin moved from wallet ({lev}×)</span><b className="mono">{money(num(isoTopUp, 1e6))}{state.health && state.health.equity > 0n ? <i className="muted"> + {money(num(state.health.equity, 1e6))} already in</i> : null}</b></div>}
        {state.trader && !iso && <div title="What all your positions are worth divided by your equity, now and after this order (one account covers every market)"><span>Account leverage</span><b className="mono">{want > 0n ? `${fmt(levNow, 1)}× → ${fmt(levAfter, 1)}×` : `${fmt(levNow, 1)}×`}</b></div>}
        <div><span>Fee ({C.TRADE_FEE_PCT})</span><b className="mono">{money(notional * C.TRADE_FEE_BPS / 10_000)}</b></div>
        {sideFee > 0 && <div title={`This order makes the vault's position bigger: ${C.CARRY.sideFeeBps / 100}% of that part is owed to the vault's depositors, paid when you next withdraw. Orders that shrink the vault's position, and closes of your own position, owe nothing.`}><span>Crowded-side fee ({C.CARRY.sideFeeBps / 100}%)</span><b className="mono">{money(sideFee)}</b></div>}
        {state.carry && (
          <div title={`While the vault holds more than ${Number(C.CARRY.holdFreeBps) / 100}% of its limit, the side it is against owes a holding fee to its depositors, up to ${C.holdPctHour(C.CARRY.holdMaxE12).toFixed(3)}% of the position's value an hour at the limit. The other side owes nothing. It is booked at each trade and paid when you withdraw.`}>
            <span>Holding fee now</span>
            <b className={paysHold ? "mono hold-pay" : "mono"}>{holdRate === 0n ? "none" : paysHold ? `you pay ${C.holdPctHour(holdRate).toFixed(4)}%/h (${money(Math.abs(after) * priceN * C.holdPctHour(holdRate) / 100 * 24, 2)} a day)` : `${holdRate > 0n ? "longs" : "shorts"} pay ${C.holdPctHour(holdRate).toFixed(4)}%/h`}</b>
          </div>
        )}
        <div><span>Position after</span><b className="mono">{after === 0 ? "flat" : `${after > 0 ? "long" : "short"} ${fmt(Math.abs(after), 4).replace(/\.?0+$/, "")} ${sym}`}</b></div>
        <div><span>Est. liquidation price</span><b className="mono">{liqAfter && want > 0n ? fmt(liqAfter, dp) : "—"}</b></div>
        {state.funding.capE9 > 0n && (() => {
          // What the position after this order pays (or receives) in funding a day, at today's rate.
          const day = C.fundingCostPerHour(state.funding.rateE9, after, Math.abs(after) * num(state.asset.price, 1e6)) * 24;
          return <div title="At the current rate, which follows how one-sided the market is and can change"><span>Funding a day (est.)</span><b className={`mono ${day > 0 ? "down" : day < 0 ? "up" : ""}`}>{after === 0 || day === 0 ? "—" : `${day > 0 ? "you pay " : "you receive "}${money(Math.abs(day), 2)}`}</b></div>;
        })()}
        <div><span>Largest order now</span><b className="mono">{state.trader ? `${units(most)} ${sym}` : `${units(vaultMax)} ${sym}`}</b></div>
        {C.KEEPER_REWARDS && <div title={`Kept in your trading account (topped up by a trade when needed, so usually paid once). If the account is ever liquidated, whoever does it is paid from this, not from your margin. It comes back when you withdraw with no position open.`}><span>Keeper deposit</span><b className="mono">{(C.KEEPER_DEPOSIT / 1e9).toFixed(4)} {C.COIN}<i className="muted"> held, refundable</i></b></div>}
      </div>

      {publicKey && state.trader && (
        <label className="ticket-note" title="Sent with this trade and signed by your wallet. People who follow you see it when they point at this trade on their chart. It is public: anyone can read it on chain.">
          <input value={note} onChange={e => setNote(e.target.value.slice(0, S.NOTE_MAX))} maxLength={S.NOTE_MAX} placeholder="Note to your followers (optional)" />
          {note && <em>{S.NOTE_MAX - [...note].length}</em>}
        </label>
      )}
      {publicKey && state.trader && copying && (
        <div className="copy-warn">
          <b>You are copying {copying.name}</b>
          <span>Copying keeps every market in your account in line with theirs, so a trade you make here is undone within seconds. Stop copying to trade on your own; your open positions stay as they are.</span>
          <button disabled={!!busy} onClick={() => send("Stop copying", [S.stopCopy(publicKey)])}>Stop copying</button>
        </div>
      )}
      <div className="ticket-go">
      {!publicKey ? <div className="connect"><WalletMultiButton /></div>
        : !mine ? <button className="submit neutral" disabled title={state.readErr}>{state.readErr ? `Could not read your account (${/429|Too Many/i.test(state.readErr) ? "the network's RPC is refusing this browser's requests: too many" : state.readErr.replace(/^failed to get [a-z ]*info about account \S+: /i, "").slice(0, 120)}), trying again…` : "Reading your account…"}</button>
        : !state.trader && !iso ? <SetupCard send={send} busy={busy} userCollateral={state.userCollateral} coins={coins} onDone={ok.reload} />
        : <button className={`submit ${side > 0n ? "up" : "down"}`} disabled={!!blocker || !!busy} onClick={submit}>{busy ? `${busy}…` : `${side > 0n ? "Long" : "Short"} ${want > 0n ? `${units(sent)} ` : ""}${sym}`}</button>}
      {state.trader && held !== 0n && (
        <div className="closeparts">
          <button className="closepos" disabled={locked || !!busy} onClick={() => (state.closeOnly || closePct >= 100 ? closeAll() : closePart(num(abs(held), 1e6) * closePct / 100))}>
            Close {closePct < 100 && !state.closeOnly ? `${closePct}% of ` : ""}{held > 0n ? "long" : "short"} {units(state.closeOnly || closePct >= 100 ? abs(held) : abs(held) * BigInt(closePct) / 100n)} {sym}
          </button>
        </div>
      )}
      {state.trader && held !== 0n && !state.closeOnly && (
        <CloseSlider pct={closePct} onChange={setClosePct} disabled={locked || !!busy} />
      )}
      {blocker && publicKey && (state.trader || iso) && blocker !== "Enter a size" && <div className="why">{blocker}</div>}
      {publicKey && mine && state.trader && <OneClickPanel ok={ok} send={send} busy={busy} />}
      </div>
      {!blocker && want > vaultMax && <div className="why">The vault takes {units(vaultMax)} {sym} on this side right now, so the order is cut to that.</div>}

      </>}
      {pendingHere && <Pending r={pendingHere} sym={sym} send={send} busy={busy} />}
      {!pendingHere && outcome && <div className="outcome" onClick={() => setOutcome(undefined)}>{outcome}</div>}
      {mode === "market" && want > 0n && <p className="fine" title={`${C.EXPIRY_DEPOSIT_BPS / 100}% of the order, at most ${Number(C.EXPIRY_DEPOSIT_CAP) / 1e9} ${C.COIN}. It is kept only if the order's price arrived and the order still expired while the market was current.`}>
        Deposit {(Number(C.expiryDeposit(sent, state.asset.price)) / 1e9).toFixed(4)} {C.COIN}, returned when it fills.
      </p>}
    </div>
  );
}

/** The position held on this market now, above the order form. */
function CurrentPosition({ held, sym }: { held: bigint; sym: string }) {
  return (
    <div className="otype" title="Your position on this market in the account shown (cross or isolated)">
      <span>Current position</span>
      <b className={`mono ${held > 0n ? "up" : held < 0n ? "down" : ""}`}>{held === 0n ? `0 ${sym}` : `${held > 0n ? "+" : "−"}${units(abs(held))} ${sym}`}</b>
    </div>
  );
}

/** What a standing order sets aside for whoever carries it out (only once the router pays keepers
 *  on this network). Unused, it comes back with the order. */
function KeeperLine({ lamports }: { lamports: number }) {
  if (!C.KEEPER_REWARDS) return null;
  return (
    <div title={`Kept with the order and paid to whoever carries it out when its price is reached: ${(C.KEEPER_FEE / 1e9).toFixed(4)} ${C.COIN} each time, plus the cost of queuing its trade. Anyone can run an executor and earn it. What is not used comes back to you when the order ends or you cancel it.`}>
      <span>Keeper budget</span><b className="mono">{(lamports / 1e9).toFixed(4)} {C.COIN}<i className="muted"> back if unused</i></b>
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
        <CurrentPosition held={held} sym={sym} />
        <label className="inp"><span>Limit price</span><input value={limit} onChange={digits(setLimit)} placeholder={fmt(priceN, dp)} inputMode="decimal" /><button className="unit" onClick={() => setLimit(String(+priceN.toFixed(dp)))}>Mark</button></label>
        <label className="inp"><span>Size</span><input value={size} onChange={digits(setSize)} placeholder="0.00" inputMode="decimal" /><em>{sym}</em></label>
        <label className="check" title={REDUCE_ONLY_HELP}><input type="checkbox" checked={reduce} onChange={e => setReduce(e.target.checked)} />Reduce only (never opens or flips a position)</label>
        <div className="sum">
          <div><span>Order value</span><b className="mono">{money(n(size) * (px || priceN))}</b></div>
          <div><span>Carried out when the price is</span><b className="mono">{px ? `${side > 0n ? "≤" : "≥"} ${fmt(px, dp)}` : "—"}</b></div>
          <KeeperLine lamports={C.keeperBudget(C.ORDER.LIMIT)} />
        </div>
        <button className={`submit ${side > 0n ? "up" : "down"}`} disabled={!!why || !!busy || !ready} onClick={() => publicKey && send(`Limit ${side > 0n ? "buy" : "sell"} ${size} ${sym} at ${limit}`, [C.placeOrder(publicKey, v.key, { index: free[0], kind: C.ORDER.LIMIT, reduceOnly: reduce, size: q, trigger: e6(px) }, state.sub)])}>
          {busy ? `${busy}…` : `Place limit ${side > 0n ? "buy" : "sell"}`}
        </button>
        {why && why !== "Enter a size" && <div className="why">{why}</div>}
        {!why && marketable && <div className="why">The price is already {side > 0n ? "at or below" : "at or above"} this limit, so the order is carried out right away.</div>}
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
      if (t) ixs.push(C.placeOrder(publicKey, v.key, { index: free[i++], kind: C.ORDER.TAKE, size: 0n, trigger: e6(t) }, state.sub));
      if (s) ixs.push(C.placeOrder(publicKey, v.key, { index: free[i++], kind: C.ORDER.STOP, size: 0n, trigger: e6(s) }, state.sub));
      if (tr) ixs.push(C.placeOrder(publicKey, v.key, { index: free[i++], kind: C.ORDER.TRAIL, size: 0n, trigger: BigInt(Math.round(tr * 100)) }, state.sub));
      send("Set TP / SL", ixs);
    };
    const pnl = (x: number) => (x && held !== 0n ? signedMoney((x - priceN) * num(held, 1e6)) : "—");
    return (
      <div className="sform">
        <div className="otype"><span>{held === 0n ? "No position" : `Protects your ${long ? "long" : "short"} ${units(abs(held))} ${sym}`}</span><span className="hint" title="Each closes the whole position. When one fills, the others are removed.">closes the whole position</span></div>
        <label className="inp"><span>Take profit</span><input value={tp} onChange={digits(setTp)} placeholder={fmt(priceN * (long ? 1.05 : 0.95), dp)} inputMode="decimal" /><em>{pnl(t)}</em></label>
        <label className="inp"><span>Stop loss</span><input value={sl} onChange={digits(setSl)} placeholder={fmt(priceN * (long ? 0.95 : 1.05), dp)} inputMode="decimal" /><em>{pnl(s)}</em></label>
        <label className="inp"><span>Trailing stop</span><input value={trail} onChange={digits(setTrail)} placeholder="2.0" inputMode="decimal" /><em>% back from the best price</em></label>
        {C.KEEPER_REWARDS && count > 0 && <div className="sum"><KeeperLine lamports={count * C.keeperBudget(C.ORDER.STOP)} /></div>}
        <button className="submit neutral" disabled={!!why || !!busy || !ready} onClick={place}>{busy ? `${busy}…` : count > 1 ? `Set ${count} orders` : "Set order"}</button>
        {why && <div className="why">{why}</div>}
        {!why && (slNow || tpNow) && <div className="why">{slNow ? "The price is already past this stop" : "The price has already reached this take-profit"}, so it is carried out right away.</div>}
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
      <label className="check" title={REDUCE_ONLY_HELP}><input type="checkbox" checked={reduce} onChange={e => setReduce(e.target.checked)} />Reduce only (never opens or flips a position)</label>
      <div className="sum">
        <div><span>Each slice</span><b className="mono">{k >= 2 && total ? `${fmt(total / k, 4).replace(/\.?0+$/, "")} ${sym} (${money(total / k * priceN)})` : "—"}</b></div>
        <div><span>One slice every</span><b className="mono">{interval ? (interval >= 120 ? `${fmt(interval / 60, 1)} min` : `${interval} s`) : "—"}</b></div>
        <div><span>Total value</span><b className="mono">{money(total * priceN)}</b></div>
        {k >= 2 && <KeeperLine lamports={C.keeperBudget(C.ORDER.TWAP, k)} />}
      </div>
      <button className={`submit ${side > 0n ? "up" : "down"}`} disabled={!!why || !!busy || !ready} onClick={() => { if (!publicKey) return; const at = free[0], q = e6(total) * side; send(`TWAP ${side > 0n ? "buy" : "sell"} ${size} ${sym}`, [C.placeOrder(publicKey, v.key, { index: at, kind: C.ORDER.TWAP, reduceOnly: reduce, size: q, trigger: 0n, interval, slices: k }, state.sub)]).then(sig => sig && keepTwapPlan(C.orderAddress(v.key, C.accountOwner(publicKey, state.sub), at), { total: q, slices: k, sig })); }}>
        {busy ? `${busy}…` : `Start TWAP ${side > 0n ? "buy" : "sell"}`}
      </button>
      {why && why !== "Enter a size" && <div className="why">{why}</div>}
    </div>
  );
}

function Pending({ r, sym, send, busy }: { r: C.RouterRequest; sym: string; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), 250); return () => clearInterval(id); }, []);
  // (Slot time on X1: the target is a slot, shown as the time it is expected at.)
  const at = C.routerUnix(r.target) || now + C.ROUTER_WAIT_SECS;
  const left = at - now;
  const done = Math.min(100, Math.max(0, (1 - left / C.ROUTER_WAIT_SECS) * 100));
  // Nobody filled it in time (the executor is down or far behind). Anyone may then remove it, so
  // the wallet does not have to wait for the executor to come back before it can trade again.
  // (A few seconds are allowed for the chain's clock running behind this one.)
  const expiresIn = at + C.ROUTER_GRACE_SECS - now;
  const late = expiresIn < -5;
  return (
    <div className="pending">
      <div className="pending-t">
        <b>{r.size === 0n ? `Close-out of ${sym}` : `${r.size > 0n ? "Long" : "Short"} ${units(abs(r.size))} ${sym}`}</b>
        <span className="mono">{left > 0 ? `price set in ${left < 1 ? left.toFixed(1) : Math.ceil(left)} s` : late ? "not filled in time" : left > -20 ? "filling…" : `still waiting, expires in ${Math.max(1, Math.ceil(expiresIn))} s`}</span>
      </div>
      <div className="pending-bar"><i style={{ width: `${done}%` }} /></div>
      {late && <div className="fine">This order was not filled within {C.ROUTER_GRACE_SECS} s and has traded nothing. Remove it to place a new one.</div>}
      {late && publicKey && <button className="btn tiny" disabled={!!busy} onClick={() => send("Remove expired order", [C.expireRequest(publicKey, r)])}>Remove it</button>}
    </div>
  );
}

// ---------------------------------------------------------------- account

function Account({ state, send, busy, held, row, vaults, accounts }: { state: C.State; send: Send; busy?: string; held: Held[]; row?: S.TraderRow; vaults: C.Vault[]; accounts: AcctView[] }) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  // Every account of the wallet together (main and isolated): its money is all of it.
  const totalEquity = accounts.reduce((t, a) => t + a.health.equity, 0n);
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
  // Fees owed to the vaults (router `carry`): paid into them, out of the margin, in the same
  // transaction as a withdrawal (the router refuses a withdrawal while any is owed).
  const owed = C.totalOwed(state.owed);
  const vaultOf = (asset: number) => vaults.find(x => x.assetIndex === asset && x.canonical) ?? vaults.find(x => x.assetIndex === asset);
  const sub = state.sub;
  const payAll = (u: PublicKey) => state.owed.flatMap(o => { const x = vaultOf(o.asset); return x ? [C.payFees(x, u, sub)] : []; });
  return (
    <>
      <div className="ph"><h3>{sub ? `Isolated ${state.vault.feed?.symbol ?? ""} account` : "Account"}{h && h.notional > 0n && <span className="lev mono">{fmt(num(h.notional, 1e6) / Math.max(num(h.equity, 1e6), 0.01), 1)}×</span>}</h3><Faucet compact /></div>
      {!publicKey ? <div className="quiet">Connect a wallet to see your account.</div> : (
        <div className="acct">
          {accounts.length > 1 && <div className="acct-row" title="Your main account and every isolated account added up"><span>All accounts</span><b className="mono">{usd(totalEquity)}</b></div>}
          <div className="acct-row"><span>{accounts.length > 1 ? (state.sub ? "This isolated account" : "Cross account") : "Equity"}</span><b className="mono">{usd(equity)}</b></div>
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
          {owed > 0n && <div className="acct-row" title="Holding fees, crowded-side fees and liquidation fees owed to the vaults' depositors. They count against your margin and are paid out of it when you withdraw."><span>Owed to vaults</span><b className="mono down">{usd(owed)}</b></div>}
          <div className="acct-row"><span>Wallet test USDC</span><b className="mono">{usd(state.userCollateral)}</b></div>
          <div className="health">
            <div className="health-l"><span>Margin health</span><b className={`mono ${used > 75 ? "down" : ""}`}>{ratio === undefined ? "no position" : `${fmt(ratio * 100, 1)}% · liquidated below ${fmt((h && h.notional > 0n ? num(h.floor, 1e6) / num(h.notional, 1e6) : 0) * 100, 1)}%`}</b></div>
            <div className="health-bar"><i className={used > 75 ? "bad" : ""} style={{ width: `${used}%` }} /></div>
          </div>
          {state.trader && (
            <>
              <div className="move">
                <label className="inp small"><span>USDC</span><input value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" /></label>
                <button className="btn white" disabled={!!busy || atoms <= 0n || atoms > state.userCollateral} onClick={() => send(sub ? `Add margin to isolated ${state.vault.feed?.symbol ?? ""}` : "Add margin", [ata(publicKey), C.routerDeposit(publicKey, atoms, sub)])}>Deposit</button>
                <button className="btn" disabled={!!busy || locked || state.openPositions > 0 || atoms <= 0n || atoms + owed > (p?.capital ?? 0n) + profit} onClick={() => send(owed > 0n ? "Pay fees and withdraw" : "Withdraw margin", [ata(publicKey), ...(profit > 0n ? [C.crank(publicKey, C.routerPortfolio(publicKey, sub), [state.vault.assetIndex]), C.routerConvertPnl(publicKey, sub)] : []), ...payAll(publicKey), C.routerWithdraw(publicKey, atoms, sub)])}>Withdraw</button>
              </div>
              {state.sub !== 0 && state.openPositions === 0 && equity > 0n && !locked && (
                <button className="btn white wide" disabled={!!busy} onClick={() => returnMargin(connection, publicKey, state.sub, vaults).then(ixs => { if (ixs.length) send(`Return ${usd(equity)} to wallet`, ixs); })} title="The position is closed: everything left in this isolated account (after any fees it owes the vault) goes back to your wallet">Return {usd(equity)} to wallet</button>
              )}
              {locked ? <div className="fine">Withdrawals are paused while an order is queued.</div>
                : state.openPositions > 0 && <div className="fine">{sub ? "Margin can be withdrawn once this position is closed." : "Margin can be withdrawn once no position is open on any market."} Deposits always work.</div>}
              {owed > 0n && state.openPositions === 0 && <div className="fine">A withdrawal first pays the {usd(owed)} owed to the vaults, out of your margin.</div>}
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- positions, history, market

const REDUCE_ONLY_HELP = "The order may only shrink the position you hold. If you have no position, or it is already on the order's side, the order is dropped instead of opening one; a slice bigger than what is left is cut to what closes it.";

/** The wallet's standing orders on other markets than the one on screen (that one's come with
 *  its state), so each position can show its take-profit, stop and trail. */
function useOrdersOn(where: { vault: PublicKey; sub: number }[], tick: number) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [orders, setOrders] = useState(new Map<string, C.StandingOrder[]>());
  const keys = [...new Set(where.map(w => `${w.vault.toBase58()}:${w.sub}`))].sort().join(",");
  useEffect(() => {
    if (!publicKey || !keys) { setOrders(new Map()); return; }
    let on = true;
    const vs = keys.split(",").map(k => { const [v, n] = k.split(":"); return { vault: new PublicKey(v), sub: Number(n) }; });
    const addrs = vs.flatMap(w => Array.from({ length: C.MAX_ORDERS }, (_, i) => C.orderAddress(w.vault, C.accountOwner(publicKey, w.sub), i)));
    connection.getMultipleAccountsInfo(addrs, "confirmed").then(accs => {
      if (!on) return;
      const m = new Map<string, C.StandingOrder[]>();
      accs.forEach((a, i) => { if (a?.data.length === C.ORDER_LEN) { const o = C.decodeOrder(addrs[i], new Uint8Array(a.data)); const k = `${o.vault.toBase58()}:${o.sub}`; m.set(k, [...(m.get(k) ?? []), o]); } });
      setOrders(m);
    }).catch(() => { /* kept as last read */ });
    return () => { on = false; };
    // Read again every few ticks; the market on screen has its own, fresher copy.
  }, [connection, publicKey?.toBase58(), keys, Math.floor(tick / 4)]);
  return orders;
}

/** A TWAP's full size and slice count. The chain keeps only what is left, so they are taken
 *  from the transaction that placed it (kept in the browser when placed from this page). */
type TwapPlan = { total: bigint; slices: number; sig?: string };
const TWAP_KEY = (order: PublicKey) => `pv:twap:${C.NETWORK}:${order.toBase58()}`;
function keepTwapPlan(order: PublicKey, plan: TwapPlan) {
  try { localStorage.setItem(TWAP_KEY(order), JSON.stringify({ total: plan.total.toString(), slices: plan.slices, sig: plan.sig })); } catch { /* storage off */ }
}
function keptTwapPlan(order: PublicKey): TwapPlan | undefined {
  try { const j = JSON.parse(localStorage.getItem(TWAP_KEY(order)) ?? "null"); return j ? { total: BigInt(j.total), slices: j.slices, sig: j.sig } : undefined; } catch { return undefined; }
}
const i128le = (d: Uint8Array, o: number) => { let x = 0n; for (let i = 15; i >= 0; i--) x = (x << 8n) | BigInt(d[o + i]); return x >= 1n << 127n ? x - (1n << 128n) : x; };
async function findTwapPlan(conn: Connection, o: C.StandingOrder): Promise<TwapPlan | undefined> {
  // Newest first: the same order slot can have held earlier orders.
  const sigs = await conn.getSignaturesForAddress(o.key, { limit: 12 }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const msg = tx?.transaction.message;
    if (!msg) continue;
    const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined });
    for (const ix of msg.compiledInstructions) {
      const d = ix.data;
      if (!keys.get(ix.programIdIndex)?.equals(C.ROUTER) || (d.length !== 48 && d.length !== 56) || d[0] !== 12 || d[1] !== o.index || d[2] !== C.ORDER.TWAP) continue;
      const plan = { total: i128le(d, 4), slices: new DataView(d.buffer, d.byteOffset + 36, 4).getUint32(0, true), sig: s.signature };
      keepTwapPlan(o.key, plan);
      return plan;
    }
  }
  return undefined;
}
function useTwapPlans(twaps: C.StandingOrder[]) {
  const { connection } = useConnection();
  const [plans, setPlans] = useState(new Map<string, TwapPlan | null>());
  const ids = twaps.map(o => o.key.toBase58()).join(",");
  useEffect(() => {
    let on = true;
    for (const o of twaps) {
      const k = o.key.toBase58();
      if (plans.has(k)) continue;
      const kept = keptTwapPlan(o.key);
      // A kept plan for an earlier order in the same slot would not add up: look it up again.
      if (kept && (kept.total < 0n) === (o.size < 0n) && abs(kept.total) >= abs(o.size)) { setPlans(m => new Map(m).set(k, kept)); continue; }
      findTwapPlan(connection, o).then(p => on && setPlans(m => new Map(m).set(k, p ?? null))).catch(() => on && setPlans(m => new Map(m).set(k, null)));
    }
    return () => { on = false; };
  }, [connection, ids]);
  return plans;
}

/** Take-profit, stop and trail levels of one position, as small coloured tags. */
function Protection({ orders, dp }: { orders: C.StandingOrder[]; dp: number }) {
  const mine = orders.filter(o => o.kind <= C.ORDER.TRAIL);
  if (!mine.length) return <span className="muted">—</span>;
  const part = (o: C.StandingOrder) => (o.size === 0n ? "" : ` · ${units(o.size)}`);
  return (
    <span className="prot">
      {mine.sort((a, b) => a.kind - b.kind).map(o => {
        if (o.kind === C.ORDER.TRAIL) {
          const stop = num(o.peak, 1e6) * (1 - o.side * Number(o.trigger) / 10_000);
          return <span key={o.index} className="ptag trail" title={`Closes ${o.size === 0n ? "the whole position" : units(o.size)} once the price comes back ${fmt(Number(o.trigger) / 100, 2)}% from the best price since it was set (${fmt(num(o.peak, 1e6), dp)})`}>Trail {fmt(Number(o.trigger) / 100, 2).replace(/\.?0+$/, "")}% <i>@ {fmt(stop, dp)}</i>{part(o)}{o.queued ? " · filling" : ""}</span>;
        }
        const tp = o.kind === C.ORDER.TAKE;
        return <span key={o.index} className={`ptag ${tp ? "tp" : "sl"}`} title={`${tp ? "Take profit" : "Stop loss"}: closes ${o.size === 0n ? "the whole position" : units(o.size)} once the price reaches ${fmt(num(o.trigger, 1e6), dp)}`}>{tp ? "TP" : "SL"} {fmt(num(o.trigger, 1e6), dp)}{part(o)}{o.queued ? " · filling" : ""}</span>;
      })}
    </span>
  );
}

function Bottom({ state, markets, fills, held, liq, send, busy, go, tick, accounts, setMargin }: {
  state: C.State; markets: Card[]; fills: Fill[]; held: Held[]; liq?: number; send: Send; busy?: string; go: (to: string) => void; tick: number; accounts: AcctView[]; setMargin: (m: MarginMode) => void;
}) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [tab, setTab] = useState<"positions" | "orders" | "twap" | "history" | "vault" | "market">("positions");
  const [rowPct, setRowPct] = useState<Map<string, number>>(new Map());
  const rk = (x: { sub: number; asset: number }) => `${x.sub}:${x.asset}`;
  const pctOf = (x: { sub: number; asset: number }) => rowPct.get(rk(x)) ?? 100;
  const isHere = (x: Held) => x.asset === state.vault.assetIndex && x.sub === state.sub;
  const others = useOrdersOn(held.flatMap(x => { const c = markets.find(m => m.v.assetIndex === x.asset && (m.v.canonical || m.v.key.equals(state.vault.key))); return c && !isHere(x) ? [{ vault: c.v.key, sub: x.sub }] : []; }), tick);
  const standing = state.orders.filter(o => o.kind !== C.ORDER.TWAP), twaps = state.orders.filter(o => o.kind === C.ORDER.TWAP);
  const plans = useTwapPlans(twaps);
  const v = state.vault, sym = v.feed?.symbol ?? "";
  const positions = held;
  const byAsset = new Map(markets.filter(c => c.v.canonical || c.v.key.equals(v.key)).map(c => [c.v.assetIndex, c]));
  const locked = !!state.trader?.hasPending;

  // Close a share of a position on any market (a close-only market closes it out instead, whole).
  const closeShare = async (vault: PublicKey, asset: number, sub: number, q: bigint, shut: boolean, s: string, pct: number) => {
    if (!publicKey || q === 0n) return;
    const tag = sub ? " isolated" : "";
    if (shut) { send(`Close ${s}${tag} position`, [C.requestClose(publicKey, publicKey, vault, sub)]); return; }
    const part = await closeSize(connection, publicKey, asset, pct, sub);
    if (part !== 0n) send(pct >= 100 ? `Close ${s}${tag} position` : `Close ${pct}% of ${s}${tag} (${units(abs(part))})`, [C.requestTrade(publicKey, vault, part, { sub, closeOnly: true })]);
  };
  // Isolated accounts with no position but money left in them: one click brings it back.
  const idle = accounts.filter(a => a.sub !== 0 && a.health.positions.length === 0 && a.health.equity > 10_000n);
  const vaultsList = markets.map(c => c.v);
  const idleList = publicKey && idle.length > 0 && (
    <div className="elsewhere">
      <span>Margin left in closed isolated accounts:</span>
      {idle.map(a => {
        const c = markets.find(m => C.isolatedSub(m.v.assetIndex) === a.sub && m.v.canonical);
        return <button key={a.sub} className="link" disabled={!!busy} onClick={() => returnMargin(connection, publicKey, a.sub, vaultsList).then(ixs => { if (ixs.length) send(`Return ${usd(a.health.equity)} to wallet`, ixs); })} title="Back to your wallet (after any fees it owes the vault)">{c?.v.feed?.symbol ?? `#${a.sub}`} {usd(a.health.equity)} <i>return to wallet</i></button>;
      })}
    </div>
  );
  const nav = C.navOf(state);
  return (
    <>
      <div className="ptabs wide">
        <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>Positions{positions.length ? <em>{positions.length}</em> : null}</button>
        <button className={tab === "orders" ? "on" : ""} onClick={() => setTab("orders")}>Open orders{standing.length ? <em>{standing.length}</em> : null}</button>
        <button className={tab === "twap" ? "on" : ""} onClick={() => setTab("twap")}>TWAP{twaps.length ? <em>{twaps.length}</em> : null}</button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>Trade history</button>
        <button className={tab === "vault" ? "on" : ""} onClick={() => setTab("vault")}>Vault capacity</button>
        <button className={tab === "market" ? "on" : ""} onClick={() => setTab("market")}>Market details</button>
      </div>
      <div className="bottom-body">
        {tab === "positions" && (!publicKey ? <div className="quiet">Connect a wallet to see your positions.</div> : positions.length === 0 ? <div className="quiet">No open positions.{idleList}</div> : (<>
          <table className="tbl lefts">
            <thead><tr><th>Market</th><th>Size</th><th>Value</th><th title="Cross: the position's value divided by the leverage you chose for the market; all of your cross account stands behind every cross position. Isolated: everything in that position's own account, which is all that stands behind it.">Margin</th><th>Entry price</th><th>Mark price</th><th>PnL</th><th>Liq. price</th><th title="Take profit, stop loss and trailing stop set on this position">TP / SL</th><th>Close</th></tr></thead>
            <tbody>
              {positions.map(x => {
                const here = isHere(x);
                const c = byAsset.get(x.asset), s = x.sym;
                const { size, mark, entry: e, pnl } = x;
                const acctEq = x.acct ? num(x.acct.health.equity, 1e6) : 0;
                // An isolated position's leverage is its account's: value over the margin in it.
                const lev = x.sub ? Math.max(1, Math.round(x.value / Math.max(acctEq, 1e-9))) : leverageOf(state, s, x.asset);
                const liqX = here ? liq : x.acct && state.marketData ? liqIn(x.acct.health, state.marketData, x.asset, size, mark) : liquidationPriceOf(state, x.asset, size, mark);
                const shut = !!state.marketData && C.closeOnly(state.marketData, x.asset);
                const dp = priceDp(mark);
                return (
                  <Fragment key={rk(x)}>
                  <tr className={here ? "here" : ""}>
                    <td><button className={`link pos-name ${size > 0 ? "up" : "down"}`} title={`${size > 0 ? "Long" : "Short"} ${s} at ${lev}×, ${x.sub ? "isolated" : "cross"} margin (open this market)`} onClick={() => { if (!c) return; if (c.v.key.equals(state.vault.key)) { setMargin(x.sub ? "isolated" : "cross"); return; } saveMargin(c.v.key, x.sub ? "isolated" : "cross"); go(c.v.canonical ? `/trade/${s}` : `/m/${c.v.key.toString()}`); }}>{s} <i>{lev}×</i><em className="mtag">{x.sub ? "Isolated" : "Cross"}</em></button></td>
                    <td className={`mono ${size > 0 ? "up" : "down"}`}>{fmt(Math.abs(size), 4).replace(/\.?0+$/, "")} {s}</td>
                    <td className="mono">{money(x.value)}</td>
                    <td className="mono">{money(x.sub ? acctEq : x.value / lev)}</td>
                    <td className="mono">{e !== undefined ? fmt(e, dp) : "—"}</td>
                    <td className="mono">{fmt(mark, dp)}</td>
                    <td className={`mono pnl ${pnl === undefined ? "" : pnl >= 0 ? "up" : "down"}`} title={pnl === undefined ? "The entry price is not known: this wallet's earlier fills on this market are not on record" : "Against the average entry price, before fees; the percentage is the price move in your favour"}>{pnl === undefined ? "—" : <>{arrow(pnl)} {signedMoney(pnl)} <i>({pct(x.ret ?? 0)})</i></>}</td>
                    <td className="mono liqp">{liqX ? fmt(liqX, dp) : "—"}</td>
                    <td><Protection orders={here ? state.orders : (c && others.get(`${c.v.key.toBase58()}:${x.sub}`)) ?? []} dp={dp} /></td>
                    <td><span className="closeset">
                      {!shut && <CloseSlider compact pct={pctOf(x)} onChange={p => setRowPct(m => new Map(m).set(rk(x), p))} disabled={(here && locked) || !!busy || !c} />}
                      <button className="btn tiny" disabled={(here && locked) || !!busy || !c} onClick={() => c && closeShare(c.v.key, x.asset, x.sub, x.q, shut, s, shut ? 100 : pctOf(x))} title="Closes this share of the position at the next oracle price; slide to choose it">Close {shut || pctOf(x) >= 100 ? "all" : `${pctOf(x)}%`}</button>
                    </span></td>
                  </tr>
                  </Fragment>
                );
              })}
              {positions.length > 1 && (() => {
                const known = positions.filter(x => x.pnl !== undefined), total = known.reduce((t, x) => t + x.pnl!, 0);
                const margin = positions.filter(x => !x.sub).reduce((t, x) => t + x.value / leverageOf(state, x.sym, x.asset), 0)
                  + accounts.filter(a => a.sub && a.health.positions.length).reduce((t, a) => t + num(a.health.equity, 1e6), 0);
                return <tr className="total"><td colSpan={2}>Total</td><td className="mono">{money(positions.reduce((t, x) => t + x.value, 0))}</td><td className="mono">{money(margin)}</td><td colSpan={2} /><td className={`mono pnl ${total >= 0 ? "up" : "down"}`}>{known.length ? <>{arrow(total)} {signedMoney(total)}</> : "—"}</td><td colSpan={3} /></tr>;
              })()}
            </tbody>
          </table>
          {idleList}
        </>))}
        {tab === "orders" && (!publicKey ? <div className="quiet">Connect a wallet to see your orders.</div> : standing.length === 0 ? <div className="quiet">No open orders on {sym}. Limit, TP / SL and trailing stop orders are placed from the order ticket; TWAP orders are in their own tab.</div> : (
          <table className="tbl lefts">
            <thead><tr><th>Market</th><th>Type</th><th>Side</th><th className="r">Size</th><th className="r">Trigger</th><th className="r">Mark price</th><th>Status</th><th /></tr></thead>
            <tbody>
              {standing.map(o => {
                const protective = o.kind <= C.ORDER.TRAIL;
                const buys = protective ? o.side < 0 : o.size > 0n;
                const mark = num(state.asset.price, 1e6), dpp = priceDp(mark);
                const trig = o.kind === C.ORDER.TRAIL ? `${fmt(Number(o.trigger) / 100, 2)}% from ${fmt(num(o.peak, 1e6), dpp)}`
                  : o.kind === C.ORDER.TWAP ? `${units(o.slice)} every ${o.interval >= 120 ? `${fmt(o.interval / 60, 1)} min` : `${o.interval} s`}`
                  : `${o.kind === C.ORDER.LIMIT ? (buys ? "≤ " : "≥ ") : ""}${fmt(num(o.trigger, 1e6), dpp)}`;
                return (
                  <tr key={o.index}>
                    <td>{sym}</td>
                    <td>{ORDER_NAME[o.kind]}{o.reduceOnly && !protective ? " · reduce only" : ""}</td>
                    <td className={buys ? "up" : "down"}>{buys ? "Buy" : "Sell"}</td>
                    <td className="r mono">{protective ? (o.size === 0n ? "whole position" : units(o.size)) : `${units(abs(o.size))} left`}</td>
                    <td className="r mono">{trig}</td>
                    <td className="r mono">{fmt(mark, dpp)}</td>
                    <td>{o.queued ? "queued: filling at the next price" : o.kind === C.ORDER.TWAP ? `next slice ${o.nextTime * 1000 <= Date.now() ? "due" : `in ${Math.max(1, Math.round((o.nextTime * 1000 - Date.now()) / 1000))} s`}` : "waiting"}</td>
                    <td className="r"><button className="btn tiny" disabled={o.queued || !!busy} title={o.queued ? "Its queued request has to fill or expire first" : undefined} onClick={() => publicKey && send(`Cancel ${ORDER_NAME[o.kind].toLowerCase()}`, [C.cancelOrder(publicKey, v.key, o.index, state.sub)])}>Cancel</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
        {tab === "twap" && (!publicKey ? <div className="quiet">Connect a wallet to see your TWAP orders.</div> : twaps.length === 0 ? <div className="quiet">No running TWAP on {sym}. Start one from the TWAP tab of the order ticket; it shows here until its last slice has filled.</div> : (
          <table className="tbl lefts">
            <thead><tr><th>Market</th><th>Side</th><th className="r">Total</th><th className="r" title="Slices that have filled, and the size they traded">Filled</th><th className="r" title="Slices still to come, and the size left">Waiting</th><th>Progress</th><th className="r">Slice</th><th>Next slice</th><th /></tr></thead>
            <tbody>
              {twaps.map(o => {
                const buys = o.size > 0n, left = abs(o.size), plan = plans.get(o.key.toBase58());
                const total = plan ? abs(plan.total) : undefined, done = total !== undefined && total > left ? total - left : 0n;
                // The last slice takes what is left, so the count rounds up.
                const waitingN = o.slice > 0n ? Number((left + o.slice - 1n) / o.slice) : 0;
                const doneN = plan ? Math.max(0, plan.slices - waitingN) : undefined;
                const share = total ? Number(done * 10_000n / total) / 10_000 : undefined;
                const every = o.interval >= 120 ? `${fmt(o.interval / 60, 1)} min` : `${o.interval} s`;
                const due = o.nextTime * 1000 <= Date.now();
                return (
                  <tr key={o.index}>
                    <td>{sym}{o.reduceOnly ? <i className="muted" title={REDUCE_ONLY_HELP}> · reduce only</i> : null}</td>
                    <td className={buys ? "up" : "down"}>{buys ? "Buy" : "Sell"}</td>
                    <td className="r mono">{total !== undefined ? units(total) : plan === undefined ? "…" : "—"}</td>
                    <td className="r mono">{doneN !== undefined ? <>{doneN}<i className="muted"> / {plan!.slices}</i> · {units(done)}</> : "—"}</td>
                    <td className="r mono">{waitingN} · {units(left)}</td>
                    <td><span className={`twap-bar ${buys ? "up" : "down"}`} title={share !== undefined ? `${fmt(share * 100, 1)}% filled` : "The full size is not known yet"}><span style={{ width: `${(share ?? 0) * 100}%` }} /></span></td>
                    <td className="r mono">{units(o.slice)} every {every}</td>
                    <td>{o.queued ? "filling at the next price" : due ? "due now" : `in ${Math.max(1, Math.round((o.nextTime * 1000 - Date.now()) / 1000))} s`}</td>
                    <td className="r"><button className="btn tiny" disabled={o.queued || !!busy} title={o.queued ? "Its queued slice has to fill or expire first" : "Stops the TWAP; slices already filled stay filled"} onClick={() => publicKey && send("Cancel TWAP", [C.cancelOrder(publicKey, v.key, o.index, state.sub)])}>Cancel</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
        {tab === "history" && (!publicKey ? <div className="quiet">Connect a wallet to see your trades.</div> : fills.length === 0 ? <div className="quiet">No trades from this wallet on record yet.</div> : (() => {
          const symOf = (vault: string) => markets.find(c => c.v.key.toBase58() === vault)?.v.feed?.symbol ?? "?";
          // Positions now, by vault: the history is worked out backwards from them.
          const now = new Map(held.flatMap(x => { const c = byAsset.get(x.asset); return c ? [[`${x.sub}:${c.v.key.toBase58()}`, x.size] as [string, number]] : []; }));
          const rows = realizedAll(fills, now);
          const fee = (f: Fill) => Math.abs(f.size) * f.price * C.feeBpsAt(f.slot) / 10_000;
          const booked = rows.reduce((t, f) => t + f.realized, 0), fees = rows.reduce((t, f) => t + fee(f), 0);
          return (
            <>
              <div className="hist-sum">
                <span title="Only trades whose position is known from flat are counted: older fills of this wallet may not be on record">Closed PnL on {rows.filter(f => f.known).length} of these {rows.length} trades</span><b className={`mono pnl ${booked >= 0 ? "up" : "down"}`}>{arrow(booked)} {signedMoney(booked)}</b>
                <span>fees</span><b className="mono">{money(fees)}</b>
                <span>after fees</span><b className={`mono pnl ${booked - fees >= 0 ? "up" : "down"}`}>{signedMoney(booked - fees)}</b>
              </div>
              <table className="tbl lefts">
                <thead><tr><th>Time</th><th>Market</th><th>Side</th><th className="r">Size</th><th className="r" title="For a trade that opened or added: its fill price. For a trade that reduced or closed: the position's average entry before it">Entry price</th><th className="r" title="The fill price of a trade that reduced or closed a position">Close price</th><th className="r">Value</th><th className="r">Fee</th><th className="r" title="What the trade booked when it reduced or closed a position: (price - average entry) x size closed, before fees">Closed PnL</th><th className="r">Transaction</th></tr></thead>
                <tbody>
                  {[...rows].reverse().map(f => (
                    <tr key={f.sig}>
                      <td className="mono muted">{ago(Math.max(0, (Number(state.slot) - f.slot) * C.slotSeconds()))}</td>
                      <td>{symOf(f.vault)}</td>
                      <td className={f.size > 0 ? "up" : "down"}>{f.size > 0 ? "Buy" : "Sell"}</td>
                      <td className="r mono">{fmt(Math.abs(f.size), 4).replace(/\.?0+$/, "")}</td>
                      <td className="r mono">{f.entry !== undefined ? fmt(f.entry, priceDp(f.entry)) : <span className="muted" title="This position was opened by fills that are not on record">—</span>}</td>
                      <td className="r mono">{f.close !== undefined ? <>{fmt(f.close, priceDp(f.close))}{f.flips && <i className="muted" title="This trade closed the position and opened one on the other side at the same price"> flip</i>}</> : <span className="muted">—</span>}</td>
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
              <div><span>Fill</span><b>{C.SLOT_TIME ? `first oracle price ${C.ROUTER_DELAY_SLOTS} to ${C.ROUTER_DELAY_SLOTS + C.ROUTER_BATCH_SLOTS - 1} slots (about ${C.ROUTER_WAIT_SECS} s) after the request, longer in a fast market` : `first oracle price ${C.ROUTER_DELAY_SECS}–${C.ROUTER_DELAY_SECS + C.ROUTER_BATCH_SECS - 1} s after the request`}</b></div>
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
              <div><span>Liquidity epoch</span><b>{String(v.epoch)}: {state.slot < v.epochStart + v.epochLen ? `ends in about ${Math.max(1, Math.ceil(Number(v.epochStart + v.epochLen - state.slot) * C.slotSeconds() / 60))} min` : v.pendingDeposit > 0n || v.pendingWithdraw > 0n ? "settling" : "no deposits or withdrawals waiting"}</b></div>
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
