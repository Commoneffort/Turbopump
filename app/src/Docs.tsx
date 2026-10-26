import { MANIFEST as M } from "./chain";
import { CANON_EPOCH_LEN_SLOTS, LAYOUT, ROUTER, ROUTER_BATCH_SECS, ROUTER_DELAY_SECS, ROUTER_GRACE_SECS, TRADE_FEE_PCT, X1, slotSeconds } from "./chain";
import { COPY_FEE_TEXT, LEADER_PAID, REBATE } from "./social";

const ex = (k: string) => (X1 ? `https://explorer.testnet.x1.xyz/address/${k}` : `https://explorer.solana.com/address/${k}?cluster=devnet`);
const A = ({ k }: { k: string }) => <a className="mono" href={ex(k)} target="_blank" rel="noreferrer">{k}</a>;

// Funding is off for now (the vault program's cap is 0); the section describes the design as it
// ran, with the cap it ran under (40 e9 per slot).
const FUNDING = { max: Number((LAYOUT.router as any).funding_max_e9 ?? 30), cap: 40, on: Number((LAYOUT.router as any).funding_canon_cap_e9 ?? 0) > 0 };
/** A rate in e9 per slot as a share per hour, at the measured slot time. */
const fundingHour = (e9: number) => e9 / 1e9 * 3600 / slotSeconds();
const fmtPct = (x: number) => `${(x * 100).toFixed(x * 100 >= 0.1 ? 2 : 3)}%`;
const fmt2 = (x: number) => x.toFixed(2);

const TOC = [
  ["overview", "Overview"],
  ["layers", "Percolator and Turbopump"],
  ["percolator", "The engine underneath"],
  ["problem", "What the engine leaves open"],
  ["frontrun", "Front-running, solved"],
  ["design", "Design"],
  ["fills", "How trades fill"],
  ["orders", "Order types"],
  ["desk", "The trading desk"],
  ["spot", "Spot swaps on xDEX"],
  ["copy", "Track records and copy trading"],
  ["community", "Contest, alerts and health"],
  ["lifecycle", "Market lifecycle"],
  ["rules", "Market rules"],
  ["pricing", "Share pricing"],
  ["funding", "Funding"],
  ["fees", "Fees and rebates"],
  ["rails", "Safety rails"],
  ["risks", "Risks"],
  ["security", "Security model"],
  ["instructions", "Instruction reference"],
  ["keeper", "Keepers and executors"],
  ["integrate", "Integrating"],
  ["networks", "Two test networks"],
  ["addresses", "Addresses"],
  ["mainnet", "Path to mainnet"],
  ["faq", "FAQ"],
];

function Diagram() {
  // Arrows show value and control flow; boxes are programs, accounts and people.
  return (
    <svg className="diagram" viewBox="0 0 900 430" role="img" aria-label="How a trade, fees and deposits flow between traders, Percolator and the vault">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="d-head" />
        </marker>
      </defs>
      <g className="d-box"><rect x="20" y="40" width="170" height="64" rx="10" /><text x="105" y="68">Trader</text><text x="105" y="88" className="d-sub">wallet + router account</text></g>
      <g className="d-box strong"><rect x="330" y="30" width="240" height="84" rx="10" /><text x="450" y="62">Percolator program</text><text x="450" y="82" className="d-sub">risk engine: margin, PnL, funding,</text><text x="450" y="98" className="d-sub">liquidation, insurance</text></g>
      <g className="d-box"><rect x="710" y="40" width="170" height="64" rx="10" /><text x="795" y="68">Pyth</text><text x="795" y="88" className="d-sub">price feed account</text></g>
      <g className="d-box accent"><rect x="330" y="200" width="240" height="84" rx="10" /><text x="450" y="232">Vault program</text><text x="450" y="252" className="d-sub">matcher + pool + market owner</text><text x="450" y="268" className="d-sub">no admin instruction</text></g>
      <g className="d-box"><rect x="20" y="210" width="170" height="64" rx="10" /><text x="105" y="238">Liquidity providers</text><text x="105" y="258" className="d-sub">deposit, share 85% of fees</text></g>
      <g className="d-box"><rect x="710" y="210" width="170" height="64" rx="10" /><text x="795" y="238">Market opener</text><text x="795" y="258" className="d-sub">earns 5% of fees</text></g>
      <g className="d-box"><rect x="330" y="340" width="240" height="64" rx="10" /><text x="450" y="368">Keeper and executor (anyone)</text><text x="450" y="388" className="d-sub">marks, fills, rolls, harvests</text></g>
      <path className="d-line" d="M190,72 L330,72" markerEnd="url(#arr)" /><text x="260" y="62" className="d-label">request → router</text>
      <path className="d-line" d="M710,72 L570,72" markerEnd="url(#arr)" /><text x="640" y="62" className="d-label">verified price</text>
      <path className="d-line" d="M430,114 L430,200" markerEnd="url(#arr)" /><text x="424" y="160" className="d-label end">asks for a fill</text>
      <path className="d-line" d="M470,200 L470,114" markerEnd="url(#arr)" /><text x="478" y="160" className="d-label start">size, at mark</text>
      <path className="d-line" d="M190,242 L330,242" markerEnd="url(#arr)" /><text x="260" y="232" className="d-label">deposits</text>
      <path className="d-line" d="M570,242 L710,242" markerEnd="url(#arr)" /><text x="640" y="232" className="d-label">5% of fees</text>
      <path className="d-line dash" d="M450,340 L450,284" markerEnd="url(#arr)" />
    </svg>
  );
}

