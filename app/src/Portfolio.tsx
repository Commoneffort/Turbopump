// The wallet's own portfolio: every open position, what the account is worth and how it got
// there, results by market and by day, and trading statistics. Read from the same public accounts
// as the Trade page plus this wallet's own fill history. The wallet's main (cross-margin) account
// and its isolated accounts count as one: equity, positions, results and history add them up.
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import * as C from "./chain";
import * as S from "./social";
import { heldEverywhere, realizedAll, Held } from "./Desk";
import { Gauge, PnlChart, Ring, openTrader, positionsOf, useMarket } from "./TraderIntel";
import { Lean, useBoard } from "./Traders";
import { Card, fmt, num, priceDp, useAccounts, useCards, useDeepFills, useFillsBySub, useVault, useWalletFills } from "./shared";

const money = (x: number, dp?: number) => {
  const a = Math.abs(x), s = x < 0 ? "−" : "";
  return a >= 1e6 ? `${s}$${fmt(a / 1e6, 2)}M` : a >= 10_000 ? `${s}$${fmt(a / 1000, 1)}k` : `${s}$${fmt(a, dp ?? 2)}`;
};
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${money(Math.abs(x))}`;
const pct = (x: number, dp = 1) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, dp)}%`;
const tone = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "");
const DAY = 86_400;

