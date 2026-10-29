// Everything public the page draws from, read once for all visitors: GET /api/state?network=…
// The market, its vaults and their accounts, every portfolio on the market, every router account,
// the slot and the recent slot times. The CDN keeps the answer a few seconds and hands the same
// copy to everyone, so a page shows without asking the public RPC (which throttles each visitor's
// address, and on Solana devnet refuses most of a page's requests). Accounts are passed on as the
// RPC gave them; the page reads them as if it had asked itself (src/view.ts).
import { PublicKey } from "@solana/web3.js";
import L from "./_layout.js";
import { PERCOLATOR, ROUTER, VAULT_PROGRAM, networkOf } from "./_config.js";

const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

async function rpc(url: string, method: string, params: any[], tries = 3): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8_000) });
      const j: any = r.status === 429 ? { error: { message: "rate limited" } } : await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await new Promise(ok => setTimeout(ok, 400 * (i + 1)));
    }
  }
}

async function build(url: string, market: string, x1: boolean) {
  const cfg = { encoding: "base64", commitment: "confirmed" };
  // What each scan was asked for, so the page knows which of its own scans this answers:
  // "d<size>" for a data size, "m<offset>:<base58>" for bytes at an offset.
  const lists = [
    { program: ROUTER, filters: [] as string[] },
    { program: VAULT_PROGRAM, filters: [`d${L.vault_len}`] },
    { program: PERCOLATOR, filters: [`d${L.portfolio.len}`, `m16:${market}`] },
  ];
  const [routerAccs, vaultAccs, portfolioAccs, m, slot, samples] = await Promise.all([
    rpc(url, "getProgramAccounts", [ROUTER, cfg]),
    rpc(url, "getProgramAccounts", [VAULT_PROGRAM, { ...cfg, filters: [{ dataSize: L.vault_len }] }]),
    rpc(url, "getProgramAccounts", [PERCOLATOR, { ...cfg, filters: [{ dataSize: L.portfolio.len }, { memcmp: { offset: 16, bytes: market } }] }]),
    rpc(url, "getAccountInfo", [market, cfg]),
    rpc(url, "getSlot", [{ commitment: "confirmed" }]),
    rpc(url, "getRecentPerformanceSamples", [5]),
  ]);
  const accounts: Record<string, any> = { [market]: m.value };
  for (const a of [...routerAccs, ...vaultAccs, ...portfolioAccs]) accounts[a.pubkey] = a.account;

  // Each vault's cash and share mint, and on Solana its Pyth price account (on X1 the price is a
  // router account, already read). One that does not exist is passed on as null.
  const more = new Set<string>();
  for (const a of vaultAccs) {
    const d = Buffer.from(a.account.data[0], "base64");
    const key = (o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
    if (key(L.vault.market) !== market) continue;
    more.add(key(L.vault.buffer)).add(key(L.vault.share_mint));
    if (!x1) more.add(PublicKey.findProgramAddressSync([new Uint8Array([0, 0]), d.subarray(L.vault.oracle_feeds, L.vault.oracle_feeds + 32)], PUSH_ORACLE)[0].toBase58());
  }
  const keys = [...more].filter(k => !(k in accounts));
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
  const got = await Promise.all(chunks.map(c => rpc(url, "getMultipleAccounts", [c, cfg])));
  chunks.forEach((c, i) => c.forEach((k, j) => { accounts[k] = got[i].value[j]; }));

  return { at: Date.now(), slot, samples, lists, accounts };
}

const cached = new Map<string, { at: number; body: any }>(); // by market, on a warm instance
const building = new Map<string, Promise<any>>();

export default async function handler(req: any, res: any) {
  const net = networkOf(req);
  try {
    let c = cached.get(net.market);
    if (!c || Date.now() - c.at > 2_500) {
      let b = building.get(net.market);
      if (!b) building.set(net.market, b = build(net.rpc, net.market, net.coin === "XNT").finally(() => building.delete(net.market)));
      cached.set(net.market, c = { at: Date.now(), body: await b });
    }
    // A few seconds old for everyone at once; while a newer one is read, the last one is handed out.
    // Devnet reads through a paid-credit RPC (RPC_URL, Helius): 10 s there keeps its use small.
    res.setHeader("Cache-Control", net.coin === "XNT" ? "public, s-maxage=4, stale-while-revalidate=20" : "public, s-maxage=10, stale-while-revalidate=60");
    return res.status(200).json(c.body);
  } catch (e: any) {
    res.setHeader("Cache-Control", "no-store");
    // (Never the RPC's address: on devnet it carries a private key.)
    return res.status(502).json({ error: String(e.message ?? e).replace(/https?:\/\/\S+/g, "the RPC").replace(/api-key=[^&\s"]+/g, "api-key=***") });
  }
}
