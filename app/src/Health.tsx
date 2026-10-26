// #/health: where the money is, read live from the chain. Percolator's own totals (what it holds
// against what it owes), each vault's value, share price, cash reserve, margin and loss cover, the
// platform treasury, and how fresh the prices are. Nothing here is signed; everyone sees the same.
import { useEffect, useState } from "react";
import * as C from "./chain";
import { view } from "./view";
import { Stat, ago, fmt, usd } from "./shared";
import * as S from "./social";
import { useBoard } from "./Traders";
import { SEED_WALLETS } from "../api/_config";

type VaultRow = {
  symbol: string;
  nav: bigint;
  share: number;
  share24h?: number;
  cashPct: number;
  marginPct?: number;
  position: bigint;
  reduceOnly: boolean;
  assetIndex: number;
  /** The vault's position limit now (units): its tier's multiple of its value now, at today's price. */
  limit: number;
  cover?: { held: bigint; paid: bigint };
  markAge?: number;
  witnessAge?: number;
  witnessGap?: number;
};
type Health = {
  held: bigint;
  capital: bigint;
  insurance: bigint;
  profit: bigint;
  vaults: VaultRow[];
  treasuryCoin: number;
  at: number;
};

const u128 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true) + (new DataView(d.buffer, d.byteOffset).getBigUint64(o + 8, true) << 64n);
const tokenAmount = (d?: Uint8Array) => (d && d.length >= 72 ? new DataView(d.buffer, d.byteOffset).getBigUint64(64, true) : 0n);
const sharePrice = (nav: bigint, supply: bigint) => (supply > 0n ? Number(nav) / 1e6 / (Number(supply) / 10 ** C.SHARE_DECIMALS) : 0);
// One roll about every ten minutes: 144 rolls back is about a day.
const DAY_ROLLS = 144;

async function readHealth(): Promise<Health> {
  const m = await C.fetchMarket(view);
  // Percolator's header totals (from byte 749): collateral it holds, insurance, accounts' capital,
  // profit it has booked to accounts.
  const [held, insurance, capital, profit] = [0, 1, 2, 3].map(i => u128(m.data, 749 + 16 * i));
  const vaults = (await C.listVaults(view)).filter(v => v.canonical && v.status === 1 && v.lastNav > 0n);
  const now = Date.now() / 1000;
  const rows: VaultRow[] = [];
  for (const v of vaults) {
    const s = await C.fetchVault(view, v.key);
    const nav = C.navOf(s);
    const share = sharePrice(nav, s.shareSupply);
    const hist = await C.vaultHistory(view, v, DAY_ROLLS).catch(() => []);
    const old = hist.length ? hist[hist.length - 1].price : undefined;
    const cash = s.buffer - s.vault.reserved - s.vault.pendingDeposit;
    const equity = s.lp.capital + s.lp.pnl;
    const extra = await view.getMultipleAccountsInfo([
      C.coverAddress(v.key), C.coverTokensAddress(v.key), C.bookAddress(v.key),
      ...(C.X1 && v.feed ? [C.reportAddress(v.feed.id), C.witnessAddress(v.feed.id)] : []),
    ]);
    const [cover, coverTokens, book, report, witness] = extra;
    const b = book ? C.decodeBook(new Uint8Array(book.data)) : undefined;
    const r = report ? C.decodeReport(new Uint8Array(report.data)) : undefined;
    const w = witness ? C.decodeReport(new Uint8Array(witness.data)) : undefined;
    rows.push({
      symbol: v.feed?.symbol ?? "?",
      nav,
      share,
      share24h: old && old > 0 ? share / old - 1 : undefined,
      cashPct: nav > 0n ? Number(cash) / Number(nav) : 0,
      marginPct: s.lp.position !== 0n && nav > 0n ? Number(equity) / Number(nav) : undefined,
      position: s.lp.position,
      reduceOnly: s.vault.needsFlat,
      assetIndex: v.assetIndex,
      limit: s.asset.price > 0n ? Number(C.liveNav(s)) * C.tierPositionBps(C.tierOfFeed(v.feedHex)) / 10_000 / Number(s.asset.price) : 0,
      cover: cover && coverTokens ? { held: tokenAmount(new Uint8Array(coverTokens.data)), paid: C.decodeCover(new Uint8Array(cover.data)).totalCovered } : undefined,
      markAge: b && b.markPublish > 0 ? now - b.markPublish : undefined,
      witnessAge: w ? now - w.publish : undefined,
      witnessGap: w && r && r.e6 > 0n ? Math.abs(Number(w.e6) / Number(r.e6) - 1) : undefined,
    });
  }
  return { held, capital, insurance, profit, vaults: rows, treasuryCoin: (await view.getBalance(C.TREASURY)) / 1e9, at: Date.now() };
}

