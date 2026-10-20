// The X1 price witness. A second key (keys/witness-keypair.json, the router's `WITNESS`) posts
// its own price for each traded feed every few seconds, read from a price service other than
// the executor's first one (default: our 9-exchange median on 127.0.0.1:8091). The router moves
// an X1 mark to the reporter's price only when this price is at most WITNESS_SECS apart and
// within WITNESS_BPS of it, so one key or one price source alone cannot move a market.
//
// Run it on another machine, with its own price service, for the full benefit: on the same
// server as the reporter it still stops a wrong price from one source, not a stolen server.
//
//   NETWORK=x1-testnet npx tsx scripts/witness.ts
//   env: WITNESS_KEY (default ../keys/witness-keypair.json), WITNESS_PRICES (price service URL),
//        WITNESS_SYMBOLS (default BTC,ETH,SOL), WITNESS_EVERY_SECS (default 8)
import fs from "fs";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed" });
const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.WITNESS_KEY ?? "../keys/witness-keypair.json", "utf8"))));
const SOURCE = process.env.WITNESS_PRICES ?? "http://127.0.0.1:8091";
const SYMBOLS = (process.env.WITNESS_SYMBOLS ?? "BTC,ETH,SOL").split(",").map(s => s.trim()).filter(Boolean);
const EVERY = Number(process.env.WITNESS_EVERY_SECS ?? 8) * 1000;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const feeds = SYMBOLS.map(s => C.FEEDS.find(f => f.symbol === s)).filter((f): f is NonNullable<typeof f> => !!f);
log("witness", key.publicKey.toBase58(), "prices from", SOURCE, "for", feeds.map(f => f.symbol).join(", "));

async function pass() {
  const r = await fetch(`${SOURCE}/v1/prices?symbols=${feeds.map(f => f.symbol.toLowerCase()).join(",")}`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`price service HTTP ${r.status}`);
  const quotes = new Map<string, { price: number; t: number }>();
  for (const x of (await r.json()).data ?? []) {
    if (x.status === "ok" && x.price > 0) quotes.set(String(x.symbol).toUpperCase(), { price: x.price, t: Math.floor(new Date(x.updatedAt).getTime() / 1000) });
  }
  const accs = await conn.getMultipleAccountsInfo(feeds.map(f => C.witnessAddress(f.id)));
  const now = Math.floor(Date.now() / 1000);
  const ixs = [];
  for (const [i, f] of feeds.entries()) {
    const q = quotes.get(f.symbol);
    if (!q || now - q.t > 20) continue; // no fresh quote: say nothing rather than something stale
    const last = accs[i] ? C.decodeReport(new Uint8Array(accs[i]!.data)).publish : 0;
    // The router keeps a witness price only if it is newer than the one before; a quote whose
    // time has not moved is posted at the current second (the price still holds).
    const publish = Math.max(q.t, Math.min(now, last + 1));
    if (publish <= last) continue;
    ixs.push(C.postWitnessPrice(key.publicKey, f.id, BigInt(Math.round(q.price * 1e6)), publish, Math.max(0, Math.min(last, publish - 1))));
  }
  if (!ixs.length) return;
  const tx = new Transaction().add(...(C.X1 ? [await C.computeLimit(conn, key.publicKey, ixs, 1.3)] : []), ...ixs);
  await conn.sendTransaction(tx, [key]);
}

let failures = 0;
for (;;) {
  try {
    await pass();
    if (failures) log(`posting again after ${failures} failed pass(es)`);
    failures = 0;
  } catch (e: any) {
    if (failures++ % 20 === 0) log("fail", String(e?.message ?? e).split("\n")[0].slice(0, 160));
  }
  await new Promise(r => setTimeout(r, EVERY));
}
