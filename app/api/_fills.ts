// A wallet's fills, read back from its trading account's transactions far enough to explain each
// position it holds now: per market, back to the fill that opened it from flat. The page works
// out entry prices and PnL from them (Percolator keeps no entry price: it settles as prices move).
// A fill transaction can fill several traders at once (the executor's batched round), so only the
// fill instructions whose trader account is this wallet's count. Each logs "fill <id> <traded> <price>".
import { PublicKey } from "@solana/web3.js";
import { MARKET, ROUTER } from "./_config.js";
import { b58, rpc, transactions } from "./_execution.js";

const MAX_SIGS = 1_500;
export type WalletFill = { sig: string; slot: number; time: number; vault: string; size: number; price: number };

export async function walletFills(o: { rpc: string; x1: boolean; wallet: string; need: Map<string, number>; market?: string }): Promise<{ fills: WalletFill[]; complete: string[] }> {
  const market = new PublicKey(o.market ?? MARKET), router = new PublicKey(ROUTER);
  const trader = PublicKey.findProgramAddressSync([Buffer.from("trader"), market.toBuffer(), new PublicKey(o.wallet).toBuffer()], router)[0].toBase58();
  // What is left to explain per vault, in e6 units, walking from now backwards.
  const left = new Map([...o.need].map(([v, q]) => [v, q]));
  const done = () => [...left.values()].every(q => q === 0);
  const fills: WalletFill[] = [];
  let before: string | undefined, read = 0;
  // A bound on the work one request can cause: the URL is public and `need` is whatever the
  // caller says, so a position that never adds up must not walk a whole history.
  while (!done() && read < MAX_SIGS) {
    const ask = Math.min(1000, MAX_SIGS - read);
    const page: any[] = await rpc(o.rpc, "getSignaturesForAddress", [trader, { limit: ask, commitment: "confirmed", ...(before ? { before } : {}) }], 4);
    if (!page.length) break;
    before = page[page.length - 1].signature;
    read += page.length;
    const ok = page.filter(x => !x.err);
    // Newest first, a chunk at a time, so a recent opening stops the walk early.
    for (let i = 0; i < ok.length && !done(); i += 200) {
      const chunk = ok.slice(i, i + 200);
      const txs = await transactions(o.rpc, chunk.map(x => x.signature), o.x1 ? 25 : 10, o.x1 ? 8 : 3);
      txs.forEach((tx, k) => {
        if (!tx) return;
        const msg = tx.transaction.message;
        const keys: string[] = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
        const logs = (tx.meta?.logMessages ?? []).filter((l: string) => /^Program log: fill \d+ -?\d+ \d+$/.test(l)).map((l: string) => l.split(" ").slice(3).map(Number));
        let n = 0;
        const here: WalletFill[] = [];
        for (const ix of msg.instructions) {
          if (keys[ix.programIdIndex] !== ROUTER || b58(ix.data)[0] !== 6) continue;
          const log = logs[n++];
          if (!log || keys[ix.accounts[2]] !== trader || log[1] === 0) continue;
          here.push({ sig: chunk[k].signature, slot: chunk[k].slot, time: chunk[k].blockTime ?? tx.blockTime ?? 0, vault: keys[ix.accounts[5]], size: log[1] / 1e6, price: log[2] / 1e6 });
        }
        for (const f of here.reverse()) {
          fills.push(f);
          const q = left.get(f.vault);
          if (q !== undefined && q !== 0) left.set(f.vault, q - Math.round(f.size * 1e6));
        }
      });
    }
    if (page.length < ask) break;
  }
  return { fills: fills.reverse(), complete: [...left].filter(([, q]) => q === 0).map(([v]) => v) };
}
