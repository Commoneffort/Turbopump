import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as C from "./chain";
import Desk from "./Desk";
import Docs from "./Docs";
import { TraderPage, TradersPage } from "./Traders";
import { Card, Faucet, Icon, Send, Stat, Toast, ago, explorer, fmt, px, short, units, usd, useCards } from "./shared";

// ---------------------------------------------------------------- routing

function useRoute(): [string[], (to: string) => void] {
  const parse = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (to: string) => { window.location.hash = to; window.scrollTo(0, 0); }];
}

// ---------------------------------------------------------------- transactions

const ERRORS: Record<string, string> = {
  "0x1": `not enough test USDC (use Get test USDC), or not enough ${C.COIN} in the wallet for the fee, the order's bond and its deposit`, "0x5608": "vault not active", "0x560a": "claim your previous request first",
  "0x560b": "nothing to claim", "0x560c": "epoch not over", "0x560d": "epoch not settled yet", "0x560e": "vault not flat yet",
  "0x5610": "amount is zero", "0x5611": "unknown asset", "0x15": "market busy: try again in a few seconds",
  "0x13": "close your open positions first (margin can only be withdrawn from an account with none)", "0xe": "not enough margin", "0x12": "asset generation changed: retry",
  "0x5705": "you already have a trade queued: it has to fill or expire first",
  "0x5706": "not enough margin for this size (the order must survive a further 10% price move): add margin or lower the size",
  "0x5707": "this market's queue is full: try again in a minute",
  "0x570f": "this market is close-only until its remaining positions are closed",
  "0x5710": "this market is open: close with a normal trade",
  "0x561b": "this epoch can settle without closing the vault's position",
  "0x5713": "this order's condition does not hold yet",
  "0x5714": "this order cannot be placed: a stop, take-profit or trailing stop needs an open position, and the prices and sizes must be positive",
  "0x5704": "that order slot is taken: cancel an order first",
  "0x5715": "a name is 3 to 16 letters, digits or underscores",
  "0x5716": "that name is taken",
  "0x5717": "the account is already in line with the trader it copies",
};

function useSend(onDone: () => void): [Send, string | undefined, Toast | undefined, () => void] {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState<string>();
  const [toast, setToast] = useState<Toast>();
  const send = useCallback<Send>(
    async (label, build) => {
      if (!wallet.publicKey) return;
      setBusy(label);
      try {
        const ixs = typeof build === "function" ? await build(connection) : build;
        // Percolator instructions can use several hundred thousand compute units.
        const tx = new Transaction().add(await C.computeLimit(connection, wallet.publicKey, ixs), ...ixs);
        let sig: string;
        if (C.X1 && wallet.signTransaction) {
          // A wallet sends through its own network. On X1 it only signs, and the page sends, so
          // the transaction goes to X1 whatever network the wallet is set to.
          tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
          tx.feePayer = wallet.publicKey;
          const signed = await wallet.signTransaction(tx);
          try {
            sig = await connection.sendRawTransaction(signed.serialize());
          } catch (e: any) {
            // A wallet that is itself set to X1 testnet may send what it signs. The page's copy
            // is then a duplicate, which is not a failure: the transaction is already on its way.
            if (!/already been processed|AlreadyProcessed/i.test(String(e?.message ?? e)) || !signed.signature) throw e;
            sig = bs58.encode(signed.signature);
          }
        } else sig = await wallet.sendTransaction(tx, connection);
        await connection.confirmTransaction(sig, "confirmed");
        setToast({ ok: true, text: `${label}: confirmed`, sig });
        onDone();
        return sig;
      } catch (e: any) {
        const logs: string[] = e?.logs ?? [];
        const code = logs.map(l => l.match(/custom program error: (0x[0-9a-f]+)/)?.[1]).find(Boolean) ?? String(e?.message ?? "").match(/custom program error: (0x[0-9a-f]+)/)?.[1];
        setToast({ ok: false, text: `${label} failed${code ? `: ${ERRORS[code] ?? code}` : `: ${e?.message ?? e}`}` });
      } finally {
        setBusy(undefined);
      }
    },
    [wallet, connection, onDone],
  );
  return [send, busy, toast, () => setToast(undefined)];
}

// ---------------------------------------------------------------- app shell

