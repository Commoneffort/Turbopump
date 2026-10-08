// Copy trading: who trades well here, by a record the router keeps itself; names and badges;
// following (their trades show on your chart) and copying (your account mirrors theirs).
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SEED_WALLETS } from "../api/_config";
import * as C from "./chain";
import * as S from "./social";
import { Send, ago, explorer, fmt, priceDp, short, useCards } from "./shared";

// ---------------------------------------------------------------- badges

/** Badge shapes, as polygons on a 0..1 square: the same points draw the badge on the page (SVG)
 *  and on the chart (canvas). The index is what a profile stores. */
const ring = (n: number, r = 0.5, turn = -Math.PI / 2, r2?: number) =>
  Array.from({ length: r2 ? n * 2 : n }, (_, i) => { const a = turn + i * Math.PI * 2 / (r2 ? n * 2 : n), rr = r2 && i % 2 ? r2 : r; return [0.5 + rr * Math.cos(a), 0.5 + rr * Math.sin(a)] as [number, number]; });
export const BADGES: { name: string; points: [number, number][] }[] = [
  { name: "Circle", points: ring(20) },
  { name: "Diamond", points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] },
  { name: "Hexagon", points: ring(6) },
  { name: "Shield", points: [[0.08, 0.06], [0.92, 0.06], [0.92, 0.55], [0.5, 1], [0.08, 0.55]] },
  { name: "Star", points: ring(5, 0.52, -Math.PI / 2, 0.22) },
  { name: "Bolt", points: [[0.62, 0], [0.12, 0.58], [0.44, 0.58], [0.34, 1], [0.88, 0.4], [0.56, 0.4]] },
  { name: "Triangle", points: [[0.5, 0.04], [1, 0.94], [0, 0.94]] },
  { name: "Square", points: [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]] },
  { name: "Pentagon", points: ring(5) },
  { name: "Cross", points: [[0.34, 0], [0.66, 0], [0.66, 0.34], [1, 0.34], [1, 0.66], [0.66, 0.66], [0.66, 1], [0.34, 1], [0.34, 0.66], [0, 0.66], [0, 0.34], [0.34, 0.34]] },
  { name: "Crown", points: [[0, 0.2], [0.27, 0.5], [0.5, 0.08], [0.73, 0.5], [1, 0.2], [0.9, 0.92], [0.1, 0.92]] },
  { name: "Burst", points: ring(8, 0.52, -Math.PI / 2, 0.34) },
];
/** Badge colours: the palette's, nothing else. */
export const BADGE_COLORS = ["#F4F4F4", "#48E160", "#E15A48", "#8A8A8A"];
/** The badge a wallet shows: its profile's, or one derived from its address until it sets one. */
export function badgeOf(wallet: string, profile?: S.Profile): { shape: number; color: string } {
  if (profile) return { shape: profile.badge % BADGES.length, color: BADGE_COLORS[profile.color % BADGE_COLORS.length] };
  let h = 0;
  for (const ch of wallet) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { shape: h % BADGES.length, color: "#4A4A4A" };
}
export function Badge({ wallet, profile, size = 18 }: { wallet: string; profile?: S.Profile; size?: number }) {
  const b = badgeOf(wallet, profile);
  return (
    <svg className="badge" width={size} height={size} viewBox="-0.06 -0.06 1.12 1.12" aria-hidden>
      <polygon points={BADGES[b.shape].points.map(p => p.join(",")).join(" ")} fill={b.color} />
    </svg>
  );
}
export const nameOf = (wallet: string, profile?: S.Profile) => profile?.name ?? short(wallet);

// ---------------------------------------------------------------- data

