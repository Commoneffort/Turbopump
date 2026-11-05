# Speed work: where we leave upstream, and how to go back

**Status: built on 2026-11-05 on branch `speed/2026-11` (all three repositories); see "Where it
stands" at the end.**

> **Flag.** This work moves Turbopump away from upstream Percolator. The router and executor
> changes are ours alone, as before. The engine change (part 3) edits Percolator's own
> settlement rules in our fork, which upstream does not have. After it ships, every upstream
> engine merge has to be redone on top of it. If the new version is not satisfactory, roll back
> to the tagged version below.

## The version to go back to

Everything that was live on X1 testnet and Solana devnet on 2026-11-05, before this work, is
tagged `pre-speed-fork-2026-11-05`:

| Repository | Tag points at | What it is |
|---|---|---|
| `percolator-vault` (Turbopump) | `86d414f7` | vault + router (dc11a1ac code), executor with the 0.4 s held price, docs |
| `percolator-prog` | `5e191084` | the Percolator program build that is live |
| `percolator` (engine) | `84fabf9` | branch `merge/2026-11-03-compat`, pinned by the program |

The deployed binaries are copied in `~/percolator/backups/pre-speed-fork-2026-11-05/`:
`{router,vault,engine}.{x1,devnet}.so` (as dumped from chain on 2026-11-05).

### Rolling back

1. Programs: upload the saved binaries over the new ones, for example:
   `PERCOLATOR_SO=~/percolator/backups/pre-speed-fork-2026-11-05/engine.x1.so deploy/upgrade-program.sh engine x1`.
   For the router and vault, check out the tag, run `deploy/release-check.sh`, then
   `deploy/upgrade-program.sh router x1` (and `devnet`). The release gate rebuilds the same bytes.
2. Services: check out the tag in `percolator-vault` and restart the executors, witness and
   price services.
3. Let the request queue empty before switching versions. A request queued under one
   version's time rules should not be filled under the other's. The router refuses to mix them
   (see "Slot time" below), so a leftover request only waits and then expires.

## What changes

| Part | Where | Leaves upstream? | Expected effect |
|---|---|---|---|
| 1. Slot time on X1 | router + executor | no (ours only) | delay counted in slots (~0.35 s each), not the lagging chain clock |
| 2. Price posted at the target slot | executor | no | no waiting for a quiet price service, no 0.4 s hold |
| 3. One-transaction fills | **engine fork** | **yes** | a fill settles only the trader and the vault, not every position on the market |
| 4. Delay that follows the market | router (risk dial) | no | short delay in calm markets, longer when prices move fast |
| 5. Instant lane (signed maker quotes) | router + maker program | no | ~0.4 s fills for quoted sizes, once there are makers |

Measured before starting (2026-11-05): fills took ~5 s on X1. Someone who sees the price first
can gain about 1 bps per trade at any horizon up to 4 s (worst 1 in 100: 2.7 bps at 0.8 s), while a
round trip pays 10 bps in fees. The delay therefore only needs to cover the time it takes our
price to reach the chain, not 4 seconds.

## Scale

Today every price move marks every open position on the market as out of date, and nobody
can open a position until all of them are updated: the work per round grows with the number of
open positions (~150 updates per second per market account at most). Part 3 removes that: a
fill touches two accounts whatever the number of holders. The other limit is the market
account itself: every fill writes it, and a chain caps the compute one account can use per
block, so one market account tops out at a few hundred fills per second. Beyond that, an asset
needs several markets (several vaults), which the executor already serves in parallel.

## Where it stands

| Part | State |
|---|---|
| 1. Slot time on X1 | built and tested (router X1 build: `SLOT_TIME`, `DELAY_SLOTS` 3, `BATCH_SLOTS` 2, `GRACE_SLOTS` 250; posted prices carry their post slot) |
| 2. Price at the target slot | built (executor posts the latest price one slot before the target, `POST_LEAD_SLOTS`) |
| 3. Lazy settlement | built and tested: engine `execute_trade_with_fee_cohort_tolerant_not_atomic`, program matcher flag `FLAG_COHORT_TOLERANT`, vault `ARMED_COHORT_TOLERANT`, router `lazy.rs` (`PriceRange`, tag 36), executor `LAZY_FILLS` |
| 4. Delay follows the market | built: the delay doubles per risk-dial step, and price speed (`risk::speed_bps`) raises the dial |
| 5. Instant lane | not built (needs makers to quote) |

Not yet built either: price, mark move and fill in one transaction (measured ~580k compute
units together, so it fits) and a ring of recent prices so that any executor can fill on X1.

Upgrading: services detect slot time from the router's own values, so they run unchanged
before and after the router upgrade. Upgrade order: engine, vault, router; restart the
executors on the new code first. Old marks and requests (unix seconds) are recognised: an old
mark counts as long ago, an old request expires by the clock (`tests/x1.rs`).

Checks: Turbopump suite (both builds) passes; engine suite passes plus three new tests; the
forked program replays a copy of live X1 (`issues/replay-2026-11-05`) identically to the
deployed one.