export default function App() {
  const [route, go] = useRoute();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);
  const [send, busy, toast, clearToast] = useSend(refresh);
  const page = route[0] ?? "";
  const { connection } = useConnection();
  useEffect(() => { C.measureSlotSeconds(connection).then(refresh); }, [connection, refresh]);

  const desk = page === "" || page === "trade" || page === "m";
  const tab = (on: boolean) => (on ? "tab active" : "tab");

  return (
    <div className={desk ? "app on-desk" : "app"}>
      <header className="top">
        <a className="brand" href="#/">
          <svg className="logo" width="22" height="22" viewBox="0 0 22 22" aria-hidden>
            <path d="M11 1.5 20.5 11 11 20.5 1.5 11Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M11 6.5 15.5 11 11 15.5 6.5 11Z" fill="currentColor" />
          </svg>
          <span className="brand-name">Turbopump</span>
        </a>
        <nav className="tabs">
          <a className={tab(desk)} href="#/">Trade</a>
          <a className={tab(page === "markets")} href="#/markets">Markets</a>
          <a className={tab(page === "launch")} href="#/launch">Open a market</a>
          <a className={tab(page === "traders" || page === "trader" || page === "leaderboard")} href="#/traders">Copy trading</a>
          <a className={tab(page === "how" || page === "docs")} href="#/docs">Docs</a>
        </nav>
        <div className="top-right">
          <div className="net-switch" title="Which deployment this page shows">
            <button className={C.X1 ? "" : "on"} onClick={() => !C.X1 || C.setNetwork("devnet")}>Solana devnet</button>
            <button className={C.X1 ? "on" : ""} onClick={() => C.X1 || C.setNetwork("x1-testnet")}>X1 testnet</button>
          </div>
          <WalletMultiButton />
        </div>
      </header>

      {desk ? (
        <Desk route={route} send={send} busy={busy} tick={tick} go={go} />
      ) : (
        <div className="page">
          {C.X1 && (
            <p className="muted small net-note">
              X1 testnet: the same programs as on Solana devnet, with test USDC as collateral. X1 has no Pyth, so prices here are posted by the
              router's reporter key from an exchange-median price service. Use the burner wallet, or a wallet that can sign for X1; you need a
              little test XNT for fees ("Get test USDC" sends some).
            </p>
          )}
          {page === "launch" ? (
            <LaunchPage key={route[1] ?? ""} send={send} busy={busy} go={go} initial={route[1]} />
          ) : page === "how" || page === "docs" ? (
            <Docs />
          ) : page === "traders" || page === "leaderboard" ? (
            <TradersPage send={send} busy={busy} tick={tick} go={go} />
          ) : page === "trader" && route[1] ? (
            <TraderPage key={route[1]} wallet={route[1]} send={send} busy={busy} tick={tick} go={go} />
          ) : (
            <MarketsPage go={go} tick={tick} />
          )}
          <footer className="foot">
            Unaudited experimental software on {C.NETWORK_NAME} · vault program{" "}
            <a href={explorer("address", C.VAULT_PROGRAM.toString())} target="_blank" rel="noreferrer">{short(C.VAULT_PROGRAM)}</a> · Percolator{" "}
            <a href={explorer("address", C.PERCOLATOR.toString())} target="_blank" rel="noreferrer">{short(C.PERCOLATOR)}</a> ·{" "}
            <a href="https://github.com/Commoneffort/Turbopump" target="_blank" rel="noreferrer">source</a>
          </footer>
        </div>
      )}

      {toast && (
        <div className={toast.ok ? "toast ok" : "toast err"} onClick={clearToast}>
          {toast.text}
          {toast.sig && <a href={explorer("tx", toast.sig)} target="_blank" rel="noreferrer"> · view</a>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- markets directory
function MarketCard({ c, go }: { c: Card; go: (to: string) => void }) {
  const sym = c.v.feed!.symbol;
  return (
    <button className="market-card" onClick={() => go(`/m/${c.v.key.toString()}`)}>
      <div className="mc-head">
        <Icon symbol={sym} />
        <div>
          <div className="mc-sym">{sym}-PERP</div>
          <div className="muted small">{c.v.feed!.name} · vault {short(c.v.key)}</div>
        </div>
        <div className="mc-price">{px(c.asset.price)}</div>
      </div>
      <div className="mc-row"><span>Liquidity</span><b>{usd(c.nav, 0)}</b></div>
      <div className="mc-row"><span>Open interest</span><b>{units(c.asset.oiLong)} {sym}</b></div>
      <div className="mc-row"><span>Fees</span><b>{usd(c.v.feesHarvested + c.asset.insurance)}</b></div>
      <div className="mc-row"><span>Epoch</span><b>{String(c.v.epoch)} · {Math.round(Number(c.v.epochLen) * C.slotSeconds() / 60)} min</b></div>
    </button>
  );
}

function MarketsPage({ go, tick }: { go: (to: string) => void; tick: number }) {
  const { cards, err } = useCards(tick);
  const canon = new Map((cards ?? []).filter(c => c.v.canonical).map(c => [c.v.feed!.symbol, c]));
  const legacy = (cards ?? []).filter(c => !c.v.canonical);
  const live = [...canon.values()].filter(c => c.v.status === 1);
  const tvl = (cards ?? []).reduce((a, c) => a + c.nav, 0n);
  const fills = (cards ?? []).reduce((a, c) => a + c.v.totalFills, 0n);
  const fees = (cards ?? []).reduce((a, c) => a + c.v.feesHarvested + (c.asset.insurance ?? 0n), 0n);

  return (
    <main>
      <section className="hero">
        <h1>One perpetual market per asset.<br /><span className="grad">One shared pool. No keys.</span></h1>
        <p className="muted">
          Anyone can open the market for a Pyth price feed; after that, everyone trades the same market and every liquidity
          provider shares the same vault. The vault lists the market on Anatoly Yakovenko's Percolator engine, owns every key to
          it, and is the counterparty to every trade. Depositors earn its fees. Nobody can pause, change or drain it.
        </p>
        <div className="hero-cta">
          <button className="btn primary" onClick={() => go("/")}>Trade</button>
          <button className="btn ghost" onClick={() => go("/launch")}>Open a market</button>
          <button className="btn ghost" onClick={() => go("/traders")}>Copy trading</button>
          <button className="btn ghost" onClick={() => go("/docs")}>Read the docs</button>
        </div>
        <div className="stats four">
          <Stat label="Markets" value={cards ? String(live.length) : "…"} sub="open now" />
          <Stat label="Liquidity" value={usd(tvl, 0)} sub="in all vaults" />
          <Stat label="Fills" value={String(fills)} sub="trades matched by vaults" />
          <Stat label="Fees earned" value={usd(fees)} sub="harvested + pending" />
        </div>
      </section>
      {err && <div className="banner warn">RPC error: {err}</div>}
      <div className="market-grid">
        {!cards ? <div className="loading">Loading markets…</div> : [...C.FEEDS, ...live.map(c => c.v.feed!).filter(f => !C.FEEDS.some(x => x.symbol === f.symbol))].map(f => {
          const c = canon.get(f.symbol);
          if (c && c.v.status === 1) return <MarketCard key={f.symbol} c={c} go={go} />;
          return (
            <button key={f.symbol} className="market-card launch-card" onClick={() => go(`/launch/${f.symbol}`)}>
              <Icon symbol={f.symbol} />
              <div className="mc-sym">{f.symbol}-PERP</div>
              <div className="muted small">{c ? "Created, waiting to be listed. Anyone can finish it." : `Not open yet. Open the ${f.name} market.`}</div>
            </button>
          );
        })}
      </div>
      {legacy.length > 0 && (
        <>
          <h3 className="section-title">Earlier vaults</h3>
          <p className="muted small">Created before one-market-per-asset. They still trade and settle normally, and their depositors can withdraw at any epoch.</p>
          <div className="market-grid">{legacy.map(c => <MarketCard key={c.v.key.toString()} c={c} go={go} />)}</div>
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------- launch

function LaunchPage({ send, busy, go, initial }: { send: Send; busy?: string; go: (to: string) => void; initial?: string }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [prices, setPrices] = useState<Record<string, bigint>>({});
  const [status, setStatus] = useState<Record<string, number>>({}); // -1 none, 0 pending, 1 live
  const [feed, setFeed] = useState(C.FEEDS.find(f => f.symbol === initial) ?? C.FEEDS[0]);
  const [seedDeposit, setSeedDeposit] = useState("500");
  const [step, setStep] = useState(0);

  const load = useCallback(async () => {
    const keys = [...C.FEEDS.map(f => C.priceAccount(f.id)), ...C.FEEDS.map(f => C.canonicalVaultAddress(f.id))];
    const accs = await connection.getMultipleAccountsInfo(keys, "confirmed");
    const p: Record<string, bigint> = {}, st: Record<string, number> = {};
    C.FEEDS.forEach((f, i) => {
      const a = accs[i];
      if (a) p[f.symbol] = C.decodePrice(new Uint8Array(a.data)).e6;
      const v = accs[C.FEEDS.length + i];
      st[f.symbol] = v ? C.decodeVault(keys[C.FEEDS.length + i], new Uint8Array(v.data)).status : -1;
    });
    setPrices(p);
    setStatus(st);
  }, [connection]);
  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, [load]);

  const vault = C.canonicalVaultAddress(feed.id);
  const st = status[feed.symbol] ?? -1;

  const open = async () => {
    if (!publicKey) return;
    if (st === -1) {
      setStep(1);
      const m = await C.fetchMarket(connection);
      if (!(await send("Create vault", [C.initVault(publicKey, feed.id, m.nextMarketId).ix]))) return setStep(0);
    }
    setStep(2);
    // Listing appends a new asset slot, so read the market right before it.
    const m = await C.fetchMarket(connection);
    const pyth = C.decodePrice(new Uint8Array((await connection.getAccountInfo(C.priceAccount(feed.id)))!.data));
    const listed = await send(`List ${feed.symbol}-PERP`, [
      createAssociatedTokenAccountIdempotentInstruction(publicKey, C.ata(publicKey, C.MINT), publicKey, C.MINT),
      C.listAsset(publicKey, vault, feed.id, m.listSlot, m.nextMarketId, pyth.e6),
      C.openBook(publicKey, vault),
    ]);
    await load();
    if (!listed) return setStep(0);
    setStep(3);
    const dep = BigInt(Math.floor(Number(seedDeposit || 0) * C.USDC));
    if (dep > 0n) {
      const s = await C.fetchVault(connection, vault, publicKey);
      if (s.userCollateral >= dep) await send("Seed deposit", [C.requestDeposit(s.vault, publicKey, dep)]);
    }
    setStep(0);
    go(`/m/${vault.toString()}`);
  };

  return (
    <main className="grid">
      <section className="card span2">
        <h2>Open a market</h2>
        <p className="muted">
          Each Pyth feed gets exactly one market and one shared liquidity vault, enforced on-chain: the vault's address is derived
          from the feed, so a second one can't exist. Whoever opens it pays about 0.12 test {C.COIN} of rent and a 1 USDC listing fee,
          and chooses nothing else. Every market runs on the same fixed rules, so nobody can open a market set up to fail. In
          return, the opener earns 5% of the market's fees for as long as it trades.
        </p>
        <div className="feed-grid">
          {C.FEEDS.map(f => (
            <button key={f.symbol} className={f.symbol === feed.symbol ? "feed active" : "feed"} onClick={() => setFeed(f)}>
              <Icon symbol={f.symbol} />
              <div className="feed-sym">{f.symbol}</div>
              <div className="muted small">{prices[f.symbol] ? px(prices[f.symbol]) : "…"}</div>
              {status[f.symbol] === 1 ? <div className="tag">live</div> : status[f.symbol] === 0 ? <div className="tag warn-tag">unlisted</div> : null}
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h3>The rules every market gets</h3>
        <div className="row"><span>Vault position limit</span><b>3× its NAV</b></div>
        <div className="row"><span>Most new exposure per order</span><b>0.75× its NAV (closing is not limited)</b></div>
        <div className="row"><span>Cash kept for withdrawals</span><b>10% of its NAV</b></div>
        <div className="row"><span>Epoch</span><b>about {Math.round(C.CANON_EPOCH_LEN_SLOTS * C.slotSeconds() / 60)} minutes</b></div>
        <div className="row"><span>Insurance kept for traders</span><b>$100</b></div>
        <div className="row"><span>Price</span><b>Pyth, ≤ 5 min old</b></div>
        <div className="row"><span>Leverage, fee</span><b>10×, {C.TRADE_FEE_PCT}</b></div>
        <div className="row"><span>Opener's share of fees</span><b>5%, forever</b></div>
        <p className="muted small">Limits scale with the vault: an empty vault quotes nothing, and every deposit deepens the market. Depositors share the rest pro rata: 85%, after the platform's 10% (which a vault under $5,000 does not pay).</p>
      </section>
      <section className="card">
        <h3>{st === 1 ? `${feed.symbol}-PERP is live` : st === 0 ? `Finish listing ${feed.symbol}-PERP` : `Open ${feed.symbol}-PERP`}</h3>
        {st === 1 ? (
          <>
            <p className="muted">This market already exists. Trade it or add to its shared pool.</p>
            <button className="btn primary wide" onClick={() => go(`/m/${vault.toString()}`)}>Go to {feed.symbol}-PERP</button>
          </>
        ) : (
          <>
            <label className="field"><span>Your seed deposit (USDC, optional)</span><input value={seedDeposit} onChange={e => setSeedDeposit(e.target.value)} inputMode="decimal" /></label>
            <ol className="stepper">
              <li className={st === 0 || step > 1 ? "done" : step === 1 ? "active" : ""}>Create the vault {st === 0 && "(done)"}</li>
              <li className={step > 2 ? "done" : step === 2 ? "active" : ""}>List {feed.symbol}-PERP with its Pyth feed</li>
              <li className={step === 3 ? "active" : ""}>Seed deposit (settles when the first epoch ends)</li>
            </ol>
            <button className="btn primary wide" disabled={!publicKey || !!busy || !prices[feed.symbol]} onClick={open}>
              {!publicKey ? "Connect a wallet" : busy ? `${busy}…` : st === 0 ? `Finish listing ${feed.symbol}-PERP` : `Open ${feed.symbol}-PERP`}
            </button>
          </>
        )}
        <Faucet />
      </section>
    </main>
  );
}
