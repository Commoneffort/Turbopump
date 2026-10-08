// Hyperliquid as the hedge venue. TEST NETWORK ONLY: the address of the real exchange is not
// in this file, and the constructor refuses any other.
//
// What the engine needs from a venue, and how Hyperliquid gives it:
//  - an id of our own on every order (`cloid`), by which the order can be looked up later;
//  - immediate-or-cancel limit orders, and reduce-only;
//  - a fill history. Fills carry the venue's order id, not ours, so each is matched to our id
//    through the order it belongs to (learned from the order reply, or looked up).
//
// Sizes and prices go over the wire as decimal strings. A size has `szDecimals` decimals; a
// price has at most 5 significant figures and at most `6 - szDecimals` decimals. A limit price
// is rounded toward the mid here, so an order never accepts more slippage than the policy set.
//
// The key that signs orders may be an API wallet approved by the account that holds the money;
// then `account` is that account's address. This file never moves funds: it only sends orders.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { Clock, Side, USD, systemClock } from "./units";
import { FundingPayment, HedgeVenue, OrderRequest, OrderState, Quote, VenueAccount, VenueFill, VenueMeta } from "./venue";

export const TESTNET_URL = "https://api.hyperliquid-testnet.xyz";

// ---- bytes ----
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error("not a hex string");
  return Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const word = (n: bigint) => unhex(n.toString(16).padStart(64, "0"));

/** MessagePack, for the value shapes an order action uses. Map keys keep their order: the
 *  exchange hashes these exact bytes. */
export function msgpack(v: unknown): Uint8Array {
  if (v === null) return Uint8Array.of(0xc0);
  if (typeof v === "boolean") return Uint8Array.of(v ? 0xc3 : 0xc2);
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`cannot encode number ${v}`);
    if (v < 0x80) return Uint8Array.of(v);
    if (v < 0x100) return Uint8Array.of(0xcc, v);
    if (v < 0x10000) return Uint8Array.of(0xcd, v >> 8, v & 0xff);
    return Uint8Array.of(0xce, v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  if (typeof v === "string") {
    const b = utf8(v);
    const head = b.length < 32 ? Uint8Array.of(0xa0 | b.length) : b.length < 0x100 ? Uint8Array.of(0xd9, b.length) : Uint8Array.of(0xda, b.length >> 8, b.length & 0xff);
    if (b.length >= 0x10000) throw new Error("string too long");
    return concat(head, b);
  }
  if (Array.isArray(v)) {
    if (v.length > 15) throw new Error("array too long");
    return concat(Uint8Array.of(0x90 | v.length), ...v.map(msgpack));
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as object);
    if (entries.length > 15) throw new Error("map too large");
    return concat(Uint8Array.of(0x80 | entries.length), ...entries.flatMap(([k, x]) => [msgpack(k), msgpack(x)]));
  }
  throw new Error(`cannot encode ${typeof v}`);
}

// ---- signing: an "L1 action" is hashed, and the hash signed as EIP-712 typed data ----
const DOMAIN = keccak_256(concat(
  keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
  keccak_256(utf8("Exchange")), keccak_256(utf8("1")), word(1337n), word(0n),
));
const AGENT_TYPE = keccak_256(utf8("Agent(string source,bytes32 connectionId)"));

/** What gets signed for an action: its bytes, the nonce, and no vault address. `source` tells
 *  the two networks apart ("b" is the test network), so a signature for one is void on the other. */
