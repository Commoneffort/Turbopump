// The leaderboard and copy trading: who trades well here, by a record the router keeps itself;
// names and badges; following (their trades show on your chart) and copying (your account
// mirrors theirs).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SEED_WALLETS } from "../api/_config";
import * as C from "./chain";
import * as S from "./social";
import { view } from "./view";
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
// ---- badge pictures
//
// A wallet can pay to show a picture of its own. The bytes come from a public chain, written by
// whoever paid, so nothing about them is trusted:
//  - they are never a link: the page fetches nothing on a stranger's say-so (no tracking, no
//    requests to other sites), and never anything but a JPEG (an SVG can carry script);
//  - the browser decodes them as a JPEG and nothing else, the result must be exactly the size
//    the page itself makes, and what is shown is those pixels drawn again by this page: no
//    byte a stranger wrote reaches the document, only a picture this page encoded;
//  - they are shown with <img>, which runs nothing, at a fixed size;
//  - a picture that fails any step is simply not shown: the wallet keeps its shape badge.
/** Wallets whose picture this page does not show (it cannot be taken off the chain). */
export const HIDDEN_PICTURES = new Set<string>([]);
const shown = new Map<string, { of: Uint8Array; url?: string; img?: HTMLImageElement }>();
const watchers = new Set<() => void>();
let shownVersion = 0;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The bytes as a picture this page drew itself, or undefined if they are not exactly a
 *  `BADGE_PX` square JPEG. */
export async function safePicture(bytes: Uint8Array): Promise<string | undefined> {
  if (bytes.length < 4 || bytes.length > S.BADGE_MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
    try {
      if (bitmap.width !== S.BADGE_PX || bitmap.height !== S.BADGE_PX) return undefined;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = S.BADGE_PX;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/png");
    } finally { bitmap.close(); }
  } catch { return undefined; }
}
/** Takes the board's pictures in: each is checked once, and again only if its bytes change. */
function takePictures(pictures: Map<string, Uint8Array>) {
  let changed = false;
  for (const w of [...shown.keys()]) if (!pictures.has(w)) { shown.delete(w); changed = true; }
  for (const [w, bytes] of pictures) {
    if (HIDDEN_PICTURES.has(w)) continue;
    const had = shown.get(w);
    if (had && sameBytes(had.of, bytes)) continue;
    const entry: { of: Uint8Array; url?: string; img?: HTMLImageElement } = { of: bytes };
    shown.set(w, entry);
    safePicture(bytes).then(async url => {
      if (shown.get(w) !== entry || !url) return;
      entry.url = url;
      // The same picture, ready to be drawn on the chart (a canvas draws only a loaded image).
      const img = new Image();
      img.src = url;
      await img.decode().then(() => { entry.img = img; }).catch(() => undefined);
      shownVersion++;
      watchers.forEach(f => f());
    });
  }
  if (changed) { shownVersion++; watchers.forEach(f => f()); }
}
export const usePictures = () => useSyncExternalStore(f => { watchers.add(f); return () => { watchers.delete(f); }; }, () => shownVersion);

