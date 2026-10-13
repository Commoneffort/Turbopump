// Read-only: where the money is on one network. Share price of each vault over its recorded
// rolls, fees harvested, the treasury, the paying wallet, and collateral that is in no account.
//   NETWORK=x1-testnet|devnet npx tsx scripts/pnl.ts
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: C.politeFetch() });
const manifest = JSON.parse(fs.readFileSync(C.X1 ? "../deploy/x1-testnet.json" : "../deploy/devnet.json", "utf8"));
const usd = (x: bigint | number) => (Number(x) / 1e6).toFixed(2);
const u128 = (d: Uint8Array, o: number) => new DataView(d.buffer, d.byteOffset).getBigUint64(o, true) + (new DataView(d.buffer, d.byteOffset).getBigUint64(o + 8, true) << 64n);

(async () => {
  const snap = await C.marketSnapshot(conn);
  const percVault = (await conn.getAccountInfo(new PublicKey(manifest.percolator_vault)))!;
  const held = new DataView(percVault.data.buffer, percVault.data.byteOffset).getBigUint64(64, true);
  let capital = 0n, profit = 0n, loss = 0n;
  for (const p of snap.portfolios) { const f = C.decodePortfolio(p.data, 0); capital += f.capital; if (f.pnl > 0n) profit += f.pnl; else loss -= f.pnl; }
  // Percolator's own totals (market header, from byte 749): printed raw to cross-check.
  // Percolator's own totals (market header, from byte 749): collateral, insurance, capital, booked profit.
  const [hv, hi, hc, hp] = [0, 1, 2, 3].map(i => u128(snap.market, 749 + 16 * i));
  console.log(`Percolator's totals: collateral ${usd(hv)} | insurance ${usd(hi)} | capital ${usd(hc)} | booked profit ${usd(hp)} | in no account ${usd(hv - hi - hc - hp)}`);
  const vaults = await C.listVaults(conn);
  let insurance = 0n;
  for (const v of vaults) insurance += C.decodeAsset(snap.market, v.assetIndex).insurance;
  console.log(`collateral held ${usd(held)} | accounts' capital ${usd(capital)} | booked profit ${usd(profit)} | booked loss ${usd(loss)} | insurance (listed assets) ${usd(insurance)} | accounts ${snap.portfolios.length}`);
  for (const v of vaults) {
    const s = await C.fetchVault(conn, v.key).catch(() => null);
    if (!s) { console.log(`${v.feed?.symbol}: not readable (retired or empty)`); continue; }
    const h = await C.vaultHistory(conn, v, 96);
    const nav = C.navOf(s);
    const now = s.shareSupply > 0n ? Number(nav) / 1e6 / (Number(s.shareSupply) / 10 ** C.SHARE_DECIMALS) : 0;
    const first = h[0];
    console.log(`${v.feed?.symbol}: value ${usd(nav)} | share now ${now.toFixed(6)} | first recorded roll (epoch ${first?.epoch}) ${first?.price.toFixed(6)} | rolls read ${h.length} | fees harvested in all ${usd((v as any).totalFeesHarvested ?? 0n)} | opener fees ${usd(v.openerFeesTotal)} | position ${Number(v.inventory) / 1e6}`);
  }
  const t = await conn.getTokenAccountBalance(new PublicKey(manifest.treasury_collateral)).catch(() => null);
  console.log(`treasury: ${t?.value.uiAmountString ?? "?"} USDC, ${(await conn.getBalance(C.TREASURY)) / 1e9} ${C.COIN} | paying wallet ${(await conn.getBalance(new PublicKey(manifest.admin ?? manifest.deployer))) / 1e9} ${C.COIN}`);
})();
