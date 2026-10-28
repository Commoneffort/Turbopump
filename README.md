# Turbopump

Turbopump is permissionless, adminless liquidity vaults for [Percolator](https://github.com/aeyakovenko/percolator), Anatoly Yakovenko's perpetual-futures risk engine on Solana, with trading that cannot be front-run.

A vault pools deposits, lists its own perpetual market on Percolator, acts as the counterparty to every trade on it, and pays the market's trading fees to its depositors. Every trade goes through a router that fills it at the first Pyth price published four to five seconds after the trade was requested (on the next 2-second mark, so trades sent close together share a price), a price nobody could know when they traded. Nobody holds a key over any of it: every parameter is fixed when a vault is created, and every maintenance step can be run by anyone.

**Status:** live on Solana devnet and X1 testnet, unaudited. Do not use with real funds.

## Percolator and Turbopump

Two different things, by two different authors. **Percolator** is the risk engine underneath: one Solana program by Anatoly Yakovenko that keeps margin, profit and loss, insurance and its own liquidation. We did not write it. **Turbopump** is what this repository adds on top:

| | Percolator (the engine, not ours) | Turbopump (this repository) |
|---|---|---|
| Liquidity | None of its own: a trade needs a counterparty | One shared vault per asset, the counterparty to every trade |
| Market keys | Whoever lists a market holds its admin, insurance and oracle keys | The vault's own address holds them; no instruction uses them |
| Price a trade gets | The market's mark at that moment | The first oracle price published 4 to 5 seconds after the request (on the next 2-second mark) |
| Order types | An immediate trade between two accounts | Market, limit, stop loss, take profit, trailing stop, TWAP |
| Who earns the fees | The asset's insurance operator | Depositors 85%, the market's opener 5%, the platform 10% |

What is in here:

- **Vault program** (`src/`): keyless markets, one per price feed, each with a pooled vault that lists the market, is its matcher and pays its fees to depositors.
- **Router program** (`router/`): the only way to trade. Queues every trade and fills it at a price nobody could know in advance.
- **Standing orders** (router tags 12 to 14): limit, stop loss, take profit, trailing stop (up to 50% back from the best price) and TWAP (2 to 500 slices, at least 10 seconds apart). Signed once, carried out by anyone, and filled like any trade, so they cannot be front-run either. Up to 8 per wallet per market.
- **Track records and copy trading** (router tags 15 to 21, 25 to 28): profit, volume and fills booked by the router itself; names, badges and badge pictures; a paid featured row; following; copying a trader's leverage at a chosen ratio.
- **Spot swaps on xDEX** (router tag 30, `router/src/swap.rs`): the router takes a 0.2% platform fee on chain, swaps the rest with xDEX's own `swap_base_input` (X1's copy of Raydium CP-Swap), and checks what reached the wallet against its minimum. Coin can be swapped straight into trading margin in one transaction.
- **Liquidation and settlement that keep markets open**: leverage set per asset (BTC and ETH 20x, liquidated below 3.5%; stocks 5x, below 12%; the rest 10x, below 6%; router tag 29), and accounts below that level are partly closed against the vault (as much as brings them back to their opening margin) before the engine's own liquidation; epochs settle while the vault holds a position.
- **Risk limits per feed** (`src/feeds.rs`): markets open only on listed feeds; the vault holds up to 3x its value on BTC and ETH and 1x elsewhere, ordinary trades use 80% of that (the rest is kept for closes and liquidations), fills on a crowded side shrink as the vault fills, the limits use the lower of the vault's value at its last roll and now, and insurance keeps 3% (majors) or 8% (the rest) of the vault's value. Pyth prices with a confidence interval over 1% are refused.
- **Funding: built, switched off** (since 2026-10-20 on both networks: with a nonzero rate every accrual left every position stale, and Percolator then refused new trades; it returns once the engine settles funding without blocking trades). (`router/src/funding.rs`, router tag 31, vault tags 42-43, and Percolator's `PushAuthFunding` 71 / `UpdateFundingCap` 72 in our fork, branch `funding/authority-rate`, now part of `merge/2026-10-28`; funding indices exact since upstream engine PR #227, merged 2026-10-27): the crowded side pays the other side every slot, inside Percolator. The mark is the oracle price here, so the rate comes from how full the vault is on one side instead of a perp-index premium: nothing under 20% of its limit, rising linearly to 30 e9 per slot (about 0.027%/h) at the whole limit, moved toward that target over about an hour (a fill or `RefreshFunding` takes a step), bounded by the market's cap (`CANON_MAX_FUNDING_E9` = 40). Percolator takes a rate only on an asset accrued to the current slot, so it never applies to time already passed. The engine change computes funding index deltas at the ADL scale before rounding (it used to round each segment's funding to a whole price unit first, which made realistic rates accrue nothing on assets under about $1,000).
- **Fees**: 0.05% per trade (5 bps, about Hyperliquid's 4.5 bps taker fee), fixed by the program; opener's share; a platform share that vaults under 5,000 USDC do not pay; weekly volume rebates and first-month refunds for new wallets on trades held 5 minutes or more, one wallet per funder (`app/scripts/rebates.ts`, from the fill log `app/scripts/fills-log.ts`); a weekly trading contest by dollar profit, $1,000+ accounts 7+ days old, one prize per funder, paid after review (`app/scripts/contest.ts`). There are no referral payments (removed 2026-10-20; router tag 24 still exists, nothing reads it). Fees in the chain's coin: 10 XNT to open a market, 20 XNT to start copying (half to the trader copied), 1 XNT for a name or a featured day, 10 XNT for a badge picture (devnet: a five-hundredth of those, in SOL).
- **Safety rails**: a price band on the mark (2% plus 0.5% per second), a deposit that makes letting an order lapse cost something, four places in each queue kept for liquidations and settlements, deposits frozen while a settlement is queued, a 30% cash reserve with a margin top-up (vault tag 38), insurance that grows with the vault (100 USDC or 3% of its value), and a loss cover the treasury funds for each vault's depositors (vault tags 39 to 41).
- **A second price source and a second network**: reported prices as a fallback for Pyth, and a full deployment on X1, which has no Pyth; there a second key (the witness) must agree with each reported price, and the two read different exchanges (`deploy/x1-services.sh` runs two copies of `app/scripts/price-service.ts`).
- **Services** (`app/scripts/executor.ts`, the keeper in `examples/`): anyone can run them, on Pyth's free plan and public RPC.
- **Web app** (`app/`): trading desk with charts, indicators, drawing tools and multi-chart layouts; Spot (xDEX pairs with their own charts, pool depth and latest swaps); Earn; open a market; leaderboard, contest and copy trading; Health (live solvency); docs; burner wallet and faucet. A Telegram alerts bot (`app/scripts/alerts-bot.ts`) messages fills, thin margin and liquidations for watched wallets.
- **Fixes to Percolator itself**, found while building on it and sent upstream.

## The problem we solved: trading against a price you already know

A market maker that fills trades immediately at an oracle price can be traded against by anyone who sees the real price first. That is almost every professional trader:

- **Traders watching the exchanges.** Pyth aggregates prices from exchanges and trading firms (Binance, OKX, Coinbase, Jane Street, Jump and others). Anyone connected to those venues sees a move before it reaches Pyth.
- **Pyth publishers.** They know their own quotes before Pyth aggregates them.
- **Anyone reading Pyth off-chain.** A new Pyth price exists on Pythnet and in Hermes (Pyth's price service) before anyone posts it on Solana, and posting is pull-based: the on-chain account is only as fresh as the last person who paid to update it. On devnet we measured Pyth's shared account at 225 seconds old.
- **Validators and searchers.** They see pending transactions, including price updates, and can order their own trades ahead of them.

Before this change the vault filled every trade immediately at Percolator's mark, which followed Pyth. Any of the parties above could buy from it below the real price and sell to it above, and the depositors paid.

### How the router removes it

1. **A trade is a request first.** It lands on chain and gets a target time: the later of the chain clock and the vault's current mark time, plus 4 seconds, rounded up to the next multiple of 2 seconds (`BATCH_SECS`). Rounding only adds wait; it means every request sent in the same 2-second window, on every market, fills at one price, so the executor re-values the accounts once for all of them instead of once per trade.
2. **It fills at exactly one price:** the first Pyth price published at or after the target. Pyth's signed update carries its own publish time and the previous one, so the router accepts only the update with `previous publish time < target <= publish time`. Nobody chooses a price: whoever executes the fill, and whenever, the price is the same, and nobody could have known it when the request landed.
3. **The vault's mark only moves through the router, and only forward.** The vault lists its market in Percolator's authority-mark mode with itself as the oracle authority, and it moves the mark only when the router asks, to a fully verified Pyth price that is newer than the current one. The router never moves it past a pending request's target before that request has filled or expired.
4. **There is no other way to trade.** The vault's matcher refuses every fill the router did not arm for that exact slot and size, so a trader calling Percolator directly gets nothing.
5. **No backing out.** A request cannot be cancelled. The trader's margin is locked from request to fill, and the request is only accepted with enough margin to open at the asset's level; if the price moves during the wait so the account can no longer afford the trade, the fill trades nothing, so a trader cannot pick which fills happen after seeing the price. A request nobody fills within 90 seconds of its target expires and its bond is forfeited; nothing is traded.
6. **Nobody can censor it.** Filling is permissionless: any wallet, the trader included, can execute any request once the mark is at its price, and earns the request's bond for doing so. Each trader's Percolator account is owned by a program address derived from their wallet; only the router can trade it, and withdrawals can only go back to that wallet.

What is left: the design assumes the chain clock does not run more than a few seconds behind real time (the 4-second delay is the margin), and a request that cannot fill (for example after the account can no longer afford it at the new price) holds the mark at most 90 seconds before it expires, at the cost of its bond.

## Why this exists

Percolator is a complete risk engine, but nobody provides liquidity on it yet. Its own mainnet market has no market maker, so the only way to trade is two users co-signing each trade. Percolator also changes the usual economics:

- Every trade settles at the market's mark price. A market maker's quoted price only sizes fees, so an LP earns no spread.
- Trading fees go to the traded asset's insurance fund, which belongs to whoever operates that asset.

So the natural liquidity provider on Percolator is the operator of a market, not a spread-quoting market maker. This program lets a pool of depositors be that operator, with no operator key at all.

## How it works

1. **One market per feed.** A vault's address is derived from (market, Pyth feed), so each price feed can have exactly one vault, and so one market and one shared liquidity pool. Whoever opens it only picks the feed: every vault runs on the same fixed template, so nobody can open a market set up to fail. Its caps scale with its own NAV and its feed's tier (on BTC and ETH a position up to 3× and each fill up to 0.75×, elsewhere 1× and 0.25×; see `src/feeds.rs` and `math::fill_caps`), so an empty vault quotes nothing and every deposit deepens the market.
2. **List.** The vault activates a new Percolator asset at a fresh, verified Pyth price. Because the vault's address signs the activation, it becomes the asset's admin, insurance operator, backing authority and oracle authority. The program has no instruction that uses those powers except moving the mark on the router's request.
3. **Trade through the router.** Takers queue requests; executors move the mark to the verified Pyth price at each request's target and fill it (see above). The vault is the counterparty, within its caps.
4. **Earn.** Takers' fees land in the asset's insurance. `HarvestFees` (anyone can call it) moves everything above what insurance keeps (100 USDC or 3% of the vault's value on BTC and ETH, 8% elsewhere, whichever is more) into the vault. That amount stays in place to protect traders. Of what is harvested, 85% belongs to the depositors pro rata, 5% is set aside for whoever opened the market (Hyperliquid HIP-3 style), who claims it with `ClaimOpenerFees` and has no other powers, and 10% goes to the platform's treasury (nothing from a vault worth less than 5,000 USDC).
5. **Settle in epochs, without stopping trading.** Deposits and withdrawals are queued, then priced together at one net asset value when the epoch ends. A flat vault's value does not depend on the price, so anyone can roll it. A vault holding a position is settled through the router instead: anyone queues the settlement, and it executes at the first Pyth price published after its target time, like a trade, so nobody can choose the price it is valued at. Capital stays in Percolator and is counted at Percolator's figure; withdrawals are paid from cash, of which the vault keeps 30% of its value outside Percolator (`RESERVE_BPS`; 10% made vaults go closing-only about once an hour). `TopUpMargin` (anyone) moves that cash into the vault's Percolator margin when the margin is under 40% of its value, back up to 60%.
6. **Keep exits open.** If an epoch's withdrawals are larger than the vault's cash, they can only be paid once its position is closed (Percolator pays out only from a flat account). Anyone can then switch the vault to closing-only (`RequireFlat`): it only accepts trades that shrink its position. Those withdrawals pay a 0.5% exit fee (`EXIT_FEE_BPS`) that stays with the depositors who remain. If a trader keeps a position open on purpose, anyone can call `Unwind` six epochs later (`UNWIND_GRACE_EPOCHS`: ordinary order flow gets that long to bring the vault flat first), and the vault closes its own position through Percolator's unilateral `RebalanceReduce`. That deleverages the traders on the other side, and Percolator then takes no new position on the market until every position on it is closed. The vault cannot take the other side of a close there, so the router closes the remaining positions out (`RequestClose`: anyone can queue it for any trader, and it executes at the first Pyth price after its target like any request); the market then resets and reopens.
7. **Liquidate before Percolator has to.** A trader whose equity falls below their positions' liquidation level (3.5% of notional on BTC and ETH, 12% on stocks, 6% elsewhere, always at least 1 point above Percolator's own) can be liquidated through the router by anyone: the request executes at the first Pyth price after its target and, if the account is still below that level at that price, closes against the vault as much of the position as brings the account back to its opening margin plus 0.5% (at least a quarter of it; all of it if under a tenth would be left; `liquidation_size`). Ordinary trades stop at 80% of the vault's limit, so a liquidation always has room. Percolator's own liquidation (at its maintenance margin, on any crank) remains the backstop; it reduces the position unilaterally, which makes the market close-only until it is closed out as above.
7. **Retire dead markets.** When a market has had no liquidity providers for three epochs, holds no position and has no trade queued, anyone can call `RetireMarket`: its leftover insurance (trading fees nobody else owns) goes to the opener, Percolator retires the asset, and its slot is reused by the next market opened. The same feed can be opened again later.
8. **Wind down.** If the market is resolved, `SettleResolved` (anyone can call it) closes the portfolio through Percolator's resolved path. Queued deposits are refunded and shares redeem pro rata.

## Instructions

### Vault program

| Tag | Instruction | Who | What |
|---|---|---|---|
| 0 | matcher call | Percolator only | Sizes a fill the router armed, during its `TradeCpi` |
| 16 | `InitVault` | anyone | On a feed in `feeds::LISTABLE` only: creates the vault, share mint, buffer, escrow and LP portfolio, and approves the matcher |
| 26 | `ListAsset` | anyone | Lists the vault's asset in authority-mark mode at a fresh, verified Pyth price |
| 17 / 18 | `RequestDeposit` / `RequestWithdraw` | depositor | Queues a request for the current epoch |
| 19 | `RollEpoch` | anyone | Settles the epoch while the portfolio is flat, then redeploys capital |
| 20 | `Claim` | depositor | Collects the shares or collateral from a settled epoch |
| 27 | `HarvestFees` | anyone | Moves insurance above the floor into the vault |
| 22 | `ConvertPnl` | anyone | Turns released profit into withdrawable capital |
| 21 | `RefreshMatcher` | anyone | Renews Percolator's time-limited matcher approval |
| 28 | `Unwind` | anyone | Liveness backstop, six epoch lengths after `RequireFlat` flagged the vault (or after the epoch ended, if later): the vault closes its own position |
| 34 | `SyncInventory` | anyone | Re-reads the vault's position from Percolator after it changed outside a fill (a liquidation or close-out on the other side) |
| 35 | `RequireFlat` | anyone | Switches to closing-only when an overdue epoch's withdrawals exceed the vault's cash |
| 29 | `ClaimOpenerFees` | market opener | Collects the opener's 5% share of harvested fees |
| 23 / 24 | `SettleResolved` / `RedeemTerminal` | anyone / holder | Wind-down after market resolution |
| 25 | `Sweep` | anyone | Moves stray vault-owned collateral into the buffer |
| 31 | `RetireMarket` | anyone | Frees the slot of an idle market (no shares, no requests, no position, nothing queued, listed 3+ epochs ago); leftover insurance goes to the opener |
| 30 | `AcceptGovernance` | current market authority | One-time: hands Percolator's market authority to the program's governor address, which is only used by `RetireMarket` |
| 32 | `PushMark` | router only | Moves the asset's mark (the router passes only verified Pyth prices) |
| 33 | `ArmFill` | router only | Arms the one fill the matcher accepts in this slot; given the market and the LP portfolio it also records the vault's value now (`live_nav`), and the fill is held to the lower of that and the value at the last roll |
| 36 | `FreezeRequests` | router only | Stops new deposit and withdrawal requests while an epoch's settlement is queued |
| 37 | `SetTradeFee` | anyone | Sets a market's trade fee to the program's constant (0.05%) |
| 38 | `TopUpMargin` | anyone | Moves the cash reserve into the vault's Percolator margin when it is under 40% of the vault's value, up to 60% |
| 39 | `InitCover` | anyone, once per vault | Creates the vault's loss cover and the token account that funds it |
| 40 | `CoverLoss` | anyone | After a roll, pays a fall of the share price below its high from the cover into the vault, once per roll |
| 41 | `WithdrawCover` | treasury | Takes money back out of a vault's cover |

### Router program

| Tag | Instruction | Who | What |
|---|---|---|---|
| 0 | `OpenAccount` | trader | Creates the trader's router account, its Percolator portfolio and collateral account |
| 1 / 2 | `Deposit` / `Withdraw` | trader | Margin in; margin out to the trader's own wallet (not while a request is pending) |
| 3 | `OpenBook` | anyone | Creates a vault's queue of requests |
| 4 | `Request` | trader | Queues a trade; sets its target time; checks margin at the asset's opening level; takes a bond and a 0.10% deposit |
| 5 | `Advance` | anyone | Moves a vault's mark to a newer verified Pyth price, never past a pending target |
| 6 | `Fill` | anyone | Fills a request at the mark once the mark is its target price; pays the executor the bond |
| 7 | `Expire` | anyone | Removes a request unfilled 90 s after its target; the bond is forfeited |
| 8 | `RequestClose` | anyone, for any trader | Queues a forced close: a close-out on a close-only market (unilateral reduce at the mark), or the liquidation of an account below its liquidation level (partly closed against the vault if still below at the fill price) |
| 9 | `RequestSettle` | anyone | Queues the settlement of a vault's epoch at the first Pyth price after its target |
| 10 | `Settle` | anyone | Rolls the vault's epoch at that price, with its position open |
| 11 | `PostPrice` | the reporter or witness key | Writes a reported (unverified) price for a feed into that key's account for it; on X1 the mark only moves to a report the witness's price (at most 30 s old) is within 1.5% of |
| 12 / 13 | `PlaceOrder` / `CancelOrder` | trader | Creates or removes a standing order: stop, take profit, trailing stop, limit or TWAP |
| 14 | `TriggerOrder` | anyone | Queues the trade of an order whose condition holds against the vault's mark, or removes an order that can no longer do anything |
| 15 | `OpenStats` | anyone, for any trader | Opens the account's track record, starting from its equity now. From then on `Deposit` and `Withdraw` book what they move in it and every `Fill` books the account's equity, so profit (equity minus the start minus net deposits), profitable days, volume and the last 16 fills are the router's own figures |
| 16 | `SetProfile` | wallet | A name (3 to 16 letters, digits or underscores; unique, compared without case) and a badge |
| 17 / 18 | `Follow` / `Unfollow` | wallet | A list of who the wallet watches. It moves no money |
| 19 / 20 | `SetCopy` / `StopCopy` | follower | Signs once: keep my positions at this trader's leverage on every market, times a ratio (up to 3x), within a limit per market. One leader at a time. Stopping leaves positions as they are |
| 21 | `TriggerCopy` | anyone, for any follower | Queues the trade that brings a follower in line with its leader on one market, when it is more than 10% from it (or the leader opened, closed or turned). The size is computed from the two accounts; the caller can only make it smaller. It is an ordinary request: same margin check, same bond, same fill at the first oracle price after its target |
| 22 | `ConvertPnl` | anyone | Turns a trader's released profit into withdrawable margin |
| 23 | `Sweep` | anyone | Sends what expired requests left in a queue to the treasury |
| 24 | `SetReferrer` | wallet, once | Records who invited the wallet. No longer used: referral payments were removed on 2026-10-20 |
| 25 / 26 / 27 | `SetBadgeImage` / `WriteBadgeImage` / `RemoveBadgeImage` | wallet | Pays for, writes and removes a 64x64 JPEG badge picture (at most 2,048 bytes) |
| 28 | `Feature` | wallet with a name | One more day in the leaderboard's featured row, at most 30 ahead |
| 29 | `SetTier` | anyone | Records an asset's leverage tier, decided from its feed (compiled in) |
| 30 | `Swap` | wallet | Takes `SWAP_FEE_BPS` (0.2%) of the input to the treasury, swaps the rest on xDEX, checks the output against `min_out` |

## Share pricing

- Shares use ERC-4626-style virtual offsets (1,000 virtual shares, 1 virtual asset), so the first-depositor inflation attack loses money.
- At a roll, withdrawals are priced at the **low** NAV: collateral actually held. Deposits are priced at the **high** NAV: plus profit booked but not yet released, plus fees not yet harvested. Neither side can take value from the other.
- Every rounding step goes against the party acting.
- If the vault has lost everything (NAV 0 with shares outstanding), that epoch's deposits are refunded rather than priced.

## Tests

`./test.sh` builds both on-chain programs and runs 145 tests. The tests need Percolator's program crate checked out next to this repo (`../percolator-prog`, branch `merge/2026-10-28` of `Commoneffort/percolator-prog`, which fetches its engine from `Commoneffort/percolator` by commit) with its SBF binary built:

```bash
git clone https://github.com/Commoneffort/Turbopump percolator-vault
git clone -b merge/2026-10-28 https://github.com/Commoneffort/percolator-prog
(cd percolator-prog && cargo build-sbf --tools-version v1.52)
cd percolator-vault && ./test.sh
```

The deployed programs' keys are not in the repository (`keys/` is ignored); the tests do not need them. The integration tests load the **production Percolator SBF binary** into LiteSVM and build markets with Percolator's own test harness; every trade in them goes through the router.

- **Front-running:** a trader who knows the price in advance ends flat, not ahead; the fill is exactly the first Pyth price at or after the target; a later update, or one that is not the first after the target, cannot move the mark; nobody can push a newer price over a pending request; the executor's identity and timing do not change the fill; a fill waits until Percolator's price has reached the mark; a direct trade against the vault is refused; only the router can move the mark or arm a fill; forged, unverified and wrong-feed Pyth accounts are refused.
- **Requests:** they cannot be cancelled or withdrawn from, and expire only after the grace period with the bond forfeited; margin must cover the asset's opening level, except for a trade that only reduces a position; withdrawals only reach the owner's wallet; a market with a queued request cannot be retired.
- **Math and property tests:** withdrawals never exceed NAV, deposit-then-withdraw never profits, incumbents are never diluted, fills never break the caps; each tier's limits, the 80% room for ordinary trades and the smaller fills on a crowded side (`fill_caps`); Pyth prices with a wide confidence interval are refused.
- **Risk limits:** a feed not on the list cannot be opened; a liquidation closes only what it takes and the rest at a later fall; an asset with no recorded tier opens at the strictest level.
- **Layout tests:** every account offset and every Percolator instruction encoding the programs use is checked against Percolator's own types and decoder.
- **X1 build** (`tests/x1.rs`): a market lists at the reported price and not at a Pyth account; a stale report cannot list; only the reporter and the witness post; a report the witness disagrees with does not move the mark; a reported price moves the mark with nothing queued; a trade fills at the first reported price after its target and nothing else; liquidation and open settlement work on reported prices.
- **Flows:** canonical vaults are unique per feed, ignore creator-chosen limits, can be listed by anyone, and scale their caps with NAV. Create → deposit → trade → roll → withdraw. List → trade → harvest fees → exit with profit. Gains and losses reach depositors exactly. Maintenance fees. Market resolution with everyone exiting. Retiring an idle market and reopening its feed in the freed slot.
- **Swaps** (`tests/swap.rs`, real xDEX binaries against copies of real pools on both builds): the fee is 0.2% rounded up, the wallet gets exactly the quote, a swap under its minimum is undone, only xDEX's program is called.
- **Loss cover** (`tests/cover.rs`): pays a fall below the high once per roll, never twice, and only the treasury withdraws.
- **Attacks:** forged matcher calls; a foreign LP routing fills through the vault; inventory caps; rolling while not flat; reduce-only enforcement; matcher expiry and permissionless renewal; claims that are early, doubled, stolen or forged; stale tickets; fake buffers; donations; the first-depositor inflation attack; attach mode and bad modes refused; duplicates and a wrong mint; double listing; sweeps; a taker holding a position to lock withdrawals.

## Devnet

| | |
|---|---|
| Vault program | `BSync6F8gtJs3Wj4w8L6H3ZtS397w2XoCYGEAJGmeYX` |
| Router program | `DkK9TSMpVXLq26HeqxTXLysXyRKDYHTKU94SLFDWgjw3` |
| Percolator program (integration branch, program 729a5538 on engine 460944c: upstream's engine of 2026-10-27 plus our fixes not merged upstream yet; the tested build) | `8o3uV87X2CvPYfPwM1sxeaYYE7sGWsTUiEy7SskEMM3P` |
| Market (test USDC collateral) | `8ZMjDzhAgcV7zidvkRXM257Dp2HmzeNz7jpbTFvRE1Ls` |
| Market authority (vault program governor address) | `78Hr1UZdw5zPX393dDNK1WnBBmjYWfe4WN3ZurvCnAkR` |
| SOL-PERP vault | `GJ5JgntYZrsW4S2GpAL53ixg5gPviFThQjk9NtwmgAat` |
| BTC-PERP vault | `AjBANbnVyHpEFPpPg3Rq11UJPGjXbxLruiP68PaUBL3F` |
| ETH-PERP vault | `EUEzFumrPr8jzRuGfQtcdY3mLLWpBiL5yspRcQShgGPD` |

Canonical epochs are 1,500 slots, about 6 minutes at devnet's current ~230 ms slots.

All addresses are in `deploy/devnet.json`. Tooling: `cargo run --example devnet --features devnet -- setup-market | create-vault | keeper | accept-governance | retire-idle | status`.

### Running the executor on Pyth's free plan

The executor (`app/scripts/executor.ts`) moves marks and fills requests. It needs a Pyth API key (Pyth's free plan is enough), read from `HERMES_API_KEY` or `~/.config/solana/percolator-test/hermes-key`; the endpoint is `https://pyth.dourolabs.app/hermes` (override with `HERMES_URL`).

- **Feeds.** The free plan serves SOL, BTC, ETH, PYTH, DOGE, HYPE, XAU and EUR, so those are the markets the app offers (JUP, WIF, RAY, JTO, BONK and TRUMP are refused on the free plan).
- **Usage.** Keeping marks fresh costs nothing: the executor uses Pyth's own sponsored on-chain feed accounts (updated at least every minute, or on a 0.5% move). Hermes is called only when a trade needs its exact target price: one request per target time, shared by every trade queued for it, plus one batched request every few minutes to refresh the feed accounts of markets not opened yet. That is a few Hermes requests per trade, far below the documented limit of 30 requests per 10 seconds. Pyth does not publish a monthly quota for the free plan; the executor backs off for a minute whenever Hermes answers 429.
- **RPC.** It fits within the public devnet RPC's limits: one batched account read every 3 seconds (every second while a trade is queued), requests sent one at a time with a pause on HTTP 429, and confirmations by polling rather than websockets.
- **Cranks.** Percolator takes new risk on an asset only when that asset is accrued to the current slot and every position on it is settled, and it settles a trader's positions only once every asset that trader holds is current. The executor puts exactly those cranks in front of each fill (`crankPlan` in `app/src/chain.ts`). How many are needed depends on the slot the transaction lands in, and a crank with nothing to do fails, so it sends two versions of the fill one crank apart: only the one that matches can succeed, and the request fills once. It also finalizes Percolator's side reset when the last position on one side of a market closes, without which that market would refuse new positions. Between trades it keeps every market within about 50 slots of the chain and settles out-of-date positions.

`RPC=https://api.devnet.solana.com npx tsx scripts/executor.ts` (from `app/`).

### Second price source: reported prices

The router can also take prices that a **reporter key** posts on chain (`PostPrice`). The reference executor fills them from an exchange-median price service (`JACK_URL`, default `http://jack0.x1.xyz:8090`: the median of top-of-book mid prices across up to eight exchanges, about four updates a second, no API key). That service does not sign its prices and has no history, so the executor records its stream to know the first price at or after a request's target, and the reporter key (`keys/reporter-keypair.json`, not in the repo) vouches for it. Nothing on chain can check such a price: **whoever holds the reporter key is trusted for it.** It is therefore used narrowly.

- **Solana (default build): fallback only.** `Advance` accepts a reported price only for a queued request whose target passed at least 20 seconds ago without a Pyth price, and only as that request's price (the first at or after its target). Anyone can still post the Pyth price within those 20 seconds, which shuts the fallback out. It exists so a Hermes outage or an exhausted quota does not leave requests to expire.
- **X1 (`--features x1`): the price source.** X1 has no Pyth. In this build a reported price follows the same rules as a Pyth update (newer than the mark, never past a pending request's price), and a market is listed at the reported price. Run the executor with `ORACLE=jack`; it posts a price when a request needs one and refreshes each mark every 30 seconds or on a 0.3% move, not on every tick, since each post is a transaction. It is deployed on X1 testnet (see X1 testnet below).

If the service starts signing its prices (ed25519 over symbol, price, timestamp and previous timestamp), the router can verify them on chain and the reporter key is no longer trusted.

## X1 testnet

Live since 2026-10-01: the same three programs, at the same addresses as on Solana devnet, with
a test USDC (6 decimals) as collateral. Addresses are in `deploy/x1-testnet.json`.

X1 has no Pyth, so the vault and router are built with `--features devnet,x1`: the price a
market lists at, its mark, and every fill, settlement and liquidation price is the one the
router's reporter key posts (`PostPrice`), taken from an exchange-median price service. The rule
that a request fills at the first price at or after its target is the same; what differs is the
trust: on X1 the reporter key is trusted for prices, checked by a second key, the witness: the mark only moves to a report that the witness's own price (at most 30 s old) is within 1.5% of (`WitnessDisagrees` otherwise; `app/scripts/witness.ts` posts it). See SECURITY.md.

**Markets (19):** SOL, BTC, ETH, HYPE, ZEC, FARTCOIN, gold (XAU), silver (XAG), TSLA, NVDA,
MSTR, AAPL, GOOGL, META, AMD, COIN, PLTR, SPCX, SPY: everything the price service has except
USDC. A feed id there is only a market's name (the ones Pyth also has keep their Pyth id; the
others are `sha256("x1:" + symbol)`). Stocks and the ETF only get new prices while their
exchanges are open; a trade queued when the service has no new price expires.

```bash
deploy/x1-testnet.sh                               # build, deploy, set up the market
cd app
NETWORK=x1-testnet npx tsx scripts/executor.ts     # prices, fills, liquidations
NETWORK=x1-testnet npx tsx scripts/seed.ts setup   # open every market; deposit
NETWORK=x1-testnet npx tsx scripts/seed.ts one 1 SOL 2   # a trade through the router
```

and the keeper, from the repo root: `PERCOLATOR_FIT_COMPUTE=1 PERCOLATOR_MANIFEST=deploy/x1-testnet.json
DEVNET_RPC=https://rpc.testnet.x1.xyz PERCOLATOR_KEYPAIR=~/.config/solana/percolator-x1/deployer.json
deploy/x1-tool keeper`. Logs: `deploy/logs/x1-executor.log`, `deploy/logs/x1-keeper.log`.

The site shows either deployment: the switch in its header (or `?network=x1-testnet`) picks, and
the faucet and leaderboard follow. On X1 a wallet only signs and the page sends, so the
transaction goes to X1 whatever network the wallet is set to.

**What it costs to run.** X1 charges 10 lamports for every compute unit a transaction asks for,
used or not. Everything that sends there therefore asks for what a simulation says it needs
(`computeLimit` in chain.ts, `PERCOLATOR_FIT_COMPUTE` in the tool); asking for the maximum, as on
Solana, costs 0.014 XNT a transaction. What remains is Percolator's own design: every market has
to be cranked forward 10 slots at a time, traded or not, at about 26,000 compute units per
market per crank. Measured on X1 testnet with 19 markets: **about 270 XNT a day**, nearly all of
it cranks (about 14 XNT per market per day). A fill costs the executor about 0.013 XNT (two
versions are sent, one fails), more than the 0.002 XNT bond it earns. Fewer markets, or a market
created with a longer accrual step (`max_accrual_dt_slots`, a risk parameter: prices then move
toward the mark more slowly), are the ways to lower it.

Checked: the X1 build's price rules in LiteSVM (`tests/x1.rs`, 9 tests, run by `./test.sh`); the
whole sequence on a local validator; and on X1 testnet itself, all 19 markets opened and trades
on SOL, BTC, ETH and TSLA filled in 7 to 14 seconds.

## Layout

```
src/            the vault program (processor, matcher, share math, state, Pyth reader, Percolator bindings, client builders)
router/         the router program (requests, marks, fills) and its client builders
tests/          LiteSVM tests against the production Percolator binary
examples/       devnet deployment and keeper
app/            web app (Vite + React + wallet adapter), the devnet faucet API, and scripts (executor, seed)
pusher/         standalone Pyth price pusher for shared feed accounts (needs a Pyth API key)
```

See [SECURITY.md](SECURITY.md) for the threat model and known limits, the live [docs page](https://turbopumpx.vercel.app/#/docs) for the full protocol description, [docs/SUBMISSION.md](docs/SUBMISSION.md) for the hackathon write-up and [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) for the demo.

Built on Percolator (Apache-2.0).