export function actionDigest(action: unknown, nonce: number, source: "a" | "b"): Uint8Array {
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  const connectionId = keccak_256(concat(msgpack(action), n, Uint8Array.of(0)));
  const agent = keccak_256(concat(AGENT_TYPE, keccak_256(utf8(source)), connectionId));
  return keccak_256(concat(Uint8Array.of(0x19, 0x01), DOMAIN, agent));
}
export type Signature = { r: string; s: string; v: number };
export function signAction(action: unknown, nonce: number, privateKey: string, source: "a" | "b"): Signature {
  const sig = secp256k1.sign(actionDigest(action, nonce, source), unhex(privateKey));
  return { r: "0x" + sig.r.toString(16).padStart(64, "0"), s: "0x" + sig.s.toString(16).padStart(64, "0"), v: 27 + sig.recovery };
}
const addressOfPublic = (uncompressed: Uint8Array) => "0x" + hex(keccak_256(uncompressed.subarray(1)).subarray(12));
export const addressOf = (privateKey: string) => addressOfPublic(secp256k1.getPublicKey(unhex(privateKey), false));
/** The address whose key made a signature (what the exchange does to identify the sender). */
export function signerOf(action: unknown, nonce: number, sig: Signature, source: "a" | "b"): string {
  const s = new secp256k1.Signature(BigInt(sig.r), BigInt(sig.s)).addRecoveryBit(sig.v - 27);
  return addressOfPublic(s.recoverPublicKey(actionDigest(action, nonce, source)).toRawBytes(false));
}

// ---- numbers on the wire ----
/** "118.59" -> 118590000n (six decimals; anything finer is cut off). */
export function fromWire(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a decimal number: ${s}`);
  const v = BigInt(m[2]) * 1_000_000n + BigInt((m[3] ?? "").padEnd(6, "0").slice(0, 6));
  return m[1] ? -v : v;
}
/** 118590000n -> "118.59" */
export function toWire(e6: bigint): string {
  const neg = e6 < 0n, a = neg ? -e6 : e6;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / 1_000_000n}${frac ? "." + frac : ""}`;
}
/** The smallest price step the exchange accepts at this price: 5 significant figures, and no
 *  more than `6 - szDecimals` decimals. */
export function priceTick(priceE6: bigint, szDecimals: number): bigint {
  const magnitude = priceE6.toString().length - 7; // floor(log10(price))
  const decimals = Math.max(0, Math.min(6 - szDecimals, 4 - magnitude));
  return 10n ** BigInt(6 - decimals);
}

type Market = { index: number; szDecimals: number };

export type HyperliquidOptions = {
  /** Hex private key that signs orders. */
  privateKey: string;
  /** The account that holds the money, when the key is an API wallet approved by it. */
  account?: string;
  /** Fills older than this (ms) are not the engine's business: a new journal starts here. */
  historyFrom?: number;
  clock?: Clock;
  fetch?: typeof fetch;
};

export class HyperliquidVenue implements HedgeVenue {
  readonly name = "hyperliquid-testnet";
  readonly signer: string;
  /** The account that is traded and read. */
  readonly user: string;
  private url = TESTNET_URL;
  private historyFrom: number;
  private clock: Clock;
  private fetch: typeof fetch;
  private key: string;
  private markets?: Map<string, Market>;
  private names: string[] = [];
  private lastNonce = 0;
  /** Venue order id <-> our id, as learned from replies and lookups. */
  private cloidOf = new Map<number, string | null>();
  /** Orders the exchange answered with a refusal. It keeps no record of those, so its word at
   *  the time is what there is; after a restart they are simply unknown to it. */
  private refused = new Map<string, OrderState>();
  private state?: { atMs: number; value: any };

  constructor(o: HyperliquidOptions) {
    this.historyFrom = o.historyFrom ?? 0;
    this.key = o.privateKey;
    this.signer = addressOf(o.privateKey);
    this.user = (o.account ?? this.signer).toLowerCase();
    this.clock = o.clock ?? systemClock;
    this.fetch = o.fetch ?? fetch;
  }

  private async post(path: "/info" | "/exchange", body: unknown): Promise<any> {
    const res = await this.fetch(this.url + path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`hyperliquid ${path}: HTTP ${res.status}`);
    return res.json();
  }
  private info(body: unknown) { return this.post("/info", body); }