export function Badge({ wallet, profile, size = 18, picture }: { wallet: string; profile?: S.Profile; size?: number; picture?: string | null }) {
  usePictures();
  const b = badgeOf(wallet, profile);
  // `picture`: a preview (null = show the shape even if the wallet has a picture).
  const url = picture === undefined ? shown.get(wallet)?.url : picture ?? undefined;
  if (url) return <img className="badge badge-pic" src={url} width={size} height={size} alt="" draggable={false} />;
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
  const connection = view;
  const [board, setBoard] = useState<S.Board | undefined>(cache?.net === C.NETWORK ? cache.board : undefined);
  const [err, setErr] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = (force: boolean) => {
      if (!force && cache?.net === C.NETWORK && Date.now() - cache.board.at < 15_000) return setBoard(cache.board);
      loading ??= S.loadBoard(connection).finally(() => { loading = undefined; });
      loading.then(b => { cache = { net: C.NETWORK, board: b }; takePictures(b.pictures); if (live) { setBoard(b); setErr(undefined); } }).catch(e => live && setErr(String(e?.message ?? e)));
    };
    load(n > 0);
    const id = setInterval(() => document.hidden || load(false), 20_000);
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

function ProfileEditor({ me, has, send, busy, done, reload }: { me: Me; has: boolean; send: Send; busy?: string; done: () => void; reload: () => void }) {
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
  // A name the wallet does not hold yet (its first, or another one) costs the fee; other capitals do not.
  const newName = ok && name.toLowerCase() !== me.profile?.name.toLowerCase();
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
        <button className="btn primary" disabled={!!why || !!busy || !publicKey} onClick={async () => { if (publicKey && await send(newName ? `Save profile (${S.SMALL_FEE_TEXT})` : "Save profile", [S.setProfile(publicKey, name, me.profile?.name, badge, color)])) done(); }}>{busy ? `${busy}…` : newName ? `Save profile · ${S.SMALL_FEE_TEXT}` : "Save profile"}</button>
        <button className="btn ghost" onClick={done}>Cancel</button>
      </div>
      {why && name && <div className="why">{why}</div>}
      <p className="fine">Your name and badge are stored by the router program under your wallet. A name belongs to one wallet at a time; changing it frees the old one. Taking a name costs {S.SMALL_FEE_TEXT}, paid to the platform, and so does changing it to another; a new badge or colour is free. About 0.002 test {C.COIN} of rent on top, returned if a name is released.</p>
      <PictureEditor me={me} has={has} send={send} busy={busy} reload={reload} />
    </div>
  );
}

// ---------------------------------------------------------------- badge picture editor

/** A picture file from the user's own computer as the JPEG the page stores: its middle square,
 *  `BADGE_PX` wide, drawn again by this page. Drawing it again drops everything else the file
 *  carried (its format, and any record of where and when it was taken). */
async function makePicture(file: File): Promise<Uint8Array> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Use a JPEG, PNG or WebP picture");
  if (file.size > 8 * 1024 * 1024) throw new Error("That file is larger than 8 MB");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("This browser cannot read that file as a picture"); });
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S.BADGE_PX;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#121212";
  g.fillRect(0, 0, S.BADGE_PX, S.BADGE_PX);
  const side = Math.min(bitmap.width, bitmap.height);
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, S.BADGE_PX, S.BADGE_PX);
  bitmap.close();
  for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.15]) {
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, "image/jpeg", quality));
    if (blob && blob.type === "image/jpeg" && blob.size <= S.BADGE_TARGET_BYTES) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error("That picture does not get small enough: try a simpler one");
}