let cache: { net: string; board: S.Board } | undefined;
let loading: Promise<S.Board> | undefined;
/** The board, shared by every part of the page that shows it and re-read every 20 seconds. */
export function useBoard(tick: number): { board?: S.Board; err?: string; reload: () => void } {
  const { connection } = useConnection();
  const [board, setBoard] = useState<S.Board | undefined>(cache?.net === C.NETWORK ? cache.board : undefined);
  const [err, setErr] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = (force: boolean) => {
      if (!force && cache?.net === C.NETWORK && Date.now() - cache.board.at < 15_000) return setBoard(cache.board);
      loading ??= S.loadBoard(connection).finally(() => { loading = undefined; });
      loading.then(b => { cache = { net: C.NETWORK, board: b }; if (live) { setBoard(b); setErr(undefined); } }).catch(e => live && setErr(String(e?.message ?? e)));
    };
    load(n > 0);
    const id = setInterval(() => load(false), 20_000);
    return () => { live = false; clearInterval(id); };
  }, [connection, tick, n]);
  return { board, err, reload: () => setN(x => x + 1) };
}

/** What the connected wallet has set up: its trading account, profile, who it follows and copies. */
export function useMe(board: S.Board | undefined, tick: number) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [trader, setTrader] = useState<C.Trader | null>();
  const me = publicKey?.toBase58();
  useEffect(() => {
    if (!publicKey) return setTrader(undefined);
    let live = true;
    connection.getAccountInfo(C.traderAddress(publicKey)).then(a => live && setTrader(a ? C.decodeTrader(new Uint8Array(a.data)) : null)).catch(() => undefined);
    return () => { live = false; };
  }, [me, tick, connection]);
  return useMemo(() => ({
    wallet: me,
    trader,
    profile: me ? board?.profiles.get(me) : undefined,
    following: new Set((board?.follows ?? []).filter(f => f.follower.toBase58() === me).map(f => f.leader.toBase58())),
    copy: board?.copies.find(c => c.follower.toBase58() === me),
  }), [me, trader, board]);
}
type Me = ReturnType<typeof useMe>;

/** Everything a wallet needs before it can follow or copy, as instructions for the same
 *  transaction: a trading account and its track record. */
const setup = (pk: PublicKey, me: Me): TransactionInstruction[] => [
  ...(me.trader === null ? [C.openTradingAccount(pk)] : []),
  ...(!me.trader?.hasStats ? [S.openStats(pk, pk)] : []),
];

const signed = (x: number, dp = 2) => `${x >= 0 ? "+" : "−"}$${fmt(Math.abs(x), dp)}`;
const pct = (x: number, dp = 1) => `${x >= 0 ? "+" : "−"}${fmt(Math.abs(x) * 100, dp)}%`;
const tone = (x: number) => (x > 0 ? "up" : x < 0 ? "down" : "");
const tagOf = (wallet: string) => (SEED_WALLETS[wallet] ? (SEED_WALLETS[wallet].startsWith("bot") ? "test bot" : "demo") : undefined);

