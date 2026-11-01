// A trader's profile in a modal, opened from any trader name or badge on the site (`openTrader`):
// profit chart, open positions with their liquidation prices, performance, activity, leverage,
// margin used, direction bias, a plain-language read of how they trade, and follow / copy.
// Everything comes from the router's track record and the trader's portfolio (public accounts in
// the shared copy): nothing is self-reported.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import * as C from "./chain";
import * as S from "./social";
import { Badge, nameOf, tagOf, useActions, useBoard, useMe } from "./Traders";
import { Send, ago, explorer, fmt, priceDp, useCards } from "./shared";
import { view } from "./view";

// ---- which trader is open (one at a time, from anywhere) ----
let current: string | undefined;
const listeners = new Set<() => void>();
export function openTrader(wallet: string) { current = wallet; listeners.forEach(f => f()); }
const closeTrader = () => { current = undefined; listeners.forEach(f => f()); };
const useCurrent = () => useSyncExternalStore(f => { listeners.add(f); return () => { listeners.delete(f); }; }, () => current);

const money = (x: number, dp?: number) => {
  const a = Math.abs(x), s = x < 0 ? "−" : "";
  return a >= 1e6 ? `${s}$${fmt(a / 1e6, 2)}M` : a >= 10_000 ? `${s}$${fmt(a / 1000, 1)}k` : `${s}$${fmt(a, dp ?? 2)}`;
};
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${money(Math.abs(x)).replace("−", "")}`;
const pct = (x: number, dp = 1) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, dp)}%`;
const tone = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "");
const DAY = 86_400_000;

/** Rendered once by the app: the modal of whichever trader is open. */
export function TraderModalHost({ send, busy, tick, go }: { send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const wallet = useCurrent();
  useEffect(() => {
    if (!wallet) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closeTrader(); };
    document.addEventListener("keydown", esc);
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = before; };
  }, [wallet]);
  if (!wallet) return null;
  return (
    <div className="tmodal-back" onMouseDown={e => { if (e.target === e.currentTarget) closeTrader(); }}>
      <div className="tmodal" role="dialog" aria-modal="true" aria-label="Trader profile">
        <TraderIntel key={wallet} wallet={wallet} send={send} busy={busy} tick={tick} go={to => { closeTrader(); go(to); }} />
      </div>
    </div>
  );
}

/** The market account, for every asset's margins and prices (read once a minute). */
function useMarket(tick: number) {
  const [m, setM] = useState<Uint8Array>();
  const at = useRef(0);
  useEffect(() => {
    if (m && Date.now() - at.current < 60_000) return;
    view.getAccountInfo(C.MARKET).then(a => { if (a) { at.current = Date.now(); setM(new Uint8Array(a.data)); } }).catch(() => {});
  }, [tick]);
  return m;
}

