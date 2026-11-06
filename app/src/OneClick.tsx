// One-click trading: the wallet approves a trading key once (router `session`), and trades sign
// with that key, without a wallet popup. See tradingKey.ts for how the key is kept.
//
// What the key can do is set on chain when it is approved: trade on this market only, for a
// limited time, at most a set size a trade and a set number of trades a day (closing a position is
// never limited). It cannot withdraw, deposit, copy, or change anything else; withdrawals always
// need the wallet and only ever pay the wallet.
import { useEffect, useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as C from "./chain";
import * as S from "./social";
import type { Send } from "./shared";
import { createTradingKey, forgetTradingKey, loadTradingKey, type TradingKey } from "./tradingKey";

const XNT = 1e9;
/** What a key is given for fees when it is approved (a quoted trade costs it ~0.01 XNT on X1). */
export const KEY_FEE_FUND = 0.5;
/** Below this the panel offers a top-up. */
const KEY_LOW = 0.05;
const DAYS = [1, 7, 30] as const;
const SIZES = [1_000, 5_000, 25_000] as const;
const TRADES = [200, 1_000] as const;

export type OneClickState = { key: TradingKey | null; session: C.Session | null; lamports: number; active: boolean; reload: () => void };

/** The wallet's trading key on the active market, and whether the router accepts it now. */
export function useTradingKey(tick: number): OneClickState {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [s, set] = useState<Omit<OneClickState, "reload">>({ key: null, session: null, lamports: 0, active: false });
  const [n, setN] = useState(0);
  const me = publicKey?.toBase58() ?? "";
  useEffect(() => {
    if (!publicKey || !C.X1) { set({ key: null, session: null, lamports: 0, active: false }); return; }
    let live = true;
    (async () => {
      const market = C.activeMarket();
      const key = await loadTradingKey(C.NETWORK, market, publicKey);
      const accs = await connection.getMultipleAccountsInfo([C.sessionAddress(publicKey, market), ...(key ? [key.publicKey] : [])], "confirmed");
      const session = C.decodeSession(accs[0] ? new Uint8Array(accs[0].data) : null);
      const lamports = key && accs[1] ? accs[1].lamports : 0;
      const active = !!key && !!session && session.key.equals(key.publicKey) && session.expires > Date.now() / 1000 + 30;
      if (live) set({ key, session, lamports, active });
    })().catch(() => {});
    return () => { live = false; };
  }, [me, tick, n, connection]);
  return { ...s, reload: useCallback(() => setN(x => x + 1), []) };
}

const money = (x: number) => `$${x.toLocaleString("en-US")}`;
const when = (unix: number) => new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The panel under the order ticket: switch one-click trading on, see it, top it up, switch it off. */
export function OneClickPanel({ ok, send, busy }: { ok: OneClickState; send: Send; busy?: string }) {
  const { publicKey } = useWallet();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(1);
  const [size, setSize] = useState<number>(5_000);
  const [trades, setTrades] = useState<number>(200);
  if (!publicKey || !C.X1) return null;
  const enable = async () => {
    const key = await createTradingKey(C.NETWORK, C.activeMarket(), publicKey);
    const expires = Math.floor(Date.now() / 1000) + days * 86_400 - 60;
    const r = await send("Turn on one-click trading", [
      C.openSession(publicKey, key.publicKey, expires, BigInt(size) * BigInt(C.USDC), trades),
      SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: key.publicKey, lamports: Math.round(KEY_FEE_FUND * XNT) }),
    ]);
    if (!r) await forgetTradingKey(C.NETWORK, C.activeMarket(), publicKey);
    setOpen(false);
    ok.reload();
  };
  const topUp = () => send("Add XNT to the trading key", [SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: ok.key!.publicKey, lamports: Math.round(KEY_FEE_FUND * XNT) })]).then(ok.reload);
  const turnOff = async () => {
    const key = ok.key;
    if (!key) return;
    // The key ends its own approval (no wallet popup) and gives what it holds back to the wallet.
    const ixs: TransactionInstruction[] = [];
    if (ok.session && ok.session.key.equals(key.publicKey)) ixs.push(C.closeSession(key.publicKey, publicKey));
    const back = ok.lamports - 0.01 * XNT;
    if (back > 0) ixs.push(SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: publicKey, lamports: Math.floor(back) }));
    const r = ixs.length && ok.lamports > 0.005 * XNT ? await send("Turn off one-click trading", ixs, { key }) : "none";
    // A key the router no longer accepts (expired, replaced) and nothing left on it: just forget it.
    if (r) await forgetTradingKey(C.NETWORK, C.activeMarket(), publicKey);
    ok.reload();
  };
  const s = ok.session;
  if (ok.active && s) {
    const xnt = ok.lamports / XNT;
    const today = Date.now() / 1000 - s.windowStart < 86_400 ? s.trades : 0;
    return (
      <div className="oneclick on">
        <div className="oneclick-h"><b>One-click trading on</b><span className="mono">until {when(s.expires)}</span></div>
        <div className="fine">
          Trades sign with a key of this browser{ok.key?.protected ? " that cannot be copied out of it" : " kept for this tab"}: up to {money(Number(s.maxNotional) / C.USDC)} a trade, {today} of {s.maxTrades} trades today. It cannot withdraw. Key fees: <b className={xnt < KEY_LOW ? "down" : ""}>{xnt.toFixed(3)} {C.COIN}</b>
        </div>
        <div className="oneclick-b">
          {xnt < KEY_LOW * 4 && <button className="btn tiny" disabled={!!busy} onClick={topUp}>Add {KEY_FEE_FUND} {C.COIN}</button>}
          <button className="btn tiny" disabled={!!busy} onClick={turnOff}>Turn off</button>
        </div>
      </div>
    );
  }
  return (
    <div className="oneclick">
      {!open ? (
        <button className="btn wide" disabled={!!busy} onClick={() => setOpen(true)} title="Approve a trading key once; trades then need no wallet popup">
          {s || ok.key ? "One-click trading ended: turn it on again" : "Turn on one-click trading"}
        </button>
      ) : (
        <>
          <div className="oneclick-h"><b>One-click trading</b></div>
          <div className="fine">
            Your wallet approves a new key made in this browser, once. Trades then sign with it, with no popup. The router lets it trade on this market only, within these limits; closing a position is never limited. It <b>cannot withdraw</b> or move your money anywhere: withdrawals always need your wallet and only pay your wallet. {KEY_FEE_FUND} {C.COIN} goes to the key for its fees (what is left comes back when you turn it off).
          </div>
          <div className="oneclick-opts">
            <label>For <select value={days} onChange={e => setDays(Number(e.target.value))}>{DAYS.map(d => <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`}</option>)}</select></label>
            <label>Up to <select value={size} onChange={e => setSize(Number(e.target.value))}>{SIZES.map(x => <option key={x} value={x}>{money(x)} a trade</option>)}</select></label>
            <label><select value={trades} onChange={e => setTrades(Number(e.target.value))}>{TRADES.map(x => <option key={x} value={x}>{x} trades a day</option>)}</select></label>
          </div>
          <div className="oneclick-b">
            <button className="btn white" disabled={!!busy} onClick={enable}>Approve in wallet</button>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

/** First time on the market: one wallet approval opens the account, deposits, and (if chosen)
 *  turns on one-click trading. Two transactions when it does not fit one, signed together. */
export function SetupCard({ send, busy, userCollateral, coins, onDone }: { send: Send; busy?: string; userCollateral: bigint; coins?: number; onDone: () => void }) {
  const { publicKey, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState("");
  const [oneClick, setOneClick] = useState(true);
  const [status, setStatus] = useState<string>();
  if (!publicKey) return null;
  const have = Number(userCollateral) / C.USDC;
  const want = Math.min(Number(amount || 0), have);
  const atoms = BigInt(Math.floor(want * C.USDC));
  const account = [C.openTradingAccount(publicKey), C.openLedger(publicKey, publicKey), S.openStats(publicKey, publicKey)];
  const deposit = atoms > 0n ? [createAssociatedTokenAccountIdempotentInstruction(publicKey, C.ata(publicKey, C.MINT), publicKey, C.MINT), C.routerDeposit(publicKey, atoms)] : [];
  const go = async () => {
    setStatus(undefined);
    if (!oneClick || !C.X1 || !signAllTransactions) { await send(atoms > 0n ? "Open trading account and deposit" : "Create trading account", [...account, ...deposit]); onDone(); return; }
    let key: TradingKey | undefined;
    try {
      key = await createTradingKey(C.NETWORK, C.activeMarket(), publicKey);
      const session = [C.openSession(publicKey, key.publicKey, Math.floor(Date.now() / 1000) + 86_400 - 60, 5_000n * BigInt(C.USDC), 200),
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: key.publicKey, lamports: Math.round(KEY_FEE_FUND * XNT) })];
      const hash = await C.recentBlockhash(connection);
      const txs = [new Transaction().add(await C.computeLimit(connection, publicKey, [...account, ...deposit]), ...account, ...deposit), new Transaction().add(...session)];
      for (const t of txs) { t.recentBlockhash = hash; t.feePayer = publicKey; }
      setStatus("Approve in your wallet…");
      const signed = await signAllTransactions(txs);
      for (const [i, t] of signed.entries()) {
        setStatus(i === 0 ? "Opening the account…" : "Turning on one-click trading…");
        const sig = await connection.sendRawTransaction(t.serialize());
        await C.confirmFast(connection, sig);
      }
      setStatus("Ready: trades sign with one click.");
    } catch (e: any) {
      if (key) await forgetTradingKey(C.NETWORK, C.activeMarket(), publicKey);
      setStatus(`Not done: ${String(e?.message ?? e).slice(0, 140)}`);
    }
    onDone();
  };
  return (
    <div className="setup">
      <div className="oneclick-h"><b>Start trading</b></div>
      <label className="inp small"><span>Deposit USDC</span><input value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={have > 0 ? `up to ${have.toFixed(2)}` : "0"} inputMode="decimal" /></label>
      {have > 0 && <div className="quick">{[0.25, 0.5, 1].map(f => <button key={f} onClick={() => setAmount((Math.floor(have * f * 100) / 100).toString())}>{f === 1 ? "All" : `${f * 100}%`}</button>)}</div>}
      {C.X1 && <label className="check"><input type="checkbox" checked={oneClick} onChange={e => setOneClick(e.target.checked)} /> One-click trading (a key of this browser signs trades for 1 day, up to $5,000 a trade; it cannot withdraw)</label>}
      <button className="submit up" disabled={!!busy || (coins !== undefined && coins < 0.6 * XNT && oneClick)} onClick={go}>{atoms > 0n ? `Deposit ${want.toLocaleString("en-US")} USDC and start` : "Open trading account"}</button>
      {coins !== undefined && coins < 0.6 * XNT && oneClick && <div className="fine">One-click trading needs about 0.6 {C.COIN} in your wallet ({KEY_FEE_FUND} goes to the key for fees).</div>}
      <div className="fine">One approval in your wallet{oneClick && C.X1 ? " (two transactions, signed together)" : ""}. Withdrawals always need your wallet.</div>
      {status && <div className="fine">{status}</div>}
    </div>
  );
}

