// Hyperliquid's API as the adapter uses it, served in memory in front of the mock venue. It
// keeps Hyperliquid's habits that make an adapter's life harder: fills carry the exchange's own
// order id and not ours, a refused order leaves no record, prices must be on the tick, and the
// sender is whoever the signature recovers to.
import { MockVenue, defaultMeta } from "../src/mock-venue";
import { fromWire, priceTick, signerOf, toWire } from "../src/hyperliquid";
import { Clock } from "../src/units";

export function fakeHyperliquid(mock: MockVenue, clock: Clock, user: string, symbols = ["SOL", "PAD1", "PAD2", "BTC", "ETH"]) {
  const szDecimals = 6 - (defaultMeta.lotQ.toString().length - 1);
  const orders = new Map<string, { oid: number; coin: string; origSz: bigint }>();
  const stats = { requests: [] as string[], lastNonce: 0 };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

  const orderStatus = async (oid: number | string) => {
    const cloid = typeof oid === "string" ? oid : [...orders].find(([, o]) => o.oid === oid)?.[0];
    const rec = cloid ? orders.get(cloid) : undefined;
    const st = cloid ? await mock.order(cloid) : null;
    // No record of an order that was never accepted, or that traded nothing.
    if (!rec || !st || st.status === "rejected" || (st.status === "cancelled" && st.filledQ === 0n)) return { status: "unknownOid" };
    const status = st.status === "filled" ? "filled" : st.status === "open" ? "open" : "canceled";
    return { status: "order", order: { status, order: { coin: rec.coin, oid: rec.oid, cloid, origSz: toWire(rec.origSz), sz: toWire(rec.origSz - st.filledQ) } } };
  };

  const info = async (b: any) => {
    switch (b.type) {
      case "meta":
        await mock.account();
        return { universe: symbols.map(name => ({ name, szDecimals, maxLeverage: 10 })) };
      case "l2Book": {
        const q = await mock.quote(b.coin);
        return { coin: b.coin, time: q.atMs, levels: [[{ px: toWire(q.midE6 - 10_000n), sz: "5", n: 1 }], [{ px: toWire(q.midE6 + 10_000n), sz: "5", n: 1 }]] };
      }
      case "clearinghouseState": {
        if (b.user !== user) return { marginSummary: { accountValue: "0.0", totalMarginUsed: "0.0" }, crossMaintenanceMarginUsed: "0.0", withdrawable: "0.0", assetPositions: [] };
        const a = await mock.account(), pos = await mock.positions();
        return {
          marginSummary: { accountValue: toWire(a.equityE6), totalMarginUsed: toWire(a.marginUsedE6) },
          crossMaintenanceMarginUsed: toWire(a.maintenanceE6), withdrawable: toWire(a.freeMarginE6),
          assetPositions: [...pos].map(([coin, q]) => ({ type: "oneWay", position: { coin, szi: toWire(q) } })),
        };
      }
      case "orderStatus":
        await mock.account();
        return orderStatus(b.oid);
      case "userFillsByTime":
        return (await mock.fills(null)).filter(f => f.atMs >= b.startTime).map(f => ({
          coin: f.symbol, px: toWire(f.priceE6), sz: toWire(f.sizeQ), side: f.side === "buy" ? "B" : "A", time: f.atMs,
          tid: Number(f.fillId.slice(1)), oid: f.clientId ? orders.get(f.clientId)!.oid : 900_000 + Number(f.fillId.slice(1)),
          fee: toWire(f.feeE6), feeToken: "USDC",
        }));
      case "userFunding":
        return (await mock.funding(null)).filter(f => f.atMs >= b.startTime).map(f => ({
          time: f.atMs, hash: "0x0", delta: { type: "funding", coin: f.symbol, usdc: toWire(-f.amountE6), szi: "0", fundingRate: "0" },
        }));
    }
    throw new Error(`fake hyperliquid: unknown info request ${b.type}`);
  };

  const exchange = async (b: any) => {
    const sender = signerOf(b.action, b.nonce, b.signature, "b");
    if (sender !== user) return { status: "err", response: `User or API Wallet ${sender} does not exist.` };
    if (b.nonce <= stats.lastNonce) return { status: "err", response: "Nonce too low" };
    stats.lastNonce = b.nonce;
    const o = b.action.orders[0];
    const coin = symbols[o.a];
    const err = (error: string) => ({ status: "ok", response: { type: "order", data: { statuses: [{ error }] } } });
    if (b.action.type !== "order" || b.action.orders.length !== 1 || o.t?.limit?.tif !== "Ioc") return err("unsupported order");
    const px = fromWire(o.p), sz = fromWire(o.s);
    if (toWire(px) !== o.p || toWire(sz) !== o.s) return err("Invalid number format.");
    if (px % priceTick(px, szDecimals) !== 0n) return err("Order has invalid price.");
    if (!orders.has(o.c)) orders.set(o.c, { oid: 1_000 + orders.size, coin, origSz: sz });
    // A fault in the mock here is a request that never got its answer.
    const st = await mock.place({ clientId: o.c, symbol: coin, side: o.b ? "buy" : "sell", sizeQ: sz, limitE6: px, reduceOnly: o.r });
    if (st.status === "rejected") return err(st.reason ?? "rejected");
    if (st.filledQ === 0n) return err("Order could not immediately match against any resting orders.");
    return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: toWire(st.filledQ), avgPx: o.p, oid: orders.get(o.c)!.oid } }] } } };
  };

  const fetch = (async (url: any, init: any) => {
    const b = JSON.parse(init.body);
    const path = new URL(String(url)).pathname;
    stats.requests.push(path === "/info" ? b.type : "exchange");
    void clock;
    return json(path === "/info" ? await info(b) : await exchange(b));
  }) as typeof globalThis.fetch;
  return { fetch, stats };
}