function PictureEditor({ me, has, send, busy, reload }: { me: Me; has: boolean; send: Send; busy?: string; reload: () => void }) {
  const { publicKey } = useWallet();
  const [pic, setPic] = useState<{ bytes: Uint8Array; url: string }>();
  const [err, setErr] = useState<string>();
  /** Bytes already on the chain of a picture whose later part did not go through. */
  const [resumeAt, setResumeAt] = useState<number>();
  const input = useRef<HTMLInputElement>(null);
  const choose = async (file?: File) => {
    setErr(undefined); setResumeAt(undefined);
    if (!file) return;
    try {
      const bytes = await makePicture(file);
      const url = await safePicture(bytes);
      if (!url) throw new Error("That picture could not be prepared");
      setPic({ bytes, url });
    } catch (e: any) { setPic(undefined); setErr(String(e?.message ?? e)); }
    if (input.current) input.current.value = "";
  };
  const parts = pic ? Math.ceil(pic.bytes.length / S.BADGE_CHUNK) : 0;
  const save = async () => {
    if (!publicKey || !pic) return;
    let at = resumeAt ?? 0;
    if (at === 0) {
      if (!await send(`Badge picture (1 of ${parts}, ${S.SOCIAL_FEE_TEXT})`, [S.setBadgeImage(publicKey, pic.bytes.length, pic.bytes.slice(0, S.BADGE_CHUNK))])) return;
      at = Math.min(S.BADGE_CHUNK, pic.bytes.length);
    }
    for (; at < pic.bytes.length; at += S.BADGE_CHUNK) {
      // The fee was paid with the first part: if a later part fails, only that part is sent again.
      if (!await send(`Badge picture (${at / S.BADGE_CHUNK + 1} of ${parts})`, [S.writeBadgeImage(publicKey, at, pic.bytes.slice(at, at + S.BADGE_CHUNK))])) { setResumeAt(at); return; }
    }
    setPic(undefined); setResumeAt(undefined);
    reload();
  };
  return (
    <div className="pedit-pic">
      <div className="pedit-l">Badge picture <span className="muted">· optional · {S.SOCIAL_FEE_TEXT}</span></div>
      <div className="pedit-pic-row">
        {me.wallet && <Badge wallet={me.wallet} profile={me.profile} size={48} picture={pic ? pic.url : undefined} />}
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => choose(e.target.files?.[0])} />
        <button className="btn tiny" disabled={!!busy} onClick={() => input.current?.click()}>{pic ? "Choose another" : has ? "Choose a new picture" : "Choose a picture"}</button>
        {pic && <button className="btn tiny primary" disabled={!!busy || !publicKey} onClick={save}>{busy ? `${busy}…` : resumeAt ? "Finish saving (no new fee)" : `Save picture · ${S.SOCIAL_FEE_TEXT}`}</button>}
        {pic && !resumeAt && <button className="btn tiny ghost" disabled={!!busy} onClick={() => setPic(undefined)}>Discard</button>}
        {!pic && has && <button className="btn tiny ghost" disabled={!!busy || !publicKey} onClick={async () => { if (publicKey && await send("Remove badge picture", [S.removeBadgeImage(publicKey)])) reload(); }}>Remove picture</button>}
      </div>
      {err && <div className="why">{err}</div>}
      {resumeAt !== undefined && <div className="why">The second part did not go through. The fee is paid: finish saving and only that part is sent again.</div>}
      <p className="fine">
        Your picture replaces the shape on the leaderboard, on your record and next to your name. It is cut to a square and stored as a small {S.BADGE_PX}×{S.BADGE_PX} JPEG by the router program under your wallet, in {parts > 1 ? `${parts} signatures` : "two signatures at most"}.
        {" "}{S.SOCIAL_FEE_TEXT} goes to the platform each time you save a picture; removing it returns the account's rent (about 0.016 {C.COIN}), not the fee. Pictures are public and cannot be edited by anyone but you.
      </p>
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
    copy: (leader: string, name: string, ratioBps = 10_000, maxNotional = 0n) => publicKey && run(me.copy?.leader.toBase58() === leader ? `New terms for copying ${name}` : `Copy ${name} (${S.SOCIAL_FEE_TEXT})`, [
      ...setup(publicKey, me),
      ...(me.following.has(leader) ? [] : [S.follow(publicKey, new PublicKey(leader))]),
      S.setCopy(publicKey, new PublicKey(leader), ratioBps, maxNotional),
    ]),
    stop: () => publicKey && run("Stop copying", [S.stopCopy(publicKey)]),
    feature: () => publicKey && run(`A day in the featured row (${S.SMALL_FEE_TEXT})`, [S.feature(publicKey)]),
  };
}

// ---------------------------------------------------------------- the board

type Sort = "pnl" | "roi" | "days" | "volume" | "copiers";
type Period = "7d" | "30d" | "all";
const PERIODS: [Period, string][] = [["7d", "7 days"], ["30d", "30 days"], ["all", "All time"]];
/** A row's profit and return over the board's period. A period's profit is the sum of the
 *  record's trading days in it (the record keeps the last thirty); "all time" is the record's
 *  own figure, which also counts what open positions are worth now. */