  private async market(symbol: string): Promise<Market> {
    if (!this.markets) {
      const meta = await this.info({ type: "meta" });
      this.names = meta.universe.map((u: any) => u.name);
      this.markets = new Map(meta.universe.map((u: any, index: number) => [u.name, { index, szDecimals: u.szDecimals }]));
    }
    const m = this.markets.get(symbol);
    if (!m) throw new Error(`hyperliquid has no market ${symbol}`);
    if (m.szDecimals > 6) throw new Error(`${symbol}: sizes finer than the engine's units`);
    return m;
  }

  async meta(symbol: string): Promise<VenueMeta> {
    const m = await this.market(symbol);
    const q = await this.quote(symbol);
    return { lotQ: 10n ** BigInt(6 - m.szDecimals), minNotionalE6: 10n * USD, tickE6: priceTick(q.midE6, m.szDecimals) };
  }

  async quote(symbol: string): Promise<Quote> {
    await this.market(symbol);
    const book = await this.info({ type: "l2Book", coin: symbol });
    const [bids, asks] = book.levels;
    if (!bids?.length || !asks?.length) throw new Error(`${symbol}: one side of the book is empty`);
    return { midE6: (fromWire(bids[0].px) + fromWire(asks[0].px)) / 2n, atMs: book.time };
  }

  /** Account state; one request serves `account` and `positions` on the same pass. */
  private async clearinghouse() {
    const now = this.clock.now();
    if (!this.state || now - this.state.atMs > 1_000 || now < this.state.atMs) {
      this.state = { atMs: now, value: await this.info({ type: "clearinghouseState", user: this.user }) };
    }
    return this.state.value;
  }
  async account(): Promise<VenueAccount> {
    const s = await this.clearinghouse();
    return {
      equityE6: fromWire(s.marginSummary.accountValue), freeMarginE6: fromWire(s.withdrawable),
      marginUsedE6: fromWire(s.marginSummary.totalMarginUsed ?? "0"), maintenanceE6: fromWire(s.crossMaintenanceMarginUsed ?? "0"),
    };
  }
  async positions(): Promise<Map<string, bigint>> {
    const s = await this.clearinghouse();
    return new Map(s.assetPositions.map((p: any) => [p.position.coin, fromWire(p.position.szi)] as [string, bigint]).filter(([, q]: [string, bigint]) => q !== 0n));
  }

  async place(o: OrderRequest): Promise<OrderState> {
    const m = await this.market(o.symbol);
    const lot = 10n ** BigInt(6 - m.szDecimals);
    if (o.sizeQ <= 0n || o.sizeQ % lot !== 0n) throw new Error(`${o.symbol}: size ${o.sizeQ} is not a whole number of lots`);
    const tick = priceTick(o.limitE6, m.szDecimals);
    // Toward the mid: a buy's limit down, a sell's up.
    const px = o.side === "buy" ? o.limitE6 - (o.limitE6 % tick) : o.limitE6 + ((tick - (o.limitE6 % tick)) % tick);
    const action = {
      type: "order",
      orders: [{ a: m.index, b: o.side === "buy", p: toWire(px), s: toWire(o.sizeQ), r: o.reduceOnly, t: { limit: { tif: "Ioc" } }, c: o.clientId }],
      grouping: "na",
    };
    const nonce = this.lastNonce = Math.max(this.clock.now(), this.lastNonce + 1);
    this.state = undefined;
    // From here on a failure leaves the order's fate unknown, and is passed on as such.
    const r = await this.post("/exchange", { action, nonce, signature: signAction(action, nonce, this.key, "b"), vaultAddress: null });
    this.state = undefined;
    const refuse = (reason: string) => {
      const st: OrderState = { clientId: o.clientId, status: "rejected", filledQ: 0n, reason };
      this.refused.set(o.clientId, st);
      return st;
    };
    if (r.status !== "ok") return refuse(String(r.response ?? "refused"));
    const st = r.response?.data?.statuses?.[0];
    if (st?.error) return refuse(String(st.error));
    if (st?.filled) {
      this.cloidOf.set(st.filled.oid, o.clientId);
      const filledQ = fromWire(st.filled.totalSz);
      return { clientId: o.clientId, status: filledQ === o.sizeQ ? "filled" : "cancelled", filledQ };
    }
    if (st?.resting) {
      this.cloidOf.set(st.resting.oid, o.clientId);
      return { clientId: o.clientId, status: "open", filledQ: 0n };
    }
    throw new Error(`hyperliquid: reply not understood: ${JSON.stringify(r).slice(0, 200)}`);
  }