function TraderIntel({ wallet, send, busy, tick, go }: { wallet: string; send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const { board, reload } = useBoard(tick);
  const { cards } = useCards(tick);
  const market = useMarket(tick);
  const me = useMe(board, tick);
  const act = useActions(me, send, reload);
  const [ratio, setRatio] = useState(10_000);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"positions" | "trades">("positions");
  const r = board?.rows.find(x => x.wallet === wallet);
  const s = r?.stats;
  const name = nameOf(wallet, r?.profile ?? board?.profiles.get(wallet)), tag = tagOf(wallet), isMe = wallet === me.wallet;
  const copying = me.copy?.leader.toBase58() === wallet ? me.copy : undefined;
  const symbol = (asset: number) => cards?.find(c => c.v.canonical && c.v.assetIndex === asset)?.v.feed?.symbol ?? `#${asset}`;

  // Positions with their prices, margins and liquidation prices (cross margin: each one's price
  // moving alone, the account's other positions held where they are).
  const positions = useMemo(() => {
    if (!r) return [];
    const lv = (a: number) => (market ? C.levels(market, a) : undefined);
    const priceOf = (a: number, fallback: number) => (market ? Number(C.decodeAsset(market, a).price) / 1e6 : fallback);
    return r.positions.filter(p => p.size !== 0).map(p => {
      const price = priceOf(p.asset, Math.abs(p.notional / p.size));
      const l = lv(p.asset) ? Number(lv(p.asset)!.liq) / 10_000 : 0.035;
      const otherFloor = r.positions.filter(q => q.asset !== p.asset).reduce((t, q) => t + Math.abs(q.notional) * (lv(q.asset) ? Number(lv(q.asset)!.liq) / 10_000 : 0.035), 0);
      const x = (otherFloor - r.equity + p.size * price) / (p.size - l * Math.abs(p.size));
      const liq = Number.isFinite(x) && x > 0 ? x : undefined;
      const open = lv(p.asset) ? Number(lv(p.asset)!.open) / 10_000 : 0.05;
      return { ...p, sym: symbol(p.asset), price, liq, dist: liq ? (p.size > 0 ? (price - liq) / price : (liq - price) / price) : undefined, margin: Math.abs(p.notional) * open };
    }).sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional));
  }, [r, market, cards]);

  const header = (
    <div className="ti-head">
      <Badge wallet={wallet} profile={r?.profile ?? board?.profiles.get(wallet)} size={46} />
      <div className="ti-name">
        <h2>{name}{tag && <em>{tag}</em>}{isMe && <em>you</em>}{r?.liquidatable && <em className="bad">below its liquidation level</em>}</h2>
        <div className="ti-addr mono">
          <span>{wallet}</span>
          <button onClick={() => { navigator.clipboard?.writeText(wallet).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); }}>{copied ? "copied" : "copy"}</button>
          <a href={explorer("address", wallet)} target="_blank" rel="noreferrer">explorer ↗</a>
          <button onClick={() => go(`/trader/${wallet}`)}>full page →</button>
        </div>
      </div>
      <div className="ti-acts">
        {!isMe && publicKey && (me.following.has(wallet)
          ? <button className="btn ghost" disabled={!!busy} onClick={() => act.unfollow(wallet, name)}>Following ✓</button>
          : <button className="btn ghost" disabled={!!busy} onClick={() => act.follow(wallet, name)}>Follow</button>)}
        {!isMe && publicKey && s && (copying
          ? <button className="btn ghost" disabled={!!busy} onClick={() => act.stop()}>Stop copying</button>
          : <button className="btn primary" disabled={!!busy} onClick={() => act.copy(wallet, name, ratio, 0n)}>Copy trades · {S.COPY_FEE_TEXT}</button>)}
        <button className="ti-close" onClick={closeTrader} aria-label="Close" title="Close (Esc)">×</button>
      </div>
    </div>
  );
  if (!board) return <>{header}<div className="quiet">Reading the chain…</div></>;
  if (!r || !s) return <>{header}<div className="quiet">This account has no track record on {C.NETWORK_NAME} yet. A record starts with its first trade here.</div></>;

  // ---- numbers ----
  const notional = positions.reduce((t, p) => t + Math.abs(p.notional), 0);
  const longN = positions.filter(p => p.size > 0).reduce((t, p) => t + Math.abs(p.notional), 0), shortN = notional - longN;
  const marginUsed = r.equity > 0 ? positions.reduce((t, p) => t + p.margin, 0) / r.equity : 0;
  const fills = s.fills;
  const buyVol = fills.filter(f => f.size > 0).reduce((t, f) => t + Math.abs(f.size * f.price), 0), sellVol = fills.filter(f => f.size < 0).reduce((t, f) => t + Math.abs(f.size * f.price), 0);
  const buyShare = buyVol + sellVol > 0 ? buyVol / (buyVol + sellVol) : 0.5;
  const daysSince = Math.max(1, (Date.now() / 1000 - s.startTime) / 86_400);
  const perDay = s.trades / daysSince, avgTrade = s.trades ? s.volume / s.trades : 0;
  const dailies = s.days.map(d => d.pnl);
  const ups = dailies.filter(x => x > 0), downs = dailies.filter(x => x < 0);
  const mean = dailies.length ? dailies.reduce((a, b) => a + b, 0) / dailies.length : 0;
  const sd = dailies.length > 1 ? Math.sqrt(dailies.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailies.length - 1)) : 0;
  const month = dailies.reduce((a, b) => a + b, 0);
  const atWork = s.startEquity + s.deposited;
  const markets = [...new Set(fills.map(f => symbol(f.asset)))];
  const tile = (label: string, value: string, cls = "", sub?: string, title?: string) => <div className="ti-tile" title={title}><span>{label}</span><b className={`mono ${cls}`}>{value}</b>{sub && <i>{sub}</i>}</div>;

  return (
    <>
      {header}
      <div className="ti-tiles">
        {tile("Account value", money(r.equity), "", `${money(atWork, 0)} paid in`, "Equity now: capital plus profit, positions marked at the oracle price")}
        {tile("Profit, all time", signed(r.pnl), tone(r.pnl), `since ${new Date(s.startTime * 1000).toISOString().slice(0, 10)}`)}
        {tile("Return", pct(r.roi), tone(r.roi), "on the money at work")}
        {tile("Last 30 trading days", signed(month), tone(month), `${s.days.length} day${s.days.length === 1 ? "" : "s"} with fills`)}
        {tile("Leverage", r.leverage > 0 ? `${fmt(r.leverage, 1)}×` : "flat", r.leverage > 10 ? "down" : "", `${money(notional, 0)} in positions`, "Everything it holds divided by its equity")}
        {tile("Margin used", `${fmt(marginUsed * 100, 0)}%`, marginUsed > 0.8 ? "down" : "", "of its equity", "The margin its positions need to stay open, against what it has")}
        {tile("Direction now", notional ? (longN >= shortN ? `${fmt(longN / notional * 100, 0)}% long` : `${fmt(shortN / notional * 100, 0)}% short`) : "flat", notional ? (longN >= shortN ? "up" : "down") : "", notional ? `${money(longN, 0)} long · ${money(shortN, 0)} short` : undefined)}
        {tile("Following it", `${r.copiers} copy`, "", `${r.followers} follow`)}
      </div>

      <div className="ti-top">
        <section className="ti-card ti-chart">
          <PnlChart stats={s} now={r.pnl} />
        </section>
        <section className="ti-card ti-book">
          <div className="ti-tabs">
            <button className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>Open positions <em>{positions.length}</em></button>
            <button className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>Trades <em>{fills.length}</em></button>
          </div>
          {tab === "positions" ? (positions.length === 0 ? <div className="quiet">No position open.</div> : (
            <div className="ti-scroll">
              <table className="tbl"><thead><tr><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Value</th><th className="r" title="Where the account would be liquidated if this price moved alone">Liq. price</th><th className="r">Distance</th><th className="r" title="Position value over the account's equity">Of account</th></tr></thead><tbody>
                {positions.map(p => (
                  <tr key={p.asset}>
                    <td><button className="link" onClick={() => go(`/trade/${p.sym}`)}>{p.sym}</button></td>
                    <td className={p.size > 0 ? "up" : "down"}>{p.size > 0 ? "Long" : "Short"}</td>
                    <td className="r mono">{fmt(Math.abs(p.size), 4).replace(/\.?0+$/, "")}</td>
                    <td className="r mono">{money(Math.abs(p.notional))}</td>
                    <td className="r mono">{p.liq ? fmt(p.liq, priceDp(p.liq)) : "—"}</td>
                    <td className={`r mono ${p.dist !== undefined && p.dist < 0.03 ? "down" : ""}`}>{p.dist !== undefined ? `${fmt(p.dist * 100, 1)}%` : "—"}</td>
                    <td className="r mono">{r.equity > 0 ? `${fmt(Math.abs(p.notional) / r.equity, 1)}×` : "—"}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )) : (fills.length === 0 ? <div className="quiet">No trade yet.</div> : (
            <div className="ti-scroll">
              <table className="tbl"><thead><tr><th>When</th><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Price</th><th className="r">Value</th></tr></thead><tbody>
                {[...fills].reverse().map((f, i) => <tr key={i}><td className="mono muted" title={new Date(f.time * 1000).toLocaleString()}>{ago(Date.now() / 1000 - f.time)}</td><td>{symbol(f.asset)}</td><td className={f.size > 0 ? "up" : "down"}>{f.size > 0 ? "Buy" : "Sell"}</td><td className="r mono">{fmt(Math.abs(f.size), 4).replace(/\.?0+$/, "")}</td><td className="r mono">{fmt(f.price, priceDp(f.price))}</td><td className="r mono">{money(Math.abs(f.size * f.price), 0)}</td></tr>)}
              </tbody></table>
              <p className="muted small">Its last {fills.length} trades, as its on-chain record keeps them ({fmt(s.trades, 0)} in all).</p>
            </div>
          ))}
        </section>
      </div>

      <div className="ti-grid3">
        <section className="ti-card">
          <h3>Performance</h3>
          <div className="ti-kv">
            <div><span>Profitable days</span><b className="mono">{r.daysUp} of {r.daysUp + r.daysDown}{r.daysUp + r.daysDown ? ` (${fmt(r.daysUp / (r.daysUp + r.daysDown) * 100, 0)}%)` : ""}</b></div>
            <div><span>Won ÷ lost</span><b className="mono">{r.profitFactor === undefined ? "—" : fmt(r.profitFactor, 2)}</b></div>
            <div><span>Avg winning / losing day</span><b className="mono"><span className="up">{ups.length ? signed(ups.reduce((a, b) => a + b, 0) / ups.length) : "—"}</span> / <span className="down">{downs.length ? signed(downs.reduce((a, b) => a + b, 0) / downs.length) : "—"}</span></b></div>
            <div><span>Best / worst day</span><b className="mono"><span className="up">{signed(Math.max(s.bestDay, ...dailies, 0))}</span> / <span className="down">{signed(Math.min(s.worstDay, ...dailies, 0))}</span></b></div>
            <div><span>Largest fall from its best</span><b className="mono">{r.drawdownPct >= 0.0005 ? `−${fmt(r.drawdownPct * 100, 1)}%` : "—"}</b></div>
            <div title="Average day over how much days vary: above 0.2 is steady, around 0 is luck"><span>Steadiness</span><b className="mono">{sd > 0 ? fmt(mean / sd, 2) : "—"}</b></div>
          </div>
        </section>
        <section className="ti-card">
          <h3>Trade activity</h3>
          <div className="ti-kv">
            <div><span>Trades / volume</span><b className="mono">{fmt(s.trades, 0)} · {money(s.volume, 0)}</b></div>
            <div><span>Trades a day</span><b className="mono">{fmt(perDay, perDay < 10 ? 1 : 0)}</b></div>
            <div><span>Average trade</span><b className="mono">{money(avgTrade, 0)}</b></div>
            <div><span>Last trade</span><b className="mono">{s.lastTime ? ago(Date.now() / 1000 - s.lastTime) : "—"}</b></div>
            <div><span>Markets lately</span><b className="mono">{markets.join(", ") || "—"}</b></div>
          </div>
          <h3>Direction bias <span className="muted small">last {fills.length} trades</span></h3>
          <div className="ti-bias">
            <div className="crowd-bar"><i className="crowd-long" style={{ width: `${buyShare * 100}%` }} /><i className="crowd-short" style={{ width: `${(1 - buyShare) * 100}%` }} /></div>
            <div className="crowd-ends mono"><span className="up">buys {fmt(buyShare * 100, 0)}% · {money(buyVol, 0)}</span><span className="down">{money(sellVol, 0)} · sells {fmt((1 - buyShare) * 100, 0)}%</span></div>
          </div>
        </section>
        <section className="ti-card">
          <h3>Analysis</h3>
          <ul className="ti-read">{readOf({ r, s, perDay, buyShare, longN, shortN, marginUsed, steady: sd > 0 ? mean / sd : undefined, positions }).map((x, i) => <li key={i}>{x}</li>)}</ul>
          <p className="muted small">Read from its track record and positions, which the router writes; not advice. Past results do not repeat by themselves.</p>
        </section>
        {!isMe && (
          <section className="ti-card ti-copy">
            <h3>{copying ? `You copy ${name}` : `Copy ${name}`}</h3>
            <p className="muted small">Your account is kept at their leverage on every market, times this:</p>
            <div className="quick">{[5_000, 10_000, 20_000, 30_000].map(b => <button key={b} className={b === (copying?.ratioBps ?? ratio) ? "on" : ""} onClick={() => setRatio(b)} disabled={!!copying}>{b / 10_000}×</button>)}</div>
            <div className="ti-kv">
              <div><span>Their leverage now</span><b className="mono">{fmt(r.leverage, 1)}×</b></div>
              <div><span>Yours would be</span><b className="mono">{fmt(r.leverage * (copying?.ratioBps ?? ratio) / 10_000, 1)}×</b></div>
              <div><span>To start</span><b className="mono">{copying ? "paid" : `${S.COPY_FEE_TEXT}, once`}</b></div>
            </div>
            {!publicKey ? <div className="why">Connect a wallet to follow or copy.</div> : copying
              ? <button className="closepos" disabled={!!busy} onClick={() => act.stop()}>Stop copying</button>
              : <button className="submit neutral" disabled={!!busy} onClick={() => act.copy(wallet, name, ratio, 0n)}>{busy ? `${busy}…` : `Copy ${name} at ${ratio / 10_000}×`}</button>}
            <p className="muted small">Each of their trades queues one for your account, filled at the next oracle price like any order. Stopping leaves your positions as they are. More settings (a cap per market) on the <button className="link" onClick={() => go(`/trader/${wallet}`)}>full page</button>.</p>
          </section>
        )}
      </div>
    </>
  );
}

/** A plain reading of how the account trades. */
function readOf(x: { r: S.TraderRow; s: S.Stats; perDay: number; buyShare: number; longN: number; shortN: number; marginUsed: number; steady?: number; positions: { sym: string; dist?: number }[] }): string[] {
  const { r, s } = x, out: string[] = [];
  out.push(x.perDay >= 20 ? `Very active: about ${fmt(x.perDay, 0)} trades a day, so mostly short-term moves.` : x.perDay >= 3 ? `Active: about ${fmt(x.perDay, 1)} trades a day.` : `Patient: ${fmt(x.perDay, 1)} trades a day on average, holding positions longer.`);
  out.push(x.buyShare > 0.65 ? `Leans long: ${fmt(x.buyShare * 100, 0)}% of its recent trading was buying.` : x.buyShare < 0.35 ? `Leans short: ${fmt((1 - x.buyShare) * 100, 0)}% of its recent trading was selling.` : "No strong lean: it buys and sells about as much.");
  if (x.longN + x.shortN > 0) out.push(`Holds ${x.longN >= x.shortN ? "more long than short" : "more short than long"} now, at ${fmt(r.leverage, 1)}× leverage, using ${fmt(x.marginUsed * 100, 0)}% of its equity as margin.`);
  else out.push("Holds no position right now.");
  out.push(r.leverage > 10 ? "High leverage: small moves change its account a lot, and it can be liquidated quickly." : r.leverage > 3 ? "Moderate leverage." : r.leverage > 0 ? "Low leverage: a cautious size for its account." : "");
  const near = x.positions.filter(p => p.dist !== undefined && p.dist < 0.05);
  if (near.length) out.push(`Close to liquidation on ${near.map(p => `${p.sym} (${fmt(p.dist! * 100, 1)}% away)`).join(", ")}.`);
  if (r.daysUp + r.daysDown >= 5) out.push(`Wins on ${fmt(r.daysUp / (r.daysUp + r.daysDown) * 100, 0)}% of its trading days${r.profitFactor !== undefined ? `, making ${fmt(r.profitFactor, 2)} for every 1 lost` : ""}.`);
  else out.push("Fewer than 5 trading days on record: too early to judge consistency.");
  if (x.steady !== undefined && r.daysUp + r.daysDown >= 5) out.push(x.steady > 0.2 ? "Its results are fairly steady day to day." : x.steady < 0 ? "Its days lose more than they win on average." : "Its days swing a lot compared with what it makes on average.");
  if (r.drawdownPct > 0.3) out.push(`It once fell ${fmt(r.drawdownPct * 100, 0)}% from its best: copying it means accepting falls like that.`);
  if (tagOf(r.wallet)) out.push("This is one of our own test or demo accounts.");
  return out.filter(Boolean);
}

/** The profit since the record started, day by day (cumulative, with each day's result as bars),
 *  ending at the live value. Hover for the day. */
function PnlChart({ stats, now }: { stats: S.Stats; now: number }) {
  const [hover, setHover] = useState<number>();
  const [span, setSpan] = useState<"7" | "30" | "all">("all");
  const box = useRef<SVGSVGElement>(null);
  const days = stats.days;
  const inDays = days.reduce((t, d) => t + d.pnl, 0);
  // Profit before the first day kept (a record keeps its last 30 trading days).
  let run = now - inDays;
  const pts: { t: number; v: number; day?: number }[] = [];
  if (days.length) pts.push({ t: (days[0].day - 1) * DAY, v: run });
  else pts.push({ t: stats.startTime * 1000, v: 0 });
  for (const d of days) { run += d.pnl; pts.push({ t: d.day * DAY, v: run, day: d.pnl }); }
  pts.push({ t: Date.now(), v: now });
  const from = span === "all" ? -Infinity : Date.now() - Number(span) * DAY;
  const shown = pts.filter((p, i) => p.t >= from || (i < pts.length - 1 && pts[i + 1].t >= from));
  if (shown.length < 2) return <div className="quiet">Not enough history for a chart yet.</div>;
  const W = 1000, H = 300, padL = 64, padR = 14, padT = 16, padB = 28, barH = 54;
  const t0 = shown[0].t, t1 = shown[shown.length - 1].t;
  const vs = shown.map(p => p.v), vmin = Math.min(0, ...vs), vmax = Math.max(0, ...vs), vr = vmax - vmin || 1;
  const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - vmin) / vr) * (H - padT - padB - barH - 10);
  const up = shown[shown.length - 1].v >= shown[0].v;
  const color = up ? "var(--green)" : "var(--coral)";
  const line = shown.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(t1)},${y(vmin)} L${x(t0)},${y(vmin)} Z`;
  const bars = shown.filter(p => p.day !== undefined);
  const bmax = Math.max(1, ...bars.map(p => Math.abs(p.day!)));
  const baseY = H - padB - barH / 2;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => vmin + vr * f);
  const h = hover !== undefined ? shown[hover] : undefined;
  const move = (e: { clientX: number }) => {
    const rc = box.current?.getBoundingClientRect();
    if (!rc) return;
    const tx = t0 + ((e.clientX - rc.left) / rc.width * W - padL) / (W - padL - padR) * (t1 - t0);
    let best = 0;
    shown.forEach((p, i) => { if (Math.abs(p.t - tx) < Math.abs(shown[best].t - tx)) best = i; });
    setHover(best);
  };
  const change = shown[shown.length - 1].v - shown[0].v;
  return (
    <div className="pnlc">
      <div className="pnlc-h">
        <div>
          <span className="muted small">Profit</span>
          <b className={`mono ${tone(h ? h.v : now)}`}>{signed(h ? h.v : now)}</b>
          <i className={`mono ${tone(change)}`}>{h ? new Date(h.t).toISOString().slice(0, 10) + (h.day !== undefined ? ` · that day ${signed(h.day)}` : " · now") : `${signed(change)} in this view`}</i>
        </div>
        <div className="pnlc-span">{(["7", "30", "all"] as const).map(k => <button key={k} className={k === span ? "on" : ""} onClick={() => setSpan(k)}>{k === "all" ? "All" : `${k}d`}</button>)}</div>
      </div>
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} className="pnlc-svg" onMouseMove={move} onMouseLeave={() => setHover(undefined)} role="img" aria-label={`Profit over time, now ${signed(now)}`}>
        <defs>
          <linearGradient id="pnlfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v, i) => <g key={i}><line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="pnlc-grid" /><text x={padL - 8} y={y(v) + 4} textAnchor="end" className="pnlc-tick">{money(v, 0)}</text></g>)}
        <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="pnlc-zero" />
        <path d={area} fill="url(#pnlfill)" />
        <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        <line x1={padL} x2={W - padR} y1={baseY} y2={baseY} className="pnlc-grid" />
        {bars.map((p, i) => { const hh = Math.abs(p.day!) / bmax * (barH / 2 - 2); const bw = Math.max(2, (W - padL - padR) / Math.max(bars.length, 1) * 0.6); return <rect key={i} x={x(p.t) - bw / 2} y={p.day! >= 0 ? baseY - hh : baseY} width={bw} height={Math.max(1, hh)} rx="1" className={p.day! >= 0 ? "pnlc-up" : "pnlc-down"} />; })}
        <text x={padL - 8} y={baseY + 4} textAnchor="end" className="pnlc-tick">daily</text>
        {[0, 0.5, 1].map(f => { const t = t0 + (t1 - t0) * f; return <text key={f} x={x(t)} y={H - 6} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} className="pnlc-tick">{new Date(t).toISOString().slice(5, 10)}</text>; })}
        {h && <g><line x1={x(h.t)} x2={x(h.t)} y1={padT} y2={H - padB} className="pnlc-cross" /><circle cx={x(h.t)} cy={y(h.v)} r="5" fill={color} stroke="var(--panel)" strokeWidth="2" /></g>}
        {!h && <circle cx={x(t1)} cy={y(now)} r="4.5" fill={color} />}
      </svg>
    </div>
  );
}
