// Market messages: short public posts about a market, kept on chain with no program of our own.
// A post is one transaction: a memo with the text ("tp:" first, so other memos are ignored) and a
// zero-lamport transfer to the market's chat address, so every post on a market can be listed
// with one `getSignaturesForAddress` call. The sender is the transaction's fee payer: it cannot be
// faked. Posts cost only the network fee, and they are permanent.
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import * as C from "./chain";

export const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const MAX_MSG = 280;
const PREFIX = "tp:";

/** Where a market's posts are gathered (an address no one holds a key for). */
export const chatAddress = (symbol: string) =>
  PublicKey.findProgramAddressSync([Buffer.from("turbopump-chat"), Buffer.from(symbol.toUpperCase().slice(0, 24))], MEMO)[0];

export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_MSG);

export function postIxs(wallet: PublicKey, symbol: string, text: string): TransactionInstruction[] {
  return [
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: chatAddress(symbol), lamports: 0 }),
    new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: wallet, isSigner: true, isWritable: false }], data: Buffer.from(PREFIX + clean(text), "utf8") }),
  ];
}

export type Post = { sig: string; from: string; text: string; time: number };

// Posts already read, by signature (a post never changes), and who sent each one.
const known = new Map<string, Post | null>();

/** The newest posts on a market, newest first. */
export async function readPosts(conn: Connection, symbol: string, limit = 60): Promise<Post[]> {
  const sigs = await conn.getSignaturesForAddress(chatAddress(symbol), { limit }, "confirmed");
  const ours = sigs.filter(s => !s.err && s.memo && s.memo.includes(PREFIX));
  const missing = ours.filter(s => !known.has(s.signature)).map(s => s.signature);
  for (let i = 0; i < missing.length; i += 20) {
    const part = missing.slice(i, i + 20);
    const txs = await conn.getTransactions(part, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    txs.forEach((tx, k) => {
      if (!tx) return;
      const from = tx.transaction.message.staticAccountKeys[0].toBase58();
      known.set(part[k], { sig: part[k], from, text: "", time: tx.blockTime ?? 0 });
    });
  }
  const out: Post[] = [];
  for (const s of ours) {
    const k = known.get(s.signature);
    if (!k) continue;
    // The RPC hands the memo as "[length] text" (several memos joined by "; ").
    const m = s.memo!.match(/tp:([\s\S]*)$/);
    const text = clean(m?.[1] ?? "");
    if (text) out.push({ ...k, text, time: s.blockTime ?? k.time });
  }
  return out;
}

export const chatNetworkNote = C.X1 ? "a tiny XNT network fee" : "a tiny SOL network fee";
