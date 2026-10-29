# Security model

## Trust

| Party | Can | Cannot |
|---|---|---|
| Vault creator (opener) | Pick the feed (every other parameter comes from the canonical template); claim 10% of harvested fees | Open a second market for a feed; change any parameter; move funds; pause; upgrade |
| Depositors | Queue deposits and withdrawals; claim; redeem after wind-down | Affect other depositors' prices |
| Traders | Queue trades through the router; move margin in, and out to their own wallet | Trade at a price they know; cancel a queued trade; withdraw while one is queued; trade against the vault any other way |
| Executors (anyone) | Move a vault's mark to a newer verified Pyth price; fill a request once the mark is at its target price (earning its bond); expire requests past their grace period | Choose the price a request fills at; move the mark past a pending request's price; move the mark backwards; fill a request early |
| Anyone | Roll, harvest, convert, renew, unwind, settle, sweep, retire an idle market | Choose amounts or destinations: each of these moves value only into the vault's own buffer or portfolio, or (retiring) the asset's leftover insurance to the opener's claimable balance |
| Percolator market authority (`marketauth`) | Force-shut down any asset (with an exit window); resolve the market | Take the vault's insurance or collateral. On devnet it is the vault program's governor address (`AcceptGovernance`), which the program only uses in `RetireMarket`, so nobody holds these powers |
| Program upgrade authorities | Replace the vault or router program | On devnet this is the deployer. A mainnet deployment must burn both or put them behind a public timelock |
| Pyth | Provide prices, signed by the Wormhole guardians | Nothing else: the router takes only fully verified updates for the vault's feed, forward in time |

## Front-running

