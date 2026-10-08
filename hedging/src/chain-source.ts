// Reads the vaults' positions from the chain. Read-only by construction: it makes two kinds of
// JSON-RPC call (getProgramAccounts to find the vaults, getMultipleAccounts to read them), loads
// no key, and builds no transaction.
//
// One getMultipleAccounts call returns the market, every vault and every vault's portfolio at
// the same slot, so a reading is never a mix of two states of the chain.
//
// Offsets come from the app's layout.json, which a Rust test exports from the program and engine
// types. The decoding here is checked against the app's own (test/chain.test.ts).
import L from "../../app/src/layout.json";
import M from "../../app/src/devnet.json";
import { ChainRead, ExposureSource, VaultReading } from "./exposure";
import { Clock, systemClock } from "./units";

/** Feed id -> symbol, for the markets of either deployment (KNOWN_FEEDS in the app's chain.ts). */
export const FEED_SYMBOLS: Record<string, string> = {
  ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d: "SOL",
  e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43: "BTC",
  ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace: "ETH",
  "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff": "PYTH",
  dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c: "DOGE",
  "4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b": "HYPE",
  "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2": "XAU",
  a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b: "EUR",
  // X1 only (the app's X1_FEEDS): sha256("x1:" + symbol).
  "18ef2a004058135517c775c4e45e8c6ae6b6583336c70902329127f87a6d7d81": "ZEC",
  "c7263494c2cf4f1f14575d26864d06f9d9718ebc7c1af2fc28506ef19415b392": "FARTCOIN",
  "6d1cb9acc057a81bbf43ce459ce7bdfc3db1a040b25718158bf6d9936025838f": "TSLA",
  "d0316d5ef0f1e4bbcf08c8ec72444bf005412a87c5368e130feac8afd862d6c8": "NVDA",
  "2a4b5bcc3a1a7b6633350fb2f75cc514c57a19071277b992cf4eef17bc20b69e": "MSTR",
  "c98e089b103f2766952e1490d902cb3a811c700e0064d4cee7c2ba6abef37ce6": "AAPL",
  "55fe35fea9478cdac31cff1c57883213faab338a84d1dca3d3b9ca8b91fe7e70": "GOOGL",
  "fb1093c2bfb0c40661d0d6b7731d08cab10bf111a77103e05ff3567ad18d969a": "META",
  "665db1539de0d2082e2c2aa72f62317b6f9a2e3d72fe7f9b041b93e31d7ac2f4": "AMD",
  "7e2e57832cf14dd0ac3bc79fd2560cfe86f388ade5d9a4d00d1528b75456abec": "COIN",
  "66020da42582157facbf93cc3d944e51c4f15c8a4effec7edf4a18b72c846a71": "PLTR",
  "38853158dfc20e282627dbc05fc728756ba7e9d5f1d483a8aeccf0123e072372": "SPCX",
  "2f9cfc1fca7825bbffe689fcbadd465aecbf42be88e090f0acd23ed427d57dfd": "SPY",
  "e8ecabe1b6c5da82b3a4d5139699da03fb89342705688370b5ac124d91124bb7": "XAG",
};