function over(r: S.TraderRow, period: Period): { pnl: number; roi: number } {
  if (period === "all" || !r.stats) return { pnl: r.pnl, roi: r.roi };
  const since = Math.floor(Date.now() / 86_400_000) - (period === "7d" ? 6 : 29);
  const pnl = r.days.filter(d => d.day >= since).reduce((t, d) => t + d.pnl, 0);
  const base = r.stats.startEquity + r.stats.deposited;
  return { pnl, roi: base > 0 ? pnl / base : 0 };
}

export function TradersPage({ send, busy, tick, go }: { send: Send; busy?: string; tick: number; go: (to: string) => void }) {
  const { publicKey } = useWallet();
  const { board, err, reload } = useBoard(tick);
  const me = useMe(board, tick);
  const act = useActions(me, send, reload);
  const [sort, setSort] = useState<Sort>("pnl");
  const [period, setPeriod] = useState<Period>("7d");
  const [view, setView] = useState<"top" | "following">("top");
  const [editing, setEditing] = useState(false);
  const rows = useMemo(() => {
    const by: Record<Sort, (r: S.TraderRow) => number> = { pnl: r => over(r, period).pnl, roi: r => over(r, period).roi, days: r => r.daysUp - r.daysDown, volume: r => r.stats?.volume ?? 0, copiers: r => r.copiers * 1000 + r.followers };
    return [...(board?.rows ?? [])].filter(r => r.stats && (view === "top" || me.following.has(r.wallet) || me.copy?.leader.toBase58() === r.wallet))
      // Accounts that have not traded since their record was opened come after those that have.
      .sort((a, b) => Number((b.stats?.trades ?? 0) > 0) - Number((a.stats?.trades ?? 0) > 0) || by[sort](b) - by[sort](a));
  }, [board, sort, view, me, period]);
  const podium = view === "top" && (sort === "pnl" || sort === "roi") ? rows.filter(r => (r.stats?.trades ?? 0) > 0).slice(0, 3) : [];
  const periodName = PERIODS.find(p => p[0] === period)![1].toLowerCase();
  // The featured row: wallets that paid for it, whoever paid furthest ahead first. It is a paid
  // place and says so; the figures in it are the router's, like everyone's.
  const nowSecs = Date.now() / 1000;
  const featured = (board?.rows ?? []).filter(r => (r.profile?.featuredUntil ?? 0) > nowSecs).sort((a, b) => b.profile!.featuredUntil! - a.profile!.featuredUntil!).slice(0, 6);
  const myUntil = me.profile?.featuredUntil ?? 0;
  const left = (until: number) => { const s = until - nowSecs; return s >= 86_400 ? `${Math.floor(s / 86_400)} d ${Math.floor(s % 86_400 / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h` : `${Math.max(1, Math.floor(s / 60))} min`; };
  const mine = board?.rows.find(r => r.wallet === me.wallet);
  const leader = me.copy && board?.rows.find(r => r.wallet === me.copy!.leader.toBase58());
  return (
    <main className="traders">
      <div className="traders-head">
        <div>
          <h2>Leaderboard</h2>
          <p className="muted small">Every trader's record is kept by the router program itself: profit is the account's value minus what was paid in, so it cannot be dressed up. Follow a trader to see their trades on your chart, or copy one ({S.SOCIAL_FEE_TEXT}, once) and your account mirrors theirs.</p>
        </div>
        <Search board={board} go={go} />
      </div>

      <section className="mecard">
        {!publicKey ? <div className="quiet">Connect a wallet to set your name and badge, follow traders and copy them.</div> : editing ? <ProfileEditor me={me} has={!!me.wallet && !!board?.pictures.has(me.wallet)} send={send} busy={busy} done={() => { setEditing(false); reload(); }} reload={reload} /> : (
          <>
            <div className="me-id">
              <Badge wallet={me.wallet!} profile={me.profile} size={34} />
              <div>
                <b>{nameOf(me.wallet!, me.profile)}</b>
                <span className="mono muted">{short(me.wallet!)}</span>
              </div>
              <button className="btn tiny" onClick={() => setEditing(true)}>{me.profile ? "Edit name, badge and picture" : "Set a name and badge"}</button>
              <button className="btn tiny ghost" onClick={() => go(`/trader/${me.wallet}`)}>My record</button>
              {me.profile && <button className="btn tiny ghost" disabled={!!busy || Math.max(myUntil, nowSecs) + S.FEATURE_SECS > nowSecs + S.FEATURE_MAX_AHEAD_SECS}
                title={`Shows you in the Featured row above the leaderboard for a day, marked as paid. ${S.SMALL_FEE_TEXT} a day, to the platform; paying again adds a day, up to 30 ahead.`}
                onClick={() => act.feature()}>{myUntil > nowSecs ? `Featured, ${left(myUntil)} left · add a day · ${S.SMALL_FEE_TEXT}` : `Get featured · ${S.SMALL_FEE_TEXT} a day`}</button>}
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
          {PERIODS.map(([k, l]) => <button key={k} className={period === k ? "on" : ""} onClick={() => setPeriod(k)}>{l}</button>)}
        </div>
        <div className="seg-tf">
          {([["pnl", "Profit"], ["roi", "Return"], ["days", "Profitable days"], ["volume", "Volume"], ["copiers", "Copiers"]] as const).map(([k, l]) => <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>{l}</button>)}
        </div>
      </div>

      {err && !board ? <div className="quiet">Cannot read the chain: {err}</div> : !board ? <div className="quiet">Reading the chain…</div> : rows.length === 0 ? (
        <div className="quiet">{view === "following" ? "You follow nobody yet. Follow a trader and their trades appear on your chart." : "No track records on this network yet. A record starts with an account's first trade."}</div>
      ) : (
        <>
        {view === "top" && featured.length > 0 && (
          <div className="featured">
            <span className="featured-l">Featured <em>paid</em></span>
            {featured.map(r => (
              <button key={r.wallet} className="trader" title={`Paid placement, ${left(r.profile!.featuredUntil!)} left. The figures are the router's record, the same as in the table.`} onClick={() => go(`/trader/${r.wallet}`)}>
                <Badge wallet={r.wallet} profile={r.profile} size={22} />
                <b>{nameOf(r.wallet, r.profile)}</b>
                {r.stats && <span className={`mono ${tone(over(r, period).pnl)}`}>{signed(over(r, period).pnl, 0)}</span>}
              </button>
            ))}
          </div>
        )}
        {podium.length > 0 && (
          <div className="podium">
            {podium.map((r, i) => {
              const name = nameOf(r.wallet, r.profile), o = over(r, period), isMe = r.wallet === me.wallet, copying = me.copy?.leader.toBase58() === r.wallet;
              return (
                <div key={r.wallet} className={`podium-card p${i + 1}`}>
                  <span className="podium-rank mono">{i + 1}</span>
                  <button className="trader" onClick={() => go(`/trader/${r.wallet}`)}>
                    <Badge wallet={r.wallet} profile={r.profile} size={44} />
                    <span className="podium-name"><b>{name}</b>{r.profile && <i className="mono muted">{short(r.wallet)}</i>}</span>
                  </button>
                  <div className="podium-nums">
                    <div><span>Profit, {periodName}</span><b className={`mono ${tone(o.pnl)}`}>{signed(o.pnl)}</b></div>
                    <div><span>Return</span><b className={`mono ${tone(o.roi)}`}>{pct(o.roi)}</b></div>
                    <div><span>Copiers</span><b className="mono">{r.copiers}</b></div>
                  </div>
                  {!isMe && publicKey && (copying
                    ? <button className="btn tiny" disabled={!!busy} onClick={() => act.stop()}>Stop copying</button>
                    : <button className="btn tiny primary" disabled={!!busy} onClick={() => act.copy(r.wallet, name)}>Copy · {S.SOCIAL_FEE_TEXT}</button>)}
                </div>
              );
            })}
          </div>
        )}
        <div className="traders-table">
          <table className="tbl">
            <thead><tr><th>#</th><th>Trader</th><th className="r">Profit{period === "all" ? "" : `, ${periodName}`}</th><th className="r">Return</th><th className="r">Profitable days</th><th>Last 30 trading days</th><th className="r">Largest fall</th><th className="r">Volume</th><th className="r">Trades</th><th className="r">Copiers</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const name = nameOf(r.wallet, r.profile), isMe = r.wallet === me.wallet, copying = me.copy?.leader.toBase58() === r.wallet, tag = tagOf(r.wallet), o = over(r, period);
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
                    <td className={`r mono ${tone(o.pnl)}`}>{signed(o.pnl)}</td>
                    <td className={`r mono ${tone(o.roi)}`}>{pct(o.roi)}</td>
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
                        : <button className="btn tiny primary" disabled={!!busy} title={`Your account mirrors this trader's positions, at the same leverage. One signature. Starting to copy costs ${S.SOCIAL_FEE_TEXT}, once.`} onClick={() => act.copy(r.wallet, name)}>Copy · {S.SOCIAL_FEE_TEXT}</button>)}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
      <p className="fine">
        The Featured row is a paid place ({S.SMALL_FEE_TEXT} a day, to the platform): it changes where a trader is shown, never their figures or their rank.
        Ranked over the period chosen above: 7 and 30 days add up the record's trading days in that time; "all time" is the whole record, including what open positions are worth now.
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
      <button className="link back" onClick={() => go("/leaderboard")}>← Leaderboard</button>
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
                  <div><span>Fee</span><b className="mono">{C.TRADE_FEE_PCT} per trade</b></div>
                  <div><span>To start copying</span><b className="mono">{copying ? "paid" : `${S.SOCIAL_FEE_TEXT}, once`}</b></div>
                </div>
                {!publicKey ? <div className="why">Connect a wallet to copy.</div> : (
                  <>
                    <button className="submit neutral" disabled={!!busy || (!!copying && copying.ratioBps === ratioBps && copying.maxNotional === capAtoms)} onClick={() => act.copy(wallet, name, ratioBps, capAtoms)}>{busy ? `${busy}…` : copying ? "Change terms" : `Copy ${name} · ${S.SOCIAL_FEE_TEXT}`}</button>
                    {copying && <button className="closepos" disabled={!!busy} onClick={() => act.stop()}>Stop copying</button>}
                    {myEquity <= 0 && <div className="why">Your trading account holds no margin yet: deposit on the Trade page and the copy starts with their next trade.</div>}
                  </>
                )}
                <p className="fine">
                  You sign once. From then on your account is kept at this trader's leverage on every market, times the setting above: when they open, add, cut or close, a trade for your account is queued and fills at the next oracle price, like any order.
                  Starting to copy a trader costs {S.SOCIAL_FEE_TEXT}, paid to the platform once; changing the terms later costs nothing, and copying someone else, or the same trader again after stopping, is a new start.
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
/** `picture`: the trader's badge picture, already checked and loaded, where they have one. */
export type Mark = { key: string; time: number; price: number; size: number; name: string; shape: number; color: string; picture?: HTMLImageElement };
export function marksFor(board: S.Board | undefined, leaders: Iterable<string>, asset: number): Mark[] {
  const out: Mark[] = [];
  for (const w of leaders) {
    const r = board?.rows.find(x => x.wallet === w);
    if (!r?.stats) continue;
    const b = badgeOf(w, r.profile), picture = shown.get(w)?.img;
    for (const f of r.stats.fills) if (f.asset === asset) out.push({ key: `${w}:${f.time}:${f.size}${picture ? ":p" : ""}`, time: f.time, price: f.price, size: f.size, name: nameOf(w, r.profile), shape: b.shape, color: b.color === "#4A4A4A" ? "#8A8A8A" : b.color, picture });
  }
  return out.sort((a, b) => a.time - b.time);
}
export type { Connection };