Anyone who sees the real price before it reaches the chain (traders on the exchanges Pyth aggregates, Pyth's publishers, readers of Pythnet and Hermes, validators and searchers who see pending transactions) could trade against a market maker that fills immediately at an oracle price. The router removes that:

- A trade is a request whose target time is fixed when it lands: `max(chain clock, current mark time) + 4 s`. It fills only at the first Pyth price published at or after that target (the update with `prev_publish_time < target <= publish_time`). Nobody could know that price when the request landed, and nobody can pick another one.
- The vault's asset is in Percolator's authority-mark mode with the vault as oracle authority. The vault moves the mark only on the router's instruction (`PushMark`), and the router passes only fully verified Pyth updates for the vault's feed, newer than the current mark, and never past a pending request's target.
- The vault's matcher accepts only the fill the router armed for that slot and size (`ArmFill`), so there is no other way to trade against it.
- A request cannot be cancelled; the trader's margin is locked until it fills or expires; it is accepted only with margin for a further 10% price move on the position it leaves (a request that only reduces a position is always accepted, so thin margin never stops a trader from closing); an unfilled request expires 90 s after its target with its bond forfeited. A trader cannot back out after seeing the price.
- Filling is permissionless and pays the executor the request's bond, so no keeper can censor a trader, and the executor's identity and timing do not change the fill.

## Invariants the tests enforce

- Only Percolator's matcher delegate for the vault's own portfolio can make the vault quote, and only for a fill the router armed in the same slot for the same size.
- Only the router's authority can move a vault's mark or arm a fill. The router only moves the mark to a fully verified Pyth update for the vault's feed that is newer than the current mark, and to the first update at or after the earliest pending target once that target has passed.
- A request fills only when the mark is the first Pyth price at or after its target and Percolator's effective price equals it; the fill price does not depend on who executes it or when.
- A request cannot be cancelled; the trader cannot withdraw or queue another while it is pending; it expires only after its grace period, and its bond is forfeited.
- Router withdrawals only reach a token account owned by the trader's wallet.
- The vault's inventory never goes past its caps through its own fills. In reduce-only mode it never grows and never crosses zero.
- A roll happens only when the LP portfolio is proven flat. Withdrawn capital is measured, not assumed.
- After every roll and claim, the buffer holds exactly what is owed (`reserved_assets`).
- Withdrawals never pay more than NAV. Deposit-then-withdraw never profits. Deposits never dilute incumbents.
- A ticket can be claimed once, only by its owner, only against the record of its own epoch. Records are created by the roll itself, at a PDA, so they cannot be forged.
- Fee harvesting never takes insurance below the fixed floor while the vault is live.
- Pre-funding a PDA address with lamports cannot block account creation.
- There is at most one vault per (market, feed), and it cannot be squatted: anyone can finish listing a created-but-unlisted vault.
- Vaults never take on more than 3x their NAV in position, or 0.75x per fill, on top of Percolator's margin rules.
- `RetireMarket` only succeeds with no shares outstanding, no queued deposit or withdrawal, no queued trade, a flat LP portfolio and at least three epochs since listing; Percolator additionally refuses unless the asset is empty.
- The opener's fee share is exactly 10% of each harvest, is held in the buffer as a reserved liability (so it never counts toward NAV), and only the opener can claim it.
- Fees owed to the vaults (router `carry`, `tests/carry.rs`): a fill names the vault's meter and the trader's ledger once they exist (refused otherwise); an account without a ledger, or with all 32 ledger slots in use, can only reduce; what is owed counts against equity in the fill's margin check, the liquidation check and the liquidation size; a withdrawal is refused while anything is owed; `PayFees` moves at most the owed amount, from the account's capital only, only while it holds no position, and only into the buffer of the operate-mode vault of the asset generation it was booked in (a vault opened later on a reused asset slot cannot collect it); a debt never exceeds the account's equity after the fill that added to it; only `OpenLedger` / `OpenCarry` create ledgers and meters, at their PDAs, and both are idempotent.

## Review of the fee ledger (2026-10-29)

Read with an attacker's view after the holding fee, crowded-side fee and liquidation fee were added. Fixed before release:
- `PayFees` paid any vault on the same asset index. A market slot is reused after a market retires, so whoever opened the next market there could have collected fees owed to the old vault's depositors. Entries now record the asset's generation and pay only that vault.
- A ledger with all 32 slots in use booked nothing on a new asset. Such a fill now only reduces.
- The devnet RPC address on the server carries a private key: API error messages are stripped of URLs and keys.

Checked and found sound: forged ledgers or meters (owner, size, magic and owner key are checked, and only the router creates them at their PDAs); a fill that leaves out the ledger or meter (refused once they exist); forcing a healthy account into liquidation with someone else's ledger (only the account's own ledger is read); withdrawing around the ledger (every withdrawal goes through the router's `Withdraw`, which checks it); paying from another trader's account or to an unrelated account (accounts are tied to the trader's PDA and the vault's buffer); arithmetic (meter sums, products and totals saturate; a fee is floored by at most one atom per fill); stack use (the ledger is edited in place: copied whole it overflowed the 4 KB frame).

Accepted, by design:
- Time held is booked when the account next trades on that asset. Until then the liquidation check counts only what is already booked, so a crowded position left untouched for months is not liquidated for its unbooked fee; that fee is booked (up to the account's equity) when it closes.
- The meter applies the price at each fill to the time since the one before. On a quiet market a holder could pick a moment for any fill to book a long gap at a slightly better price; the effect is the price move over that gap times the fee rate.
- Anyone may open a ledger for any trader (they pay its rent). Older pages then cannot withdraw for that trader until updated; no money moves.
- The executor pays the rent of a ledger (under a cent) for each trader whose order waits without one. Opening many trading accounts to make it pay costs the attacker more than it costs the executor.

## Known limits

- **Unaudited.** Neither these programs nor Percolator have been audited.
- **Percolator trust.** The vault inherits Percolator's correctness. Devnet and X1 testnet run our integration branch (program 729a5538 on engine 460944c, upstream's engine as of 2026-10-27), which includes fixes not yet merged upstream, among them permissionless listing while traders hold open PnL (percolator-prog #447).
- **Chain clock.** A request's target time comes from the chain clock (or the mark time, if later). The 4-second delay assumes the clock does not run more than a few seconds behind real time; Solana's clock is a stake-weighted validator estimate and normally tracks real time within a second or two.
- **A request that cannot fill.** If a request cannot fill (for example a price move larger than the 10% margin buffer, or the vault being unable to take the trade), the mark waits at its target price until the request expires, at most 90 s, before it can move on. It costs the requester the bond; liquidations on that market are delayed by that long.
- **Executors and Pyth access.** Filling needs someone to fetch the target-time Pyth update from Hermes (which requires a Pyth API key; the free plan covers the feeds the app lists) and send the transactions. The provided executor does; anyone with a key can run another. Keeping marks fresh between trades uses Pyth's free sponsored feed accounts. If no executor runs, queued trades expire and nothing trades; funds are not at risk.
- **Keeper liveness matters for trading.** Once a market has positions, Percolator refuses new risk while the asset's accrual clock lags; if keepers stop for hours, a one-time catch-up (`app/scripts/catchup.ts`) is needed before trades fill again.
- **Market authority.** Whoever holds `marketauth` can shut down the vault's asset (with Percolator's exit window) or resolve the market; the vault then winds down through `SettleResolved`. On devnet it is the governor address, so nobody can, and permissionless stale resolution is off. On a market we do not govern, this power stays with its authority.
- **Directional risk.** The vault is the counterparty to all traders. If traders win overall, depositors lose. Fees are the compensation.
- **Liveness needs keepers.** Rolls, harvests, cranks, settling out-of-date positions, finalizing Percolator's side resets, matcher renewal and retiring idle markets are permissionless, but someone has to send them. The provided keeper and executor do. Every price move leaves each position on that asset out of date until it is cranked, and Percolator refuses new positions on the asset until all of them are, so the cost of keeping a market tradable grows with the number of open positions on it.
- **Unwind price.** `Unwind` closes at Percolator's effective price within its unilateral close capacity. It may take several calls in a stressed market.
- **Settlement with a position open.** A vault holding a position is valued at Percolator's price, so its epoch is settled only by the router, at the first Pyth price after a target time fixed when the settlement was queued, with the vault's position settled at that price. Whoever queues or executes it cannot choose the price. Capital in Percolator is counted at its booked figure less any loss not yet taken out; unreleased profit only raises the price deposits pay. Withdrawals must fit in the vault's cash (10% of its value is kept outside Percolator); if they do not, the roll fails and `RequireFlat` makes the vault closing-only.
- **Liquidation level.** The router liquidates below 12.5% of notional, at a committed Pyth price and only if the account is still below it at that price. A trader can therefore be closed 2.5 points of margin before Percolator's own 10%. No fee is taken beyond the normal trading fee. If nobody queues it in time, Percolator's liquidation applies and the market is closed out.
- **Reported prices.** The reporter key (compiled into the router) can post a price for any feed. On Solana the router lets such a price move a mark only for a queued request that has waited 20 seconds past its target without a Pyth price, and only as the first price at or after that target as the reporter states it. Within that window the reporter chooses the price those requests fill at, and its publish times are its own word. To use it, it has to keep Pyth's price for that target off the chain for 20 seconds, which any other executor defeats by posting it. In an X1 build there is no Pyth and the reporter is the oracle for every mark, fill, settlement and listing: that deployment is only as trustworthy as the reporter key and the price service behind it.
- **No funding; a holding fee instead.** Funding is built but switched off (it blocked fills: see the Docs, Funding). Since 2026-10-29 the router charges the crowded side a holding fee for the vault instead (up to 0.01%/h at the vault's limit), collected when the trader withdraws. A trader who loses everything never pays it (the vault already has their loss), and it is booked only when the account next trades on that asset. The vault's exposure is still bounded by its limit (3× NAV).
- **An unwind closes the market out.** `Unwind` deleverages the traders on the other side of the vault, pro rata, at the mark, and Percolator then takes no new position on that market until every position on it is closed. Anyone can queue a close-out for any trader there (`RequestClose`); it executes at the first Pyth price after its target, so it gives nobody a price they know. A trader who holds a position through an unwind therefore has it closed at a Pyth price within a few minutes, without choosing to. The trigger needs a deposit or withdrawal to have waited a full extra epoch while the vault could not get flat.
