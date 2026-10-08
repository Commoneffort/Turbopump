# Hedging: an external risk layer for the vaults

An off-chain process that watches what the vaults hold and offsets it on one external venue,
with capital that is funded separately and kept there.

**Status: simulation, shadow mode, and Hyperliquid's test network.** Two venues exist: a mock,
and Hyperliquid's test network (test money). The real exchange's address is not in the code and
the adapter cannot be pointed at it. No real money moves.

## What it is, and what it is not

The vault is still the counterparty to every trade. Nothing here changes Percolator, the vault
program, the router, the matcher, the margin rules, liquidation, or the oracle, and none of them
knows this process exists.

- **It only reads the chain.** Two RPC methods (`getProgramAccounts`, `getMultipleAccounts`). It
  loads no Solana or X1 key and builds no transaction; a test fails if any source file starts
  to. The only thing it ever signs is an order on the venue, with the venue's own key.
- **The hedge trails the vault.** A trade fills on Percolator first. The hedger sees the new
  position on its next pass (every 10 s by default) and then moves the hedge. In between, the
  vault is hedged too little or too much. Fills never wait for the hedge.
- **The hedge's money is not in the vault.** Its profit and loss stay in the venue account.
  The terms are decided (all of it is the depositors'; see Terms), but nothing moves it into
  the vault yet, so until that exists depositors' NAV is unchanged by the hedge.

## Parts

```
ChainSource ──▶ ExposureMonitor ──▶ HedgePolicy ──▶ HedgeEngine ──▶ HedgeVenue (mock, or Hyperliquid testnet)
 (read-only)                         (pure)           │     ▲              │
                                                      ▼     │              ▼
                                                   Journal ◀┴─ Reconciler ◀─ orders, fills, funding, positions
                                                      │
                                                      ▼
                                      risk model (risk.ts) + states (state.ts) ──▶ risk.json, transitions.jsonl
```

| File | What it does |
|---|---|
| `src/chain-source.ts` | Reads the market, every vault and every vault's portfolio in one call at one slot. Decodes with the offsets in the app's `layout.json`; checked against the app's own decoder on live accounts. |
| `src/exposure.ts` | `ExposureMonitor`: net position per symbol, and whether the reading may be acted on. It uses the position Percolator counts (after deleveraging), not the matcher's tracked inventory, and notes when the two differ. |
| `src/policy.ts` | `HedgePolicy`: a pure function from (vault position, hedge held, limits) to one order or a reason to hold. |
| `src/config.ts` | The risk limits. |
| `src/journal.ts` | Persistent state: an append-only journal, flushed before the engine acts. The ledger is the journal folded. One process per journal; a journal is tied to one venue. |
| `src/reconcile.ts` | Makes the ledger agree with the venue, or halts. |
| `src/engine.ts` | The coordinator. One pass: reconcile, read, decide, send at most one order per symbol, then work out the risk and each symbol's state. |
| `src/risk.ts` | The risk model: what the vaults still carry after the hedge, the hedge's result, and how the hedge account stands. Pure. |
| `src/state.ts` | The coordinator's states, worked out from the journal and the latest readings. Pure. |
| `src/report.ts` | Writes `risk.json` and `transitions.jsonl` beside the journal, for people and other programs. |
| `src/venue.ts` | The interface a venue has to offer. |
| `src/mock-venue.ts` | A margin account in memory, with fees, spread, funding, and faults on request. |
| `src/hyperliquid.ts` | Hyperliquid's test network as the venue: order signing, wire formats, and matching the exchange's fills to our order ids. |
| `src/simulator.ts` | `HedgeSimulator`: the real engine on a simulated vault, venue and clock. |

## The risk model

The question it answers: **how much risk do the vaults still carry after the hedge?**

Per symbol, on every pass (`src/risk.ts`, shown by `npm run status`):

```
what the vault holds ─▶ what it is meant to keep ─▶ hedge needed ─▶ hedge held ─▶ still open
     -$15,000               -$3,000 (ratio 80%)        80 SOL          66.66 SOL     -$2,001
```

| Number | What it is |
|---|---|
| vault holds | the vaults' net position and its dollar value at Percolator's price |
| meant to keep | the share the hedge ratio leaves with the vault (nothing at ratio 1) |
| hedge needed / held | the hedge that would leave exactly that, and the position on the venue |
| hedged | the hedge as a share of the vault's position |
| still open | what the hedge is short of (or past) what is needed. The band and `maxUnhedgedUsd` are limits on this |
| vault keeps | vault position plus hedge: what a price move still lands on |
| stress loss | what a move of `stressBps` (10%) against that would cost, also as a share of the vaults' value |
| hedge result | on open positions, on closed trades, fees, funding; and what fills cost against the mid price |
| basis | the venue's price against Percolator's |

For the hedge account: what it is worth, margin in use and free, **room for more hedge** (free
margin less the reserve, at the policy's margin rate), leverage, and the **distance to
liquidation**: how far every hedged price can move against the account before the venue closes
it, `(equity - maintenance margin) / hedge held`. Per symbol, the price at which that hedge
alone would use the margin up. It is an estimate (it takes the maintenance margin as fixed), and
it assumes every price moves the wrong way together, so it errs toward caution.

Totals add sizes without regard to side: a long SOL vault is not counted as offsetting a short
BTC one.

**The account is checked against the ledger.** The first time the account is valued, what was
put into it is written to the journal (`baseline`). After that, its value must equal that plus
the ledger's fills, fees and funding. A difference above `maxUnexplainedUsd` is reported as
DEGRADED: money was moved in or out (`npm run status -- rebase 5000` records a $5,000 deposit),
or the venue charged something the ledger does not see.

## States

Each symbol is in one state, and the hedge as a whole is in the worst of its symbols'
(`src/state.ts`).

```
NORMAL ─▶ HEDGE_REQUIRED ─▶ SUBMITTING ─▶ PARTIALLY_FILLED ─▶ HEDGED        switched off: CLOSING ─▶ OFF
```

| State | Means | What the engine does |
|---|---|---|
| NORMAL | nothing to hedge | watches |
| HEDGE_REQUIRED | more is open than the band allows | sends an order when the wait between orders is over |
| SUBMITTING | an order is at the venue, its fills not all seen | sends nothing more on that symbol |
| PARTIALLY_FILLED | the last order filled in part | sends the rest on later passes |
| HEDGED | within the band | watches |
| STALE | the vault, or the venue's price, cannot be read or is too old | sends nothing; keeps the hedge it has |
| DEGRADED | a limit keeps the hedge from where it should be: margin, the hedge or gross cap, the price gap between venue and Percolator, the order limit, a wait after refusals, more open than `maxUnhedgedUsd`, outside the band for `unhedgedAlarmSecs`, or the account less than `minLiqDistanceBps` from liquidation | keeps hedging as far as the limit allows; near liquidation the hedge may only shrink |
| FAILED | `maxFailures` orders in a row traded nothing | retries, doubling the wait each time up to `maxBackoffSecs`; one fill clears it |
| UNKNOWN | an order's outcome is not known, or the venue cannot be reached | sends nothing until the venue's records settle it |
| EMERGENCY | halted (ledger and venue disagree); or hedges are being cut to keep the account from liquidation; or more than `maxUnhedgedUsd` has been open for `unhedgedAlarmSecs` | halted: nothing. Otherwise carries on. A person is needed |

**The state is not stored.** It is worked out on every pass from the journal and what was just
read. A stored state would be a second record that can disagree with the journal after a crash.
So a restart needs no repair: the failure count, the unresolved orders, halts and switches are
all in the journal, and the state follows from them. A test crashes the process at every single
journal write and checks it ends in the same state, with the same result, as with no crash.
(The two timers, "outside the band for" and "past the limit for", restart with the process.)

Every change of state is printed (`ALERT` for a trouble state) and appended to
`transitions.jsonl`. The latest pass is in `risk.json`. Nothing is pushed anywhere yet.

**The margin guard.** The hedge account can only lose on the hedge when the vault gains, but the
vault's gain is not in the account. Below `minLiqDistanceBps` (10%) the hedge may shrink but not
grow. Below `deleverageLiqDistanceBps` (5%; 0 turns it off) every hedge is cut by the same share,
with reduce-only orders, until the distance is back at 10%; this needs no reading of the vault.
The cut leaves the vault less hedged. The alternative is the venue closing everything, for a
fee, and a halt. The guard does not make a small account large (see "squeeze" below), and a
price jump larger than the distance left gets past it.

## Policy

The target hedge is the opposite of the vault's position times the hedge ratio.

- No order while the hedge is within the band of its target.
- Rounding and every limit make the hedge smaller, never larger: an order never takes the hedge
  past its target or onto the vault's own side.
- The hedge never changes side in one order: it is closed (reduce-only), then reopened.
- Every order is immediate-or-cancel with a limit price near the venue's mid.

Limits (`src/config.ts`; a JSON file in dollars and seconds via `--config`):

| Limit | Default | |
|---|---|---|
| `hedgeRatio` | 1 | share of the vault's position to offset |
| `bandUsd` | 250 | no order inside it |
| `maxHedgeUsd` | 50,000 | largest hedge per symbol |
| `maxOrderUsd` | 10,000 | largest single order |
| `minOrderGapSecs` | 20 | between orders on a symbol |
| `maxSlippageBps` | 30 | limit price distance from the venue's mid |
| `maxBasisBps` | 100 | no order if the venue's price is further than this from Percolator's |
| `maxGrossUsd` | 100,000 | all hedges together |
| `maxOrdersPerHour` | 600 | all symbols together |
| `maxExposureAgeSecs` | 60 | an older vault reading is not acted on |
| `maxQuoteAgeSecs` | 15 | an older venue quote is not acted on |
| `marginRateBps`, `marginReserveUsd` | 2,000 / 500 | new exposure must fit in free margin, less the reserve |
| `lostAfterSecs` | 60 | when an order the venue never saw is given up on |
| `operatorFeeBps` | 2,000 | the operator's share of depositors' fee income (accounting only) |
| `maxUnhedgedUsd` | 10,000 | per symbol: more than this open is DEGRADED, and an EMERGENCY after `unhedgedAlarmSecs`. The hedger cannot enforce it; it has no say over the vault |
| `unhedgedAlarmSecs` | 300 | see above |
| `minLiqDistanceBps`, `deleverageLiqDistanceBps` | 1,000 / 500 | the margin guard |
| `maxFailures`, `maxBackoffSecs` | 3 / 600 | orders that traded nothing: when it is FAILED, and the longest wait |
| `stressBps` | 1,000 | the price move the stress loss is worked out for |
| `maxUnexplainedUsd` | 25 | how far the account's value may be from what the ledger explains |

The policy holds, and says why, when: the symbol is halted; an order is unresolved; the vault
reading is missing, old, from an RPC node that stopped following the chain, or incomplete (a
vault missing, a position with no price); the venue quote is missing or old; the two prices
disagree; margin is short; the order would be below the venue's minimum.

## State and reconciliation

Every order is written to the journal **before** it is sent, with an id fixed by the journal and
the event number. After a crash, an order with no recorded outcome is looked up at the venue by
that id. It is never sent again.

On every pass, before anything is decided:

1. New fills are read from the venue's history into the ledger. A fill that no order of this
   engine produced is recorded too, and **halts** the symbol.
2. Unresolved orders are looked up. An outcome is recorded once the fills seen add up to what
   the venue says was filled. An order the venue has never seen is given up on after
   `lostAfterSecs`; if it turns up later, its fills are still taken in and the excess is traded
   back.
3. Funding the venue charged or paid is read into the ledger, each payment once.
4. Positions are compared. A difference the fill history does not explain **halts** the symbol.
   A position in a market the engine does not manage **halts everything**.

A halt only stops orders. Nothing trades to "fix" a difference. An operator looks, then adopts
the venue's position and resumes (`npm run status -- resume SOL`). Halts survive restarts.

A failed journal write stops the process: it does not carry on with a ledger it could not save.

## The switch

Hedging is **off until it is switched on**, and can be switched while the hedger runs:

```bash
npm run switch -- on          # hedge every configured symbol
npm run switch -- off         # close every hedge and stay out
npm run switch -- off SOL     # one symbol apart from the rest (`clear SOL` to undo)
npm run switch                # show the switches
```

- **Off closes the hedge**; it does not freeze it. The target becomes zero whatever the vault
  holds, and only reduce-only orders are sent, in pieces no larger than the order cap. A hedge
  left open with nothing behind it would be a bet of its own.
- Closing needs no reading of the vault, so a failing RPC cannot keep a switched-off hedge open.
- A halt outranks the switch: a halted symbol is not traded in either direction.
- The command writes `switch.json` in the state directory. The hedger reads it on every pass and
  journals each change, so the switches survive a restart and a deleted file.
- The band already does the fine-grained "only when needed": below it, nothing is hedged. The
  switch is the operator's decision on top of that.

## Terms

Decided 2026-10-01:

- **All of the hedge's result belongs to the depositors**, gains and costs alike.
- **Whoever runs and funds the hedge is paid 20% of the depositors' fee income**
  (`operatorFeeBps`, 2,000).

The simulator and `npm run measure` account for both. **Nothing moves this money yet.** The
hedge's result sits in the venue account and the fee income in the vault; settling one against
the other needs a way to pay hedge gains into the vault and to repay the operator for hedge
losses and pay from it. The first is a transfer. The second means the vault paying out on a
number computed off-chain, which the vault program has no instruction for and which someone
would have to be trusted for (or a cap would have to bound). That is a change to the vault
program, on both chains, and it is not designed yet.

## Solana and X1

The hedger reads the chain through two standard RPC calls and the account layout, which are the
same on both. One hedger watches one deployment:

```bash
RPC=<solana rpc> npm run shadow -- --deployment ../app/src/devnet.json --state state/solana
RPC=<x1 rpc>     npm run shadow -- --deployment <x1 deployment json>   --state state/x1
```

Each has its own journal, switch and venue account.

**One deployment is not a hedge venue for the other.** To offset the Solana vault on X1, the
hedger would trade against the X1 vault, which then holds the position the Solana vault wanted
rid of. The risk moves from one set of depositors to the other; it does not leave. It only
helps to the extent that traders on the two chains happen to be on opposite sides. A hedge
needs a counterparty outside both vaults. Not built: netting the two (a long SOL
vault on one chain against a short one on the other needs no hedge at all, which would save
fees, but then the hedge's result has to be split between two vaults).

## Running it

```bash
cd hedging && npm install

npm test          # 107 tests: policy, journal, engine and crash recovery, reconciliation, risk model, states, simulator, decoder
npm run sim       # every scenario; `npm run sim -- chaos` for one, with its hold reasons
npm run measure   # does hedging pay: depositors' result over 40 sessions per setting (about a minute)
npm run shadow    # live devnet vaults, paper hedge (read-only); RPC=... to change the endpoint
npm run switch    # on / off (see above)
npm run hl        # Hyperliquid test network: make a key, check the connection
npm run testnet   # live devnet vaults, hedge on Hyperliquid's test network
npm run status    # the hedger's state, the risk the vaults still carry, the hedge account; then its journal
npm run dashboard # the same on one page for every hedger on this machine: http://127.0.0.1:8792 (read-only)
```

`../deploy/local-services.sh start` runs a shadow hedger for each deployment (journals in
`state/shadow-devnet` and `state/shadow-x1`), the dashboard, and the chart indexer, and keeps
them running; `stop` and `status` do what they say. The dashboard has no buttons: halts are
lifted and switches flipped from the command line. It listens on this machine only; from
another one, `ssh -L 8792:127.0.0.1:8792 <this machine>` and open http://127.0.0.1:8792.

Shadow mode (`npm run shadow`) runs the real monitor, policy, journal and reconciliation on the live vaults and
holds the hedge on a paper account priced at Percolator's own prices. Its journal is in
`state/shadow/` (not in git).

## What the simulator shows

One session is 2,000 passes of 10 s (5.5 hours) on a vault with $10,000 of deposits, so a
$30,000 position cap. Traders trade up to $4,000 on 40% of passes, about $1.5M a session, and
pay Percolator's 5 bps fee. The venue charges a 5 bps taker fee and has a 2 bps spread.

**What the vault earns.** Percolator settles every trade at the mark, so the vault earns no
spread. Its income is the trading fee. The fee is charged to both sides of a trade and lands in
the market's insurance; the vault harvests it, 10% goes to whoever opened the market, and the
vault's own half was its money to begin with. So of a fee `f`, depositors net `0.8 f` and the
opener gets `0.2 f`: at 5 bps, **4 bps of trader volume for depositors**, 1 bps for the opener
(checked against `e2e_operate_mode_lists_asset_and_harvests_fees` in the vault's tests).

`npm run sim`, one session each. "No hedge" and "hedged" are the depositors' result: fee income
plus what the vault's position made, without and with all of the hedge's result.

| Scenario | Orders | Fee income | Vault P&L | Hedge P&L | Hedge cost | No hedge | Hedged | Risk removed |
|---|---|---|---|---|---|---|---|---|
| calm: traders have no edge | 664 | $645 | +$870 | -$1,725 | $883 | +$1,515 | -$340 | 94% |
| adverse: traders are right 65% of the time | 604 | $564 | -$2,376 | +$1,608 | $776 | -$1,812 | -$317 | 96% |
| two symbols | 1,306 | $1,245 | +$644 | -$2,384 | $1,700 | +$1,889 | -$744 | 95% |
| gross limit too small for both | 768 | $1,245 | +$644 | -$1,419 | $909 | +$1,889 | +$221 | 68% |
| costly: 10 bps spread, funding against | 664 | $645 | +$870 | -$2,314 | $1,468 | +$1,515 | -$928 | 76% |
| gap: -12% in one pass, then an unwind | 667 | $649 | +$372 | -$1,238 | $895 | +$1,021 | -$347 | 94% |
| thin margin: $1,500 hedge account | 427 | $645 | +$870 | -$574 | $309 | +$1,515 | +$812 | 34% |
| half hedge | 627 | $645 | +$870 | -$865 | $440 | +$1,515 | +$521 | 50% |
| venue unreachable for 200 passes | 602 | $645 | +$870 | -$1,691 | $807 | +$1,515 | -$305 | 88% |
| vault reads fail for 200 passes | 602 | $645 | +$870 | -$1,691 | $807 | +$1,515 | -$305 | 88% |
| refused: the venue refuses every order for 300 passes | 568 | $645 | +$870 | -$1,476 | $758 | +$1,515 | -$90 | 83% |
| squeeze: $3,000 hedge account, strong trend, traders on the wrong side | 119 | $496 | +$13,136 | -$2,929 | $146 | +$13,632 | +$10,604 | 22% |
| chaos: faults on 34% of orders, 65 crashes | 501 | $632 | +$518 | -$1,221 | $686 | +$1,151 | -$196 | 81% |

"Hedged" is after the operator's pay (20% of fee income).

In every scenario the ledger equals the venue at the end, nothing halts, no order reaches
the venue twice, and the hedge account is worth exactly what the ledger says it should be.

- **refused**: in 300 passes of refusals the venue is asked 8 times, not 150, and the symbol is
  reported FAILED for that time.
- **squeeze**: the vault gains $13,136 and the hedge, on the other side, loses; the $3,000
  account cannot carry it. With the margin guard it is cut down in steps, never liquidated, and
  the hedger keeps running, in EMERGENCY for 59% of the session. Without the guard the venue
  liquidates the account once and the hedger halts. Either way nearly all of the $3,000 is
  lost: the fix for a small account is a larger account or a smaller hedge, not the guard.

### Does hedging pay?

`npm run measure`: 40 sessions per row, depositors' result per session, in dollars on $10,000
of deposits. "Act on $X" is the band: the hedge moves only when it is more than $X from where it
should be. Depositors' fee income is about $600 a session in all three tables. Hedged rows are
on the agreed terms (below): all of the hedge's result, less the operator's pay (20% of fee
income, about $120 a session).

Traders have no edge:

| Setting | Average | Bad session (1 in 20) | Worst | Hedge cost |
|---|---|---|---|---|
| no hedge | +$924 | -$2,259 | -$2,967 | $0 |
| hedge all, act on $250 | -$339 | -$407 | -$412 | $826 |
| hedge all, act on $1,000 | -$309 | -$380 | -$394 | $793 |
| hedge all, act on $2,500 | -$114 | -$215 | -$217 | $607 |
| hedge all, act on $5,000 | +$137 | -$85 | -$150 | $352 |
| hedge all, act on $10,000 | +$253 | -$370 | -$537 | $157 |
| hedge half, act on $2,500 | +$496 | -$1,203 | -$1,492 | $172 |
| hedge all, act on $5,000, venue fee 0.30% | -$1,330 | -$1,735 | -$1,751 | $1,819 |

Traders lose (on the wrong side of the trend 60% of the time):

| Setting | Average | Bad session (1 in 20) | Worst | Hedge cost |
|---|---|---|---|---|
| no hedge | +$3,284 | +$685 | +$634 | $0 |
| hedge all, act on $250 | -$310 | -$386 | -$415 | $780 |
| hedge all, act on $5,000 | +$234 | -$80 | -$176 | $335 |
| hedge all, act on $10,000 | +$783 | +$303 | +$292 | $157 |
| hedge half, act on $2,500 | +$1,701 | +$404 | +$363 | $167 |

Traders win (on the right side of the trend 60% of the time):

| Setting | Average | Bad session (1 in 20) | Worst | Hedge cost |
|---|---|---|---|---|
| no hedge | -$2,444 | -$5,901 | -$6,170 | $0 |
| hedge all, act on $250 | -$348 | -$454 | -$531 | $784 |
| hedge all, act on $5,000 | -$35 | -$243 | -$1,522 | $331 |
| hedge all, act on $10,000 | -$238 | -$991 | -$1,062 | $152 |
| hedge half, act on $2,500 | -$1,297 | -$2,983 | -$3,899 | $165 |

What this says:

- **Hedging every trade loses money.** The venue charges about as much per dollar (5 bps plus
  spread) as depositors earn per dollar traded (4 bps), so at a $250 band the hedge costs more
  than the whole fee income, every session.
- **A wide band is what makes it work.** Traders' buys and sells partly cancel inside the vault
  for free. Acting only on $5,000 (half the deposits) cuts hedge orders from about 640 to about
  95 and the cost to about $350, and turns a -$2,259 bad session into -$85.
- **The hedge gives up the vault's winnings too.** When traders lose, an unhedged vault makes
  +$3,284 a session; hedged, +$234. A hedge trades a wide range of outcomes for a narrow one,
  which is why it has a switch.
- **A venue charging 0.30% a trade** (a swap pool) costs five times the fee income. Not viable.
- These are simulated traders. What real traders do, and so which table applies, is not known
  until there is real flow; shadow mode on live vaults is how to find out.

## Hyperliquid's test network

```bash
npm run hl -- new-key          # a new key in ~/.config/hyperliquid/testnet-key; prints its address
npm run hl                     # what the test network says about the account (read-only)
npm run hl -- order-check      # sends one order that cannot trade, to prove signing and access
npm run testnet                # the hedger, with its journal in state/hyperliquid-testnet
npm run switch -- on --state state/hyperliquid-testnet
```

The account needs test money: fund the key's address on the test network, or approve the key
as an API wallet of an account that has it and pass `--account 0x...`.

How it is known to work:

- **Signing** reproduces the signatures in Hyperliquid's own SDK tests, byte for byte, and the
  live test network recovers our address from an order we send.
- **Everything else** runs against a fake of Hyperliquid's API in front of the mock venue
  (`test/fake-hyperliquid.ts`), which keeps the habits that make an adapter's life hard: fills
  carry the exchange's order id and not ours, a refused order leaves no record, prices must be
  on the tick, and the sender is whoever the signature recovers to. The engine's crash test
  (a crash at every journal write) and the fault-injection scenario pass through it.
- **Not yet seen live:** a fill. Until an order has filled on the funded test account, three
  things rest on the documentation and the fake: that a cancelled order reports what is left in
  `sz`, that an order that traded nothing leaves no record, and the fee fields of a fill. If
  any is wrong the effect is a halt ("the venue reports X filled, its fill history shows Y"),
  not a wrong trade.

Limits of the adapter: cross margin only (HYPE is isolated-only on the test network and is left
out); sizes down to a millionth of a coin; fees not paid in USDC are counted as zero.

## Before real money

Not done, on purpose:

- **The real exchange.** The adapter is the test network's only; enabling the real one is a
  code change, to be made after the live test-network run above.
- **Cash is reconciled in total, not line by line.** The account's value is checked against the
  ledger (see the risk model); individual fees and funding payments are not checked against the
  venue's statement. On Hyperliquid the funding history and the margin figures have not been seen
  live yet (they follow the documentation and the fake).
- **Alerts are not sent anywhere.** State changes are printed and written to `transitions.jsonl`;
  nothing pages a person.
- **The hedger cannot slow the vault down.** When more is open than `maxUnhedgedUsd`, all it can
  do is say so. Making the vault accept only reducing trades until the hedge catches up would be
  a change to the vault program.
- **No settlement** between the hedge account and the vault (see Terms).
- `lostAfterSecs` must be longer than the longest time the venue can take to act on an order
  that was sent; otherwise a late order briefly doubles the hedge before it is traded back.
- The test network's prices are its own. Where they are further from Percolator's than
  `maxBasisBps`, the hedger holds; that is the limit working, not a fault.
- Mainnet prices, sizes and venue lot sizes: the defaults are sized for the devnet vaults.
