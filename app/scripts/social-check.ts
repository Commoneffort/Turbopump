// Prints the page's builders for the new router instructions with fixed keys, in the format of
// the router test `builders_print_what_the_page_must_send`, so the two can be compared.
// Run: npx tsx scripts/social-check.ts   (devnet market; NETWORK=x1-testnet for the other)
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as C from "../src/chain";
import * as S from "../src/social";
const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const [wallet, leader, payer, vault] = [k(1), k(2), k(3), k(4)];
const show = (name: string, ix: TransactionInstruction) =>
  console.log(`IX ${name} ${Buffer.from(ix.data).toString("hex")} ${ix.keys.map(a => `${a.pubkey.toBase58()}:${a.isSigner ? "s" : ""}${a.isWritable ? "w" : ""}`).join(",")}`);
console.log("MARKET", C.MARKET.toBase58());
show("open_stats", S.openStats(payer, wallet));
show("set_profile", S.setProfile(wallet, "Satoshi_1", undefined, 3, 2));
show("rename", S.setProfile(wallet, "nakamoto", "Satoshi_1", 11, 1));
show("follow", S.follow(wallet, leader));
show("unfollow", S.unfollow(wallet, leader));
show("set_copy", S.setCopy(wallet, leader, 20_000, 250_000_000n));
show("stop_copy", S.stopCopy(wallet));
show("set_badge_image", S.setBadgeImage(wallet, 1_234, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])));
show("write_badge_image", S.writeBadgeImage(wallet, 7, new Uint8Array([4, 5, 6])));
show("remove_badge_image", S.removeBadgeImage(wallet));
show("trigger_copy", S.triggerCopy(payer, { key: S.copyAddress(wallet), market: C.MARKET, follower: wallet, leader, ratioBps: 0, maxNotional: 0n, since: 0, triggers: 0 }, vault, -1_500_000n));
show("deposit", C.routerDeposit(wallet, 7n));
show("withdraw", C.routerWithdraw(wallet, 9n));