export default function PortfolioPage({ tick, go }: { tick: number; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const { cards } = useCards(tick);
  const live = useMemo(() => (cards ?? []).filter(c => c.v.status === 1 && c.v.feed && c.v.canonical), [cards]);
  if (!publicKey) return (
    <main className="pf">
      <h1>Portfolio</h1>
      <div className="card pf-empty"><p>Connect a wallet to see your positions, results and trading statistics.</p><div className="connect"><WalletMultiButton /></div></div>
    </main>
  );
  if (!cards) return <div className="desk-msg">Loading markets…</div>;
  if (!live.length) return <div className="desk-msg">No market is open yet.</div>;
  return <Inner key={publicKey.toBase58()} markets={live} tick={tick} go={go} />;
}

function Inner({ markets, tick, go }: { markets: Card[]; tick: number; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const wallet = publicKey!.toBase58();
  // Any market's state carries the main account (cross margin); the isolated ones are read too.
  const { state } = useVault(markets[0].v.key, tick);
  const { accounts } = useAccounts(markets, tick);
  const { board } = useBoard(tick);
  const row = board?.rows.find(r => r.wallet === wallet);
  const recent = useWalletFills(publicKey, BigInt(tick));
  const need = useMemo(() => (state?.health?.positions ?? []).map(x => {
    const c = markets.find(m => m.v.assetIndex === x.asset);
    return c ? `${c.v.key.toBase58()}:${x.size}` : "";
  }).filter(Boolean).sort().join(","), [state, markets]);
  const mainFills = useDeepFills(publicKey, need, recent);
  const isoFills = useFillsBySub(publicKey, accounts.filter(a => a.sub).map(a => a.sub), tick);
  const fills = useMemo(() => [...mainFills.map(f => ({ ...f, sub: 0 })), ...[...isoFills.values()].flat()].sort((a, b) => a.slot - b.slot), [mainFills, isoFills]);
  const symOfVault = useMemo(() => new Map(markets.map(c => [c.v.key.toBase58(), c.v.feed!.symbol])), [markets]);
  const market = useMarket(tick);

  if (!state) return <div className="desk-msg">Reading your account…</div>;
  if (!state.trader && !accounts.length) return (
    <main className="pf">
      <h1>Portfolio</h1>
      <div className="card pf-empty"><p>This wallet has no trading account yet. Make your first trade and your portfolio fills in here.</p><button className="btn primary" onClick={() => go("/")}>Trade</button></div>
    </main>
  );

  // Every account together: the main one and each isolated one.
  const all = accounts.length ? accounts : [];
  const held = heldEverywhere(all, markets, fills, row);
  const equity = num(all.reduce((t, a) => t + a.health.equity, 0n), C.USDC);
  const inPos = num(all.reduce((t, a) => t + a.health.notional, 0n), 1e6);
  const floor = num(all.reduce((t, a) => t + a.health.floor, 0n), 1e6);
  const lev = equity > 0 ? inPos / equity : 0;
  const used = inPos > 0 ? Math.min(100, Math.max(0, (floor / Math.max(equity, 1e-9)) * 100)) : 0;
  const openPnl = held.reduce((t, x) => t + (x.pnl ?? 0), 0);
  const today = row?.days.length && row.days[row.days.length - 1].day === Math.floor(Date.now() / 86_400_000) ? row.days[row.days.length - 1].pnl : 0;

  // Closed results from this wallet's own fills (positions now known, so each fill's effect is too).
  const nowPos = new Map<string, number>();
  for (const x of held) { const c = markets.find(m => m.v.assetIndex === x.asset); if (c) nowPos.set(`${x.sub}:${c.v.key.toBase58()}`, x.size); }
  const rows = realizedAll(fills, nowPos);
  const closes = rows.filter(r => r.known && r.close !== undefined && Math.abs(r.realized) > 1e-9);
  const wins = closes.filter(r => r.realized > 0), losses = closes.filter(r => r.realized < 0);
  const sumWin = wins.reduce((t, r) => t + r.realized, 0), sumLoss = -losses.reduce((t, r) => t + r.realized, 0);
  const byMarket = new Map<string, { sym: string; realized: number; trades: number; volume: number; wins: number; closes: number }>();
  for (const r of rows) {
    const sym = symOfVault.get(r.vault) ?? "other";
    const m = byMarket.get(sym) ?? { sym, realized: 0, trades: 0, volume: 0, wins: 0, closes: 0 };
    m.trades++; m.volume += Math.abs(r.size) * r.price;
    if (r.known && r.close !== undefined && Math.abs(r.realized) > 1e-9) { m.realized += r.realized; m.closes++; if (r.realized > 0) m.wins++; }
    byMarket.set(sym, m);
  }
  const buyVol = rows.filter(r => r.size > 0).reduce((t, r) => t + Math.abs(r.size) * r.price, 0);
  const allVol = rows.reduce((t, r) => t + Math.abs(r.size) * r.price, 0);
  const st = row?.stats;

  const win = row ? S.winRatio(row) : undefined, lean = row ? S.leanOf(row) : { bull: 0.5, from: "none" as const };
  const symbolOf = (asset: number) => markets.find(c => c.v.assetIndex === asset)?.v.feed?.symbol ?? `#${asset}`;
  const risk = row ? positionsOf(row, market, symbolOf) : [];
  const longV = held.filter(x => x.size > 0).reduce((t, x) => t + x.value, 0), shortV = held.filter(x => x.size < 0).reduce((t, x) => t + x.value, 0);

  return (
    <main className="pf">
      <div className="pf-head">
        <div className="pf-who">
          <h1>Portfolio</h1>
          <span className="muted small mono">{wallet}</span>
        </div>
        <div className="pf-head-acts">
          {row && <Lean row={row} big />}
          <button className="btn ghost" onClick={() => openTrader(wallet)} title="What other traders see about you">My public profile</button>
          <button className="btn primary" onClick={() => go("/")}>Trade</button>
        </div>
      </div>

      <section className="pf-kpis">
        <Kpi label="Equity" value={money(equity)} sub={`${money(inPos)} in positions${all.length > 1 ? ` · ${all.length} accounts` : ""}`} />
        <Kpi label="Open PnL" value={signed(openPnl)} tone={tone(openPnl)} sub={`${held.length} position${held.length === 1 ? "" : "s"}`} />
        <Kpi label="Today" value={signed(today)} tone={tone(today)} sub="UTC day" />
        <Kpi label="All-time PnL" value={row ? signed(row.pnl) : "—"} tone={row ? tone(row.pnl) : ""} sub={row ? `${pct(row.roi)} return` : undefined} />
        <Kpi label="Win ratio" value={win === undefined ? "—" : `${fmt(win * 100, 0)}%`} tone={win === undefined ? "" : win >= 0.5 ? "up" : "down"} sub={row ? `${row.daysUp} of ${row.daysUp + row.daysDown} days up` : undefined} />
        <Kpi label="Closing trades won" value={closes.length ? `${fmt(wins.length / closes.length * 100, 0)}%` : "—"} sub={closes.length ? `${wins.length} of ${closes.length}` : "none closed yet"} />
        <Kpi label="Leverage" value={inPos > 0 ? `${fmt(lev, 2)}×` : "none"} sub={inPos > 0 ? `${money(Math.max(0, equity - floor))} above liquidation` : "no open position"} />
        <div className="pf-kpi" title="How much of your equity the liquidation level takes: at 100% the account is liquidated">
          <span>Margin used</span><b className={`mono ${used > 75 ? "down" : ""}`}>{inPos > 0 ? `${fmt(used, 0)}%` : "0%"}</b>
          <div className="health-bar"><i className={used > 75 ? "bad" : ""} style={{ width: `${used}%` }} /></div>
        </div>
      </section>

      <div className="pf-row pf-row-a">
        <section className="card pf-card">
          <h3>Profit over time</h3>
          {st && row ? <PnlChart stats={st} now={row.pnl} /> : <div className="quiet">Your track record appears here after your first trade is recorded.</div>}
        </section>
        <section className="card pf-card pf-dials">
          <div className="ti-dial">
            <h3>Win ratio</h3>
            <Ring value={win} />
            <div className="ti-dial-l mono"><span className="up">{row?.daysUp ?? 0} up</span><span className="down">{row?.daysDown ?? 0} down</span></div>
            <p className="muted small">{row?.profitFactor === undefined ? "No losing day yet." : `You make ${fmt(row.profitFactor, 2)} for every 1 you lose.`}</p>
          </div>
          <div className="ti-dial">
            <h3>Sentiment</h3>
            <Gauge bull={lean.bull} none={lean.from === "none"} />
            <div className="ti-dial-l mono"><span className="down">Bearish {fmt((1 - lean.bull) * 100, 0)}%</span><span className="up">Bullish {fmt(lean.bull * 100, 0)}%</span></div>
            <p className="muted small">{lean.from === "positions" ? `From your open positions: ${money(longV, 0)} long, ${money(shortV, 0)} short.` : lean.from === "trades" ? "Nothing open: from your recent trades." : "No positions or trades yet."}</p>
          </div>
        </section>
        <section className="card pf-card">
          <h3>Risk <em className="muted small">how far each position is from liquidation</em></h3>
          <Risk list={risk} equity={equity} used={used} />
        </section>
      </div>

      <div className="pf-row pf-row-b">
        <section className="card pf-card">
          <h3>Open positions</h3>
          <Exposure held={held} equity={equity} go={go} />
        </section>
        <section className="card pf-card">
          <h3>Calendar <em className="muted small">each trading day's result</em></h3>
          {row?.days.length ? <Calendar days={row.days} /> : <div className="quiet">No trading days on record yet.</div>}
        </section>
        <section className="card pf-card">
          <h3>Results by market <em className="muted small">closed trades in your fill history</em></h3>
          <ByMarket list={[...byMarket.values()].sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized))} />
        </section>
      </div>

      <div className="pf-row pf-row-b">
        <section className="card pf-card">
          <h3>Trading statistics</h3>
          <div className="pf-stats">
            <Stat k="Volume traded" v={st ? money(st.volume, 0) : money(allVol, 0)} />
            <Stat k="Trades" v={fmt(st?.trades ?? rows.length, 0)} />
            <Stat k="Average win" v={wins.length ? money(sumWin / wins.length) : "—"} tone="up" />
            <Stat k="Average loss" v={losses.length ? `−${money(sumLoss / losses.length)}` : "—"} tone="down" />
            <Stat k="Profit factor" v={row?.profitFactor !== undefined ? fmt(row.profitFactor, 2) : sumLoss > 0 ? fmt(sumWin / sumLoss, 2) : "—"} title="Winning days (or trades) added up, divided by losing ones: above 1 makes money" />
            <Stat k="Best day" v={st ? signed(st.bestDay) : "—"} tone="up" />
            <Stat k="Worst day" v={st ? signed(st.worstDay) : "—"} tone="down" />
            <Stat k="Largest drop from a high" v={st ? `−${money(st.maxDrawdown)}` : "—"} sub={row ? `${fmt(row.drawdownPct * 100, 1)}%` : undefined} />
            <Stat k="Buys / sells (recent fills)" v={allVol ? `${fmt(buyVol / allVol * 100, 0)}% / ${fmt((1 - buyVol / allVol) * 100, 0)}%` : "—"} />
            <Stat k="Deposited / withdrawn" v={st ? `${money(st.deposited, 0)} / ${money(st.withdrawn, 0)}` : "—"} />
            <Stat k="Trading since" v={st ? new Date(st.startTime * 1000).toLocaleDateString() : "—"} />
            <Stat k="Followers / copiers" v={row ? `${row.followers} / ${row.copiers}` : "—"} />
          </div>
        </section>
        <section className="card pf-card">
          <h3>When you trade <em className="muted small">fills by hour of day, your time</em></h3>
          <Hours times={[...rows.map(r => r.time ?? 0), ...(st?.fills ?? []).map(f => f.time)].filter(Boolean)} />
        </section>
        <section className="card pf-card">
          <h3>Wins and losses <em className="muted small">each closing trade's result</em></h3>
          <Spread values={closes.map(r => r.realized)} />
        </section>
      </div>

      <section className="card pf-card">
        <h3>Recent trades</h3>
        <TradeList rows={[...rows].reverse().slice(0, 80)} symOf={v => symOfVault.get(v) ?? "?"} />
      </section>
    </main>
  );
}

