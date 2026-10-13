import { MANIFEST as M } from "./chain";
import { CANON_EPOCH_LEN_SLOTS, ROUTER, ROUTER_DELAY_SECS, ROUTER_GRACE_SECS, X1, slotSeconds } from "./chain";

const ex = (k: string) => (X1 ? `https://explorer.testnet.x1.xyz/address/${k}` : `https://explorer.solana.com/address/${k}?cluster=devnet`);
const A = ({ k }: { k: string }) => <a className="mono" href={ex(k)} target="_blank" rel="noreferrer">{k}</a>;

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
  ["copy", "Track records and copy trading"],
  ["lifecycle", "Market lifecycle"],
  ["rules", "Market rules"],
  ["pricing", "Share pricing"],
  ["fees", "Fees, rebates and referrals"],
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
            its target time, but that price is the reporter's word and nothing on chain can check it: whoever holds the reporter key is
            trusted for prices. Markets cover crypto, stocks and metals; stocks only have a price while their exchanges are open, and a
            trade queued outside those hours expires. Collateral is a test USDC; fees and rent are paid in test XNT.
          </p>
        )}
        <p className="lead">
          Turbopump is a perpetual-futures exchange that anyone can add a market to and nobody controls. It is built on
          Percolator, Anatoly Yakovenko's risk engine, and adds everything an exchange needs around it: markets that own their
          own keys, a shared liquidity vault for each asset, trading that cannot be front-run, limit, stop, take-profit,
          trailing and TWAP orders, track records and copy trading written by the program itself, and a trading desk to use it
          all from. Every trade fills at the first oracle price published {ROUTER_DELAY_SECS} seconds after it was requested,
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
          <li><b>Fees with a purpose</b>: an opener's share, a platform share that small vaults do not pay, volume rebates and referrals.</li>
          <li><b>Safety rails</b>: a price band, deposits and bonds that make abandoned orders cost something, places in the queue kept for liquidations.</li>
          <li><b>A second price source and a second network</b>: reported prices as a fallback for Pyth, and a full deployment on X1, which has no Pyth.</li>
          <li><b>The services</b>: a keeper and an executor that anyone can run, on free price data and public RPC.</li>
          <li><b>The trading desk</b>: this site, with charts, drawing tools, indicators and several charts side by side.</li>
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
          <li><b>Request.</b> The trader queues a trade (a size; the fill is at the mark). It lands on chain and gets a target time: the later of the chain clock and the vault's current mark time, plus {ROUTER_DELAY_SECS} seconds. The trader's margin is locked from now until it fills or expires, and the request is only accepted with enough margin for a further 10% price move. It takes a small bond, and a deposit of 0.10% of the trade's value in the chain's coin, which comes back when the trade fills.</li>
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
          <li><b>Vault capacity instead of an order book.</b> There is no book: every trade fills at the oracle price against the vault. The panel shows the largest buy and sell the vault can take right now, its own position and its limit.</li>
          <li><b>Ticket.</b> Market, limit, take-profit and stop, and TWAP tabs; size in coin or dollars; a leverage slider for the whole account; the fee, margin used, position after and estimated liquidation price before you sign.</li>
          <li><b>One account for every market.</b> Margin is shared across positions (cross-margin). Positions, open orders, trade history and market details sit under the chart.</li>
          <li><b>Charts.</b> Candles from one minute to one day, technical indicators, drawing tools (trend lines, Fibonacci levels, measure, brush, notes), several charts side by side, a full-screen view, and the trades of the traders you follow marked on the candles.</li>
          <li><b>Earn.</b> Deposit into the market's vault, see what a share was worth at its last rolls, claim results.</li>
          <li><b>Burner wallet and faucet.</b> A test wallet kept in your browser and a button for test USDC, so anyone can try it without installing anything.</li>
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
          <li><b>What a copy cannot do.</b> It cannot withdraw, and it cannot trade more than the margin rule allows. A trader you copy who loses loses your money too, in proportion: a good record is not a promise. Starting to copy a trader costs 10 XNT (0.02 SOL on devnet), paid to the platform once; changing the terms is free. Each copy trade pays the usual 0.10% fee; small differences (under 10% of the target) are left alone so you do not pay it on every tick. While you copy, positions you open yourself are brought back in line. Stop at any time: your positions stay as they are.</li>
        </ul>

        <h2 id="lifecycle">Market lifecycle</h2>
        <ol className="steps-doc">
          <li><b>Open.</b> Opening a market costs 10 XNT (0.02 SOL on devnet), paid once to the platform by whoever creates its vault. <code>InitVault</code> creates the vault, its share mint, buffer and escrow, and its Percolator LP portfolio, and approves the vault program as that portfolio's matcher. <code>ListAsset</code> then activates the asset and configures its Pyth feed. Anyone can call either; if someone creates a vault and never lists it, anyone else can finish.</li>
          <li><b>Deposit.</b> <code>RequestDeposit</code> moves collateral into the vault's buffer and records a ticket for the current epoch.</li>
          <li><b>Roll.</b> When an epoch ends and the LP portfolio is flat, <code>RollEpoch</code> (anyone) withdraws all capital from Percolator, prices every queued withdrawal and deposit, burns and mints shares, redeploys everything that is not owed, and renews the matcher approval.</li>
          <li><b>Claim.</b> Each depositor's <code>Claim</code> collects their shares or collateral from the settled epoch, pro rata from the epoch record.</li>
          <li><b>Trade.</b> Takers queue requests with the router; executors fill them at the first Pyth price at or after each request's target, with the vault as counterparty (see How trades fill).</li>
          <li><b>Harvest.</b> <code>HarvestFees</code> (anyone) moves insurance above the floor into the buffer; 5% is set aside for the opener and 10% is paid to the platform's treasury.</li>
          <li><b>Settle without stopping.</b> When an epoch ends, a flat vault is rolled by anyone. A vault holding a position is settled through the router: the settlement is queued and executes at the first Pyth price published after its target time, like a trade, so nobody can pick the price the vault is valued at. Withdrawals are paid from cash; the vault keeps 10% of its value outside Percolator for that.</li>
          <li><b>Stay live.</b> If an epoch's withdrawals are larger than that cash, they can only be paid once the vault's position is closed. Anyone can then switch it to closing-only (<code>RequireFlat</code>). If a taker holds a position so the vault can't get flat, <code>Unwind</code> (anyone, six epochs later) makes the vault close its own position through Percolator's unilateral <code>RebalanceReduce</code>. That scales down the positions on the other side, and Percolator then takes no new position on the market until all of them are closed; the vault cannot take the other side of a close there, so the router closes them out (<code>RequestClose</code>, which anyone can queue for any trader and which executes at the first Pyth price after its target, like any request). The market then resets and reopens.</li>
          <li><b>Liquidate early.</b> An account whose equity falls below 15% of its positions' notional can be liquidated through the router by anyone: at the first Pyth price after the request's target, the position is closed against the vault if the account is still below that level. Percolator's own liquidation at 10% stays as the backstop; it would make the market close-only.</li>
          <li><b>Retire.</b> Once a market has had no liquidity providers for three epochs and holds no position, <code>RetireMarket</code> (anyone) pays its leftover insurance to the opener and has Percolator retire the asset. The next market opened reuses the slot, and the same feed can be opened again later.</li>
          <li><b>Wind down.</b> If the market is resolved, <code>SettleResolved</code> closes the portfolio through Percolator's resolved path; queued deposits are refunded, and shares redeem pro rata with <code>RedeemTerminal</code>.</li>
        </ol>

        <h2 id="rules">Market rules</h2>
        <p>Every market opened here runs on the same fixed template, so nobody can open a market set up to fail. The program ignores whatever parameters the opener sends.</p>
        <table className="doc-table">
          <tbody>
            <tr><td>Vault position limit</td><td>3× the vault's NAV in notional, at the current price</td></tr>
            <tr><td>Most new exposure per fill</td><td>0.75× the vault's NAV (the part of a fill that closes the vault's position is not limited)</td></tr>
            <tr><td>Epoch</td><td>{CANON_EPOCH_LEN_SLOTS.toLocaleString()} slots (about {Math.round(CANON_EPOCH_LEN_SLOTS * slotSeconds() / 60)} minutes at the current slot time) on devnet</td></tr>
            <tr><td>Insurance floor</td><td>100 USDC kept in insurance for traders; only fees above it are harvested</td></tr>
            <tr><td>Price</td><td>Verified Pyth prices only, moved forward by the router; listing needs a price at most 300 seconds old</td></tr>
            <tr><td>Execution</td><td>The first Pyth price published at or after {ROUTER_DELAY_SECS} seconds after the request landed</td></tr>
            <tr><td>Leverage and fee</td><td>10× (10% initial margin) and a 0.10% fee per side, fixed by the program</td></tr>
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

        <h2 id="fees">Fees, rebates and referrals</h2>
        <ul>
          <li>Every trade pays the market's fee (0.10%) on both sides into the asset's insurance. On a trade against the vault, the vault pays its side too, and gets both back when fees are harvested.</li>
          <li>Harvested fees above the 100 USDC floor are split 85% to depositors (by raising the share price), 5% to the opener and 10% to the platform's treasury, which pays for price updates, re-valuations and liquidations. Half of what is harvested is the vault's own payments coming back, so of what traders paid, depositors keep 70%, the opener gets 10% and the platform 20% (claimable with <code>ClaimOpenerFees</code>).</li>
          <li>A vault worth less than 5,000 USDC at its last roll pays the platform nothing: its depositors keep that part too, so a new market's first providers earn the most.</li>
          <li><b>Rebates.</b> The platform pays part of its own share back, weekly: a wallet that traded 100,000 USDC or more in the week gets 0.5 basis points of it back, 1,000,000 or more gets 1 basis point. Whoever invited a wallet (the wallet confirms it once, on chain, and it can never be changed) gets 0.5 basis points of what it trades. Rebates are never more than three quarters of what the treasury took in that week, and they cost depositors and openers nothing.</li>
          <li>The vault is the counterparty to traders, so its result is <b>fees + what traders lose − what traders win</b>. Fees are the compensation for that exposure. Each market's liquidity panel shows what a share was worth at its last rolls.</li>
        </ul>

        <h2 id="rails">Safety rails</h2>
        <p>Rules the router and vault enforce on top of the engine's own:</p>
        <ul>
          <li><b>Liquidation at 15%.</b> An account whose equity is below 15% of its positions' value is closed against the vault at the next oracle price, by anyone. That is above the engine's own 10% on purpose: the engine liquidates by cutting the other side's positions, which shuts the market until it is emptied. Closing against the vault first avoids that.</li>
          <li><b>Places kept for liquidations.</b> The last four places in each market's queue cannot be taken by trades, and the fill of any request from an account below the liquidation level closes its position. A trader cannot stay ahead of a liquidation by keeping the queue full.</li>
          <li><b>Price band.</b> A new mark may differ from the one before it by at most 2% plus 0.5% for each second between the two prices. A broken feed or a wrong price is refused; a real move that large is accepted once enough time has passed.</li>
          <li><b>Orders that cannot fill do not block the market.</b> A request whose price the mark has held for 30 seconds without a fill can be removed, so the requests behind it, liquidations included, move on.</li>
          <li><b>Deposits freeze before a settlement.</b> Once an epoch's settlement is queued, the vault takes no new deposit or withdrawal for that epoch, because the settlement price is public seconds before it executes.</li>
          <li><b>One fee for every market.</b> The trade fee is a constant of the program (0.10%); anyone can set a market back to it, and nobody can set anything else.</li>
          <li><b>Leftovers are swept.</b> Money left behind by expired requests can be sent to the treasury by anyone; it cannot go anywhere else.</li>
        </ul>

        <h2 id="risks">Risks</h2>
        <ul>
          <li><b>Directional.</b> If traders win overall, depositors lose. Caps bound the vault's exposure to 3× its NAV.</li>
          <li><b>Chain clock.</b> A request's target comes from the chain clock (or the mark time, if later). The {ROUTER_DELAY_SECS}-second delay assumes the clock does not run more than a few seconds behind real time; Solana's clock normally tracks it within a second or two.</li>
          <li><b>A request that cannot fill.</b> If a request cannot fill (for example after a price move larger than its 10% margin buffer), the mark waits at its price until it expires, at most {ROUTER_GRACE_SECS} seconds, before moving on. The requester loses the bond; liquidations on that market wait that long.</li>
          <li><b>Executors.</b> Filling needs someone to fetch each target-time Pyth update from Hermes (which needs a Pyth API key; the free plan covers every market listed here) and send the transactions. Keeping marks fresh between trades uses Pyth's free sponsored feed accounts. Anyone with a key can run an executor; if nobody does, requests expire and nothing trades.</li>
          <li><b>Market authority.</b> On devnet, Percolator's market-level authority belongs to the vault program's governor address, which the program only uses to retire idle markets. Nobody can shut an asset down or resolve the market, and permissionless stale resolution is off. On another market, whoever holds that authority can shut assets down or resolve the market; the vault then winds down and pays out.</li>
          <li><b>Smart contracts.</b> Unaudited code. The program is upgradeable on devnet; a mainnet deployment must burn that authority.</li>
          <li><b>Keepers.</b> Everything is permissionless, but someone has to send the transactions. If nobody does, epochs don't roll and prices don't update.</li>
          <li><b>Margin stays in while you hold a position.</b> Percolator pays margin out only from an account with no open position on any market, so a trader closes everything before withdrawing. A queued trade must also leave enough margin for a further 10% price move; a trade that only reduces a position is always accepted.</li>
          <li><b>Fallback prices are trusted.</b> If Pyth has not served a queued trade 20 seconds after its target, a reporter key may post the price from an exchange-median price service instead, so trades survive an outage of Pyth's API. Nothing on chain can verify that price. Anyone posting the Pyth price within those 20 seconds keeps the fallback out.</li>
          <li><b>No funding rate.</b> Percolator derives funding from the gap between mark and index price. Here both are the same Pyth price, which is what stops front-running, so funding is always zero and nothing pays traders to balance longs and shorts. The vault carries the imbalance, within its position limit, for the fees.</li>
          <li><b>An unwind closes the market out.</b> If withdrawals larger than the vault's cash reserve have waited six further epochs and the vault still holds a position, the vault closes it unilaterally. Traders on the other side are scaled down, and the positions left on that market are closed out at the next Pyth price before it reopens. A trader can have a position closed this way without choosing to.</li>
          <li><b>Cost per position.</b> Each price move leaves every open position on that asset out of date until it is cranked, and Percolator takes no new position on the asset until all of them are. The executor does this in front of each fill, so keeping a market tradable costs more the more positions it has.</li>
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
        <p>The program is tested against the production Percolator binary in LiteSVM, with 116 tests:</p>
        <ul>
          <li><b>Front-running</b>: a trader who knows the price in advance ends flat; the fill is exactly the first Pyth price at or after the target; no later or skipped update can move the mark; nobody can push a newer price over a pending request; the executor's identity and timing do not change the fill; direct trades, forged or unverified Pyth accounts and non-router mark moves are refused.</li>
          <li><b>Requests</b>: no cancelling, no withdrawing while queued, expiry only after the grace period with the bond forfeited, stressed margin check, withdrawals only to the owner's wallet.</li>
          <li><b>Orders</b>: each order type triggers only when its condition holds, a limit never fills worse than its price, a trailing stop follows the best price, TWAP slices come no sooner than their interval, reduce-only orders cannot grow a position, and an order cannot be used to skip the margin check.</li>
          <li><b>Track records and copying</b>: profit is booked by the router and cannot be written by the trader; a copy's size comes from the two accounts and the caller cannot enlarge or reverse it; a copy trade is an ordinary request with the same margin check; a referrer is named once and never changed.</li>
          <li><b>Reported prices</b>: on the X1 build only the reporter posts, a stale report cannot list a market, and a trade fills at the first reported price after its target and nothing else.</li>
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
            <tr><td>16</td><td>InitVault</td><td>anyone</td><td>Creates the canonical vault for a feed and its accounts</td></tr>
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
            <tr><td>33</td><td>ArmFill</td><td>router only</td><td>Arms the one fill the matcher accepts in this slot</td></tr>
            <tr><td>36</td><td>FreezeRequests</td><td>router only</td><td>Stops new deposit and withdrawal requests while an epoch's settlement is queued</td></tr>
            <tr><td>37</td><td>SetTradeFee</td><td>anyone</td><td>Sets a market's trade fee to the program's constant (0.10%)</td></tr>
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
            <tr><td>8</td><td>RequestClose</td><td>anyone, for any trader</td><td>Queues a forced close: a close-out on a close-only market, or the liquidation of an account below 15%</td></tr>
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
            <tr><td>24</td><td>SetReferrer</td><td>wallet, once</td><td>Records who invited the wallet; it can never be changed</td></tr>
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
          condition holds, queues copy trades, liquidates accounts below 15%, settles epochs and expires late requests. It needs
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
            <tr><td>Prices</td><td>Pyth, verified on chain; a reported price only as a fallback after 20 seconds</td><td>X1 has no Pyth: every price is posted by the router's reporter key from an exchange-median service, and is trusted</td></tr>
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
          <dt>What is the "Devnet Burner" wallet?</dt>
          <dd>A key stored in your browser so you can try the app without installing a wallet. Devnet only; never use it for real funds.</dd>
        </dl>
      </article>
    </main>
  );
}
