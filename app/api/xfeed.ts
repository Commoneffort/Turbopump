// GET /api/xfeed?handles=a,b,c : the latest posts of a list of X accounts, newest first, merged.
// Read from X's public embed timelines (the data behind "embed this profile"; no key, no
// account). Searching all of X for a cashtag needs X's paid API, so the page filters these posts
// for $BTC, $SOL, $ETH… instead. Kept by the CDN for ten minutes and shared by everyone.
export const config = { maxDuration: 30 };

/** Accounts read when the page names none: news and the main accounts of the markets we list. */
export const DEFAULT_HANDLES = [
  "WatcherGuru", "whale_alert", "lookonchain", "WuBlockchain", "Cointelegraph", "CoinDesk", "TheBlock__",
  "BitcoinMagazine", "solana", "ethereum", "SolanaFloor", "aeyakovenko", "VitalikButerin", "saylor",
];

export type XPost = {
  id: string; time: number; text: string; handle: string; name: string; avatar: string;
  likes: number; reposts: number; replies: number; image?: string; repost?: boolean; followers?: number;
};

const cache = new Map<string, { at: number; posts: XPost[]; err?: string }>();
const valid = (h: string) => /^[A-Za-z0-9_]{1,15}$/.test(h);

export async function readHandle(handle: string, fresh = false): Promise<{ posts: XPost[]; err?: string }> {
  const had = cache.get(handle.toLowerCase());
  if (had && !fresh && Date.now() - had.at < 9 * 60_000) return had;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`, {
      signal: ctl.signal,
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36", accept: "text/html" },
    });
    if (!r.ok) throw new Error(`X answered ${r.status}`);
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error("no timeline in X's answer");
    const entries: any[] = JSON.parse(m[1])?.props?.pageProps?.timeline?.entries ?? [];
    const posts: XPost[] = [];
    for (const e of entries) {
      const tw = e?.content?.tweet;
      if (!tw?.id_str) continue;
      const rt = tw.retweeted_status;
      const src = rt ?? tw;
      let text: string = src.full_text ?? src.text ?? "";
      for (const u of src.entities?.urls ?? []) if (u.url) text = text.split(u.url).join(u.display_url ?? u.expanded_url ?? "");
      for (const md of src.extended_entities?.media ?? src.entities?.media ?? []) if (md.url) text = text.split(md.url).join("");
      text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
      const media = (src.extended_entities?.media ?? src.entities?.media ?? [])[0];
      posts.push({
        id: src.id_str, time: Math.floor(Date.parse(src.created_at) / 1000) || 0, text,
        handle: src.user?.screen_name ?? handle, name: src.user?.name ?? handle,
        avatar: String(src.user?.profile_image_url_https ?? "").replace("_normal.", "_bigger."),
        likes: src.favorite_count ?? 0, reposts: src.retweet_count ?? 0, replies: src.reply_count ?? 0,
        image: media?.media_url_https ? `${media.media_url_https}?name=small` : undefined,
        repost: !!rt,
      });
    }
    const out = { at: Date.now(), posts };
    cache.set(handle.toLowerCase(), out);
    return out;
  } catch (e: any) {
    const err = e?.name === "AbortError" ? "X did not answer in time" : String(e?.message ?? e);
    if (had) return { posts: had.posts, err };
    return { posts: [], err };
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- X API (with a key)

/** Reputable accounts with large followings whose posts make the feed (X_ACCOUNTS overrides). */
export const X_ACCOUNTS = [
  "saylor", "BitcoinMagazine", "solana", "VitalikButerin", "BitcoinNews", "KobeissiLetter", "WatcherGuru", "CoinDesk",
  "Cointelegraph", "TheBlockCo", "WuBlockchain", "lookonchain", "ethereum", "toly", "APompliano", "DocumentingBTC",
  "glassnode", "tier10k", "EricBalchunas", "brian_armstrong", "cz_binance",
];
const accounts = () => (process.env.X_ACCOUNTS ? process.env.X_ACCOUNTS.split(",").map(x => x.trim().replace(/^@/, "")).filter(x => /^[A-Za-z0-9_]{1,15}$/.test(x)) : X_ACCOUNTS);
// Their own posts only (no reposts or replies). X caps a query at 512 characters.
const defaultQuery = () => `(${accounts().map(a => `from:${a}`).join(" OR ")}) -is:retweet -is:reply`.slice(0, 512);
/** A post that is mostly cashtags, hashtags, mentions and links says nothing: left out. */
export const saysSomething = (text: string) => text.replace(/https?:\/\/\S+|\S+\.\S+\/\S*|[$#@][A-Za-z0-9_]+/g, " ").split(/\s+/).filter(w => /[A-Za-z]{2,}/.test(w)).length >= 6;
let bearer: { token: string; at: number } | undefined;
async function bearerToken(): Promise<string | undefined> {
  if (process.env.X_BEARER_TOKEN) return process.env.X_BEARER_TOKEN;
  const key = process.env.X_API_KEY, secret = process.env.X_API_SECRET;
  if (!key || !secret) return undefined;
  if (bearer && Date.now() - bearer.at < 3600_000) return bearer.token;
  const r = await fetch("https://api.x.com/oauth2/token", {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "grant_type=client_credentials",
  });
  const j: any = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`X refused the API key (${r.status})`);
  bearer = { token: j.access_token, at: Date.now() };
  return bearer.token;
}

/** Recent posts matching the search, as XPost. */
async function searchX(token: string): Promise<XPost[]> {
  // Only accounts with a large following are kept (X_MIN_FOLLOWERS, default 100,000), so ask for
  // a full page: most posts in a search come from small accounts.
  const max = Math.min(100, Math.max(10, Number(process.env.X_MAX_RESULTS) || 100));
  const minFollowers = Number(process.env.X_MIN_FOLLOWERS) || 100_000;
  const q = new URLSearchParams({
    query: process.env.X_QUERY || defaultQuery(), max_results: String(max), sort_order: "recency",
    expansions: "author_id,attachments.media_keys", "tweet.fields": "created_at,public_metrics,entities",
    "user.fields": "name,username,profile_image_url,public_metrics", "media.fields": "url,preview_image_url,type",
  });
  const r = await fetch(`https://api.x.com/2/tweets/search/recent?${q}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`X API ${r.status}: ${j?.title ?? j?.detail ?? "error"}`);
  const users = new Map<string, any>((j.includes?.users ?? []).map((u: any) => [u.id, u]));
  const media = new Map<string, any>((j.includes?.media ?? []).map((m: any) => [m.media_key, m]));
  return (j.data ?? []).filter((t: any) => (users.get(t.author_id)?.public_metrics?.followers_count ?? 0) > minFollowers).map((t: any): XPost => {
    const u = users.get(t.author_id) ?? {};
    let text: string = t.text ?? "";
    for (const x of t.entities?.urls ?? []) if (x.url) text = text.split(x.url).join(x.media_key ? "" : (x.display_url ?? x.expanded_url ?? ""));
    const m = (t.attachments?.media_keys ?? []).map((k: string) => media.get(k)).find(Boolean);
    return {
      id: t.id, time: Math.floor(Date.parse(t.created_at) / 1000) || 0, text: text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim(),
      handle: u.username ?? "", name: u.name ?? u.username ?? "", avatar: String(u.profile_image_url ?? "").replace("_normal.", "_bigger."),
      likes: t.public_metrics?.like_count ?? 0, reposts: t.public_metrics?.retweet_count ?? 0, replies: t.public_metrics?.reply_count ?? 0,
      image: m ? (m.url ?? m.preview_image_url) : undefined, followers: u.public_metrics?.followers_count,
    };
  });
}