/** Each position's distance to its liquidation price, as a bar that shrinks as it gets close. */
function Risk({ list, equity, used }: { list: ReturnType<typeof positionsOf>; equity: number; used: number }) {
  if (!list.length) return <div className="quiet">No open position, nothing at risk.</div>;
  return (
    <div className="pf-risk">
      {list.map(p => {
        const d = p.dist ?? 1, bad = d < 0.03, warn = d < 0.1;
        return (
          <div key={p.asset} className="pf-risk-r" title={`${p.sym} ${p.size > 0 ? "long" : "short"}: liquidated at ${p.liq ? fmt(p.liq, priceDp(p.liq)) : "no price in reach"}, price now ${fmt(p.price, priceDp(p.price))}`}>
            <div className="pf-risk-h"><b>{p.sym}</b><em className={p.size > 0 ? "up" : "down"}>{p.size > 0 ? "Long" : "Short"}</em><span className="mono muted">liq. {p.liq ? fmt(p.liq, priceDp(p.liq)) : "—"}</span><span className={`mono ${bad ? "down" : ""}`}>{p.dist !== undefined ? `${fmt(p.dist * 100, 1)}% away` : "far"}</span></div>
            <div className="pf-risk-t"><i className={bad ? "bad" : warn ? "warn" : ""} style={{ width: `${Math.min(100, d / 0.3 * 100)}%` }} /></div>
          </div>
        );
      })}
      <p className="muted small">Bars are full at 30% or more away. Margin used: {fmt(used, 0)}% of {money(equity, 0)} equity.</p>
    </div>
  );
}

