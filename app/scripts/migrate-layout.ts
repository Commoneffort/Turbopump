// One-shot move of the network's Percolator markets to the account layout of engine c030aa4
// (upstream #247 provider principal and #449 raw-basis sums: 64 bytes more per asset slot).
// Run right after Percolator is upgraded to the build with tag 73; until a market is moved, the
// new Percolator cannot read it. The vault program's MigrateMarketLayout (tag 46) has the
// market's governor sign Percolator's tag 73; Percolator refuses anything but an exact move.
//
//   NETWORK=x1-testnet|devnet npx tsx scripts/migrate-layout.ts            show each market's layout
//   NETWORK=...               npx tsx scripts/migrate-layout.ts go [extra market addresses...]
//
// KEYPAIR (default the network's deploy wallet) pays the fees and the extra rent.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as C from "../src/chain";
import L from "../src/layout.json";

const conn = new Connection(process.env.RPC ?? C.RPC_URL, "confirmed");
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const NEW = L.market.slot_len, OLD = NEW - 64;
const layoutOf = (len: number) => ((len - L.market.slots) % NEW === 0 ? "current" : (len - L.market.slots) % OLD === 0 ? "v1" : "unknown");

(async () => {
  const go = process.argv[2] === "go";
  const markets = [...C.MARKETS.map(m => m.key), ...process.argv.slice(3).map(a => new PublicKey(a))];
  const key = process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/${C.X1 ? "percolator-x1" : "percolator-test"}/deployer.json`;
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(key, "utf8"))));
  let failed = 0;
  for (const m of markets) {
    const a = await conn.getAccountInfo(m, "confirmed");
    if (!a) { say(`${m.toBase58()}: no account`); continue; }
    const before = layoutOf(a.data.length);
    say(`${m.toBase58()}: ${a.data.length} bytes, layout ${before}`);
    if (!go || before !== "v1") continue;
    try {
      // A governed market goes through the vault program; one whose authority is the payer's own
      // key (an old test market) takes Percolator's tag 73 directly, with the rent added first.
      const auth = new PublicKey(a.data.subarray(16, 48));
      const slots = (a.data.length - L.market.slots) / OLD;
      const rent = await conn.getMinimumBalanceForRentExemption(L.market.slots + slots * NEW);
      const ixs = auth.equals(kp.publicKey)
        ? [
            ...(a.lamports < rent ? [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: m, lamports: rent - a.lamports })] : []),
            new TransactionInstruction({ programId: C.PERCOLATOR, keys: [{ pubkey: kp.publicKey, isSigner: true, isWritable: false }, { pubkey: m, isSigner: false, isWritable: true }], data: Buffer.from([73]) }),
          ]
        : [C.migrateMarketLayout(kp.publicKey, m)];
      const sig = await conn.sendTransaction(new Transaction().add(await C.computeLimit(conn, kp.publicKey, ixs), ...ixs), [kp]);
      await conn.confirmTransaction(sig, "confirmed");
      const b = (await conn.getAccountInfo(m, "confirmed"))!;
      say(`  moved: ${b.data.length} bytes, layout ${layoutOf(b.data.length)}, ${sig}`);
      if (layoutOf(b.data.length) !== "current") failed++;
    } catch (e: any) {
      failed++;
      say(`  NOT moved: ${String(e?.message ?? e).slice(0, 300)}`);
    }
  }
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
