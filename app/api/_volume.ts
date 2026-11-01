// Each market's trading volume over the last 24 hours, from the chain alone. Every fill writes
// its vault's holding-fee meter (router `carry`) and almost nothing else does, so that account's
// transaction list is the market's fill list. Each fill logs "fill <id> <traded> <price>".
import { PublicKey } from "@solana/web3.js";
import { ROUTER } from "./_config.js";
import { b58, openVaults, rpc, transactions } from "./_execution.js";

export type Volume = {
  network: string; at: number;
  /** By symbol: dollars traded (both sides counted once), fills that traded, and the hours covered (less than 24 for a market younger than a day). */
  markets: Record<string, { volume: number; trades: number; hours: number }>;
};

export async function volume24h(o: { rpc: string; market: string; network: string; x1: boolean }): Promise<Volume> {
  const now = Math.floor(Date.now() / 1000), since = now - 86_400;
  const vaults = await openVaults(o.rpc, o.market);
  const byVault = new Map(vaults.map(v => [v.key, v.symbol]));
  const out: Volume["markets"] = {};
  const sigs = new Set<string>();
  for (const v of vaults) {
    const carry = PublicKey.findProgramAddressSync([Buffer.from("carry"), new PublicKey(v.key).toBuffer()], new PublicKey(ROUTER))[0].toBase58();
    let before: string | undefined, oldest = now;
    for (let page = 0; page < 8; page++) {
      const l: any[] = await rpc(o.rpc, "getSignaturesForAddress", [carry, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }], 4).catch(() => []);
      for (const x of l) { if ((x.blockTime ?? 0) < since) break; oldest = x.blockTime ?? oldest; if (!x.err) sigs.add(x.signature); }
      if (l.length < 1000 || (l[l.length - 1].blockTime ?? 0) < since) break;
      before = l[l.length - 1].signature;
    }
    out[v.symbol] = { volume: 0, trades: 0, hours: Math.round((now - oldest) / 360) / 10 };
  }
  const list = [...sigs];
  const txs = await transactions(o.rpc, list, o.x1 ? 20 : 10, o.x1 ? 8 : 2);
  for (const tx of txs) {
    if (!tx) continue;
    const msg = tx.transaction.message;
    const keys: string[] = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    const logs = (tx.meta?.logMessages ?? []).filter((l: string) => l.startsWith("Program log: fill ")).map((l: string) => l.split(" ").slice(3).map(Number));
    let n = 0;
    for (const ix of msg.instructions) {
      if (keys[ix.programIdIndex] !== ROUTER || b58(ix.data)[0] !== 6) continue;
      const log = logs[n++], sym = byVault.get(keys[ix.accounts[5]]);
      if (!log || !sym || !out[sym] || log[1] === 0) continue;
      out[sym].volume += Math.abs(log[1]) / 1e6 * (log[2] / 1e6);
      out[sym].trades++;
    }
  }
  for (const m of Object.values(out)) m.volume = Math.round(m.volume * 100) / 100;
  return { network: o.network, at: now, markets: out };
}