/** Trading days as a calendar (weeks in columns), green up and red down, deeper for bigger. */
function Calendar({ days }: { days: S.Day[] }) {
  const map = new Map(days.map(d => [d.day, d.pnl]));
  const last = Math.floor(Date.now() / 86_400_000), first = Math.min(days[0].day, last - 34);
  const start = first - ((first + 3) % 7); // Monday on top (day 0 was a Thursday)
  const top = Math.max(...days.map(d => Math.abs(d.pnl)), 1e-9);
  const weeks = Math.ceil((last - start + 1) / 7);
  const cell = 18, gap = 4, W = weeks * (cell + gap), H = 7 * (cell + gap);
  const total = days.reduce((t, d) => t + d.pnl, 0);
  return (
    <div className="pf-cal">
      <svg viewBox={`-26 -2 ${W + 28} ${H + 4}`} className="pf-cal-svg" role="img" aria-label={`Daily results calendar, ${signed(total)} in all`}>
        {["Mon", "Wed", "Fri"].map((n, i) => <text key={n} x={-4} y={i * 2 * (cell + gap) + cell - 5} textAnchor="end" className="pnlc-tick">{n}</text>)}
        {Array.from({ length: weeks * 7 }, (_, i) => {
          const day = start + i;
          if (day > last) return null;
          const v = map.get(day), x = Math.floor(i / 7) * (cell + gap), y = (i % 7) * (cell + gap);
          const f = v === undefined ? 0 : 0.25 + 0.75 * Math.sqrt(Math.abs(v) / top);
          return (
            <rect key={day} x={x} y={y} width={cell} height={cell} rx="4" className={v === undefined ? "pf-cal-none" : v >= 0 ? "pf-cal-up" : "pf-cal-down"} style={v === undefined ? undefined : { opacity: f }}>
              <title>{`${new Date(day * 86_400_000).toISOString().slice(0, 10)}: ${v === undefined ? "no trading" : signed(v)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="pf-days-l small mono"><span className={tone(total)}>{signed(total)} over {days.length} trading day{days.length === 1 ? "" : "s"}</span><span className="muted">{days.filter(d => d.pnl > 0).length} up · {days.filter(d => d.pnl < 0).length} down</span></div>
    </div>
  );
}

/** Fills by hour of the day (the browser's time zone). */
function Hours({ times }: { times: number[] }) {
  if (!times.length) return <div className="quiet">No fills read yet.</div>;
  const n = new Array(24).fill(0);
  for (const t of times) n[new Date(t * 1000).getHours()]++;
  const top = Math.max(...n, 1), busiest = n.indexOf(top);
  const W = 480, H = 140, bw = W / 24;
  return (
    <div className="pf-hours">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="pf-hours-svg" role="img" aria-label={`Busiest hour ${busiest}:00`}>
        <line x1="0" x2={W} y1={H} y2={H} className="pnlc-zero" />
        {n.map((c, h) => (
          <g key={h}>
            <title>{`${String(h).padStart(2, "0")}:00 – ${String(h).padStart(2, "0")}:59: ${c} fill${c === 1 ? "" : "s"}`}</title>
            <rect x={h * bw} y={0} width={bw} height={H} fill="transparent" />
            <rect x={h * bw + 2} y={H - (c / top) * (H - 6)} width={bw - 4} height={Math.max(c ? 2 : 0, (c / top) * (H - 6))} rx="3" className={h === busiest ? "pf-h-top" : "pf-h"} />
          </g>
        ))}
        {[0, 6, 12, 18, 23].map(h => <text key={h} x={h * bw + bw / 2} y={H + 14} textAnchor="middle" className="pnlc-tick">{String(h).padStart(2, "0")}</text>)}
      </svg>
      <p className="muted small">Busiest around {String(busiest).padStart(2, "0")}:00 · {times.length} fills counted.</p>
    </div>
  );
}

/** Closing trades' results sorted from worst to best: losses red on the left, wins green on the right. */
function Spread({ values }: { values: number[] }) {
  if (!values.length) return <div className="quiet">No closing trade read yet.</div>;
  const v = [...values].sort((a, b) => a - b), top = Math.max(...v.map(Math.abs), 1e-9);
  const W = 480, H = 140, mid = H / 2, bw = W / v.length;
  const won = v.filter(x => x > 0), lost = v.filter(x => x < 0);
  return (
    <div className="pf-spread">
      <svg viewBox={`0 0 ${W} ${H}`} className="pf-hours-svg" preserveAspectRatio="none" role="img" aria-label={`${won.length} wins and ${lost.length} losses`}>
        <line x1="0" x2={W} y1={mid} y2={mid} className="pnlc-zero" />
        {v.map((x, i) => { const h = Math.abs(x) / top * (mid - 4); return <rect key={i} x={i * bw + 0.5} y={x >= 0 ? mid - h : mid} width={Math.max(1, bw - 1)} height={Math.max(1, h)} rx={bw > 6 ? 2 : 0} className={x >= 0 ? "pnlc-up" : "pnlc-down"}><title>{signed(x)}</title></rect>; })}
      </svg>
      <div className="pf-days-l small mono"><span className="down">{lost.length} lost · {signed(lost.reduce((t, x) => t + x, 0))}</span><span className="up">{won.length} won · {signed(won.reduce((t, x) => t + x, 0))}</span></div>
    </div>
  );
}

function Kpi({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return <div className="pf-kpi"><span>{label}</span><b className={`mono ${tone}`}>{value}</b>{sub && <i className="muted">{sub}</i>}</div>;
}
function Stat({ k, v, sub, tone, title }: { k: string; v: string; sub?: string; tone?: string; title?: string }) {
  return <div className="pf-stat" title={title}><span>{k}</span><b className={`mono ${tone ?? ""}`}>{v}{sub && <i className="muted"> {sub}</i>}</b></div>;
}

/** Each open position as a bar of its value (share of equity), long green / short red, with its result. */
function Exposure({ held, equity, go }: { held: Held[]; equity: number; go: (to: string) => void }) {
  if (!held.length) return <div className="quiet">No open positions.</div>;
  const top = Math.max(...held.map(x => x.value), 1);
  const longV = held.filter(x => x.size > 0).reduce((t, x) => t + x.value, 0), shortV = held.filter(x => x.size < 0).reduce((t, x) => t + x.value, 0);
  return (
    <div className="pf-exp">
      <div className="pf-split" title={`Long ${money(longV)} · short ${money(shortV)}`}>
        <i className="up" style={{ flexGrow: longV || 0.0001 }} /><i className="down" style={{ flexGrow: shortV || 0.0001 }} />
      </div>
      <div className="pf-split-l small"><span className="up">Long {money(longV)}</span><span className="muted">net {signed(longV - shortV)}</span><span className="down">Short {money(shortV)}</span></div>
      {[...held].sort((a, b) => b.value - a.value).map(x => (
        <button key={`${x.sub}:${x.asset}`} className="pf-bar pf-pos" onClick={() => go(`/trade/${x.sym}`)} title={`${x.sym} ${x.size > 0 ? "long" : "short"} ${fmt(Math.abs(x.size), 4)} · value ${money(x.value)} (${equity > 0 ? fmt(x.value / equity * 100, 0) : "—"}% of equity)${x.entry ? ` · entry ${fmt(x.entry, priceDp(x.mark))}` : ""} · mark ${fmt(x.mark, priceDp(x.mark))}`}>
          <span className="pf-bar-n"><b>{x.sym}</b><em className={x.size > 0 ? "up" : "down"}>{x.size > 0 ? "Long" : "Short"}</em>{x.sub ? <em className="mtag">Isolated</em> : null}</span>
          <span className="pf-bar-t"><i className={x.size > 0 ? "up" : "down"} style={{ width: `${Math.max(2, x.value / top * 100)}%` }} /></span>
          <span className="mono pf-bar-v">{money(x.value, 0)}</span>
          <span className={`mono pf-bar-p ${x.pnl === undefined ? "" : tone(x.pnl)}`}>{x.pnl === undefined ? "—" : `${signed(x.pnl)} (${pct(x.ret ?? 0)})`}</span>
        </button>
      ))}
    </div>
  );
}

function ByMarket({ list }: { list: { sym: string; realized: number; trades: number; volume: number; wins: number; closes: number }[] }) {
  if (!list.length) return <div className="quiet">No trades in your fill history yet.</div>;
  const top = Math.max(...list.map(m => Math.abs(m.realized)), 1e-9);
  return (
    <div className="pf-bym">
      {list.map(m => (
        <div key={m.sym} className="pf-bym-r" title={`${m.sym}: ${m.trades} trades, ${money(m.volume, 0)} traded, ${m.closes ? `${m.wins} of ${m.closes} closing trades won` : "nothing closed yet"}`}>
          <b>{m.sym}</b>
          <span className="pf-div">
            <span className="neg">{m.realized < 0 && <i className="down" style={{ width: `${Math.abs(m.realized) / top * 100}%` }} />}</span>
            <span className="pos">{m.realized > 0 && <i className="up" style={{ width: `${m.realized / top * 100}%` }} />}</span>
          </span>
          <span className={`mono ${tone(m.realized)}`}>{signed(m.realized)}</span>
          <span className="mono muted small">{m.trades} trades</span>
        </div>
      ))}
    </div>
  );
}

function TradeList({ rows, symOf }: { rows: ReturnType<typeof realizedAll>; symOf: (vault: string) => string }) {
  if (!rows.length) return <div className="quiet">No trades read yet (your history is read from your wallet's transactions, a few at a time).</div>;
  return (
    <div className="pf-table">
      <table className="tbl">
        <thead><tr><th>Time</th><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Price</th><th className="r">Value</th><th className="r">Closed PnL</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={`${r.sig}:${r.vault}:${r.size}`}>
              <td className="mono muted">{r.time ? new Date(r.time * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
              <td>{symOf(r.vault)}</td>
              <td className={r.size > 0 ? "up" : "down"}>{r.size > 0 ? "Buy" : "Sell"}{r.flips ? " · flip" : ""}</td>
              <td className="r mono">{fmt(Math.abs(r.size), 4).replace(/\.?0+$/, "")}</td>
              <td className="r mono">{fmt(r.price, priceDp(r.price))}</td>
              <td className="r mono">{money(Math.abs(r.size) * r.price)}</td>
              <td className={`r mono ${tone(r.realized)}`}>{r.close !== undefined && r.known ? signed(r.realized) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