// ---- little-endian readers ----
const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u16 = (d: Uint8Array, o: number) => dv(d).getUint16(o, true);
const u32 = (d: Uint8Array, o: number) => dv(d).getUint32(o, true);
const u64 = (d: Uint8Array, o: number) => dv(d).getBigUint64(o, true);
const u128 = (d: Uint8Array, o: number) => u64(d, o) + (u64(d, o + 8) << 64n);
const i128 = (d: Uint8Array, o: number) => {
  const v = u128(d, o);
  return v >= 1n << 127n ? v - (1n << 128n) : v;
};
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  for (; n > 0n; n /= 58n) out = ALPHABET[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

const VAULT_MAGIC = new TextEncoder().encode("PLVAULT1");
const ADL_ONE = 1_000_000_000_000_000n;

export type VaultAccount = {
  market: string; lpPortfolio: string; status: number; assetIndex: number; feedHex: string;
  inventory: bigint; lastNav: bigint; needsFlat: boolean;
};

export function decodeVault(d: Uint8Array): VaultAccount {
  const v = L.vault;
  if (d.length !== L.vault_len) throw new Error(`vault account is ${d.length} bytes, expected ${L.vault_len}`);
  if (!VAULT_MAGIC.every((b, i) => d[v.magic + i] === b)) throw new Error("not a vault account");
  return {
    market: base58(d.subarray(v.market, v.market + 32)),
    lpPortfolio: base58(d.subarray(v.lp_portfolio, v.lp_portfolio + 32)),
    status: d[v.status],
    assetIndex: u16(d, v.asset_index),
    feedHex: hex(d.subarray(v.oracle_feeds, v.oracle_feeds + 32)),
    inventory: i128(d, v.inventory),
    lastNav: u64(d, v.last_nav),
    needsFlat: d[v.needs_flat] === 1,
  };
}

const engine = (market: Uint8Array, asset: number) => {
  const at = L.market.slots + asset * L.market.slot_len + L.market.engine;
  if (at + L.market.epoch_short + 8 > market.length) throw new Error(`market account has no asset ${asset}`);
  return at;
};

/** The portfolio's position on `asset` as Percolator counts it (positive = long). A stored size
 *  is scaled by how far its side has been deleveraged since the position was opened, and counts
 *  for nothing once the side has been emptied and reset. */
export function position(market: Uint8Array, portfolio: Uint8Array, asset: number): bigint {
  if (portfolio.length !== L.portfolio.len) throw new Error(`portfolio account is ${portfolio.length} bytes, expected ${L.portfolio.len}`);
  let out = 0n;
  for (let i = 0; i < 16; i++) {
    const leg = L.portfolio.legs + i * L.portfolio.leg_len;
    if (portfolio[leg + L.leg.active] !== 1 || u32(portfolio, leg + L.leg.asset_index) !== asset) continue;
    const q = i128(portfolio, leg + L.leg.basis_pos_q);
    let size = q < 0n ? -q : q;
    const long = portfolio[leg + L.leg.side] === 0;
    const a = engine(market, asset);
    if (u64(portfolio, leg + L.leg.epoch_snap) !== u64(market, a + (long ? L.market.epoch_long : L.market.epoch_short))) size = 0n;
    else {
      const now = u128(market, a + (long ? L.market.a_long : L.market.a_short)), then = u128(portfolio, leg + L.leg.a_basis);
      if (then > 0n && now !== then) size = (size * now + then - 1n) / then;
    }
    out = long ? size : -size;
  }
  return out;
}

/** Percolator's price for an asset (e6). */
export const assetPrice = (market: Uint8Array, asset: number) => u64(market, engine(market, asset) + L.market.effective_price);
/** True while the asset's market is being closed out (a side has been deleveraged). */
export const closeOnly = (market: Uint8Array, asset: number) => {
  const a = engine(market, asset);
  return u128(market, a + L.market.a_long) !== ADL_ONE || u128(market, a + L.market.a_short) !== ADL_ONE;
};

/** One vault's reading from the three accounts that describe it. */
export function readVault(key: string, vault: Uint8Array, portfolio: Uint8Array | null, market: Uint8Array, symbol: string): VaultReading {
  const v = decodeVault(vault);
  // A vault that has not listed its asset yet has no market and cannot hold a position.
  const listed = v.status !== 0;
  if (listed && !portfolio) throw new Error(`vault ${key} has no portfolio account`);
  return {
    vault: key, symbol, status: v.status,
    positionQ: listed ? position(market, portfolio!, v.assetIndex) : 0n,
    trackedQ: v.inventory,
    priceE6: listed ? assetPrice(market, v.assetIndex) : 0n,
    navE6: v.lastNav,
    needsFlat: v.needsFlat,
    closeOnly: listed && closeOnly(market, v.assetIndex),
  };
}

export type ChainSourceOptions = {
  rpc: string;
  vaultProgram?: string;
  market?: string;
  feeds?: Record<string, string>;
  /** How often the list of vaults is refreshed. */
  rediscoverMs?: number;
  clock?: Clock;
  fetch?: typeof fetch;
};

export class ChainSource implements ExposureSource {
  private vaults: { key: string; portfolio: string; symbol: string }[] = [];
  private discoveredAt = -Infinity;
  private o: Required<ChainSourceOptions>;

  constructor(o: ChainSourceOptions) {
    this.o = { vaultProgram: M.vault_program, market: M.market, feeds: FEED_SYMBOLS, rediscoverMs: 300_000, clock: systemClock, fetch, ...o };
  }

  private async rpc(method: "getProgramAccounts" | "getMultipleAccounts", params: unknown[]) {
    const call = () => this.o.fetch(this.o.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    let res = await call();
    // The public RPC limits requests per address; one more try after a pause, then give up
    // until the next pass.
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 1_500));
      res = await call();
    }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const j: any = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }

  private async discover() {
    const accs: any[] = await this.rpc("getProgramAccounts", [this.o.vaultProgram, { commitment: "confirmed", encoding: "base64", filters: [{ dataSize: L.vault_len }] }]);
    const found = [];
    for (const a of accs) {
      const v = decodeVault(Buffer.from(a.account.data[0], "base64"));
      const symbol = this.o.feeds[v.feedHex];
      if (v.market === this.o.market && symbol) found.push({ key: a.pubkey as string, portfolio: v.lpPortfolio, symbol });
    }
    // A vault never leaves the list: if it stops being returned, the monitor is told it is
    // missing instead of treating its position as gone.
    for (const old of this.vaults) if (!found.some(f => f.key === old.key)) found.push(old);
    this.vaults = found;
    this.discoveredAt = this.o.clock.now();
  }

  async read(): Promise<ChainRead> {
    if (this.o.clock.now() - this.discoveredAt >= this.o.rediscoverMs) await this.discover();
    const keys = [this.o.market, ...this.vaults.flatMap(v => [v.key, v.portfolio])];
    if (keys.length > 100) throw new Error("too many vaults for one read");
    const r = await this.rpc("getMultipleAccounts", [keys, { commitment: "confirmed", encoding: "base64" }]);
    const data = (i: number): Uint8Array | null => (r.value[i] ? Buffer.from(r.value[i].data[0], "base64") : null);
    const market = data(0);
    if (!market) throw new Error("market account not found");
    const vaults: VaultReading[] = [];
    this.vaults.forEach((v, i) => {
      const vault = data(1 + 2 * i);
      if (vault) vaults.push(readVault(v.key, vault, data(2 + 2 * i), market, v.symbol));
    });
    return { slot: r.context.slot, readAtMs: this.o.clock.now(), vaults };
  }
}
