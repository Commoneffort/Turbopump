// #/execution: how well trades are carried out, measured from the chain by an independent reader
// (api/_execution.ts; the same numbers come from `npx tsx scripts/exec-quality.ts`). Nothing here
// comes from our executor's own logs: every number is rebuilt from public transactions and an
// outside exchange's prices, so anyone can check it.
import { useMemo } from "react";
import * as C from "./chain";
import { Stat, explorer, fmt, num, short, useCards } from "./shared";
import { useExecReport } from "./Pulse";
import type { Report, Row, Stats } from "../api/_execution";

const bps = (x?: number, dp = 1) => (x === undefined || Number.isNaN(x) ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${fmt(Math.abs(x), dp)} bps`);
const absBps = (x?: number, dp = 1) => (x === undefined || Number.isNaN(x) ? "—" : `${fmt(x, dp)} bps`);
const secs = (x?: number) => (x === undefined || Number.isNaN(x) ? "—" : `${fmt(x, 0)} s`);
const pctOf = (a: number, b: number) => (b > 0 ? `${fmt(a / b * 100, 1)}%` : "—");
const hours = (a: number, b: number) => `${fmt((b - a) / 3600, 1)} h`;
const price = (p?: number) => (p === undefined ? "—" : `$${fmt(p, p >= 1000 ? 2 : p >= 1 ? 3 : 5)}`);
const KIND: Record<string, string> = { trade: "Market", close: "Close", order: "Standing order", copy: "Copy" };
const ORDER_KIND = ["stop loss", "take profit", "trailing stop", "limit", "TWAP"];

/** A plain verdict for one measurement: fine, worth watching, or a problem. */
type Verdict = "ok" | "watch" | "bad" | "none";
const Mark = ({ v }: { v: Verdict }) => <span className={`verdict ${v}`}>{v === "ok" ? "OK" : v === "watch" ? "Watch" : v === "bad" ? "Problem" : "No data"}</span>;

export default function ExecutionPage({ tick }: { tick: number }) {
  const { report, err } = useExecReport();
  const { cards } = useCards(tick);
  // How much of each vault's position limit is used now.
  const util = useMemo(() => new Map((cards ?? []).filter(c => c.v.canonical && c.v.status === 1 && c.v.feed).map(c => {
    const v = c.v, tier = C.tierOfFeed(v.feedHex);
    const bpsCap = v.positionNavBps ? Math.min(v.positionNavBps, C.tierPositionBps(tier)) : 0;
    const limit = bpsCap && c.asset.price > 0n ? (c.nav * BigInt(bpsCap) / 10_000n) * C.UNIT / c.asset.price : v.maxInventory;
    const held = v.inventory < 0n ? -v.inventory : v.inventory;
    return [v.feed!.symbol, { used: limit > 0n ? Number(held * 10_000n / limit) / 100 : 0, side: v.inventory > 0n ? "long" : v.inventory < 0n ? "short" : "flat", value: num(held, 1e6) * num(c.asset.price, 1e6), nav: num(c.nav, 1e6) }];
  })), [cards]);

  if (!report) {
    return (
      <>
        <section className="hero"><h1>Execution quality</h1></section>
        {err ? <div className="banner warn">Could not build the report: {err}</div> : <p className="muted">Reading the last few hours of trades from the chain…</p>}
      </>
    );
  }
  const t = report.total, n = (s: Stats) => s.filled + s.refused + s.expired;
  const from = Math.min(...report.markets.map(m => m.from)), to = Math.max(...report.markets.map(m => m.to));
  const designed = `${report.delaySecs}–${report.delaySecs + report.batchSecs} s`;
  const executors = t.executors;
  const top = executors[0], topShare = top && t.filled ? top.fills / t.filled : 0;

  // Each attack, the number that shows whether it is happening, and a plain verdict.
  const slipOk: Verdict = !t.slippage ? "none" : Math.abs(t.slippage.mean) < 2 && t.slippage.worse < 0.6 ? "ok" : Math.abs(t.slippage.mean) < 5 ? "watch" : "bad";
  const matchOk: Verdict = !t.oracleMatch ? "none" : t.oracleMatch.mismatches === 0 ? "ok" : "bad";
  const m300 = t.markout?.s300;
  const markOk: Verdict = m300 === undefined ? "none" : Math.abs(m300) < 3 ? "ok" : Math.abs(m300) < 8 ? "watch" : "bad";
  const trigOk: Verdict = t.triggers.medianDelay === undefined ? "none" : t.triggers.medianDelay <= 6 ? "ok" : t.triggers.medianDelay <= 20 ? "watch" : "bad";
  const execOk: Verdict = !executors.length ? "none" : executors.length >= 3 && topShare < 0.6 ? "ok" : "watch";
  const latOk: Verdict = !t.latency ? "none" : t.latency.median <= report.delaySecs + report.batchSecs + 2 ? "ok" : t.latency.median <= 15 ? "watch" : "bad";

  return (
    <>
      <section className="hero">
        <h1>Execution quality</h1>
        <p className="muted">
          Every trade here fills at the oracle price (a price feed built from big exchanges), a few seconds after you send it, against the market's vault.
          There is no order book. This page checks, from public data only, whether that actually works out well for traders: how long fills take,
          how close the price is to the outside market, how often trades fail, and whether anyone gets an unfair edge.
        </p>
        <p className="muted small"><a href="#/execution" onClick={e => { e.preventDefault(); document.getElementById("become-executor")?.scrollIntoView({ behavior: "smooth" }); }}>Anyone can become an executor and earn rewards ↓</a></p>
        <p className="muted small">
          {C.NETWORK_NAME} · last {hours(from, to)} of transactions on {report.markets.length} market{report.markets.length === 1 ? "" : "s"} · {n(t)} requests · read {Math.max(1, Math.round((Date.now() / 1000 - report.at) / 60))} min ago.
          Rebuilt from the chain by a reader separate from our executor; check it yourself with <code>NETWORK={report.network} npx tsx scripts/exec-quality.ts</code>.
          {report.skipped.length ? ` Left out this time (the RPC refused): ${report.skipped.join(", ")}.` : ""}
        </p>
        <div className="stats four">
          <Stat label="Median time to fill" value={secs(t.latency?.median)} sub={`slowest 10%: over ${secs(t.latency?.p90)} · designed wait ${designed}`} />
          <Stat label="Fill price vs outside market" value={absBps(t.deviation?.median, 1)} sub={t.deviation ? `typical gap · 90% within ${absBps(t.deviation.p90)} · on average ${bps(t.deviation.mean)}` : "no exchange price for these markets"} />
          <Stat label="Price move while waiting" value={bps(t.slippage?.mean, 2)} sub={t.slippage ? `average, + = against the trader · ${fmt(t.slippage.worse * 100, 0)}% of fills were worse` : "—"} />
          <Stat label="Trades that did not fill" value={pctOf(t.refused + t.expired, n(t))} sub={`${t.refused} refused · ${t.expired} expired · ${pctOf(t.failedTxs, t.txs)} of transactions failed`} />
        </div>
      </section>

      <h3 className="section-title">Protection, measured</h3>
      <p className="muted small">What each kind of attack would look like in the numbers, and what the numbers show now. A bps (basis point) is a hundredth of a percent: on a $10,000 trade, 1 bps is $1.</p>
      <div className="table-wrap">
        <table className="tbl prot-tbl">
          <thead><tr><th>Risk</th><th>Why it is hard here</th><th>How we measure it</th><th className="r">Now</th><th /></tr></thead>
          <tbody>
            <tr>
              <td><b>Someone gets in line ahead of you</b><div className="muted small">transaction ordering</div></td>
              <td>Your price is the first oracle price after your request's target time, the same for everyone in that moment. Going first in a block does not get a better price.</td>
              <td>Does every fill equal a price the oracle posted? Is the move while waiting zero on average (as often for you as against you)?</td>
              <td className="r mono">{t.oracleMatch ? `${t.oracleMatch.n - t.oracleMatch.mismatches}/${t.oracleMatch.n} at the oracle price` : "—"}<br />{bps(t.slippage?.mean, 2)} avg · {t.slippage ? `${fmt(t.slippage.worse * 100, 0)}% worse` : "—"}</td>
              <td><Mark v={matchOk === "bad" ? "bad" : slipOk} /></td>
            </tr>
            <tr>
              <td><b>Sandwich attacks</b><div className="muted small">someone buys just before you and sells just after</div></td>
              <td>The vault has no price curve: a trade does not move the price, so there is nothing to push up before you or sell into after you.</td>
              <td>The same price-move numbers: a sandwich would show as fills that are worse on average, more so for big trades.</td>
              <td className="r mono">{t.slippage ? `90% within ${absBps(t.slippage.p90abs)}` : "—"}</td>
              <td><Mark v={slipOk} /></td>
            </tr>
            <tr>
              <td><b>Trading on a price you already know</b><div className="muted small">adverse selection around oracle updates</div></td>
              <td>A request fills at a price published after it lands ({report.delaySecs} s or more later), so seeing an exchange move first does not lock in the old price.</td>
              <td>After each fill, did the price keep moving in the trader's favour? Measured 1 and 5 minutes later, weighted by trade size. Near zero means no edge.</td>
              <td className="r mono">1 min {bps(t.markout?.s60, 2)}<br />5 min {bps(t.markout?.s300, 2)}</td>
              <td><Mark v={markOk} /></td>
            </tr>
            <tr>
              <td><b>Hunting pending stop orders</b><div className="muted small">exploiting conditional orders</div></td>
              <td>Stops and limits are public, but they trigger on the oracle price, which nobody here can push around with a trade, and fill at the next oracle price like any trade.</td>
              <td>How long after its price was reached each order was carried out, and how far past its level it filled.</td>
              <td className="r mono">{secs(t.triggers.medianDelay)} median ({t.triggers.n})<br />{t.triggers.medianGapBps === undefined ? "—" : t.triggers.medianGapBps > 0 ? `filled ${absBps(t.triggers.medianGapBps)} worse than level` : `filled ${absBps(-t.triggers.medianGapBps)} better than level`}</td>
              <td><Mark v={trigOk} /></td>
            </tr>
            <tr>
              <td><b>One executor can stall trades</b><div className="muted small">depending on a single operator</div></td>
              <td>Anyone may fill, trigger, liquidate or expire, and is paid for it by whoever needed it. A backup executor takes over any work left undone for a few seconds. If nobody fills a request, anyone can expire it after 30 s so the queue moves on.</td>
              <td>How many different wallets carried fills out, and the biggest one's share.</td>
              <td className="r mono">{executors.length} executor{executors.length === 1 ? "" : "s"}<br />{top ? `top: ${fmt(topShare * 100, 0)}%` : "—"}</td>
              <td><Mark v={execOk} /></td>
            </tr>
            <tr>
              <td><b>Slow fills</b></td>
              <td>The wait is part of the design ({designed}); anything longer is the executor or the network.</td>
              <td>Time from a request landing on chain to its fill.</td>
              <td className="r mono">{secs(t.latency?.median)} median<br />{secs(t.latency?.p90)} slowest 10%</td>
              <td><Mark v={latOk} /></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 className="section-title">By market</h3>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr>
            <th>Market</th><th className="r">Window</th><th className="r">Requests</th><th className="r" title="Filled with nothing traded (margin, closing-only market, or a limit price not met), or expired">Did not fill</th>
            <th className="r">Time to fill</th><th className="r" title="Typical gap between the fill price and an outside exchange at the same second">vs outside</th>
            <th className="r" title="Average move between the request landing and its fill, + = against the trader">While waiting</th>
            <th className="r" title="Traders' gain 1 and 5 minutes after their fills, weighted by size; near zero = no edge">After fill</th>
            <th className="r">Liquidations</th><th className="r" title="How much of the vault's position limit it uses now">Vault used</th>
          </tr></thead>
          <tbody>
            {report.markets.map(m => {
              const s = m.stats, u = util.get(m.symbol);
              return (
                <tr key={m.symbol}>
                  <td><a className="link" href={`#/trade/${m.symbol}`}>{m.symbol}</a></td>
                  <td className="r mono muted">{hours(m.from, m.to)}</td>
                  <td className="r mono">{n(s) + s.open}</td>
                  <td className="r mono">{pctOf(s.refused + s.expired, n(s))}</td>
                  <td className="r mono">{secs(s.latency?.median)}<i className="muted"> / {secs(s.latency?.p90)}</i></td>
                  <td className="r mono">{absBps(s.deviation?.median)}</td>
                  <td className="r mono">{bps(s.slippage?.mean, 2)}</td>
                  <td className="r mono">{bps(s.markout?.s60, 1)}<i className="muted"> / {bps(s.markout?.s300, 1)}</i></td>
                  <td className="r mono">{s.liquidations.n ? `${s.liquidations.n} · ${secs(s.liquidations.medianSecs)}` : "none"}</td>
                  <td className="r">{u ? <span className="util" title={`${u.side}, $${fmt(u.value, 0)} of a vault worth $${fmt(u.nav, 0)}`}><span className="mono">{fmt(u.used, 0)}%</span><i><b style={{ width: `${Math.min(100, u.used)}%` }} className={u.used > 80 ? "hot" : ""} /></i></span> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="section-title" id="orders">Conditional-order integrity</h3>
      <OrderIntegrity report={report} />

      <h3 className="section-title" id="executors">Executors</h3>
      <p className="muted small">
        Anyone can run an executor, for any part of the work, without asking us: filling trades, carrying out standing orders, expiring stale requests, liquidating.
        Each piece of work is paid by whoever needed it done, never out of the platform's fees, and only when it succeeds: a duplicate or failed attempt earns nothing.
        Every number here is read from the chain.
      </p>
      <Executors report={report} />

      <div className="exec-two">
        <section>
          <h3 className="section-title">Liquidations</h3>
          <p className="muted small">When an account's margin runs too low, an executor queues a close of its position. It fills like a trade, at the next oracle price.</p>
          <div className="kv-list">
            <div><span>Liquidations filled</span><b className="mono">{t.liquidations.n}</b></div>
            <div><span>Median time from queued to closed</span><b className="mono">{secs(t.liquidations.medianSecs)}</b></div>
            <div><span>Average price move while queued</span><b className="mono">{bps(t.liquidations.meanSlipBps, 1)}</b></div>
            <div><span>Liquidations that expired unfilled</span><b className={`mono ${t.liquidations.expired ? "down" : ""}`}>{t.liquidations.expired}</b></div>
          </div>
        </section>
        <section>
          <h3 className="section-title">How executors are paid</h3>
          <p className="muted small">The rule: whoever needs the work done pays for it. Rewards are fixed amounts, not a share of the trade, so no trade is worth more to an executor than another.</p>
          <div className="kv-list">
            <div><span>Fill a trade</span><b className="mono">the request's bond, {coin(C.ROUTER_BOND_LAMPORTS)}</b></div>
            <div><span>Carry out a stop, limit or TWAP slice</span><b className="mono">{coin(C.KEEPER_FEE)} from the order's keeper budget</b></div>
            <div><span>Liquidate an account</span><b className="mono">{coin(C.ROUTER_BOND_LAMPORTS / 2)} from its keeper deposit</b></div>
            <div><span>Expire a request nobody filled</span><b className="mono">{coin(C.ROUTER_BOND_LAMPORTS / 4)}, a quarter of its bond</b></div>
            <div><span>Remove an order that can do nothing</span><b className="mono">{coin(C.KEEPER_FEE)} from its budget</b></div>
          </div>
          <p className="muted small">{C.KEEPER_REWARDS ? "Live on this network." : "Fills are paid today. The other rewards are built and tested and switch on with the next router upgrade on this network."} Expiring always pays less than filling, so letting a trade lapse never pays.</p>
        </section>
      </div>

      <BecomeExecutor />

      <h3 className="section-title">Recent executions</h3>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr>
            <th>When</th><th>Market</th><th>Type</th><th>Side</th><th className="r">Size</th><th className="r">Took</th>
            <th className="r" title="The oracle price when the request landed">Price at request</th><th className="r">Fill price</th><th className="r" title="+ = against the trader">Move</th>
            <th className="r" title="An outside exchange at the second the fill's price was published">Outside</th><th className="r">Tx</th>
          </tr></thead>
          <tbody>
            {report.recent.slice(0, 40).map((r: Row) => (
              <tr key={r.sig + (r.doneSig ?? "")}>
                <td className="mono muted">{new Date(r.at * 1000).toLocaleTimeString()}</td>
                <td>{r.market}</td>
                <td>{r.liquidation ? "Liquidation" : r.kind === "order" && r.orderKind !== undefined ? ORDER_KIND[r.orderKind] : KIND[r.kind]}</td>
                <td className={r.traded ? (r.traded > 0 ? "up" : "down") : "muted"}>{r.outcome === "filled" ? (r.traded! > 0 ? "Buy" : "Sell") : r.outcome}</td>
                <td className="r mono">{r.traded ? fmt(Math.abs(r.traded), 4).replace(/\.?0+$/, "") : "—"}</td>
                <td className="r mono">{r.doneAt ? secs(r.doneAt - r.at) : "—"}</td>
                <td className="r mono">{price(r.markAtRequest)}</td>
                <td className="r mono">{price(r.price)}</td>
                <td className={`r mono ${r.slipBps === undefined ? "" : r.slipBps > 0 ? "down" : "up"}`}>{bps(r.slipBps, 1)}</td>
                <td className="r mono muted">{price(r.exchangeAtFill)}</td>
                <td className="r"><a href={explorer("tx", r.doneSig ?? r.sig)} target="_blank" rel="noreferrer">{short(r.doneSig ?? r.sig)}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">How each number is worked out</h3>
      <div className="method muted small">
        <p><b>Window.</b> Each market's last {report.network === "x1-testnet" ? "1,000" : "300"} transactions. A request is matched to the fill or expiry that follows it on the same request account.</p>
        <p><b>Time to fill.</b> Block time of the fill minus block time of the request. The router waits on purpose ({designed}) so the price is one nobody knew when they sent the trade.</p>
        <p><b>Fill price vs outside market.</b> The fill price against {report.exchangeSource}, at the second the fill's oracle price was published. A steady small gap is normal (the oracle is a median of several exchanges); a wide or growing one is not.</p>
        <p><b>Price move while waiting</b> (realized slippage). The fill price against the {report.priceSource === "oracle prices posted on chain" ? "oracle price posted on chain" : "exchange price"} when the request landed, signed so + is against the trader. Example: you buy when the price is $100.00 and fill at $100.02: +2 bps. With nobody cheating, it averages to about zero.</p>
        <p><b>After fill</b> (adverse selection, "markout"). The price 1 and 5 minutes after each fill against the fill price, signed so + is in the trader's favour, averaged by trade size. If traders keep winning right after their fills, they know something the vault does not, and the vault (its depositors) pays for it.</p>
        <p><b>Did not fill.</b> Refused: the fill traded nothing (not enough margin at the new price, a closing-only market, or a limit price not met). Expired: nobody filled it in time. Failed transactions: sent but rejected on chain, by anyone. Not counted as failed: the spare version of a fill. The cranks a fill carries depend on the slot it lands in, so an executor sends it in two versions at once and the one that fits fills; the other is rejected while its twin fills the same request. That saves a second round trip, a few seconds, on every fill.</p>
        <p><b>Standing orders.</b> From the oracle prices posted on chain: the first time the order's price was reached, to when it was carried out. Trailing stops and TWAPs are left out of the delay.</p>
        <p><b>Liquidations.</b> A close queued by someone other than the account's owner. <b>Vault used</b>: the vault's position now against its limit.</p>
      </div>
    </>
  );
}

const coin = (lamports: number) => `${fmt(lamports / 1e9, 4).replace(/\.?0+$/, "")} ${C.COIN}`;

/** Conditional-order integrity, per market: the standing orders carried out in the window, what
 *  became of them, how long they took, how their fill compares with their own price level, and
 *  how many attempts carrying each out took. (Shared with the Health page.) */
export function OrderIntegrity({ report, compact }: { report: Report; compact?: boolean }) {
  const rows = [...report.markets.map(m => ({ name: m.symbol, s: m.stats })), { name: "All markets", s: report.total }];
  const o = (s: Stats) => s.orders;
  const t = o(report.total);
  const verdict: Verdict = !t || !t.n ? "none" : (t.filled + t.refused) / t.n >= 0.95 && (t.medianToFill ?? 99) <= 15 ? "ok" : (t.filled + t.refused) / t.n >= 0.8 ? "watch" : "bad";
  if (!t) return <p className="muted small">Not in this report yet.</p>;
  return (
    <>
      {!compact && <p className="muted small">
        Stops, take-profits, limits and TWAPs trigger on the oracle price, which no trade here can move, and anyone may carry them out once their price is reached.
        These numbers check that they are: what share of triggered orders filled, how long from being carried out to the fill, how the fill compares with the order's own level, how many attempts on chain each took, and how many expired.
      </p>}
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr>
            <th>Market</th><th className="r">Carried out</th><th className="r" title="Filled with something traded">Filled</th>
            <th className="r" title="Carried out, then traded nothing at the fill (a limit whose price was not met by then keeps waiting; a stop with nothing left to close)">Traded nothing</th>
            <th className="r" title="Carried out, then nobody filled it in time">Expired</th>
            <th className="r" title="From the order being carried out to its fill: median / slowest 10%">To fill</th>
            <th className="r" title="How long after its price was reached each order was carried out (stops, take-profits, limits)">Trigger delay</th>
            <th className="r" title="The fill price against the order's own level, + = worse for the trader: median / 90% within">Fill vs level</th>
            <th className="r" title="Attempts on chain per order carried out (failed ones + the one that worked)">Attempts</th>
          </tr></thead>
          <tbody>
            {rows.map(({ name, s }) => {
              const x = o(s);
              return (
                <tr key={name} className={name === "All markets" ? "total" : ""}>
                  <td>{name === "All markets" ? <b>{name}</b> : <a className="link" href={`#/trade/${name}`}>{name}</a>}</td>
                  <td className="r mono">{x.n}</td>
                  <td className="r mono">{pctOf(x.filled, x.n)}</td>
                  <td className="r mono">{pctOf(x.refused, x.n)}</td>
                  <td className={`r mono ${x.expired ? "down" : ""}`}>{pctOf(x.expired, x.n)}</td>
                  <td className="r mono">{secs(x.medianToFill)}<i className="muted"> / {secs(x.p90ToFill)}</i></td>
                  <td className="r mono">{secs(s.triggers.medianDelay)}<i className="muted"> ({s.triggers.n})</i></td>
                  <td className="r mono">{bps(s.triggers.medianGapBps, 0)}<i className="muted"> / {absBps(x.p90GapAbsBps, 0)}</i></td>
                  <td className="r mono">{x.meanAttempts === undefined ? "—" : fmt(x.meanAttempts, 2)}{x.retried ? <i className="muted"> ({x.retried} retried)</i> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small"><Mark v={verdict} /> {t.n ? `${pctOf(t.filled + t.refused, t.n)} of the ${t.n} orders carried out reached a fill, ${t.expired} expired; median ${secs(t.medianToFill)} from being carried out to the fill.` : "No standing order was carried out in this window."} A fill better than its level (−) is common: the order is carried out at the first price past its level, and fills at the next one.</p>
    </>
  );
}

/** Every executor in the window: what it did, its failures, its speed, how much of the time it
 *  was at work, and what it earned. */
function Executors({ report }: { report: Report }) {
  const ex = report.executors ?? [];
  if (!ex.length) return <p className="muted small">No executor did any work in this window.</p>;
  const fills = ex.reduce((t, e) => t + e.fills + e.refused, 0);
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>
          <th>Executor</th><th className="r" title="Fills that traded (and fills that traded nothing)">Fills</th><th className="r">Share</th>
          <th className="r" title="Standing orders and copies carried out">Triggers</th><th className="r">Liquidations</th><th className="r">Expiries</th>
          <th className="r" title="Its transactions rejected on chain for a real reason, as a share of the work it did">Failed</th>
          <th className="r" title="Median time from request to fill, for the fills it carried out">Fill time</th>
          <th className="r" title="Share of 10-minute periods in the window in which it did some work">Active</th>
          <th className="r" title="Bonds of its fills plus the router's keeper rewards, in the chain's coin">Earned</th>
        </tr></thead>
        <tbody>
          {ex.map(e => (
            <tr key={e.key}>
              <td><a className="link mono" href={explorer("address", e.key)} target="_blank" rel="noreferrer">{short(e.key)}</a></td>
              <td className="r mono">{e.fills}{e.refused ? <i className="muted"> (+{e.refused})</i> : null}</td>
              <td className="r mono">{pctOf(e.fills + e.refused, fills)}</td>
              <td className="r mono">{e.triggers}</td>
              <td className="r mono">{e.liquidations}</td>
              <td className="r mono">{e.expiries}</td>
              <td className="r mono" title={e.spare ? `Not counted: ${e.spare} spare versions of fills. A fill is sent in two versions on purpose, one for each slot it could land in (the cranks it needs depend on that slot), so it fills without a second try. The version that does not fit is rejected while its twin fills the same request.` : undefined}>
                {e.failed}<i className="muted"> ({pctOf(e.failed, e.failed + e.fills + e.refused + e.triggers + e.liquidations + e.expiries + e.cleanups)})</i>
              </td>
              <td className="r mono">{secs(e.medianFillSecs)}</td>
              <td className="r mono">{fmt(e.activeShare * 100, 0)}%</td>
              <td className="r mono" title={Object.entries(e.rewardsBy).map(([k, v]) => `${k}: ${coin(v)}`).join(" · ")}>{coin(e.rewards)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How to run an executor: anyone may, with no sign-up (the programs check every piece of work). */
function BecomeExecutor() {
  const net = C.X1 ? "NETWORK=x1-testnet " : "RPC=<your devnet RPC> HERMES_API_KEY=<free Pyth key> ";
  return (
    <section className="exec-join" id="become-executor">
      <h3 className="section-title">Become an executor</h3>
      <p className="muted small">
        No sign-up and no permission: the router accepts work from any wallet and checks every step itself. You need a computer that stays online,
        Node.js, and a wallet with a little {C.COIN} for transaction fees. You are paid per piece of work, at the rates above, straight into that wallet.
      </p>
      <ol className="exec-steps">
        <li><span>Get the code</span><pre>git clone -b audit-2026-10 https://github.com/Commoneffort/Turbopump{"\n"}cd Turbopump/app && npm install</pre></li>
        <li><span>Make a wallet for it and send it some {C.COIN} for fees</span><pre>solana-keygen new -o executor.json</pre></li>
        <li><span>Start it</span><pre>{net}KEYPAIR=./executor.json npx tsx scripts/executor.ts</pre></li>
      </ol>
      <div className="kv-list">
        <div><span>Only some of the work</span><b className="mono">EXECUTOR_ROLES=trade · maintenance · liquidation</b></div>
        <div><span>Stand by as a backup (acts only on work overdue N seconds)</span><b className="mono">BACKUP_AFTER_SECS=N</b></div>
      </div>
      <p className="muted small">
        {C.X1
          ? "On X1 testnet the price comes from the router's reporter key (X1 has no Pyth), so your executor fills a trade once the posted price reaches its target; standing orders, liquidations and expiries need nothing else."
          : "On devnet your executor posts Pyth prices itself; Pyth's free plan covers every feed here."}
        {" "}Several executors can run side by side: the first to do a piece of work is paid, and a duplicate attempt fails without costing more than its transaction fee.
      </p>
    </section>
  );
}