export default async function handler(req: any, res: any) {
  // Two sources, merged: a search of all of X when an API key is set (X_BEARER_TOKEN, or X_API_KEY
  // and X_API_SECRET), and the accounts our collector reads (XFEED_URL, scripts/xfeed-collector.ts;
  // X refuses Vercel's shared addresses for the free embed timelines). The CDN keeps the answer.
  const minutes = Math.min(240, Math.max(5, Number(process.env.X_REFRESH_MINUTES) || 60));
  const posts: XPost[] = [];
  const errors: string[] = [];
  let sources = 0;
  const token = await bearerToken().catch(e => { errors.push(String(e?.message ?? e)); return undefined; });
  if (token) { sources++; try { posts.push(...await searchX(token)); } catch (e: any) { errors.push(String(e?.message ?? e)); } }
  const from = process.env.XFEED_URL;
  if (from) {
    sources++;
    try {
      const r = await fetch(`${from.replace(/\/$/, "")}/xfeed.json`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error(`collector answered ${r.status}`);
      posts.push(...((await r.json()).posts ?? []));
    } catch (e: any) { errors.push(String(e?.message ?? e)); }
  }
  const seen = new Set<string>();
  // At most 8 posts per account, so a few very busy ones do not fill the feed.
  const per = new Map<string, number>();
  const out = posts.filter(p => saysSomething(p.text)).filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true))).sort((a, b) => b.time - a.time)
    .filter(p => { const n = (per.get(p.handle.toLowerCase()) ?? 0) + 1; per.set(p.handle.toLowerCase(), n); return n <= 8; }).slice(0, 400);
  res.setHeader("Cache-Control", out.length ? `public, s-maxage=${minutes * 60}, stale-while-revalidate=7200` : "public, s-maxage=120");
  return res.status(200).json({ at: Math.floor(Date.now() / 1000), posts: out, off: sources === 0, errors: out.length ? undefined : errors });
}
