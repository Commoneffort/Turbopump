// Spot swaps on xDEX through the router (see swap.ts). Our own coin/USDC pool comes first, so
// coin can be turned into margin and deposited in one transaction.
import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as C from "./chain";
import * as S from "./swap";
import { Send, explorer, fmt, short } from "./shared";

const SLIPPAGES = [50, 100, 300];

function tokenName(mint: PublicKey, listed?: S.ListedPool): string {
  if (mint.equals(NATIVE_MINT)) return C.COIN;
  if (mint.equals(C.MINT)) return "USDC";
  const m = mint.toBase58();
  const s = listed ? (listed.a.mint === m ? listed.a.symbol : listed.b.mint === m ? listed.b.symbol : "") : "";
  return s || short(m);
}
const known = (mint: PublicKey) => mint.equals(NATIVE_MINT) || mint.equals(C.MINT);

/** `text` as atoms of a token with `dp` decimals (undefined when it is not a number). */
function atoms(text: string, dp: number): bigint | undefined {
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return undefined;
  const [w, f = ""] = text.split(".");
  return BigInt(w || "0") * 10n ** BigInt(dp) + BigInt((f + "0".repeat(dp)).slice(0, dp) || "0");
}
const show = (a: bigint, dp: number, max = 6) => fmt(Number(a) / 10 ** dp, Math.min(dp, max));