const pct = (x: number, dp = 1) => `${x >= 0 ? "" : "−"}${fmt(Math.abs(x) * 100, dp)}%`;

export default function HealthPage({ tick }: { tick: number }) {
  const [h, setH] = useState<Health>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    let live = true;
    const load = () => readHealth().then(x => { if (live) { setH(x); setErr(undefined); } }).catch(e => live && setErr(String(e?.message ?? e)));
    load();
    const id = setInterval(() => document.hidden || load(), 20_000);
    return () => { live = false; clearInterval(id); };
  }, [tick]);

  const owed = h ? h.capital + h.insurance + h.profit : 0n;
  const spare = h ? h.held - owed : 0n;
  const solvent = h ? h.held >= owed : true;

  return (
    <main>
      <section className="hero">
        <h1>Health</h1>
        <p className="muted">
          Read live from {C.NETWORK_NAME}, every 20 seconds. Percolator holds every trader's and every vault's collateral in one account; what it
          owes is the capital of all accounts, the insurance kept for each market, and profit it has booked to winners. Held at least what it owes
          means every account can be paid in full.
        </p>
        <div className="stats four">
          <Stat label="Collateral held" value={h ? usd(h.held, 0) : "…"} sub="in Percolator's vault" />
          <Stat label="Owed to accounts" value={h ? usd(owed, 0) : "…"} sub="capital + insurance + booked profit" />
          <Stat label={solvent ? "Solvent" : "SHORT"} value={h ? usd(spare < 0n ? -spare : spare, 2) : "…"} sub={solvent ? "held beyond what is owed" : "owed beyond what is held"} />
          <Stat label="Treasury" value={h ? `${fmt(h.treasuryCoin, 1)} ${C.COIN}` : "…"} sub="pays the services; funds loss covers" />
        </div>
      </section>
      {err && <div className="banner warn">Could not read the chain: {err}</div>}
      <h3 className="section-title">Vaults</h3>
      <p className="muted small">
        Share price: what one share of the vault is worth, and its change over about a day of rolls. Cash reserve: kept outside Percolator to pay
        withdrawals without closing the vault's position (30% after each roll from the vault build of 2026-10-20, 10% before). Margin: the vault's equity
        in Percolator against its value, while it holds a position (from that build, topped up from the reserve below 40%). Loss cover: money that pays providers back when the share price falls below its highest.
      </p>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Market</th><th className="r">Value</th><th className="r">Share price</th><th className="r">24 h</th><th className="r">Cash reserve</th>
              <th className="r">Margin</th><th className="r">Position</th><th className="r">Loss cover</th><th className="r">Price</th><th>State</th>
            </tr>
          </thead>
          <tbody>
            {!h ? (
              <tr><td colSpan={10} className="muted">Reading…</td></tr>
            ) : h.vaults.map(r => (
              <tr key={r.symbol}>
                <td>{r.symbol}-PERP</td>
                <td className="r">{usd(r.nav, 0)}</td>
                <td className="r">{fmt(r.share, 4)}</td>
                <td className="r">{r.share24h === undefined ? "—" : pct(r.share24h)}</td>
                <td className="r">{pct(r.cashPct, 0)}</td>
                <td className="r">{r.marginPct === undefined ? "flat" : pct(r.marginPct, 0)}</td>
                <td className="r">{fmt(Number(r.position) / Number(C.UNIT), 4)}</td>
                <td className="r">{r.cover ? `${usd(r.cover.held, 0)}${r.cover.paid > 0n ? ` · paid ${usd(r.cover.paid, 0)}` : ""}` : "none"}</td>
                <td className="r">
                  {r.markAge === undefined ? "—" : ago(r.markAge)}
                  {C.X1 && <span className="muted small">{r.witnessAge === undefined ? " · no witness" : ` · witness ${ago(r.witnessAge)}${r.witnessGap !== undefined ? `, ${pct(r.witnessGap, 2)} apart` : ""}`}</span>}
                </td>
                <td>{r.reduceOnly ? <span className="warn-tag">reduce-only (paying withdrawals)</span> : "open"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {C.X1 && (
        <p className="muted small">
          X1 prices: the reporter key posts each price from Jack's oracle (jack0.x1.xyz, our exchange median as backup); a second key, the witness,
          posts its own from a separate source. Once the router build of 2026-10-20 is live, a price moves a market only when the two agree within 1.5% and 30 seconds.
        </p>
      )}
      {h && <p className="muted small">Read {ago((Date.now() - h.at) / 1000)}. "Price" is how old the price each market last moved to is.</p>}
      {h && <Crowding vaults={h.vaults} tick={tick} />}
      <Organic tick={tick} />
    </main>
  );
}

/** Activity that is not ours: every figure leaves out our test bots (and demo accounts), so it
 *  shows real use rather than volume. From the router's track records (no history request). */
function Organic({ tick }: { tick: number }) {
  const { board } = useBoard(tick);
  if (!board) return null;
  const now = Date.now() / 1000, today = Math.floor(now / 86_400), week = 7 * 86_400;
  const ours = (w: string) => !!SEED_WALLETS[w];
  const records = board.rows.filter(r => r.stats);
  const real = records.filter(r => !ours(r.wallet));
  const active = real.filter(r => r.stats!.lastTime >= now - week);
  const tradedIn = (r: S.TraderRow, from: number, to: number) => r.stats!.days.some(d => d.day >= from && d.day < to);
  const returning = active.filter(r => tradedIn(r, today - 13, today - 6));
  const fresh = real.filter(r => r.stats!.startTime >= now - week);
  const volume = (rs: S.TraderRow[]) => rs.reduce((t, r) => t + r.stats!.volume, 0);
  const all = volume(records), realVol = volume(real);
  const newWallets = real.filter(r => now - r.stats!.startTime <= S.NEW_WALLET.days * 86_400);
  const fee = (v: number) => v * S.feeSharePerMillion(1) / 1e6;
  const pctOf = (a: number, b: number) => (b > 0 ? `${fmt(a / b * 100, 0)}%` : "—");
  return (
    <>
      <h3 className="section-title">Real use</h3>
      <p className="muted small">
        Leaves out our test bots and demo accounts. Active: traded in the last 7 days. Coming back: active, and also traded in the 7 days before.
        Fees are worked out at today's trade fee ({C.TRADE_FEE_PCT} a side). Volume from wallets in their first month may have had its fees refunded.
      </p>
      <div className="stats four">
        <Stat label="Active traders" value={String(active.length)} sub={`${fresh.length} new this week · ${real.length} ever`} />
        <Stat label="Coming back" value={pctOf(returning.length, active.length)} sub={`${returning.length} of ${active.length} active`} />
        <Stat label="Fees paid by real traders" value={`$${fmt(fee(realVol), 0)}`} sub={`on $${fmt(realVol, 0)} traded, all time`} />
        <Stat label="Volume that is ours" value={pctOf(all - realVol, all)} sub={`first-month wallets: ${pctOf(volume(newWallets), realVol)} of real`} />
      </div>
    </>
  );
}

/** How one-sided each vault gets, and for how long: its position rebuilt backwards from now through
 *  every account's recent fills (each fill is against the vault, so before a trader's fill of s the
 *  vault held what it holds after plus s). A track record keeps an account's last 16 fills, so the
 *  rebuild reaches back only as far as every busy account's records do; the table says how far. */
export function crowding(position: number, limit: number, fills: { time: number; size: number }[], from: number, now: number) {
  const steps = fills.filter(f => f.time >= from && f.time <= now).sort((a, b) => b.time - a.time);
  // Walk back from now: [start, end) intervals with the position held in each.
  const spans: { start: number; end: number; pos: number }[] = [];
  let pos = position, end = now;
  for (const f of steps) { spans.push({ start: f.time, end, pos }); end = f.time; pos += f.size; }
  spans.push({ start: from, end, pos });
  const total = Math.max(1, now - from);
  let t80 = 0, t50 = 0, longest = 0, run = 0;
  for (const sp of spans.reverse()) {
    const d = Math.max(0, sp.end - sp.start), use = limit > 0 ? Math.abs(sp.pos) / limit : 0;
    if (use >= 0.5) t50 += d;
    if (use >= 0.8) { t80 += d; run += d; longest = Math.max(longest, run); } else run = 0;
  }
  return { now: limit > 0 ? Math.abs(position) / limit : 0, at80: t80 / total, at50: t50 / total, longest, hours: total / 3600 };
}

function Crowding({ vaults, tick }: { vaults: VaultRow[]; tick: number }) {
  const { board } = useBoard(tick);
  if (!board) return null;
  const now = Date.now() / 1000;
  // How far back every fill is known: past the oldest of the 16 kept by each account whose record is full.
  let from = now - 7 * 86_400;
  for (const r of board.rows) {
    const f = r.stats?.fills ?? [];
    if (f.length >= 16) from = Math.max(from, Math.min(...f.map(x => x.time)));
  }
  const hm = (secs: number) => (secs >= 3600 ? `${fmt(secs / 3600, 1)} h` : `${Math.round(secs / 60)} min`);
  const rows = vaults.map(v => {
    const fills = board.rows.flatMap(r => (r.stats?.fills ?? []).filter(f => f.asset === v.assetIndex).map(f => ({ time: f.time, size: f.size })));
    return { v, c: crowding(Number(v.position) / Number(C.UNIT), v.limit, fills, from, now) };
  });
  return (
    <>
      <h3 className="section-title">How one-sided the vaults get</h3>
      <p className="muted small">
        Each vault takes the other side of every trade. Funding is switched off for now (it blocked fills, see Docs), so nothing pays traders to
        balance a crowd, and a vault near its limit carries that risk for the trade fees alone. This is how much of the time each vault spent near its limit: at 80% it takes no more
        ordinary trades on that side. Rebuilt from every account's recent fills, which reach back {hm(now - from)} now; the limit used is today's.
      </p>
      <div className="table-wrap">
        <table className="tbl">
          <thead><tr><th>Market</th><th className="r">Now</th><th className="r">Time at 80%+ of its limit</th><th className="r">Time at 50%+</th><th className="r">Longest stretch at 80%+</th></tr></thead>
          <tbody>
            {rows.map(({ v, c }) => (
              <tr key={v.symbol}>
                <td>{v.symbol}-PERP</td>
                <td className={`r ${c.now >= 0.8 ? "down" : ""}`}>{pct(c.now, 0)} {Number(v.position) === 0 ? "" : Number(v.position) > 0 ? "long" : "short"}</td>
                <td className={`r ${c.at80 >= 0.25 ? "down" : ""}`}>{pct(c.at80, 0)}</td>
                <td className="r">{pct(c.at50, 0)}</td>
                <td className="r">{c.longest > 0 ? hm(c.longest) : "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