  private async lookup(oid: number | string): Promise<{ state: OrderState; oid: number; cloid: string | null } | null> {
    const r = await this.info({ type: "orderStatus", user: this.user, oid });
    if (r.status !== "order") return null;
    const ord = r.order.order, status: string = r.order.status;
    // `sz` is what is left of the order; `origSz` what it started as.
    const filledQ = fromWire(ord.origSz) - fromWire(ord.sz);
    const mapped: OrderState["status"] = status === "open" || status === "triggered" ? "open"
      : status === "filled" ? "filled"
      : filledQ > 0n || /cancel/i.test(status) ? "cancelled" : "rejected";
    const cloid: string | null = ord.cloid ?? null;
    this.cloidOf.set(ord.oid, cloid);
    return { state: { clientId: cloid ?? "", status: mapped, filledQ, reason: mapped === "filled" || mapped === "open" ? undefined : status }, oid: ord.oid, cloid };
  }

  async order(clientId: string): Promise<OrderState | null> {
    const found = await this.lookup(clientId);
    if (found) return { ...found.state, clientId };
    return this.refused.get(clientId) ?? null;
  }

  /** The cursor is the time of the last fill seen. Fills at that same millisecond are returned
   *  again; the ledger knows each fill by its id and takes it once. */
  async fills(cursor: string | null): Promise<VenueFill[]> {
    const out: VenueFill[] = [];
    let from = cursor ? Number(cursor) : this.historyFrom;
    for (;;) {
      const page: any[] = await this.info({ type: "userFillsByTime", user: this.user, startTime: from });
      page.sort((a, b) => a.time - b.time || a.tid - b.tid);
      for (const f of page) {
        if (!this.cloidOf.has(f.oid)) await this.lookup(f.oid);
        const fee = f.feeToken === undefined || f.feeToken === "USDC" ? fromWire(f.fee) : 0n;
        out.push({
          fillId: String(f.tid), clientId: this.cloidOf.get(f.oid) ?? null, symbol: f.coin, side: (f.side === "B" ? "buy" : "sell") as Side,
          sizeQ: fromWire(f.sz), priceE6: fromWire(f.px), feeE6: fee, atMs: f.time, cursor: String(f.time),
        });
      }
      // A full page may be cut off: carry on from its last fill.
      if (page.length < 2_000 || page[page.length - 1].time === from) break;
      from = page[page.length - 1].time;
    }
    const seen = new Set<string>();
    return out.filter(f => !seen.has(f.fillId) && seen.add(f.fillId));
  }

  /** Funding is settled per position every hour. The exchange reports what the account received
   *  (negative when it paid). The cursor is the time of the last payment seen; payments at that
   *  same millisecond are returned again, and the ledger takes each once by its id. */
  async funding(cursor: string | null): Promise<FundingPayment[]> {
    const out: FundingPayment[] = [];
    let from = cursor ? Number(cursor) : this.historyFrom;
    for (;;) {
      const page: any[] = await this.info({ type: "userFunding", user: this.user, startTime: from });
      page.sort((a, b) => a.time - b.time);
      for (const f of page) {
        if (f.delta?.type !== "funding") continue;
        out.push({ fundingId: `${f.time}:${f.delta.coin}`, symbol: f.delta.coin, amountE6: -fromWire(f.delta.usdc), atMs: f.time, cursor: String(f.time) });
      }
      if (page.length < 500 || page[page.length - 1].time === from) break;
      from = page[page.length - 1].time;
    }
    const seen = new Set<string>();
    return out.filter(f => !seen.has(f.fundingId) && seen.add(f.fundingId));
  }
}
