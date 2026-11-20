// Read-only recorder for a transaction replay of live X1 Percolator traffic.
// Phase A: learn which accounts recent Percolator txs touch. Phase B: snapshot them (+ every
// Percolator/router/vault-owned account) at one moment. Phase C: record every Percolator tx that
// lands after the snapshot for MINUTES. Writes <dir>/{accounts.jsonl,txs.jsonl,programs/*.so,meta.json}.
// Usage: npx tsx record.ts <dir>   (copy into app/scripts/ and run from app/, for node_modules)
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";

const RPC = process.env.RPC ?? "https://rpc.testnet.x1.xyz";
const dir = process.argv[2];
const MINUTES = Number(process.env.MINUTES ?? 12);
const RATE_MS = Number(process.env.RATE_MS ?? 300); // ~3 req/s, keep the public RPC usable for our services
const PERC = new PublicKey("8o3uV87X2CvPYfPwM1sxeaYYE7sGWsTUiEy7SskEMM3P");
const OWNERS = [PERC, new PublicKey("DkK9TSMpVXLq26HeqxTXLysXyRKDYHTKU94SLFDWgjw3"), new PublicKey("BSync6F8gtJs3Wj4w8L6H3ZtS397w2XoCYGEAJGmeYX")];
const conn = new Connection(RPC, { commitment: "confirmed" });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let last = 0;
async function rpc<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    const wait = last + RATE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try { return await f(); } catch (e: any) { if (i > 8) throw e; await sleep(1000 * (i + 1)); }
  }
}
const BUILTIN = new Set(["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "AddressLookupTab1e1111111111111111111111111", "Ed25519SigVerify111111111111111111111111111", "KeccakSecp256k11111111111111111111111111111", "Sysvar1nstructions1111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "SysvarRent111111111111111111111111111111111", "SysvarS1otHashes111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "BPFLoaderUpgradeab1e11111111111111111111111", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "MemoSq4gqABAXKb96qnH8TyNoNYc7xoNoBaiVRDHhfo"]);

async function newSigs(after?: string, until?: string): Promise<{ signature: string; slot: number; err: any }[]> {
  const out: any[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await rpc(() => conn.getSignaturesForAddress(PERC, { before, until, limit: 1000 }));
    out.push(...page);
    if (page.length < 1000 || !until) break;
    before = page[page.length - 1].signature;
  }
  return out.reverse(); // oldest first
}
async function getTx(sig: string) {
  for (let i = 0; i < 20; i++) {
    const t = await rpc(() => conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
    if (t) return t;
    await sleep(1000);
  }
  return null;
}
function keysOf(t: any): string[] {
  const m = t.transaction.message;
  const st = (m.staticAccountKeys ?? m.accountKeys).map((k: PublicKey) => k.toBase58());
  const la = t.meta?.loadedAddresses;
  const lut = (m.addressTableLookups ?? []).map((l: any) => l.accountKey.toBase58());
  return [...st, ...lut, ...(la?.writable ?? []).map((k: any) => k.toBase58?.() ?? k), ...(la?.readonly ?? []).map((k: any) => k.toBase58?.() ?? k)];
}

(async () => {
  fs.mkdirSync(`${dir}/programs`, { recursive: true });
  // Phase A
  const recent = (await rpc(() => conn.getSignaturesForAddress(PERC, { limit: 150 }))).filter(s => !s.err);
  const keys = new Set<string>();
  for (const s of recent.slice(0, 120)) { const t = await getTx(s.signature); if (t) keysOf(t).forEach(k => keys.add(k)); }
  console.log(`phase A: ${keys.size} keys from ${Math.min(120, recent.length)} txs`);
  // Phase B
  const snapSig = (await rpc(() => conn.getSignaturesForAddress(PERC, { limit: 1 })))[0].signature;
  const accts = new Map<string, any>();
  let minSlot = Infinity, maxSlot = 0;
  for (const owner of OWNERS) {
    const r = await rpc(() => conn.getProgramAccounts(owner, { withContext: true } as any)) as any;
    minSlot = Math.min(minSlot, r.context.slot); maxSlot = Math.max(maxSlot, r.context.slot);
    for (const a of r.value) accts.set(a.pubkey.toBase58(), a.account);
  }
  const rest = [...keys].filter(k => !accts.has(k));
  for (let i = 0; i < rest.length; i += 100) {
    const chunk = rest.slice(i, i + 100);
    const r = await rpc(() => conn.getMultipleAccountsInfoAndContext(chunk.map(k => new PublicKey(k))));
    minSlot = Math.min(minSlot, r.context.slot); maxSlot = Math.max(maxSlot, r.context.slot);
    r.value.forEach((a, j) => { if (a) accts.set(chunk[j], a); });
  }
  console.log(`phase B: ${accts.size} accounts, context slots ${minSlot}..${maxSlot}`);
  const w = fs.createWriteStream(`${dir}/accounts.jsonl`);
  const dump = (k: string, a: any, late: boolean) => w.write(JSON.stringify({ k, lamports: a.lamports, owner: a.owner.toBase58(), exec: a.executable, data: Buffer.from(a.data).toString("base64"), late }) + "\n");
  for (const [k, a] of accts) dump(k, a, false);
  // Phase C: txs strictly after the last snapshot slot
  const t0 = Date.now();
  let cursor = snapSig;
  const tw = fs.createWriteStream(`${dir}/txs.jsonl`);
  let n = 0, skipped = 0;
  const programs = new Set<string>();
  while (Date.now() - t0 < MINUTES * 60_000) {
    await sleep(4000);
    const sigs = await newSigs(undefined, cursor);
    if (!sigs.length) continue;
    cursor = sigs[sigs.length - 1].signature;
    for (const s of sigs) {
      if (s.slot <= maxSlot) { skipped++; continue; }
      const t: any = await getTx(s.signature);
      if (!t) { console.log("missing", s.signature); continue; }
      const ks = keysOf(t);
      for (const k of ks) if (!accts.has(k)) {
        const a = await rpc(() => conn.getAccountInfo(new PublicKey(k)));
        accts.set(k, a ?? { lamports: 0, owner: PublicKey.default, executable: false, data: Buffer.alloc(0) });
        if (a) dump(k, a, true);
      }
      const m = t.transaction.message;
      const st = (m.staticAccountKeys ?? m.accountKeys);
      for (const ix of m.compiledInstructions ?? []) programs.add(st[ix.programIdIndex].toBase58());
      const la = t.meta?.loadedAddresses; const all = [...st.map((k: any) => k.toBase58()), ...(la?.writable ?? []).map((k: any) => k.toBase58?.() ?? k), ...(la?.readonly ?? []).map((k: any) => k.toBase58?.() ?? k)];
      for (const inner of t.meta?.innerInstructions ?? []) for (const ix of inner.instructions) programs.add(all[ix.programIdIndex]);
      tw.write(JSON.stringify({ sig: s.signature, slot: t.slot, time: t.blockTime, err: t.meta?.err ?? null, tx: Buffer.from(t.transaction.message.serialize()).toString("base64"), sigs: t.transaction.signatures, cu: t.meta?.computeUnitsConsumed }) + "\n");
      n++;
    }
    console.log(`${new Date().toISOString()} txs ${n} (skipped pre-snapshot ${skipped})`);
  }
  // Programs (current bytes of each non-builtin program invoked)
  for (const p of programs) {
    if (BUILTIN.has(p)) continue;
    const a = await rpc(() => conn.getAccountInfo(new PublicKey(p)));
    if (!a?.executable) continue;
    let elf = a.data;
    if (a.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111") {
      const pd = new PublicKey(a.data.slice(4, 36));
      const d = await rpc(() => conn.getAccountInfo(pd));
      elf = d!.data.slice(45);
    }
    fs.writeFileSync(`${dir}/programs/${p}.so`, elf);
  }
  await new Promise(r => w.end(r)); await new Promise(r => tw.end(r));
  fs.writeFileSync(`${dir}/meta.json`, JSON.stringify({ snapshotSlot: maxSlot, minSlot, txs: n, programs: [...programs] }));
  console.log(`done: ${n} txs, programs ${[...programs].join(",")}`);
})();