export default function SwapPage({ send, busy, tick }: { send: Send; busy?: string; tick: number }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [list, setList] = useState<S.ListedPool[]>();
  const [poolKey, setPoolKey] = useState(S.USDC_POOL.toBase58());
  const [pool, setPool] = useState<S.Pool | null>();
  const [err, setErr] = useState<string>();
  const [from, setFrom] = useState<0 | 1>(0);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(100);
  const [search, setSearch] = useState("");
  const [balances, setBalances] = useState<[bigint, bigint]>([0n, 0n]);
  const [hasTrader, setHasTrader] = useState(false);
  const [deposit, setDeposit] = useState(true);

  useEffect(() => { S.listPools().then(setList).catch(() => setList([])); }, []);
  useEffect(() => {
    let live = true;
    S.readPool(connection, new PublicKey(poolKey)).then(p => { if (live) { setPool(p); setErr(undefined); } })
      .catch(e => { if (live) { setPool(null); setErr(String(e?.message ?? e)); } });
    return () => { live = false; };
  }, [connection, poolKey, tick]);
  // Start on the coin side of a pool that has it.
  useEffect(() => { if (pool) setFrom(pool.mints[1].equals(NATIVE_MINT) ? 1 : 0); }, [pool?.key.toBase58()]);
  useEffect(() => {
    if (!publicKey || !pool) return setBalances([0n, 0n]);
    const read = async (i: 0 | 1) => {
      if (pool.mints[i].equals(NATIVE_MINT)) return BigInt(await connection.getBalance(publicKey));
      const a = await connection.getAccountInfo(getAssociatedTokenAddressSync(pool.mints[i], publicKey, true, pool.programs[i]));
      return a && a.data.length >= 72 ? Buffer.from(a.data).readBigUInt64LE(64) : 0n;
    };
    Promise.all([read(0), read(1)]).then(b => setBalances(b as [bigint, bigint])).catch(() => {});
    connection.getAccountInfo(C.traderAddress(publicKey)).then(a => setHasTrader(!!a)).catch(() => {});
  }, [connection, publicKey, pool, tick]);

  const listed = list?.find(l => l.pool === poolKey);
  const to = (1 - from) as 0 | 1;
  const amountIn = pool ? atoms(amount, pool.decimals[from]) : undefined;
  const q = pool && amountIn && amountIn > 0n ? S.quote(pool, from, amountIn, slippage) : undefined;
  const fromName = pool ? tokenName(pool.mints[from], listed) : "";
  const toName = pool ? tokenName(pool.mints[to], listed) : "";
  // Keep enough coin for fees and new token accounts.
  const reserve = pool?.mints[from].equals(NATIVE_MINT) ? (C.X1 ? 50_000_000n : 10_000_000n) : 0n;
  const spendable = balances[from] > reserve ? balances[from] - reserve : 0n;
  const intoMargin = !!pool && pool.mints[to].equals(C.MINT) && hasTrader && deposit;
  const problem = !pool ? undefined
    : pool.unsupported ? `This pool's token ${pool.unsupported}: the page does not swap it.`
    : pool.status !== 0 ? "xDEX has paused this pool."
    : pool.openTime > Date.now() / 1000 ? "This pool is not open yet."
    : pool.reserves[0] === 0n || pool.reserves[1] === 0n ? "This pool is empty."
    : undefined;
  const impactClass = q && q.impactBps > 500 ? "down" : "";

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    const rows = (list ?? []).filter(l => l.pool !== S.USDC_POOL.toBase58());
    return (s ? rows.filter(l => [l.a.symbol, l.b.symbol, l.a.mint, l.b.mint, l.pool].some(x => x.toLowerCase().includes(s))) : rows).slice(0, 40);
  }, [list, search]);

  const go = () => {
    if (!publicKey || !pool || !q) return;
    const ixs = S.swapInstructions(publicKey, pool, from, q);
    if (intoMargin) ixs.push(C.routerDeposit(publicKey, q.minOut));
    send(intoMargin ? "Swap and deposit" : "Swap", ixs);
  };

  return (
    <main className="swap-page">
      <h1>Swap</h1>
      <p className="muted">
        Spot swaps on <a href="https://xdex.xyz" target="_blank" rel="noreferrer">xDEX</a>, X1's exchange, through the Turbopump
        router. You receive real tokens in your wallet. The router takes a {Number(S.SWAP_FEE_BPS) / 100}% platform fee from what you pay
        in; the pool charges its own fee on top. A swap of {C.COIN} into USDC can go straight into your trading margin.
      </p>

      <div className="swap-grid">
        <section className="card">
          {pool === undefined && !err ? <div className="quiet">Reading the pool…</div> : !pool ? (
            <div className="banner warn">
              {poolKey === S.USDC_POOL.toBase58() ? `The ${C.COIN}/USDC pool is not open on ${C.NETWORK_NAME} yet. Pick another pool on the right.` : `Cannot read this pool: ${err}`}
            </div>
          ) : (
            <>
              <div className="swap-side">
                <div className="swap-l"><span className="muted small">You pay</span>
                  <button className="link small" disabled={!publicKey} onClick={() => setAmount((Number(spendable) / 10 ** pool.decimals[from]).toString())}>
                    Balance {show(balances[from], pool.decimals[from], 4)} {fromName}
                  </button>
                </div>
                <label className="inp"><span>{fromName}</span><input value={amount} placeholder="0.0" inputMode="decimal" onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} /></label>
              </div>
              <button className="swap-flip" title="Swap direction" onClick={() => { setFrom(to); setAmount(""); }}>↓↑</button>
              <div className="swap-side">
                <div className="swap-l"><span className="muted small">You receive (estimated)</span><span className="muted small">Balance {show(balances[to], pool.decimals[to], 4)} {toName}</span></div>
                <div className="inp swap-out"><span>{toName}</span><b className="mono">{q ? show(q.out, pool.decimals[to]) : "0.0"}</b></div>
              </div>

              <div className="kv">
                <div><span>Rate</span><b className="mono">{q && q.out > 0n ? `1 ${fromName} = ${fmt(Number(q.out) / 10 ** pool.decimals[to] / (Number(q.amountIn) / 10 ** pool.decimals[from]), 6)} ${toName}` : "—"}</b></div>
                <div><span>Price impact</span><b className={`mono ${impactClass}`}>{q ? `${fmt(q.impactBps / 100, 2)}%` : "—"}</b></div>
                <div><span>Platform fee ({Number(S.SWAP_FEE_BPS) / 100}%)</span><b className="mono">{q ? `${show(q.platformFee, pool.decimals[from])} ${fromName}` : "—"}</b></div>
                <div><span>Pool fee ({fmt(Number(pool.feeRate) / 10_000, 2)}%)</span><b className="mono">{q ? `${show(q.poolFee, pool.decimals[from])} ${fromName}` : "—"}</b></div>
                <div><span>Least you receive</span><b className="mono">{q ? `${show(q.minOut, pool.decimals[to])} ${toName}` : "—"}</b></div>
                <div><span>Slippage limit</span>
                  <div className="seg narrow">{SLIPPAGES.map(s => <button key={s} className={`seg-b ${s === slippage ? "active" : ""}`} onClick={() => setSlippage(s)}>{s / 100}%</button>)}</div>
                </div>
              </div>

              {pool.mints[to].equals(C.MINT) && publicKey && (
                hasTrader
                  ? <label className="check"><input type="checkbox" checked={deposit} onChange={e => setDeposit(e.target.checked)} /> Deposit the USDC as trading margin (the least you receive goes in; any extra stays in your wallet)</label>
                  : <p className="fine">Open a trading account on the Trade page to swap straight into margin.</p>
              )}
              {problem && <div className="banner warn">{problem}</div>}
              {q && q.impactBps > 500 && <div className="banner warn">This swap moves the pool's price by {fmt(q.impactBps / 100, 1)}%: the pool is small for this amount.</div>}
              <button className="btn primary wide" disabled={!publicKey || !!busy || !q || q.out === 0n || !!problem || (amountIn ?? 0n) > spendable}
                onClick={go}>
                {!publicKey ? "Connect a wallet" : busy ? busy + "…" : (amountIn ?? 0n) > spendable ? `Not enough ${fromName}` : intoMargin ? "Swap and deposit" : "Swap"}
              </button>
              <p className="fine">
                Pool <a href={explorer("address", pool.key.toBase58())} target="_blank" rel="noreferrer">{short(pool.key)}</a> ·
                {" "}{tokenName(pool.mints[0], listed)} <a href={explorer("address", pool.mints[0].toBase58())} target="_blank" rel="noreferrer">{short(pool.mints[0])}</a> /
                {" "}{tokenName(pool.mints[1], listed)} <a href={explorer("address", pool.mints[1].toBase58())} target="_blank" rel="noreferrer">{short(pool.mints[1])}</a>
                {(!known(pool.mints[0]) || !known(pool.mints[1])) && " · Anyone can open an xDEX pool under any name: check the token's address before you swap."}
              </p>
            </>
          )}
        </section>

        <section className="card">
          <h3>Pools</h3>
          <button className={`pool-row ${poolKey === S.USDC_POOL.toBase58() ? "on" : ""}`} onClick={() => setPoolKey(S.USDC_POOL.toBase58())}>
            <b>{C.COIN} / USDC</b><span className="muted small">Turbopump's pool · into margin</span>
          </button>
          <label className="inp small swap-search"><span>Find</span><input value={search} placeholder="symbol or address" onChange={e => setSearch(e.target.value)} style={{ textAlign: "left" }} /></label>
          {!list ? <div className="quiet">Loading xDEX pools…</div> : shown.length === 0 ? <div className="quiet">No pools found.</div> : shown.map(l => (
            <button key={l.pool} className={`pool-row ${poolKey === l.pool ? "on" : ""}`} onClick={() => setPoolKey(l.pool)}>
              <b>{l.a.symbol || short(l.a.mint)} / {l.b.symbol || short(l.b.mint)}</b>
              <span className="muted small mono">{short(l.pool)} · 24h ${fmt(l.volume, 0)}</span>
            </button>
          ))}
          <p className="fine">Pools as listed by xDEX. The page reads each pool's balances on chain itself before quoting.</p>
        </section>
      </div>
    </main>
  );
}