/** A day's result as a bar: thirty trading days, oldest on the left. */
function DayBars({ days, height = 22, width = 96 }: { days: S.Day[]; height?: number; width?: number }) {
  if (!days.length) return <span className="muted">—</span>;
  const most = Math.max(...days.map(d => Math.abs(d.pnl)), 1e-9), w = width / 30, mid = height / 2;
  return (
    <svg className="daybars" width={width} height={height} aria-hidden>
      <line x1="0" x2={width} y1={mid} y2={mid} stroke="#2A2A2A" />
      {days.map((d, i) => {
        const h = Math.max(1, Math.abs(d.pnl) / most * (mid - 1));
        return <rect key={d.day} x={(30 - days.length + i) * w + 0.5} width={Math.max(1, w - 1)} y={d.pnl >= 0 ? mid - h : mid} height={h} fill={d.pnl >= 0 ? "#48E160" : "#E15A48"} />;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- search

function Search({ board, go }: { board?: S.Board; go: (to: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const text = q.trim();
  const address = useMemo(() => { try { return text.length >= 32 ? new PublicKey(text).toBase58() : undefined; } catch { return undefined; } }, [text]);
  const hits = useMemo(() => {
    if (!text || !board) return [];
    const t = text.toLowerCase();
    return board.rows.filter(r => r.profile?.name.toLowerCase().includes(t) || r.wallet.toLowerCase().startsWith(t) || SEED_WALLETS[r.wallet]?.includes(t)).slice(0, 8);
  }, [text, board]);
  const pick = (w: string) => { setOpen(false); setQ(""); go(`/trader/${w}`); };
  return (
    <div className="tsearch" ref={box}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.5 10.5 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      <input value={q} placeholder="Search a name or paste any account address" onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={e => { if (e.key === "Enter") { if (address) pick(address); else if (hits[0]) pick(hits[0].wallet); } if (e.key === "Escape") setOpen(false); }} />
      {open && text && (
        <div className="tsearch-menu">
          {hits.map(r => (
            <button key={r.wallet} onClick={() => pick(r.wallet)}>
              <Badge wallet={r.wallet} profile={r.profile} /><b>{nameOf(r.wallet, r.profile)}</b><span className="mono muted">{short(r.wallet)}</span>
              <span className={`mono ${tone(r.pnl)}`}>{r.stats ? signed(r.pnl, 0) : ""}</span>
            </button>
          ))}
          {address && !hits.some(h => h.wallet === address) && <button onClick={() => pick(address)}><Badge wallet={address} /><b>Open this account</b><span className="mono muted">{short(address)}</span><span /></button>}
          {!hits.length && !address && <div className="quiet">No name starts like that. A full address opens any account.</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- profile editor

function ProfileEditor({ me, send, busy, done }: { me: Me; send: Send; busy?: string; done: () => void }) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [name, setName] = useState(me.profile?.name ?? "");
  const [badge, setBadge] = useState(me.profile?.badge ?? 0);
  const [color, setColor] = useState(me.profile?.color ?? 0);
  const [taken, setTaken] = useState(false);
  const ok = S.validName(name);
  // A name is free when nobody's account sits at its address (or it is this wallet's own).
  useEffect(() => {
    setTaken(false);
    if (!ok || name.toLowerCase() === me.profile?.name.toLowerCase()) return;
    let live = true;
    const id = setTimeout(() => connection.getAccountInfo(S.nameAddress(name)).then(a => live && setTaken(!!a && a.data.length > 0)).catch(() => undefined), 300);
    return () => { live = false; clearTimeout(id); };
  }, [name, ok, connection, me.profile?.name]);
  const why = !name ? "Choose a name" : !ok ? `${S.NAME_MIN} to ${S.NAME_MAX} letters, digits or underscores` : taken ? "That name is taken" : undefined;
  const preview: S.Profile | undefined = publicKey ? { wallet: publicKey, name: name || "you", badge, color, created: 0 } : undefined;
  return (
    <div className="pedit">
      <label className="inp"><span>Username</span><input value={name} maxLength={S.NAME_MAX} onChange={e => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))} placeholder="satoshi" style={{ fontFamily: "inherit" }} /></label>
      <div className="pedit-l">Badge</div>
      <div className="pedit-badges">
        {BADGES.map((b, i) => (
          <button key={b.name} title={b.name} aria-label={b.name} className={i === badge ? "on" : ""} onClick={() => setBadge(i)}>
            <svg width="20" height="20" viewBox="-0.06 -0.06 1.12 1.12" aria-hidden><polygon points={b.points.map(p => p.join(",")).join(" ")} fill={BADGE_COLORS[color]} /></svg>
          </button>
        ))}
      </div>
      <div className="pedit-colors">
        {BADGE_COLORS.map((c, i) => <button key={c} aria-label={`Colour ${i + 1}`} className={i === color ? "on" : ""} onClick={() => setColor(i)}><i style={{ background: c }} /></button>)}
        {preview && me.wallet && <span className="pedit-prev"><Badge wallet={me.wallet} profile={preview} size={20} /><b>{preview.name}</b></span>}
      </div>
      <div className="btns">
        <button className="btn primary" disabled={!!why || !!busy || !publicKey} onClick={async () => { if (publicKey && await send("Save profile", [S.setProfile(publicKey, name, me.profile?.name, badge, color)])) done(); }}>{busy ? `${busy}…` : "Save profile"}</button>
        <button className="btn ghost" onClick={done}>Cancel</button>
      </div>
      {why && name && <div className="why">{why}</div>}
      <p className="fine">Your name and badge are stored by the router program under your wallet. A name belongs to one wallet at a time; changing it frees the old one. About 0.002 test {C.COIN} of rent, returned if a name is released.</p>
    </div>
  );
}

// ---------------------------------------------------------------- actions

function useActions(me: Me, send: Send, reload: () => void) {
  const { publicKey } = useWallet();
  const run = async (label: string, ixs: TransactionInstruction[]) => { const r = await send(label, ixs); reload(); return r; };
  return {
    follow: (leader: string, name: string) => publicKey && run(`Follow ${name}`, [S.follow(publicKey, new PublicKey(leader))]),
    unfollow: (leader: string, name: string) => publicKey && run(`Unfollow ${name}`, [S.unfollow(publicKey, new PublicKey(leader))]),
    /** One click: a trading account and its track record if the wallet has none yet, a follow
     *  (so the trader's fills show on the chart), and the copy itself. */
    copy: (leader: string, name: string, ratioBps = 10_000, maxNotional = 0n) => publicKey && run(`Copy ${name}`, [
      ...setup(publicKey, me),
      ...(me.following.has(leader) ? [] : [S.follow(publicKey, new PublicKey(leader))]),
      S.setCopy(publicKey, new PublicKey(leader), ratioBps, maxNotional),
    ]),
    stop: () => publicKey && run("Stop copying", [S.stopCopy(publicKey)]),
  };
}

// ---------------------------------------------------------------- the board

type Sort = "pnl" | "roi" | "days" | "volume" | "copiers";

export function TradersPage({ send, busy, tick, go }: { send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const { board, err, reload } = useBoard(tick);
  const me = useMe(board, tick);
  const act = useActions(me, send, reload);
  const [sort, setSort] = useState<Sort>("pnl");
  const [view, setView] = useState<"top" | "following">("top");
  const [editing, setEditing] = useState(false);
  const rows = useMemo(() => {
    const by: Record<Sort, (r: S.TraderRow) => number> = { pnl: r => r.pnl, roi: r => r.roi, days: r => r.daysUp - r.daysDown, volume: r => r.stats?.volume ?? 0, copiers: r => r.copiers * 1000 + r.followers };
    return [...(board?.rows ?? [])].filter(r => r.stats && (view === "top" || me.following.has(r.wallet) || me.copy?.leader.toBase58() === r.wallet))
      // Accounts that have not traded since their record was opened come after those that have.
      .sort((a, b) => Number((b.stats?.trades ?? 0) > 0) - Number((a.stats?.trades ?? 0) > 0) || by[sort](b) - by[sort](a));
  }, [board, sort, view, me]);
  const mine = board?.rows.find(r => r.wallet === me.wallet);
  const leader = me.copy && board?.rows.find(r => r.wallet === me.copy!.leader.toBase58());
  return (
    <main className="traders">
      <div className="traders-head">
        <div>
          <h2>Copy trading</h2>
          <p className="muted small">Every trader's record is kept by the router program itself: profit is the account's value minus what was paid in. Follow a trader to see their trades on your chart, or copy one and your account mirrors theirs.</p>
        </div>
        <Search board={board} go={go} />
      </div>

      <section className="mecard">
        {!publicKey ? <div className="quiet">Connect a wallet to set your name and badge, follow traders and copy them.</div> : editing ? <ProfileEditor me={me} send={send} busy={busy} done={() => { setEditing(false); reload(); }} /> : (
          <>
            <div className="me-id">
              <Badge wallet={me.wallet!} profile={me.profile} size={34} />
              <div>
                <b>{nameOf(me.wallet!, me.profile)}</b>
                <span className="mono muted">{short(me.wallet!)}</span>
              </div>
              <button className="btn tiny" onClick={() => setEditing(true)}>{me.profile ? "Edit name and badge" : "Set a name and badge"}</button>
              <button className="btn tiny ghost" onClick={() => go(`/trader/${me.wallet}`)}>My record</button>
            </div>
            <div className="me-stats">
              <div><span>Profit</span><b className={`mono ${tone(mine?.pnl ?? 0)}`}>{mine?.stats ? signed(mine.pnl) : "—"}</b></div>
              <div><span>Return</span><b className={`mono ${tone(mine?.roi ?? 0)}`}>{mine?.stats ? pct(mine.roi) : "—"}</b></div>
              <div><span>Profitable days</span><b className="mono">{mine?.stats ? `${mine.daysUp} of ${mine.daysUp + mine.daysDown}` : "—"}</b></div>
              <div><span>Following</span><b className="mono">{me.following.size}</b></div>
              <div><span>Copying</span><b>{me.copy ? <button className="link" onClick={() => go(`/trader/${me.copy!.leader.toBase58()}`)}>{nameOf(me.copy.leader.toBase58(), leader?.profile ?? undefined)} · {fmt(me.copy.ratioBps / 10_000, 1)}×</button> : "nobody"}</b></div>
              {me.copy && <button className="btn tiny" disabled={!!busy} onClick={() => act.stop()}>Stop copying</button>}
            </div>
          </>
        )}
      </section>

      <div className="traders-bar">
        <div className="seg-tf">
          <button className={view === "top" ? "on" : ""} onClick={() => setView("top")}>All traders</button>
          <button className={view === "following" ? "on" : ""} onClick={() => setView("following")}>Following{me.following.size ? ` ${me.following.size}` : ""}</button>
        </div>
        <div className="seg-tf">
          {([["pnl", "Profit"], ["roi", "Return"], ["days", "Profitable days"], ["volume", "Volume"], ["copiers", "Copiers"]] as const).map(([k, l]) => <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>{l}</button>)}
        </div>
      </div>

      {err && !board ? <div className="quiet">Cannot read the chain: {err}</div> : !board ? <div className="quiet">Reading the chain…</div> : rows.length === 0 ? (
        <div className="quiet">{view === "following" ? "You follow nobody yet. Follow a trader and their trades appear on your chart." : "No track records on this network yet. A record starts with an account's first trade."}</div>
      ) : (
        <div className="traders-table">
          <table className="tbl">
            <thead><tr><th>#</th><th>Trader</th><th className="r">Profit</th><th className="r">Return</th><th className="r">Profitable days</th><th>Last 30 trading days</th><th className="r">Largest fall</th><th className="r">Volume</th><th className="r">Trades</th><th className="r">Copiers</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const name = nameOf(r.wallet, r.profile), isMe = r.wallet === me.wallet, copying = me.copy?.leader.toBase58() === r.wallet, tag = tagOf(r.wallet);
                return (
                  <tr key={r.wallet} className={isMe ? "me" : ""}>
                    <td className="mono muted">{i + 1}</td>
                    <td>
                      <button className="trader" onClick={() => go(`/trader/${r.wallet}`)}>
                        <Badge wallet={r.wallet} profile={r.profile} size={20} />
                        <b>{name}</b>
                        {r.profile && <span className="mono muted">{short(r.wallet)}</span>}
                        {isMe && <em>you</em>}{tag && <em title={SEED_WALLETS[r.wallet]}>{tag}</em>}{copying && <em className="on">copying</em>}
                      </button>
                    </td>
                    <td className={`r mono ${tone(r.pnl)}`}>{signed(r.pnl)}</td>
                    <td className={`r mono ${tone(r.roi)}`}>{pct(r.roi)}</td>
                    <td className="r mono">{r.daysUp} of {r.daysUp + r.daysDown}</td>
                    <td><DayBars days={r.days} /></td>
                    <td className="r mono">{r.drawdownPct >= 0.0005 ? `−${fmt(r.drawdownPct * 100, 1)}%` : "—"}</td>
                    <td className="r mono">${fmt(r.stats!.volume, 0)}</td>
                    <td className="r mono">{r.stats!.trades}</td>
                    <td className="r mono">{r.copiers}{r.followers ? <span className="muted"> · {r.followers}</span> : null}</td>
                    <td className="r"><div className="acts">
                      {!isMe && publicKey && (me.following.has(r.wallet)
                        ? <button className="btn tiny ghost" disabled={!!busy} onClick={() => act.unfollow(r.wallet, name)}>Following</button>
                        : <button className="btn tiny ghost" disabled={!!busy} onClick={() => act.follow(r.wallet, name)}>Follow</button>)}
                      {!isMe && publicKey && (copying
                        ? <button className="btn tiny" disabled={!!busy} onClick={() => act.stop()}>Stop</button>
                        : <button className="btn tiny primary" disabled={!!busy} title="Your account mirrors this trader's positions, at the same leverage. One signature." onClick={() => act.copy(r.wallet, name)}>Copy</button>)}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">
        Records start when an account's track record is opened (the first trade after this feature went live), not before. Profit is equity now minus equity then minus net deposits since; return is profit over the money that was at work.
        A trading day counts as profitable when the account was worth more at its last fill that day than at the last fill before it. Copiers · followers in the last column. Accounts tagged "test bot" are our own test traffic.
      </p>
    </main>
  );
}

// ---------------------------------------------------------------- one trader

export function TraderPage({ wallet, send, busy, tick, go }: { wallet: string; send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const { board, reload } = useBoard(tick);
  const { cards } = useCards(tick);
  const me = useMe(board, tick);
  const act = useActions(me, send, reload);
  const [ratio, setRatio] = useState<number>();
  const [cap, setCap] = useState<string>();
  const valid = useMemo(() => { try { return new PublicKey(wallet).toBase58() === wallet; } catch { return false; } }, [wallet]);
  if (!valid) return <main className="traders"><div className="quiet">That is not an account address.</div></main>;
  const r = board?.rows.find(x => x.wallet === wallet);
  const symbol = (asset: number) => cards?.find(c => c.v.canonical && c.v.assetIndex === asset)?.v.feed?.symbol ?? `#${asset}`;
  const name = nameOf(wallet, r?.profile), isMe = wallet === me.wallet, tag = tagOf(wallet);
  const copying = me.copy?.leader.toBase58() === wallet ? me.copy : undefined;
  const ratioBps = ratio ?? copying?.ratioBps ?? 10_000;
  const capText = cap ?? (copying && copying.maxNotional > 0n ? String(Number(copying.maxNotional) / C.USDC) : "");
  const capAtoms = BigInt(Math.max(0, Math.round(Number(capText || 0) * C.USDC)));
  const s = r?.stats;
  const myEquity = board?.rows.find(x => x.wallet === me.wallet)?.equity ?? 0;
  const tile = (label: string, value: string, cls = "", sub?: string) => <div className="tile"><span>{label}</span><b className={`mono ${cls}`}>{value}</b>{sub && <i>{sub}</i>}</div>;
  return (
    <main className="traders">
      <button className="link back" onClick={() => go("/traders")}>← All traders</button>
      <div className="tp-head">
        <Badge wallet={wallet} profile={r?.profile} size={44} />
        <div className="tp-name">
          <h2>{name}{tag && <em>{tag}</em>}{isMe && <em>you</em>}</h2>
          <a className="mono muted" href={explorer("address", wallet)} target="_blank" rel="noreferrer">{wallet}</a>
        </div>
        {!isMe && publicKey && (
          <div className="tp-acts">
            {me.following.has(wallet)
              ? <button className="btn ghost" disabled={!!busy} onClick={() => act.unfollow(wallet, name)}>Following</button>
              : <button className="btn ghost" disabled={!!busy} onClick={() => act.follow(wallet, name)}>Follow</button>}
          </div>
        )}
      </div>

      {!board ? <div className="quiet">Reading the chain…</div> : !s ? (
        <div className="quiet">This account has no track record on {C.NETWORK_NAME}{r ? "" : " and no profile"}. A record starts with its first trade here.</div>
      ) : (
        <>
          <div className="tiles">
            {tile("Profit", signed(r!.pnl), tone(r!.pnl), `since ${new Date(s.startTime * 1000).toISOString().slice(0, 10)}`)}
            {tile("Return", pct(r!.roi, 2), tone(r!.roi), `on $${fmt(s.startEquity + s.deposited, 0)} at work`)}
            {tile("Profitable days", `${r!.daysUp} of ${r!.daysUp + r!.daysDown}`, "", r!.daysUp + r!.daysDown ? `${fmt(r!.daysUp / (r!.daysUp + r!.daysDown) * 100, 0)}% of trading days` : undefined)}
            {tile("Best day", s.days.length ? signed(Math.max(s.bestDay, ...s.days.map(d => d.pnl))) : "—", "up")}
            {tile("Worst day", s.days.length ? signed(Math.min(s.worstDay, ...s.days.map(d => d.pnl))) : "—", "down")}
            {tile("Largest fall", r!.drawdownPct >= 0.0005 ? `−${fmt(r!.drawdownPct * 100, 1)}%` : "—", "", "from its best, of the money at work")}
            {tile("Won ÷ lost", r!.profitFactor === undefined ? "—" : fmt(r!.profitFactor, 2), "", "winning days over losing days")}
            {tile("Equity now", `$${fmt(r!.equity)}`, "", r!.leverage > 0 ? `${fmt(r!.leverage, 1)}× leverage` : "no position")}
            {tile("Volume", `$${fmt(s.volume, 0)}`, "", `${s.trades} trades`)}
            {tile("Copiers", String(r!.copiers), "", `${r!.followers} followers`)}
          </div>

          <div className="tp-grid">
            <section className="tp-card">
              <h3>Trading days</h3>
              {s.days.length === 0 ? <div className="quiet">No fill since the record was opened.</div> : <>
                <DayBars days={s.days} height={110} width={540} />
                <div className="tp-days mono"><span>{new Date(s.days[0].day * 86_400_000).toISOString().slice(5, 10)}</span><span>{s.days.length} trading day{s.days.length > 1 ? "s" : ""}</span><span>{new Date(s.days[s.days.length - 1].day * 86_400_000).toISOString().slice(5, 10)}</span></div>
              </>}
              <h3>Open positions</h3>
              {r!.positions.length === 0 ? <div className="quiet">None.</div> : (
                <table className="tbl"><thead><tr><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Value</th></tr></thead><tbody>
                  {r!.positions.map(p => <tr key={p.asset}><td><button className="link" onClick={() => go(`/trade/${symbol(p.asset)}`)}>{symbol(p.asset)}-PERP</button></td><td className={p.size > 0 ? "up" : "down"}>{p.size > 0 ? "Long" : "Short"}</td><td className="r mono">{fmt(Math.abs(p.size), 4).replace(/\.?0+$/, "")}</td><td className="r mono">${fmt(p.notional)}</td></tr>)}
                </tbody></table>
              )}
              <h3>Latest trades</h3>
              {s.fills.length === 0 ? <div className="quiet">None yet.</div> : (
                <table className="tbl"><thead><tr><th>When</th><th>Market</th><th>Side</th><th className="r">Size</th><th className="r">Price</th></tr></thead><tbody>
                  {[...s.fills].reverse().map((f, i) => <tr key={i}><td className="mono">{ago(Date.now() / 1000 - f.time)}</td><td>{symbol(f.asset)}-PERP</td><td className={f.size > 0 ? "up" : "down"}>{f.size > 0 ? "Buy" : "Sell"}</td><td className="r mono">{fmt(Math.abs(f.size), 4).replace(/\.?0+$/, "")}</td><td className="r mono">{fmt(f.price, priceDp(f.price))}</td></tr>)}
                </tbody></table>
              )}
            </section>

            {!isMe && (
              <section className="tp-card copy">
                <h3>{copying ? `You are copying ${name}` : `Copy ${name}`}</h3>
                <div className="pedit-l">Leverage, compared with theirs</div>
                <div className="quick">
                  {[5_000, 10_000, 20_000, 30_000].map(b => <button key={b} className={b === ratioBps ? "on" : ""} onClick={() => setRatio(b)}>{b / 10_000}×</button>)}
                </div>
                <label className="inp small"><span>Most on one market</span><input value={capText} onChange={e => setCap(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="no limit" inputMode="decimal" /><em>USD</em></label>
                <div className="sum">
                  <div><span>Their leverage now</span><b className="mono">{fmt(r!.leverage, 1)}×</b></div>
                  <div><span>Yours would be</span><b className="mono">{fmt(r!.leverage * ratioBps / 10_000, 1)}×</b></div>
                  <div><span>Your margin</span><b className="mono">${fmt(myEquity)}</b></div>
                  <div><span>Fee</span><b className="mono">0.05% per trade</b></div>
                </div>
                {!publicKey ? <div className="why">Connect a wallet to copy.</div> : (
                  <>
                    <button className="submit neutral" disabled={!!busy || (!!copying && copying.ratioBps === ratioBps && copying.maxNotional === capAtoms)} onClick={() => act.copy(wallet, name, ratioBps, capAtoms)}>{busy ? `${busy}…` : copying ? "Change terms" : `Copy ${name}`}</button>
                    {copying && <button className="closepos" disabled={!!busy} onClick={() => act.stop()}>Stop copying</button>}
                    {myEquity <= 0 && <div className="why">Your trading account holds no margin yet: deposit on the Trade page and the copy starts with their next trade.</div>}
                  </>
                )}
                <p className="fine">
                  You sign once. From then on your account is kept at this trader's leverage on every market, times the setting above: when they open, add, cut or close, a trade for your account is queued and fills at the next oracle price, like any order.
                  While you copy, positions you open yourself are brought back in line. Stopping leaves your positions as they are. Nobody can withdraw from your account or choose the size of a copy trade: the router computes it from both accounts.
                  {copying && ` Brought in line ${copying.triggers} time${copying.triggers === 1 ? "" : "s"} so far.`}
                </p>
              </section>
            )}
          </div>
        </>
      )}
    </main>
  );
}

/** For other pages: a wallet's trades as chart marks (see Chart `marks`). */
export type Mark = { key: string; time: number; price: number; size: number; name: string; shape: number; color: string };
export function marksFor(board: S.Board | undefined, leaders: Iterable<string>, asset: number): Mark[] {
  const out: Mark[] = [];
  for (const w of leaders) {
    const r = board?.rows.find(x => x.wallet === w);
    if (!r?.stats) continue;
    const b = badgeOf(w, r.profile);
    for (const f of r.stats.fills) if (f.asset === asset) out.push({ key: `${w}:${f.time}:${f.size}`, time: f.time, price: f.price, size: f.size, name: nameOf(w, r.profile), shape: b.shape, color: b.color === "#4A4A4A" ? "#8A8A8A" : b.color });
  }
  return out.sort((a, b) => a.time - b.time);
}
export type { Connection };
