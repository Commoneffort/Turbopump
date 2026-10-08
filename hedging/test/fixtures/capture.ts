// Saves the live market, vault and portfolio accounts as a fixture for chain.test.ts.
// Run: RPC=... npx tsx test/fixtures/capture.ts
import * as fs from "fs";
import L from "../../../app/src/layout.json";
import M from "../../../app/src/devnet.json";
import { decodeVault } from "../../src/chain-source";

const rpc = async (method: string, params: unknown[]) => {
  const res = await fetch(process.env.RPC ?? "https://api.devnet.solana.com", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const accs: any[] = await rpc("getProgramAccounts", [M.vault_program, { commitment: "confirmed", encoding: "base64", filters: [{ dataSize: L.vault_len }] }]);
const vaults = accs.map(a => ({ key: a.pubkey as string, portfolio: decodeVault(Buffer.from(a.account.data[0], "base64")).lpPortfolio }));
await new Promise(r => setTimeout(r, 2000));
const r = await rpc("getMultipleAccounts", [[M.market, ...vaults.flatMap(v => [v.key, v.portfolio])], { commitment: "confirmed", encoding: "base64" }]);
const data = (i: number) => r.value[i]?.data[0] ?? null;
fs.writeFileSync(new URL("devnet.json", import.meta.url), JSON.stringify({
  slot: r.context.slot, market: data(0),
  vaults: vaults.map((v, i) => ({ ...v, vaultData: data(1 + 2 * i), portfolioData: data(2 + 2 * i) })),
}));
console.log(`saved ${vaults.length} vaults at slot ${r.context.slot}`);
