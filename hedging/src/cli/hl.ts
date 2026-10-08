// Hyperliquid test network: make a key, and check that the connection works.
//
//   npm run hl -- new-key                 writes a new private key to the key file, prints its address
//   npm run hl                            what the test network says about the account (read-only)
//   npm run hl -- order-check             also sends one order that cannot trade (a buy at half
//                                         the market price, immediate-or-cancel), to prove that
//                                         orders are signed correctly and reach the account
//
// Options: [--key-file file] [--account 0x...]   (default key file ~/.config/hyperliquid/testnet-key)
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { HyperliquidVenue, addressOf, priceTick } from "../hyperliquid";
import { errorText, qty, usd } from "../units";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const keyFile = opt("key-file") ?? `${process.env.HOME}/.config/hyperliquid/testnet-key`;
const account = opt("account");

if (args[0] === "new-key") {
  if (fs.existsSync(keyFile)) throw new Error(`${keyFile} already exists`);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = "0x" + crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(keyFile, key + "\n", { mode: 0o600, flag: "wx" });
  console.log(`new key written to ${keyFile}\naddress ${addressOf(key)}`);
  process.exit(0);
}

const hl = new HyperliquidVenue({ privateKey: fs.readFileSync(keyFile, "utf8").trim(), account });
console.log(`signing key  ${hl.signer}\naccount      ${hl.user}${hl.user === hl.signer ? "" : "  (the key must be approved by it as an API wallet)"}`);
const a = await hl.account();
console.log(`equity ${usd(a.equityE6)}, free margin ${usd(a.freeMarginE6)}`);
const pos = await hl.positions();
console.log("positions:", pos.size ? Object.fromEntries([...pos].map(([k, v]) => [k, qty(v)])) : "none");
for (const s of ["SOL", "BTC", "ETH"]) {
  const [q, m] = [await hl.quote(s), await hl.meta(s)];
  console.log(`${s}: mid ${usd(q.midE6)}, lot ${qty(m.lotQ)}, tick ${usd(m.tickE6)}, quote age ${Date.now() - q.atMs} ms`);
}
console.log(`fills on record: ${(await hl.fills(null)).length}`);

if (args[0] === "order-check") {
  const q = await hl.quote("SOL"), m = await hl.meta("SOL");
  const half = q.midE6 / 2n, limit = half - (half % priceTick(half, 2));
  // The smallest whole number of lots worth the venue's minimum at that price.
  const size = (m.minNotionalE6 * 1_000_000n / limit / m.lotQ + 1n) * m.lotQ;
  const id = "0x" + crypto.randomBytes(16).toString("hex");
  console.log(`sending: buy ${qty(size)} SOL at ${usd(limit)} (market ${usd(q.midE6)}), immediate-or-cancel`);
  try {
    const st = await hl.place({ clientId: id, symbol: "SOL", side: "buy", sizeQ: size, limitE6: limit, reduceOnly: false });
    console.log(`the exchange answered: ${st.status}${st.reason ? ` (${st.reason})` : ""}, filled ${qty(st.filledQ)}`);
    const said = st.reason ?? "";
    if (/could not immediately match/i.test(said)) console.log("OK: the order was accepted as ours and, as intended, did not trade.");
    else if (said.includes(hl.signer)) console.log("The signature is right (the exchange recovered our address from it), but it does not know this key: fund the address on the test network, or approve it as an API wallet and pass --account.");
    else if (/does not exist/i.test(said)) console.log("PROBLEM: the exchange recovered a different address from the signature.");
  } catch (e) {
    console.log(`no answer: ${errorText(e)}`);
  }
}