export default function Docs() {
  return (
    <main className="docs">
      <aside className="toc">
        <div className="toc-title">Documentation</div>
        {TOC.map(([id, t]) => <a key={id} href={`#/docs`} onClick={e => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }); }}>{t}</a>)}
      </aside>
      <article className="doc">
        <h1 id="overview">Turbopump</h1>
        {X1 && (
          <p className="callout">
            <b>You are looking at the X1 testnet deployment.</b> The programs are the same as on Solana devnet, and this page describes
            the Solana one. What differs on X1: there is no Pyth, so wherever this page says "Pyth price", the price is one posted by
            the router's reporter key, taken from an exchange-median price service. A trade still fills at the first price at or after
            its target time, but that price is the reporter's word. A second key, the witness, posts its own price for every
            market, and the mark only moves to a reported price that the witness's own price, at most 30 seconds old, is within
            1.5% of. So one key alone can no longer set a price, but the two keys together are still trusted for prices. Markets cover crypto, stocks and metals; stocks only have a price while their exchanges are open, and a
            trade queued outside those hours expires. Collateral is a test USDC; fees and rent are paid in test XNT.
          </p>
        )}
        <p className="lead">
          Turbopump is a perpetual-futures exchange that anyone can add a market to and nobody controls. It is built on
          Percolator, Anatoly Yakovenko's risk engine, and adds everything an exchange needs around it: markets that own their
          own keys, a shared liquidity vault for each asset, trading that cannot be front-run, limit, stop, take-profit,
          trailing and TWAP orders, track records and copy trading written by the program itself, spot swaps on xDEX, and a
          trading desk to use it all from. Every trade fills at the first oracle price published {ROUTER_DELAY_SECS} seconds after it was requested,
          so nobody can trade against a price they already know.
        </p>
        <div className="callout">
          <b>Status.</b> Live on Solana devnet and X1 testnet. Unaudited: neither Turbopump nor Percolator has been audited. Use test funds only.
          Source: <a href="https://github.com/Commoneffort/Turbopump" target="_blank" rel="noreferrer">github.com/Commoneffort/Turbopump</a>.
        </div>

        <h2 id="layers">Percolator and Turbopump</h2>
        <p>
          Two different things, by two different authors. <b>Percolator</b> is the engine underneath: it keeps the books. We did
          not write it. <b>Turbopump</b> is what this project built on top of it, and it is what you are using on this site.
        </p>
        <table className="doc-table">
          <thead><tr><th></th><th>Percolator (the engine, not ours)</th><th>Turbopump (what we built)</th></tr></thead>
          <tbody>
            <tr><td>What it is</td><td>A risk engine: one Solana program by Anatoly Yakovenko</td><td>Two Solana programs (vault and router), the services that run them, and this web app</td></tr>
            <tr><td>Its job</td><td>Margin, profit and loss, insurance, its own liquidation, bounded price moves</td><td>Everything else: who lists a market, who provides liquidity, how and at what price a trade fills, orders, fees, records</td></tr>
            <tr><td>Liquidity</td><td>None of its own: a trade needs a counterparty</td><td>One shared vault per asset that is the counterparty to every trade</td></tr>
            <tr><td>Market keys</td><td>Whoever lists a market holds its admin, insurance and oracle keys</td><td>The vault's own address holds them, and the program has no instruction that uses them</td></tr>
            <tr><td>Price a trade gets</td><td>The market's mark, whatever it is at that moment</td><td>The first oracle price published {ROUTER_DELAY_SECS} seconds after the request: unknown to everyone when the trade is sent</td></tr>
            <tr><td>Order types</td><td>An immediate trade between two accounts</td><td>Market, limit, stop loss, take profit, trailing stop and TWAP</td></tr>
            <tr><td>Who earns the fees</td><td>The asset's insurance operator</td><td>Depositors 85%, the market's opener 5%, the platform 10%</td></tr>
          </tbody>
        </table>
        <p>What Turbopump adds, in the order this page describes it:</p>
        <ul>
          <li><b>The vault program</b>: keyless markets, one per price feed, each with a pooled vault that lists the market, quotes it and pays its fees to depositors.</li>
          <li><b>The router program</b>: the only way to trade. It queues every trade and fills it at a price nobody could know in advance.</li>
          <li><b>Standing orders</b>: limit, stop loss, take profit, trailing stop and TWAP, signed once and carried out on chain by anyone.</li>
          <li><b>Track records and copy trading</b>: profit, volume and fills booked by the router itself; names, badges, following and copying.</li>
          <li><b>Liquidations and settlement that keep markets open</b>: positions are closed against the vault before the engine has to step in, and epochs settle while the vault holds a position.</li>
          <li><b>Fees with a purpose</b>: an opener's share, a platform share that small vaults do not pay, volume rebates and first-month refunds for new wallets.</li>
          <li><b>Safety rails</b>: leverage and vault limits set per asset, partial liquidations with room kept for them, smaller fills for the crowded side, a price band and a confidence check, a cash reserve and a margin top-up for the vault, a loss cover for depositors, deposits and bonds that make abandoned orders cost something, places in the queue kept for liquidations.</li>
          <li><b>Spot swaps</b>: real tokens bought and sold on xDEX pools through the router, with the platform's fee taken on chain, and coin turned into trading margin in one step.</li>
          <li><b>A second price source and a second network</b>: reported prices as a fallback for Pyth, and a full deployment on X1, which has no Pyth.</li>
          <li><b>The services</b>: a keeper and an executor that anyone can run, on free price data and public RPC.</li>
          <li><b>The trading desk</b>: this site, with charts, drawing tools, indicators and several charts side by side, a weekly contest, a Health page and Telegram alerts.</li>
          <li><b>Fixes to Percolator itself</b>, found while building on it and sent upstream.</li>
        </ul>

        <h2 id="percolator">The engine underneath: Percolator</h2>
        <p>
          This section is the only one about Percolator alone; skip it if you only want to know what Turbopump does.{" "}
          <a href="https://github.com/aeyakovenko/percolator" target="_blank" rel="noreferrer">Percolator</a> is a perpetual-futures
          risk engine and Solana program. A <i>market</i> account holds many <i>assets</i> (asset 0 is the collateral unit; the rest
          are perps priced in it). Each trader has a <i>portfolio</i> account with collateral and up to a few cross-margined positions.
        </p>
        <ul>
          <li><b>Trades settle at the market's mark price.</b> A trade names a counterparty portfolio (an LP) whose <i>matcher</i> program Percolator calls to decide the fill size. The price a matcher quotes only sizes fees; profit and loss come from the mark moving.</li>
          <li><b>Fees go to insurance.</b> Every trade pays a base fee on both sides into the traded asset's insurance budget, which absorbs bad debt. That asset's <i>insurance operator</i> can withdraw budget above what is needed, when the market is healthy.</li>
          <li><b>Listing is permissionless.</b> Anyone can activate a new asset by paying a fee. The activating signer becomes the asset's admin and names its insurance, backing and oracle authorities.</li>
          <li><b>Safety is engineered in.</b> Prices can only move a bounded amount per slot, positive PnL is only usable when backed, bad debt stays inside the asset that caused it, and anyone can crank the market forward in bounded steps.</li>
        </ul>

        <h2 id="problem">What the engine leaves open</h2>
        <p>Percolator on its own is not an exchange anyone can use. These are the gaps Turbopump fills:</p>
        <ol>
          <li><b>New markets are empty.</b> A freshly listed asset has no liquidity, so nobody can trade it. Percolator's own mainnet market has no market maker.</li>
          <li><b>Whoever lists a market holds its keys.</b> The lister becomes admin, insurance operator and oracle authority: they can shut the market down, rotate its keys or withdraw its insurance. Traders have to trust them.</li>
          <li><b>Liquidity fragments.</b> If every listing is a separate market, three SOL markets means three thin books.</li>
          <li><b>A spread earns nothing.</b> Because trades settle at the mark, a classic spread-quoting market maker has no edge. The income is in the fees, which belong to whoever operates the asset.</li>
          <li><b>Filling at an oracle price invites front-running.</b> A market maker that fills immediately at the current oracle price can be traded against by anyone who sees the real price first.</li>
        </ol>

        <h2 id="frontrun">Front-running, solved</h2>
        <p><b>Who sees prices before Pyth?</b> Almost every professional trader:</p>
        <ul>
          <li><b>Traders watching the exchanges.</b> Pyth aggregates prices from exchanges and trading firms (Binance, OKX, Coinbase, Jane Street, Jump and others). Anyone connected to those venues sees a move before Pyth does.</li>
          <li><b>Pyth's publishers,</b> who know their own quotes before Pyth aggregates them.</li>
          <li><b>Anyone reading Pyth off-chain.</b> A new Pyth price exists on Pythnet and in Hermes, Pyth's price service, before anyone posts it on Solana, and posting is pull-based: the on-chain account is only as fresh as the last person who paid to update it. We measured Pyth's shared devnet account at 225 seconds old.</li>
          <li><b>Validators and searchers,</b> who see pending transactions, price updates included, and can put their own trades first.</li>
        </ul>
        <p>
          Before the router, the vault filled every trade immediately at Percolator's mark, which followed Pyth, so any of them could
          buy from it below the real price and sell to it above, and depositors paid. Now every trade is a request that fills at a
          price nobody could know when it was made (below). That is the problem this solves: <b>no one can trade against the vault
          at a price they already know, and no one can choose the price a trade fills at.</b>
        </p>

        <h2 id="design">Design</h2>
        <Diagram />
        <p>Turbopump is two on-chain programs, both ours. The <b>vault program</b> does four jobs at once:</p>
        <ul>
          <li><b>Market owner.</b> The vault's own address signs the listing, so the vault becomes the asset's admin, insurance operator, backing authority and oracle authority. The asset is listed in Percolator's authority-mark mode at a fresh, verified Pyth price, and the vault moves its mark only when the router asks, to a verified Pyth price. The program has no other instruction that uses those powers.</li>
          <li><b>Matcher.</b> The vault account doubles as the matcher context. When the router executes a trade against the vault's LP portfolio, Percolator calls the vault program, which returns a fill size within its caps. It only answers calls signed by Percolator's matcher delegate for this vault's own portfolio, and only for the one fill the router armed in that slot.</li>
          <li><b>Pool.</b> Depositors hold vault shares (an SPL token). Deposits and withdrawals queue during an epoch and settle together at one price.</li>
          <li><b>One market per asset.</b> The vault address is derived from <code>(market, Pyth feed)</code>. A second vault for the same feed cannot exist, so all liquidity for an asset is in one pool and every fill sees all of it.</li>
        </ul>
        <p>
          The <b>router program</b> (<code>{ROUTER.toBase58().slice(0, 4)}…</code>) is the only way to trade: it queues requests,
          moves each vault's mark to verified Pyth prices, and executes fills. Each trader's Percolator account is owned by a
          program address derived from their wallet; only the router can trade it, and withdrawals can only go back to that wallet.
        </p>

        <h2 id="fills">How trades fill</h2>
        <ol>
          <li><b>Request.</b> The trader queues a trade (a size; the fill is at the mark). It lands on chain and gets a target time: the later of the chain clock and the vault's current mark time, plus {ROUTER_DELAY_SECS} seconds, rounded up to the next {ROUTER_BATCH_SECS}-second mark. Rounding only adds wait; it means trades sent within the same {ROUTER_BATCH_SECS} seconds, on any market, share one price and fill together, which is what lets the platform fill many trades a second. The trader's margin is locked from now until it fills or expires, and the request is only accepted with enough margin to open at the asset's level (5% on BTC and ETH, 10% on the rest; see Market rules). If the price moves during the wait so that the account can no longer afford the trade, the fill trades nothing. It takes a small bond, and a deposit of 0.10% of the trade's value in the chain's coin, which comes back when the trade fills.</li>
          <li><b>The price.</b> It fills at exactly one price: the first Pyth price published at or after the target. Every Pyth update is signed with its publish time and the previous one's, so the router accepts only the update with <code>previous publish time &lt; target ≤ publish time</code>. Nobody could have known it when the request landed, and nobody can substitute another.</li>
          <li><b>The mark.</b> Executors move the vault's mark with verified Pyth updates, always forward in time. The router never moves it past a pending request's target: once that target has passed, the only update it accepts is the first one at or after it. Percolator's price then walks to the mark within its per-slot cap.</li>
          <li><b>Fill.</b> Once the mark is the request's price and Percolator's price has reached it, anyone can execute the fill, the trader included, and earns the bond. Who executes it, and when, does not change the price. The vault's matcher only accepts the fill the router armed for that slot and size, so there is no other way to trade against the vault.</li>
          <li><b>No backing out.</b> A request cannot be cancelled. If nobody fills it within {ROUTER_GRACE_SECS} seconds of its target it expires, nothing is traded, and its bond is forfeited. If its price had already become the mark by then, the deposit is kept too: letting an order lapse after seeing the price is not free.</li>
        </ol>
        <p>The router has no admin: no pause, no allow or block list, and its upgrade authority is to be burned before mainnet.</p>

        <h2 id="orders">Order types</h2>
        <p>
          A market order is the request described above. Everything else is a <b>standing order</b>: an instruction your wallet
          signs once and the router keeps in an account. When its condition holds, anyone can carry it out (the executors do),
          and carrying it out only queues an ordinary request. So every order type fills the same way a market order does, at
          the first oracle price after its target time, and none of them can be front-run. Conditions are checked against the
          vault's mark, which is itself a verified oracle price.
        </p>
        <table className="doc-table">
          <thead><tr><th>Order</th><th>What it does</th></tr></thead>
          <tbody>
            <tr><td>Market</td><td>Trades a size now. Fills {ROUTER_DELAY_SECS} seconds later at the oracle price: no spread and no price impact, whatever the size, up to what the vault can take.</td></tr>
            <tr><td>Limit</td><td>Trades once the mark is at your price or better, and only fills at a price no worse than it. If the price has moved away by the time it would fill, the order stays and waits.</td></tr>
            <tr><td>Stop loss</td><td>Closes a position, or part of it, once the mark is at or through your price against you.</td></tr>
            <tr><td>Take profit</td><td>The same in your favour.</td></tr>
            <tr><td>Trailing stop</td><td>A stop that follows the price: it closes once the mark has come back a chosen percentage (up to 50%) from the best price since you placed it.</td></tr>
            <tr><td>TWAP</td><td>Splits a size into equal slices and trades one every interval: 2 to 500 slices, at least 10 seconds apart. Each slice is its own request at its own oracle price.</td></tr>
          </tbody>
        </table>
        <ul>
          <li>Up to 8 standing orders per wallet on each market. Each can carry an expiry time, after which anyone may remove it.</li>
          <li>Stops, take-profits and trailing stops can only shrink a position. A limit or TWAP order can be marked reduce-only.</li>
          <li>An order can be cancelled at any time, except while a request it queued is waiting to fill.</li>
          <li>An order's trade passes the same margin check as any other. If the account is liquidated first, a limit or TWAP order keeps what it had left.</li>
        </ul>

        <h2 id="desk">The trading desk</h2>
        <ul>
          <li><b>Vault capacity instead of an order book.</b> There is no book: every trade fills at the oracle price against the vault. The panel shows the largest buy and sell the vault can take right now, its own position and its limit, and next to them what the vault can actually absorb: its value now, its insurance, and what it would lose on a 10%, 20% or 30% move against the position it holds. What it lets traders open and what it can afford to lose are not the same thing, and the panel shows both.</li>
          <li><b>Ticket.</b> Market, limit, take-profit and stop, and TWAP tabs; size in coin or dollars. <b>Leverage</b> is set per order, from 1× to the market's maximum (20× on BTC and ETH, 10× on the rest), and remembered per market: the 25%, 50%, 75% and Max buttons size the order from your free margin times that leverage, and the ticket shows the margin the order uses out of what is free. Against a position you hold, the buttons pick a share of it to close instead. Percolator itself only asks for the market's opening margin, so a lower leverage just uses less of what your account could open; the account's overall leverage and the estimated liquidation price (one margin account covers every market) are shown before you sign, with the fee and the position after.</li>
          <li><b>One account for every market.</b> Margin is shared across positions (cross-margin). Positions, open orders, trade history and market details sit under the chart.</li>
          <li><b>Profit and loss everywhere.</b> Each open position shows what it is up or down, with an arrow, in the positions table (with a total), on the chart (a line at its entry price labelled with the market, side, size and PnL) and in the account panel, which also shows today's result and the account's all-time PnL after fees. Trade history covers every market and shows what each trade booked when it reduced or closed a position, with the fees. Entry prices come from the wallet's own fills; a position whose opening trades are no longer on record shows "—" rather than a guess.</li>
          <li><b>Charts.</b> Candles from one minute to one day, technical indicators, drawing tools (trend lines, Fibonacci levels, measure, brush, notes), several charts side by side, a full-screen view, and the trades of the traders you follow marked on the candles.</li>
          <li><b>What other traders are doing, live.</b> The queue of trades waiting their {ROUTER_DELAY_SECS} to {ROUTER_DELAY_SECS + ROUTER_BATCH_SECS - 1} seconds for a price, each with a countdown and then its fill; every trade on the market as it happens; how traders lean, long against short, and how much of the vault's limit is used; a short notice when an account is being liquidated; and a "Whales" box on the chart that marks every trade above a chosen size with a bubble sized by its value. All of it is read from the router's own accounts, and our test bots are labelled.</li>
          <li><b>Earn.</b> Deposit into the market's vault, see what a share was worth at its last rolls, claim results.</li>
          <li><b>Burner wallet and faucet.</b> A test wallet kept in your browser and a button for test USDC, so anyone can try it without installing anything.</li>
        </ul>

        <h2 id="spot">Spot swaps on xDEX</h2>
        <p>
          The Spot tab buys and sells real tokens, not futures. The swap itself happens on <b>xDEX</b>, X1's exchange (a copy of
          Raydium's constant-product pools); Turbopump only routes it and takes its fee. The screen is laid out like the Trade page.
        </p>
        <ul>
          <li><b>How a swap works.</b> The router's <code>Swap</code> instruction takes the platform's 0.2% of what you pay in and sends it to the treasury, then hands the rest to xDEX's own swap. After the swap it checks what actually reached your wallet. If that is less than the minimum you accepted (your slippage setting: 0.5%, 1% or 3%), the whole transaction is undone and nothing is spent.</li>
          <li><b>What it costs.</b> The pool's own fee (0.25% to 0.3% on our pools, set by each pool) plus 0.2% to the platform. Example: swapping 100 USDC pays 0.20 USDC to the platform and about 0.30 USDC to the pool, and the rest buys tokens at the pool's price.</li>
          <li><b>Nothing is held.</b> Your wallet signs the swap and the tokens go straight to it. The router holds no tokens and signs nothing on your behalf. It works with plain SPL tokens and Token-2022 tokens; a token with a transfer fee or hook is refused.</li>
          <li><b>Coin to margin in one step.</b> Our own coin/USDC pool is listed first. From it you can swap the chain's coin (XNT or SOL) and put the USDC straight into your trading account in the same transaction.</li>
          <li><b>The screen.</b> Each pair has its own price chart (candles built from the pair's swaps on xDEX, the last one following the pool's live price), the day's figures, the pool's depth where an order book would be, the latest swaps, a Buy/Sell ticket, your own swaps, and every pair and pool below.</li>
        </ul>

        <h2 id="copy">Track records and copy trading</h2>
        <ul>
          <li><b>A record nobody can write but the router.</b> Once an account's track record is open, the router books every deposit and withdrawal in it, and the account's equity at every fill. Profit is equity now, minus equity when the record was opened, minus net deposits since. Profitable days, volume and the latest fills come from the same account. Nothing is self-reported.</li>
          <li><b>Names and badges.</b> A wallet can take a name (unique, 3 to 16 letters, digits or underscores) and a badge. Both live in an account of the router under that wallet. Taking a name costs 1 XNT (0.002 SOL on devnet), paid to the platform, and so does changing it; the badge and its colour are free.</li>
          <li><b>The featured row, 1 XNT a day.</b> A wallet with a name can pay to be shown in a row above the leaderboard for a day, marked as paid; paying again adds a day, up to thirty ahead. It changes where a trader is shown and nothing else: the figures are still the router's.</li>
          <li><b>The leaderboard.</b> Every record on the network, ranked by profit or return over 7 days, 30 days or all time, with profitable days, largest fall, volume and how many copy each trader.</li>
          <li><b>A badge picture, 10 XNT.</b> A wallet can pay to show a picture of its own instead of a shape (10 XNT on X1, 0.02 SOL on devnet, to the platform's treasury, each time a picture is saved). The page cuts it to a 64 by 64 JPEG and the router stores those bytes under the wallet: at most 2,048, only a JPEG, only that wallet can write them. The page never follows a link for a picture, decodes the bytes as a JPEG and nothing else, shows only a picture of exactly that size, and draws it again itself before it reaches the screen.</li>
          <li><b>Following.</b> A list of traders you watch. Their fills on a market are marked on your chart with their badge: under the candle for a buy, over it for a sell.</li>
          <li><b>Copying.</b> You sign once: keep my account at this trader's leverage on every market, times a ratio you choose, and never more than a limit per market. When they open, add, cut or close, anyone (the executors do) can queue the trade that brings you in line. The router computes its size from the two accounts; the caller cannot make it bigger or turn it round. It then fills like any order, at the first oracle price after its target time, so a copy can be front-run no more than a trade can.</li>
          <li><b>What a copy cannot do.</b> It cannot withdraw, and it cannot trade more than the margin rule allows. A trader you copy who loses loses your money too, in proportion: a good record is not a promise. Starting to copy a trader costs {COPY_FEE_TEXT}, once{LEADER_PAID ? ": half to the trader you copy, half to the platform" : ", paid to the platform"}; changing the terms is free. Each copy trade pays the usual {TRADE_FEE_PCT} fee; small differences (under 10% of the target) are left alone so you do not pay it on every tick. While you copy, positions you open yourself are brought back in line. Stop at any time: your positions stay as they are.</li>
        </ul>

        <h2 id="community">Contest, alerts and health</h2>
        <ul>
          <li><b>Weekly contest.</b> Every week, Monday 00:00 to Sunday 24:00 UTC, accounts are ranked by the dollars they made that week. To enter, an account needs at least 1,000 USDC in it, a track record at least 7 days old, and at least 5 trades in the week. The top five win 500, 250, 100, 50 and 50 USDC, paid by the platform after the week ends, once the winners have been checked. Wallets funded from the same wallet count as one person and win one prize at most. Ranking by dollars rather than percentage return means a prize takes real money at risk: many small accounts betting both ways cannot buy a winner. The standings are on the leaderboard and come from the router's track records, so nobody can fake them. Test bots are left out.</li>
          <li><b>First month's fees back.</b> A wallet in its first 30 days gets back the fees of trades it held at least 5 minutes, up to 50 USDC a week, paid weekly from a budget the platform sets aside. A trade opened and closed within 5 minutes is not refunded, and only one wallet per funder gets the refund, so it cannot be turned into free volume.</li>
          <li><b>Telegram alerts.</b> The Turbopump bot (<code>@Turbopump_bot</code>, linked on the leaderboard) sends a message when a wallet you watch gets a fill, when its margin is running thin, and when it is liquidated. Send it <code>/watch</code> and a wallet address. It only reads public accounts: it has no keys and cannot trade.</li>
          <li><b>Health page.</b> Shows where the money is, read live from the chain: what Percolator holds against what it owes, each vault's value and share price over the last 24 hours, its cash reserve, its margin, its loss cover, the platform's treasury, and how fresh each price is. Nothing on it is signed; everyone sees the same figures.</li>
        </ul>

        <h2 id="lifecycle">Market lifecycle</h2>
        <ol className="steps-doc">
          <li><b>Open.</b> Opening a market costs 10 XNT (0.02 SOL on devnet), paid once to the platform by whoever creates its vault. Markets can only be opened on the feeds on the program's list (on devnet: SOL, BTC, ETH, PYTH, DOGE, HYPE, gold and the euro; on X1: the crypto, metals and stocks its price service covers): a thin market whose price someone could push is not one the vault should quote. <code>InitVault</code> creates the vault, its share mint, buffer and escrow, and its Percolator LP portfolio, and approves the vault program as that portfolio's matcher. <code>ListAsset</code> then activates the asset and configures its Pyth feed. Anyone can call either; if someone creates a vault and never lists it, anyone else can finish.</li>
          <li><b>Deposit.</b> <code>RequestDeposit</code> moves collateral into the vault's buffer and records a ticket for the current epoch.</li>
          <li><b>Roll.</b> When an epoch ends and the LP portfolio is flat, <code>RollEpoch</code> (anyone) withdraws all capital from Percolator, prices every queued withdrawal and deposit, burns and mints shares, redeploys everything that is not owed, and renews the matcher approval.</li>
          <li><b>Claim.</b> Each depositor's <code>Claim</code> collects their shares or collateral from the settled epoch, pro rata from the epoch record.</li>
          <li><b>Trade.</b> Takers queue requests with the router; executors fill them at the first Pyth price at or after each request's target, with the vault as counterparty (see How trades fill).</li>
          <li><b>Harvest.</b> <code>HarvestFees</code> (anyone) moves insurance above the floor into the buffer; 5% is set aside for the opener and 10% is paid to the platform's treasury.</li>
          <li><b>Settle without stopping.</b> When an epoch ends, a flat vault is rolled by anyone. A vault holding a position is settled through the router: the settlement is queued and executes at the first Pyth price published after its target time, like a trade, so nobody can pick the price the vault is valued at. Withdrawals are paid from cash; the vault keeps 30% of its value outside Percolator for that (it was 10%, and vaults then went closing-only about once an hour). If the vault's margin inside Percolator falls below 40% of its value, anyone can call <code>TopUpMargin</code> to move cash in until it is back at 60%.</li>
          <li><b>Stay live.</b> If an epoch's withdrawals are larger than that cash, they can only be paid once the vault's position is closed. Anyone can then switch it to closing-only (<code>RequireFlat</code>). Those withdrawals pay a 0.5% exit fee, which stays in the vault for the depositors who remain, since they bear the cost of the market closing; ordinary withdrawals paid from cash pay nothing. If a taker holds a position so the vault can't get flat, <code>Unwind</code> (anyone, six epochs later) makes the vault close its own position through Percolator's unilateral <code>RebalanceReduce</code>. That scales down the positions on the other side, and Percolator then takes no new position on the market until all of them are closed; the vault cannot take the other side of a close there, so the router closes them out (<code>RequestClose</code>, which anyone can queue for any trader and which executes at the first Pyth price after its target, like any request). The market then resets and reopens.</li>
          <li><b>Liquidate early, and only as much as it takes.</b> An account whose equity falls below its positions' liquidation level (3.5% of notional on BTC and ETH, 12% on stocks, 6% on the rest) can be liquidated through the router by anyone: at the first Pyth price after the request's target, if the account is still below that level, part of its position is closed against the vault. Enough is closed to bring the account back to its opening margin plus 0.5%, at least a quarter of the position, and all of it if less than a tenth would be left. If the price keeps falling, anyone can liquidate it again. Percolator's own liquidation, at least one point lower, stays as the backstop; it would make the market close-only.</li>
          <li><b>Retire.</b> Once a market has had no liquidity providers for three epochs and holds no position, <code>RetireMarket</code> (anyone) pays its leftover insurance to the opener and has Percolator retire the asset. The next market opened reuses the slot, and the same feed can be opened again later.</li>
          <li><b>Wind down.</b> If the market is resolved, <code>SettleResolved</code> closes the portfolio through Percolator's resolved path; queued deposits are refunded, and shares redeem pro rata with <code>RedeemTerminal</code>.</li>
        </ol>

        <h2 id="rules">Market rules</h2>
        <p>Every market opened here runs on the same fixed template, so nobody can open a market set up to fail. The program ignores whatever parameters the opener sends.</p>
        <table className="doc-table">
          <tbody>
            <tr><td>Vault position limit</td><td>By the feed's tier: 3× the vault's value in notional on BTC and ETH, 1× on everything else. Ordinary trades may use 80% of it; the last 20% is kept for trades that close a trader's position, liquidations among them, so a liquidation is never refused because the vault is full.</td></tr>
            <tr><td>Most new exposure per fill</td><td>0.75× the vault's value on BTC and ETH, 0.25× on the rest, when the vault is flat; less the fuller it is on that side (half full: half as much; never under a tenth). The part of a fill that shrinks the vault's position is not limited.</td></tr>
            <tr><td>Value the limits use</td><td>The lower of the vault's value at its last roll and its value now (its equity in Percolator, read when each fill is armed): a vault that has lost since its last roll takes trades for what it is worth now.</td></tr>
            <tr><td>Epoch</td><td>{CANON_EPOCH_LEN_SLOTS.toLocaleString()} slots (about {Math.round(CANON_EPOCH_LEN_SLOTS * slotSeconds() / 60)} minutes at the current slot time) on devnet</td></tr>
            <tr><td>Insurance kept</td><td>100 USDC or a share of the vault's value, whichever is more: 3% on BTC and ETH, 8% on everything else, which moves more. Kept in insurance for traders; only fees above it are harvested.</td></tr>
            <tr><td>Cash reserve</td><td>30% of the vault's value kept outside Percolator to pay withdrawals; moved in as margin if the vault's margin falls below 40% of its value</td></tr>
            <tr><td>Price</td><td>Verified Pyth prices only, moved forward by the router; listing needs a price at most 300 seconds old. A price whose confidence interval (how far Pyth's publishers disagree) is wider than 1% of the price is refused, like a broken one: it neither fills a trade nor moves the mark.</td></tr>
            <tr><td>Execution</td><td>The first Pyth price published at or after the target: {ROUTER_DELAY_SECS} seconds after the request landed, rounded up to the next {ROUTER_BATCH_SECS}-second mark</td></tr>
            <tr><td>Leverage</td><td>Set per asset by the program from the price feed (<code>SetTier</code> records it; nobody chooses it). BTC and ETH: up to 20× (5% margin to open), liquidated below 3.5%. Stocks and the ETF (X1): up to 5× (20% to open), liquidated below 12%, because their price stands still while their exchange is closed and can jump at the open. Everything else: up to 10× (10% to open), liquidated below 6%. An asset whose tier is not recorded yet opens at the strictest level. Never looser than Percolator's own margins: liquidation stays at least 1 point above the engine's, and opening at least 1.5 points above that.</td></tr>
            <tr><td>Trade fee</td><td>{TRADE_FEE_PCT} per side, fixed by the program</td></tr>
            <tr><td>Opener's share</td><td>5% of harvested fees (a tenth of what traders pay), forever, with no other powers</td></tr>
            <tr><td>Matcher approval</td><td>216,000 slots (about {Math.round(216_000 * slotSeconds() / 3600)} hours), renewed at every roll; anyone can renew it with <code>RefreshMatcher</code></td></tr>
          </tbody>
        </table>
        <p>Because limits are multiples of NAV, an empty vault quotes nothing and every deposit makes the market deeper. Percolator's own margin checks apply on top.</p>

        <h2 id="pricing">Share pricing</h2>
        <p>Shares use ERC-4626-style virtual offsets so the first-depositor inflation attack loses money. At a roll, with <code>S</code> the share supply:</p>
        <pre>{`NAV_low  = buffer − owed − queued deposits           (collateral actually held)
NAV_high = NAV_low + booked-but-unreleased profit + 90% × unharvested fees

withdrawal:  assets = shares × (NAV_low + 1) / (S + 1000)          (rounded down, ≤ NAV_low)
deposit:     shares = assets × (S' + 1000) / (NAV_high' + 1)       (rounded down)`}</pre>
        <ul>
          <li>Withdrawals are priced low and deposits high, so neither side can take value from the other. Every rounding step goes against the party acting.</li>
          <li>Pricing only happens when the LP portfolio is proven flat, so there is no mark-to-market to game.</li>
          <li>If the vault has lost everything while shares exist, that epoch's deposits are refunded instead of priced.</li>
        </ul>

        <h2 id="funding">Funding</h2>
        <p>
          Funding is what the crowded side pays the other side for holding its positions, so that a one-sided market costs
          something to stay one-sided. Here it is paid every slot, inside Percolator, between every long and every short on the
          market, the vault included (it holds the other side of every trade).
        </p>
        {!FUNDING.on && (
          <p className="callout">
            <b>Switched off for now.</b> Funding ran for about an hour on 20 October and was switched off again because it stopped
            trades from filling. Percolator treats every funding payment like a price move: each one leaves every open position on
            the market out of date, and the market takes no new trade until all of them are brought up to date. With funding paid
            every slot, that never stops, so most orders failed. It is off on every market, on both networks, and nothing is
            charged or paid for holding a position.
          </p>
        )}
        {!FUNDING.on && (
          <p>
            <b>Why that is fine for now.</b> On other exchanges funding mainly keeps the perp's price close to the index. Here a
            trade always fills at the oracle price itself, so there is no gap to close: funding would only pay the vault for
            carrying a one-sided market. Until it is back, the vault's own limits do that job: a cap on its position (3× its value
            on BTC and ETH, 1× elsewhere), smaller fills the fuller it is on one side, and 20% of its limit kept for closes and
            liquidations (see Market rules). <b>What brings it back:</b> a change in Percolator so that a funding payment alone
            no longer blocks new trades (each position would take its funding when it is next settled, instead of every position
            having to be settled first). The rest is built and tested: the rate, its limits and the switch are on chain, and the
            design below is what will run.
          </p>
        )}
        <ul>
          <li><b>What sets the rate.</b> On other exchanges the rate comes from how far the perp's own price sits above or below the index. Here the trading price is the oracle price itself (that is what makes trades impossible to front-run), so that gap is always zero. The same pressure shows instead in the vault: when traders crowd one side, the vault holds the other, and how full it is against its limit says how one-sided the market is. Under a fifth of its limit used, nobody pays. From there the rate rises in a straight line, to {fmtPct(fundingHour(FUNDING.max))} an hour at the whole limit, about {fmtPct(fundingHour(FUNDING.max) * 24)} a day.</li>
          <li><b>Who pays.</b> The side the market is crowded on. If traders are mostly long (the vault short), longs pay shorts; if mostly short, shorts pay longs. The vault receives on its side like any position.</li>
          <li><b>How often.</b> Continuously: Percolator accrues it every slot on every open position, and it is settled into each account's value whenever the account is settled. There is no funding time to wait for or to dodge.</li>
          <li><b>Smoothing and limits.</b> The rate moves toward its target gradually, over about an hour: one large trade, or a whale opening and closing, cannot set it at once. Prices do not enter it at all, so a price spike changes nothing. The router never sets more than {fmtPct(fundingHour(FUNDING.max))} an hour, and Percolator refuses any rate above its market's cap ({fmtPct(fundingHour(FUNDING.cap))} an hour).</li>
          <li><b>Enforced on chain.</b> Funding is part of every position's value in Percolator's own accounts: it counts toward margin and liquidation like any loss, and what one side pays the other receives (each side's share is rounded against it, so the market is never short). The router sets the rate after each fill and anyone can step it along on a quiet market (<code>RefreshFunding</code>); Percolator applies a new rate only from the slot it is set at, never to time already passed.</li>
          <li><b>Where to see it.</b> The market bar shows the current rate, who pays and where it is heading (today it says "off"); once it is on, the order ticket also shows what the position after your order would pay, or receive, in a day at today's rate.</li>
          <li><b>Example.</b> A vault that is 60% full, short (traders net long), sets a target of half the maximum: about {fmtPct(fundingHour(FUNDING.max) / 2)} an hour. A $10,000 long then pays about ${fmt2(10_000 * fundingHour(FUNDING.max) / 2 * 24)} a day, which goes to the vault and to traders who are short.</li>
        </ul>

        <h2 id="fees">Fees and rebates</h2>
        <ul>
          <li>Every trade pays the market's fee ({TRADE_FEE_PCT}) on both sides into the asset's insurance. On a trade against the vault, the vault pays its side too, and gets both back when fees are harvested.</li>
          <li>Harvested fees above what insurance keeps (see Market rules) are split 85% to depositors (by raising the share price), 5% to the opener and 10% to the platform's treasury, which pays for price updates, re-valuations and liquidations. Half of what is harvested is the vault's own payments coming back, so of what traders paid, depositors keep 70%, the opener gets 10% and the platform 20% (claimable with <code>ClaimOpenerFees</code>).</li>
          <li>A vault worth less than 5,000 USDC at its last roll pays the platform nothing: its depositors keep that part too, so a new market's first providers earn the most.</li>
          <li><b>Volume rebates.</b> Paid weekly by the platform. A wallet that traded 100,000 USDC or more in the week gets {Math.round(REBATE.tiers[1].share * 100)}% of its own fees back, 1,000,000 or more {Math.round(REBATE.tiers[0].share * 100)}%, counted on fees that were not refunded already. Together they are never more than what the treasury took in that week, and they cost depositors and openers nothing.</li>
          <li><b>No referrals.</b> There were referral payments until 2026-10-20. They were removed: anyone could refer a second wallet of their own, and be paid on volume whose fees the first-month refund had already paid back.</li>
          <li><b>First month free.</b> A new wallet gets back the fees of trades it held at least 5 minutes, for its first 30 days, up to 50 USDC a week, from a separate budget the platform sets aside. One wallet per funder.</li>
          <li>The vault is the counterparty to traders, so its result is <b>fees + what traders lose − what traders win</b>. Fees are the compensation for that exposure. Each market's liquidity panel shows what a share was worth at its last rolls.</li>
        </ul>
        <p>Every fee in one place ({X1 ? "X1 testnet figures; Solana devnet in brackets" : "Solana devnet figures; X1 testnet in brackets"}):</p>
        <table className="doc-table">
          <thead><tr><th>What</th><th>Fee</th><th>Who gets it</th></tr></thead>
          <tbody>
            <tr><td>Each trade</td><td>{TRADE_FEE_PCT} of its value, each side</td><td>Depositors 70%, the market's opener 10%, the platform 20% (see above)</td></tr>
            <tr><td>Funding, while holding</td><td>{FUNDING.on ? <>0 to {fmtPct(fundingHour(FUNDING.max))} an hour of the position's value, by how one-sided the market is (see Funding)</> : <>None for now: switched off (see Funding)</>}</td><td>{FUNDING.on ? "Paid by the crowded side to the other side, the vault included" : "—"}</td></tr>
            <tr><td>Each spot swap</td><td>0.2% of what is paid in, on top of the pool's own fee</td><td>The platform</td></tr>
            <tr><td>Opening a market</td><td>{X1 ? "10 XNT (0.02 SOL)" : "0.02 SOL (10 XNT)"}, once</td><td>The platform</td></tr>
            <tr><td>Starting to copy a trader</td><td>{X1 ? "20 XNT (0.04 SOL)" : "0.04 SOL (20 XNT)"}, once</td><td>Half to the trader copied, half to the platform</td></tr>
            <tr><td>A name, or changing it</td><td>{X1 ? "1 XNT (0.002 SOL)" : "0.002 SOL (1 XNT)"}</td><td>The platform</td></tr>
            <tr><td>A day in the featured row</td><td>{X1 ? "1 XNT (0.002 SOL)" : "0.002 SOL (1 XNT)"}</td><td>The platform</td></tr>
            <tr><td>A badge picture</td><td>{X1 ? "10 XNT (0.02 SOL)" : "0.02 SOL (10 XNT)"}, each time one is saved</td><td>The platform</td></tr>
            <tr><td>A withdrawal that forces the vault to close its position</td><td>0.5%</td><td>The depositors who stay</td></tr>
            <tr><td>Bond per trade request</td><td>{X1 ? "0.02 XNT (0.002 SOL)" : "0.002 SOL (0.02 XNT)"}</td><td>Whoever fills it; kept if the request expires</td></tr>
            <tr><td>Deposit per trade request</td><td>0.10% of its value, in the chain's coin</td><td>Comes back when it fills; kept only if it expires after its price was known</td></tr>
          </tbody>
        </table>

        <h2 id="rails">Safety rails</h2>
        <p>Rules the router and vault enforce on top of the engine's own:</p>
        <ul>
          <li><b>Leverage and liquidation per asset.</b> BTC and ETH open at up to 20× and are liquidated below 3.5%; stocks open at up to 5× and are liquidated below 12%; everything else opens at up to 10× and is liquidated below 6%. The program decides the level from the price feed, so nobody can pick a looser one. A liquidation closes part of the account's position against the vault at the next oracle price, by anyone, as much as it takes to bring the account back to its opening margin. It sits above the engine's own level on purpose: the engine liquidates by cutting the other side's positions, which shuts the market until it is emptied. Closing against the vault first avoids that.</li>
          <li><b>Room kept for liquidations.</b> Ordinary trades can fill only 80% of the vault's position limit. The rest is for trades that close a trader's position, liquidations among them, so a liquidation is not refused because the vault has run out of room.</li>
          <li><b>Less for the crowded side.</b> A trade that adds to the vault's position gets a smaller fill the fuller the vault already is on that side. The more one-sided the market, the slower it can get more one-sided. (Funding would lean the same way with a payment from the crowded side; it is switched off for now, see Funding.)</li>
          <li><b>Limits from what the vault is worth now.</b> The vault's limits are worked out from the lower of its value at the last roll and its value now, so after a loss it takes smaller trades right away instead of at the next roll. The vault panel shows what it can absorb and what it would lose on a 10%, 20% or 30% move against its position.</li>
          <li><b>Only feeds deep enough to quote.</b> Markets can be opened on the program's list of feeds only, and a Pyth price whose publishers disagree by more than 1% is refused.</li>
          <li><b>Cash reserve and margin top-up.</b> The vault keeps 30% of its value as cash outside Percolator, so ordinary withdrawals are paid without closing its position. If its margin inside Percolator runs below 40% of its value, anyone can move cash back in up to 60% (<code>TopUpMargin</code>; the executor checks every 30 seconds).</li>
          <li><b>Loss cover.</b> Each vault can have a cover fund that the platform's treasury puts money into, so that a market's first depositors do not carry its first losses. After each roll, if a share is worth less than the highest it has been, the cover pays the difference for every share into the vault, as far as the fund goes. It pays once per roll, anyone can trigger it (the executor does right after each roll), and only the treasury can take money back out of it.</li>
          <li><b>A second price key on X1.</b> On X1 a reported price only moves the mark if the witness key has posted its own price for the market in the last 30 seconds and the two are within 1.5% of each other. One stolen or broken key cannot set a price alone. The two keys read different exchanges: the reporter reads Jack's oracle, then our price service on Coinbase, Kraken, OKX, Bybit and KuCoin; the witness reads a second copy of the service on Bitstamp, Gemini, Bitfinex and MEXC. Both still run on one server today.</li>
          <li><b>Places kept for liquidations.</b> The last four places in each market's queue cannot be taken by trades, and the fill of any request from an account below the liquidation level is a liquidation instead. A trader cannot stay ahead of a liquidation by keeping the queue full. The executor fills requests that share a price together, three to a transaction, so many liquidations in a crash do not wait one behind the other.</li>
          <li><b>Price band.</b> A new mark may differ from the one before it by at most 2% plus 0.5% for each second between the two prices. A broken feed or a wrong price is refused; a real move that large is accepted once enough time has passed.</li>
          <li><b>Orders that cannot fill do not block the market.</b> A request whose price the mark has held for 30 seconds without a fill can be removed, so the requests behind it, liquidations included, move on.</li>
          <li><b>Deposits freeze before a settlement.</b> Once an epoch's settlement is queued, the vault takes no new deposit or withdrawal for that epoch, because the settlement price is public seconds before it executes.</li>
          <li><b>One fee for every market.</b> The trade fee is a constant of the program ({TRADE_FEE_PCT}); anyone can set a market back to it, and nobody can set anything else.</li>
          <li><b>Leftovers are swept.</b> Money left behind by expired requests can be sent to the treasury by anyone; it cannot go anywhere else.</li>
        </ul>
        <p><b>When a price moves fast, in order.</b> What happens to an account that cannot cover its positions, and who pays when it cannot pay:</p>
        <ol>
          <li><b>Partial liquidation.</b> Below its liquidation level, the account is closed against the vault at the next oracle price, as much as it takes, by anyone. There is no order book to push through, so this does not move the price and set off more liquidations.</li>
          <li><b>Again, if needed.</b> If the price keeps going, the account is liquidated again from what is left.</li>
          <li><b>Insurance.</b> If a gap takes an account past zero before it is closed, the loss it cannot pay comes out of its market's insurance (see Market rules for how much each keeps).</li>
          <li><b>The vault.</b> Beyond insurance, the vault, which was the account's counterparty, is not paid what it won; its depositors carry that.</li>
          <li><b>Loss cover.</b> If that lowers the share price below its high, the vault's loss cover pays the difference back after the next roll, as far as its fund goes.</li>
          <li><b>Auto-deleveraging, last.</b> If the router cannot close an account in time (the price fell too fast, or the vault had no room left on that side to take the close) and it reaches Percolator's own maintenance margin, the executor has Percolator liquidate it itself (a crank of the up-to-date account, which anyone may send). Percolator closes it and scales down positions on the other side to match (auto-deleveraging). The market then takes only closing trades until every position on it is closed, and reopens.</li>
        </ol>

        <h2 id="risks">Risks</h2>
        <ul>
          <li><b>Directional.</b> If traders win overall, depositors lose. Caps bound the vault's exposure to 3× its value on BTC and ETH and 1× elsewhere: on BTC a 33% move against a full vault would cost it all of its value; on the rest that takes a move of 100%.</li>
          <li><b>Chain clock.</b> A request's target comes from the chain clock (or the mark time, if later). The {ROUTER_DELAY_SECS}-second delay assumes the clock does not run more than a few seconds behind real time; Solana's clock normally tracks it within a second or two.</li>
          <li><b>A request that cannot fill.</b> If a request cannot fill (for example because the price moved during the wait and the account can no longer afford it), the mark waits at its price until it expires, at most {ROUTER_GRACE_SECS} seconds, before moving on. The requester loses the bond; liquidations on that market wait that long.</li>
          <li><b>Executors.</b> Filling needs someone to fetch each target-time Pyth update from Hermes (which needs a Pyth API key; the free plan covers every market listed here) and send the transactions. Keeping marks fresh between trades uses Pyth's free sponsored feed accounts. Anyone with a key can run an executor; if nobody does, requests expire and nothing trades.</li>
          <li><b>Market authority.</b> On devnet, Percolator's market-level authority belongs to the vault program's governor address, which the program only uses to retire idle markets. Nobody can shut an asset down or resolve the market, and permissionless stale resolution is off. On another market, whoever holds that authority can shut assets down or resolve the market; the vault then winds down and pays out.</li>
          <li><b>Smart contracts.</b> Unaudited code. The program is upgradeable on devnet; a mainnet deployment must burn that authority.</li>
          <li><b>Keepers.</b> Everything is permissionless, but someone has to send the transactions. If nobody does, epochs don't roll and prices don't update.</li>
          <li><b>Margin stays in while you hold a position.</b> Percolator pays margin out only from an account with no open position on any market, so a trader closes everything before withdrawing. A queued trade must leave enough margin to open at the asset's level; a trade that only reduces a position is always accepted.</li>
          <li><b>Spot swaps go through xDEX.</b> The router checks what reaches your wallet, but the pool's price and its own fee are xDEX's. A thin pool moves a lot on a large swap; the ticket shows the price impact before you sign.</li>
          <li><b>The loss cover is limited.</b> It pays only as far as the money in it goes, and the treasury can take that money back out. It is a cushion, not a promise.</li>
          <li><b>Fallback prices are trusted.</b> If Pyth has not served a queued trade 20 seconds after its target, a reporter key may post the price from an exchange-median price service instead, so trades survive an outage of Pyth's API. Nothing on chain can verify that price. Anyone posting the Pyth price within those 20 seconds keeps the fallback out.</li>
          <li><b>Funding follows the vault, not a perp price.</b> There is no separate perp price to compare with the index here (that is what stops front-running), so the rate is set from how one-sided the vault is (see Funding). It is a measure of crowding, bounded and smoothed, and it cannot follow a price spike, because prices do not enter it. While funding is switched off (it is now), the vault carries any imbalance for the fees alone.</li>
          <li><b>An unwind closes the market out.</b> If withdrawals larger than the vault's cash reserve have waited six further epochs and the vault still holds a position, the vault closes it unilaterally. Traders on the other side are scaled down, and the positions left on that market are closed out at the next Pyth price before it reopens. A trader can have a position closed this way without choosing to.</li>
          <li><b>Cost per position.</b> Each price move leaves every open position on that asset out of date until it is cranked, and Percolator takes no new position on the asset until all of them are. The executor does this once per round for every trade in it (see Keepers and executors), but a round still costs more, and takes longer, the more positions are open.</li>
          <li><b>Percolator fixes.</b> Devnet runs our Percolator integration branch, which includes fixes not yet merged upstream, among them the one that makes permissionless listing work while traders hold open positions (<a href="https://github.com/aeyakovenko/percolator-prog/pull/447" target="_blank" rel="noreferrer">percolator-prog #447</a>).</li>
        </ul>

        <h2 id="security">Security model</h2>
        <table className="doc-table">
          <thead><tr><th>Party</th><th>Can</th><th>Cannot</th></tr></thead>
          <tbody>
            <tr><td>Opener</td><td>Pick the feed; claim 5% of harvested fees</td><td>Choose any parameter; open a second market for a feed; move funds; pause</td></tr>
            <tr><td>Depositors</td><td>Queue deposits and withdrawals, claim, redeem after wind-down</td><td>Affect other depositors' prices</td></tr>
            <tr><td>Anyone</td><td>Roll, harvest, convert, renew, unwind, settle, sweep, retire an idle market</td><td>Choose amounts or destinations: value only moves into the vault's own accounts, or to the opener when a market is retired</td></tr>
            <tr><td>Traders</td><td>Queue trades through the router; move margin in, and out to their own wallet</td><td>Trade at a price they know, cancel a queued trade, withdraw while one is queued, trade against the vault any other way, or lock withdrawals</td></tr>
            <tr><td>Executors (anyone)</td><td>Move a mark to a newer verified Pyth price; fill a request at its price and earn its bond; expire late requests</td><td>Choose a fill price, move the mark past a pending request's price or backwards, or fill early</td></tr>
            <tr><td>Governor (program address)</td><td>Retire an idle, empty market through <code>RetireMarket</code></td><td>Anything else: the program has no other instruction that uses Percolator's market authority</td></tr>
          </tbody>
        </table>
        <p>The programs are tested against the production Percolator binary (and, for swaps, the real xDEX binaries) in LiteSVM, with 142 tests:</p>
        <ul>
          <li><b>Front-running</b>: a trader who knows the price in advance ends flat; the fill is exactly the first Pyth price at or after the target; no later or skipped update can move the mark; nobody can push a newer price over a pending request; the executor's identity and timing do not change the fill; direct trades, forged or unverified Pyth accounts and non-router mark moves are refused.</li>
          <li><b>Requests</b>: no cancelling, no withdrawing while queued, expiry only after the grace period with the bond forfeited, stressed margin check, withdrawals only to the owner's wallet.</li>
          <li><b>Orders</b>: each order type triggers only when its condition holds, a limit never fills worse than its price, a trailing stop follows the best price, TWAP slices come no sooner than their interval, reduce-only orders cannot grow a position, and an order cannot be used to skip the margin check.</li>
          <li><b>Track records and copying</b>: profit is booked by the router and cannot be written by the trader; a copy's size comes from the two accounts and the caller cannot enlarge or reverse it; a copy trade is an ordinary request with the same margin check.</li>
          <li><b>Risk limits</b>: a liquidation closes only what brings the account back above its opening margin, and the rest at a later fall; ordinary trades stop at 80% of the vault's limit while closes may use all of it; fills that add to a crowded side shrink as the vault fills; each tier's limits; an asset without a recorded tier opens at the strictest level; a feed not on the list cannot be opened; a Pyth price with a confidence interval over 1% is refused.</li>
          <li><b>Reported prices</b>: on the X1 build only the reporter and the witness post, a stale report cannot list a market, a price the witness disagrees with does not move the mark, and a trade fills at the first reported price after its target and nothing else.</li>
          <li><b>Swaps</b>: against copies of real xDEX pools on both builds, the platform's fee is exactly 0.2% rounded up, the wallet receives exactly what the quote says, a swap below the minimum is undone, and only xDEX's own program can be called.</li>
          <li><b>Loss cover</b>: it pays a fall below the highest share price once per roll, never twice for the same roll, and only the treasury can withdraw from it.</li>
          <li><b>Property tests</b>: withdrawals never exceed NAV, deposit-then-withdraw never profits, incumbents are never diluted, fills never break the caps.</li>
          <li><b>Layout tests</b>: every account offset and every Percolator instruction encoding is checked against Percolator's own types and decoder.</li>
          <li><b>Flows</b>: open, deposit, trade, roll, withdraw; fee harvest and the opener's share; gains and losses reaching depositors exactly; maintenance fees; market resolution with everyone paid out; one vault per feed; caps scaling with NAV; retiring an idle market and reopening its feed in the freed slot.</li>
          <li><b>Attacks</b>: forged matcher calls, a foreign LP routing fills through the vault, inventory caps, rolling while not flat, reduce-only enforcement, matcher expiry and renewal, early, doubled, stolen and forged claims, fake buffers, donations, the inflation attack, bad parameters, double listing, sweeps, and a trader holding a position to lock withdrawals.</li>
        </ul>

        <h2 id="instructions">Instruction reference</h2>
        <table className="doc-table">
          <thead><tr><th>Tag</th><th>Instruction</th><th>Who</th><th>Effect</th></tr></thead>
          <tbody>
            <tr><td>0</td><td>matcher call</td><td>Percolator only</td><td>Sizes the fill the router armed, during its <code>TradeCpi</code></td></tr>
            <tr><td>16</td><td>InitVault</td><td>anyone</td><td>Creates the canonical vault for a feed on the program's list, and its accounts</td></tr>
            <tr><td>26</td><td>ListAsset</td><td>anyone</td><td>Lists the vault's asset in authority-mark mode at a fresh, verified Pyth price</td></tr>
            <tr><td>17 / 18</td><td>RequestDeposit / RequestWithdraw</td><td>depositor</td><td>Queues a request for the current epoch</td></tr>
            <tr><td>19</td><td>RollEpoch</td><td>anyone</td><td>Settles the epoch while flat and redeploys capital</td></tr>
            <tr><td>20</td><td>Claim</td><td>depositor</td><td>Collects shares or collateral from a settled epoch</td></tr>
            <tr><td>27</td><td>HarvestFees</td><td>anyone</td><td>Moves insurance above the floor into the vault</td></tr>
            <tr><td>29</td><td>ClaimOpenerFees</td><td>opener</td><td>Collects the opener's accrued 5%</td></tr>
            <tr><td>22</td><td>ConvertPnl</td><td>anyone</td><td>Turns released profit into withdrawable capital</td></tr>
            <tr><td>21</td><td>RefreshMatcher</td><td>anyone</td><td>Renews the time-limited matcher approval</td></tr>
            <tr><td>28</td><td>Unwind</td><td>anyone</td><td>Liveness backstop once <code>RequireFlat</code> has applied for six epochs: the vault closes its own position</td></tr>
            <tr><td>34</td><td>SyncInventory</td><td>anyone</td><td>Re-reads the vault's position from Percolator after it changed outside a fill</td></tr>
            <tr><td>35</td><td>RequireFlat</td><td>anyone</td><td>Closing-only when an overdue epoch's withdrawals exceed the vault's cash</td></tr>
            <tr><td>23 / 24</td><td>SettleResolved / RedeemTerminal</td><td>anyone / holder</td><td>Wind-down after market resolution</td></tr>
            <tr><td>25</td><td>Sweep</td><td>anyone</td><td>Moves stray vault-owned collateral into the buffer</td></tr>
            <tr><td>31</td><td>RetireMarket</td><td>anyone</td><td>Frees the slot of an idle market (no shares, no requests, no position, listed 3+ epochs ago); leftover insurance goes to the opener</td></tr>
            <tr><td>30</td><td>AcceptGovernance</td><td>market authority</td><td>One-time: hands Percolator's market authority to the program's governor address</td></tr>
            <tr><td>32</td><td>PushMark</td><td>router only</td><td>Moves the asset's mark (the router passes only verified Pyth prices)</td></tr>
            <tr><td>33</td><td>ArmFill</td><td>router only</td><td>Arms the one fill the matcher accepts in this slot, with the vault's value now read from its Percolator account</td></tr>
            <tr><td>36</td><td>FreezeRequests</td><td>router only</td><td>Stops new deposit and withdrawal requests while an epoch's settlement is queued</td></tr>
            <tr><td>37</td><td>SetTradeFee</td><td>anyone</td><td>Sets a market's trade fee to the program's constant ({TRADE_FEE_PCT})</td></tr>
            <tr><td>38</td><td>TopUpMargin</td><td>anyone</td><td>Moves the cash reserve into the vault's Percolator margin when that margin is under 40% of its value, up to 60%</td></tr>
            <tr><td>39</td><td>InitCover</td><td>anyone, once per vault</td><td>Creates the vault's loss cover and its fund</td></tr>
            <tr><td>40</td><td>CoverLoss</td><td>anyone</td><td>After a roll, pays a fall of the share price below its high from the cover into the vault, once per roll</td></tr>
            <tr><td>41</td><td>WithdrawCover</td><td>the treasury</td><td>Takes money back out of a vault's cover</td></tr>
            <tr><td>42</td><td>PushFunding</td><td>router only</td><td>Sets the funding rate of the vault's asset in Percolator (the vault is the asset's oracle authority)</td></tr>
            <tr><td>43</td><td>SetFundingCap</td><td>anyone</td><td>Turns funding on for a governed market: its cap set to the program's constant, nothing else</td></tr>
          </tbody>
        </table>
        <p>Router program (trading, orders, records):</p>
        <table className="doc-table">
          <thead><tr><th>Tag</th><th>Instruction</th><th>Who</th><th>Effect</th></tr></thead>
          <tbody>
            <tr><td>0</td><td>OpenAccount</td><td>trader</td><td>Creates the trader's router account, Percolator portfolio and collateral account</td></tr>
            <tr><td>1 / 2</td><td>Deposit / Withdraw</td><td>trader</td><td>Margin in; margin out to the trader's own wallet (not while a request is queued)</td></tr>
            <tr><td>3</td><td>OpenBook</td><td>anyone</td><td>Creates a vault's queue of requests</td></tr>
            <tr><td>4</td><td>Request</td><td>trader</td><td>Queues a trade and fixes its target time</td></tr>
            <tr><td>5</td><td>Advance</td><td>anyone</td><td>Moves a vault's mark to a newer verified Pyth price, never past a pending target</td></tr>
            <tr><td>6</td><td>Fill</td><td>anyone</td><td>Fills a request at its price; pays the executor the bond</td></tr>
            <tr><td>7</td><td>Expire</td><td>anyone</td><td>Removes a request unfilled {ROUTER_GRACE_SECS} s after its target; the bond is forfeited</td></tr>
            <tr><td>8</td><td>RequestClose</td><td>anyone, for any trader</td><td>Queues a forced close: a close-out on a close-only market, or the (partial) liquidation of an account below its liquidation level</td></tr>
            <tr><td>9</td><td>RequestSettle</td><td>anyone</td><td>Queues the settlement of a vault's epoch at the first Pyth price after its target</td></tr>
            <tr><td>10</td><td>Settle</td><td>anyone</td><td>Rolls the vault's epoch at that price, with its position open</td></tr>
            <tr><td>11</td><td>PostPrice</td><td>the reporter key</td><td>Writes a reported (unverified) price for a feed; usable only as described under Risks</td></tr>
            <tr><td>12 / 13</td><td>PlaceOrder / CancelOrder</td><td>trader</td><td>Creates or removes a standing order: stop, take profit, trailing stop, limit or TWAP</td></tr>
            <tr><td>14</td><td>TriggerOrder</td><td>anyone</td><td>Queues the trade of an order whose condition holds (or removes an expired one)</td></tr>
            <tr><td>15</td><td>OpenStats</td><td>anyone, for any trader</td><td>Opens an account's track record, starting from its equity now</td></tr>
            <tr><td>16</td><td>SetProfile</td><td>wallet</td><td>A unique name and a badge</td></tr>
            <tr><td>17 / 18</td><td>Follow / Unfollow</td><td>wallet</td><td>The list of traders a wallet watches; moves no money</td></tr>
            <tr><td>19 / 20</td><td>SetCopy / StopCopy</td><td>follower</td><td>Signs once to mirror one trader's leverage (times a ratio up to 3×, within a limit per market); stopping leaves positions as they are</td></tr>
            <tr><td>21</td><td>TriggerCopy</td><td>anyone, for any follower</td><td>Queues the trade that brings a follower in line with the trader it copies</td></tr>
            <tr><td>22</td><td>ConvertPnl</td><td>anyone</td><td>Turns a trader's released profit into withdrawable margin</td></tr>
            <tr><td>23</td><td>Sweep</td><td>anyone</td><td>Sends what expired requests left in a queue to the treasury</td></tr>
            <tr><td>24</td><td>SetReferrer</td><td>wallet, once</td><td>Records who invited the wallet. No longer used: referrals were removed and nothing reads it</td></tr>
            <tr><td>25 / 26 / 27</td><td>SetBadgeImage / WriteBadgeImage / RemoveBadgeImage</td><td>wallet</td><td>Pays for, writes and removes the wallet's 64 by 64 JPEG badge picture</td></tr>
            <tr><td>28</td><td>Feature</td><td>wallet with a name</td><td>One more day in the leaderboard's featured row, up to thirty ahead</td></tr>
            <tr><td>29</td><td>SetTier</td><td>anyone</td><td>Records an asset's leverage tier, which the router decides from its price feed</td></tr>
            <tr><td>30</td><td>Swap</td><td>wallet</td><td>Takes the platform's 0.2%, swaps the rest on xDEX, and checks what arrived against the wallet's minimum</td></tr>
            <tr><td>31</td><td>RefreshFunding</td><td>anyone</td><td>Moves a market's funding rate a step toward its target (a fill does the same step itself); acts only on an asset accrued to the current slot</td></tr>
          </tbody>
        </table>

        <h2 id="keeper">Keepers and executors</h2>
        <p>
          Nothing needs a trusted operator, but someone has to send maintenance transactions. The reference keeper
          (<code>cargo run --example devnet --features devnet -- keeper</code>) discovers every vault of the program and, for each:
          keeps its asset's price accrual current (each crank advances it by at most 10 slots; idle markets are kept within 40
          slots so their first trade can catch up), settles positions left out of date by a price move, harvests fees above the
          floor, converts released profit, rolls the epoch when it ends, calls <code>Unwind</code> if an epoch is overdue by a
          full epoch, and retires idle markets. Anyone can run another one.
        </p>
        <p>
          The executor (<code>app/scripts/executor.ts</code>) runs the router. When a queued trade's target time has passed, it
          fetches the first Pyth update at or after it from Hermes, posts it and moves the vault's mark to it, then fills the
          trade; between trades it keeps the mark on Pyth's free sponsored feed account. It also carries out standing orders whose
          condition holds, queues copy trades, liquidates accounts below their liquidation level, settles epochs, expires late
          requests, and every 30 seconds applies loss covers and margin top-ups. On X1 a separate script
          (<code>app/scripts/witness.ts</code>) posts the witness's prices. It needs
          a Pyth API key; the free plan covers every market listed here, and it makes only a few Hermes requests per trade.
          Anyone can run one; the program checks everything, and each fill pays its executor the request's bond.
        </p>
        <p>
          A fill is more than one instruction. Percolator takes a new position on an asset only when that asset is accrued to
          the current slot and every position on it is settled, and each price move leaves every position on the asset out of
          date. So the executor puts the cranks that fix this in front of each fill: they bring every asset the traders involved
          hold up to the current slot (which also walks Percolator's price to the mark), then settle each of those accounts.
          The number of cranks depends on the slot the transaction lands in, and a crank with nothing to do fails, so two
          versions are sent, one crank apart; only the matching one can succeed, and the request fills once. When the last
          position on one side of a market closes, Percolator parks that side until anyone finalizes the reset; the executor
          does that too.
        </p>
        <p>
          <b>Many trades at once.</b> Trade targets fall on a shared {ROUTER_BATCH_SECS}-second grid, so every trade sent in the
          same window, on every market, fills at the same price. The executor works in rounds: it moves every market that has a
          trade due to its target price at once, brings every account those moves left out of date up to date once (losses
          before gains), and then fills each market's trades side by side, several to a transaction. One round of re-valuing the
          accounts serves all the trades in it, instead of one round per trade. In a load test on a local copy of the chain
          (October 2026) this took the platform from under one fill a second, with trades expiring from three a second, to
          about nine fills a second with 240 accounts holding positions, a typical wait of six to eight seconds from sending a
          trade to its fill, and none expiring at any rate tried (up to 24 a second). What still limits it is that each round
          re-values every open account on a market whose price moved, so a round takes longer the more positions are open.
          Above about eight trades a second on three markets, each market's queue (28 places for trades) fills up and further
          trades are turned away at once, without cost, rather than kept waiting.
        </p>

        <h2 id="integrate">Integrating</h2>
        <p>
          Trading goes through the router: <code>OpenAccount</code> once, <code>Deposit</code> margin, then <code>Request</code> a
          size against a vault. The request fills a few seconds later, at the first Pyth price published at or after its target;
          nothing needs to be signed after the request. Calling Percolator's <code>TradeCpi</code> against a vault directly is
          refused by its matcher.
        </p>
        <p>
          The addresses and layouts are exported as <code>app/src/layout.json</code>. The TypeScript builders in
          <code>app/src/chain.ts</code> and the Rust builders in <code>src/client.rs</code> and <code>router/src/client.rs</code>
          cover every instruction.
        </p>

        <h2 id="networks">Two test networks</h2>
        <p>The switch at the top right chooses which deployment this site shows. The programs are the same on both.</p>
        <table className="doc-table">
          <thead><tr><th></th><th>Solana devnet</th><th>X1 testnet</th></tr></thead>
          <tbody>
            <tr><td>Prices</td><td>Pyth, verified on chain; a reported price only as a fallback after 20 seconds</td><td>X1 has no Pyth: every price is posted by the router's reporter key from an exchange-median service, and only used if the witness key agrees within 1.5%; the two keys are trusted</td></tr>
            <tr><td>Spot swaps</td><td>xDEX on devnet</td><td>xDEX on X1 testnet</td></tr>
            <tr><td>Collateral</td><td>Test USDC</td><td>Test USDC</td></tr>
            <tr><td>Fees and rent paid in</td><td>Devnet SOL</td><td>Test XNT</td></tr>
            <tr><td>Bond per request</td><td>0.002 SOL</td><td>0.02 XNT: on X1 a transaction pays for the compute it asks for, so the bond covers what a fill costs</td></tr>
          </tbody>
        </table>

        <h2 id="addresses">Addresses on {X1 ? "X1 testnet" : "Solana devnet"}</h2>
        <table className="doc-table">
          <tbody>
            <tr><td>Vault program</td><td><A k={M.vault_program} /></td></tr>
            <tr><td>Router program</td><td><A k={ROUTER.toBase58()} /></td></tr>
            <tr><td>Percolator program</td><td><A k={M.percolator_program} /></td></tr>
            <tr><td>Market</td><td><A k={M.market} /></td></tr>
            <tr><td>Test USDC</td><td><A k={M.collateral_mint} /></td></tr>
          </tbody>
        </table>
        <p className="muted small">The Percolator program was deployed from the exact build the vault is tested against (engine 6de466b, program 27d758ed on the integration branch). The market's authority is the vault program's governor address.</p>

        <h2 id="mainnet">Path to mainnet</h2>
        <ol>
          <li>Build against the final, audited Percolator program ID (a compile-time constant; the devnet build already swaps it).</li>
          <li>Create a market with permissionless listing enabled and hand its market authority to the governor with <code>AcceptGovernance</code>, or list into an existing market (whose authority then keeps its powers).</li>
          <li>Run executors with Hermes access, and burn the router's upgrade authority along with the vault's.</li>
          <li>Audit the vault program, then burn its upgrade authority (or put it behind a public timelock).</li>
          <li>Set mainnet template values (for example one-hour epochs) and a real collateral with its freeze authority revoked.</li>
          <li>Run redundant keepers and a Pyth price pusher.</li>
        </ol>

        <h2 id="faq">FAQ</h2>
        <dl className="faq">
          <dt>Why does a trade fill at the mark, not at a quoted price?</dt>
          <dd>That is how Percolator v16 works: the matcher's price only sizes fees. The vault earns from fees and from traders' losses, not from a spread.</dd>
          <dt>Is Turbopump part of Percolator?</dt>
          <dd>No. Percolator is the risk engine by Anatoly Yakovenko, and Turbopump calls it. The vault and router programs, the order types, copy trading, the services and this site are Turbopump's own work.</dd>
          <dt>Can a limit or stop order be front-run?</dt>
          <dd>No more than a market order. Carrying out an order only queues a request, and that request fills at the first oracle price after its target time, which nobody knows when it is queued.</dd>
          <dt>Why does my trade take a few seconds?</dt>
          <dd>It fills at the first Pyth price published {ROUTER_DELAY_SECS} seconds after your request landed. That wait is what makes the price one nobody, including you, could know in advance, so nobody can trade against the vault, or against you, ahead of it.</dd>
          <dt>Why do deposits wait for the epoch?</dt>
          <dd>Percolator only lets a portfolio withdraw when it holds no position. Settling everyone together at a flat point means nobody can buy or sell shares at a stale price.</dd>
          <dt>Can the same pair be listed twice?</dt>
          <dd>Not through this program: the vault address is derived from the feed, so the second attempt fails on-chain.</dd>
          <dt>What stops someone from blocking withdrawals by holding a position?</dt>
          <dd>Reduce-only quoting after the epoch, then <code>Unwind</code>, which lets anyone make the vault close its own position six epochs later.</dd>
          <dt>Who pays for maintenance?</dt>
          <dd>Whoever sends it. Each transaction costs a network fee only; a roll also pays a small rent for the epoch record.</dd>
          <dt>Why does a swap here cost 0.2% more than on xDEX directly?</dt>
          <dd>That 0.2% is the platform's fee, taken on chain by the router. In return the swap sits on the same screen as your trading account, and coin can go straight into margin in one transaction.</dd>
          <dt>Is the vault solvent right now?</dt>
          <dd>See the Health page: it reads what Percolator holds against what it owes, and each vault's cash, margin and loss cover, live from the chain.</dd>
          <dt>What is the "Devnet Burner" wallet?</dt>
          <dd>A key stored in your browser so you can try the app without installing a wallet. Devnet only; never use it for real funds.</dd>
        </dl>
      </article>
    </main>
  );
}
