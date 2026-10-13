// Read-only: saves Percolator's accounts of one network as they are now, with the cranks the
// executor would send for the accounts that are out of date.  npx tsx scripts/_snap.ts <dir>
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";
const dir = process.argv[2];
const conn = new Connection(C.RPC_URL, { commitment: "confirmed", fetch: C.politeFetch(C.X1 ? 0 : 120) });
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const r = await conn.getProgramAccountsAndContext?.(C.PERCOLATOR).catch(() => null) as any;
  const slot = await conn.getSlot("confirmed");
  const raw = r?.value ?? (await conn.getProgramAccounts(C.PERCOLATOR));
  const accs = raw.map((a: any) => ({ pubkey: a.pubkey as PublicKey, data: new Uint8Array(a.account.data), lamports: a.account.lamports, owner: a.account.owner.toBase58() }));
  fs.writeFileSync(`${dir}/accounts.txt`, accs.map((a: any) => `${a.pubkey.toBase58()} ${a.lamports} ${a.owner} ${Buffer.from(a.data).toString("hex")}`).join("\n") + "\n");
  const market = accs.find((a: any) => a.pubkey.equals(C.MARKET));
  const snap = { market: market.data, slot, portfolios: accs.filter((a: any) => a.data.length === C.PORTFOLIO_LEN && Buffer.from(a.data.slice(16, 48)).equals(C.MARKET.toBuffer())) };
  const payer = PublicKey.default;
  const vaults = (await C.listVaults(conn)).filter(v => v.status === 1 && v.lastNav > 0n);
  const assets = vaults.map(v => v.assetIndex);
  const plan = C.crankPlan(snap as any, payer, vaults[0].lpPortfolio, undefined, undefined, assets.slice(0, 4));
  const enc = (ix: any) => ({ keys: ix.keys.map((k: any) => k.pubkey.toBase58()), data: Buffer.from(ix.data).toString("hex") });
  const out = { slot, assets, lag: plan.lag, lagCrank: enc(plan.lagCrank), settleAlone: plan.settleAlone.map(enc), settle: plan.settle.map(enc) };
  fs.writeFileSync(`${dir}/cranks.json`, JSON.stringify(out));
  console.log(`${dir}: slot ${slot}, ${accs.length} accounts, ${snap.portfolios.length} portfolios, lag ${plan.lag}, out of date ${plan.settleAlone.length}`);
})();
