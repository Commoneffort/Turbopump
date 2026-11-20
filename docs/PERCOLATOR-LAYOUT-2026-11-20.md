# Percolator layout switch, 2026-11-20 (read this before touching Percolator again)

On 2026-11-20 both test networks (X1 testnet, Solana devnet) moved to upstream's engine
c030aa4. That engine stores 64 more bytes per asset slot in every market account
(upstream #247 provider principal, #449 raw-basis sums). The live markets were moved in place
with a one-shot migration; nobody had to close positions.

## The points that matter

1. **No rollback.** A program from before 2026-11-20 cannot read a migrated market (it fails with
   `InvalidAccountData`). Any fix from now on must be a fix *forward* on branch
   `merge/2026-11-20-layout` or later. Do not redeploy an older Percolator binary
   (e.g. `backups/2026-11-20/engine-merge-e6d5f91d.so` or older).
2. **What is live.** Percolator binary sha256 `55ba2085…`
   (`backups/2026-11-20/engine-layout-55ba2085.so`), built from
   `Commoneffort/percolator-prog` `merge/2026-11-20-layout` (10a2beaf), which pins
   `Commoneffort/percolator` `merge/2026-11-20-layout` (e026541) by commit. Vault/router/app:
   this repo at 254d5800 (and later).
3. **Migrated markets.** X1: 281YHBA8 (main), 5fBaKk5D, 74jd4xa2, EHurKZwo, 7a56g7R3 (idle split
   markets), 4AzMyRdA (old, empty). Devnet: 35XfkPtq (main), 8ZMjDzhA (old).
   **Not migrated:** devnet F9zUEE5M (retired): one side had been force-reduced with positions
   open, so its new totals cannot be derived exactly. It is frozen under the new program.
4. **How a market is migrated.** Percolator tag 73 (`MigrateMarketLayoutV2`, market authority
   only, refuses anything but an exact move) — for our governed markets through the vault's
   tag 46 (`MigrateMarketLayout`, anyone may send; the governor PDA signs, the payer adds rent).
   `app/scripts/migrate-layout.ts` shows each market's layout and, with `go`, migrates.
5. **Both layouts are read** by the vault/router (`src/percolator.rs`: `market_slot_len`,
   `engine_field`), the app (`app/src/chain.ts`: `marketLayout`) and the leaderboard API.
   Keep that until every market we care about is migrated; a new market is created in the
   new layout.
6. **Upstream still has the #172 crank-order bug** (checked on unmodified c030aa4): when the
   keeper liquidates the loser before the winner is settled, the winner can be paid far less
   (example: 601,851 instead of 1,597,136, with 995,284 left unowned). Reproduction:
   `tests/kf_before_b_crank_order.rs` in our engine branch (4 of 5 fail upstream; the sweep finds
   153 of 1,097 scenarios order-dependent). Our engine keeps the fix (commit "Settle pending K/F
   before a standalone SettleB crank step"). Upstream closed issue #172 on 2026-11-10; the
   follow-up comments showing the gap (2026-11-12, ours included) got no reply, and upstream's
   newer test `inv_071 … public_b_prerequisite …` assumes the buggy order. **Do not drop our fix
   when merging upstream** unless upstream fixes the order itself (rerun that test file to check).

## Expected program-suite failures on our branch

Against unmodified upstream, our program branch fails extra tests for three known reasons, each
proved by rebuilding without the cause:
- rosters/pin guards that do not list our extra instructions (tags 71, 72) or our engine pin;
- funding tests: our funding design (tag 71: the oracle authority sets each asset's rate;
  funding is off on our markets);
- `inv_061 … reset_carry_liquidation_matrix …` and `inv_071 … public_b_prerequisite …`: our
  crank-order fix (point 6).

## How it was checked

- Engine tests all pass; vault/router `./test.sh` 196/196 (incl. `tests/layout_dual.rs`: every
  reader gives the same answers on the live markets before and after migration).
- 807 live X1 transactions replayed on migrated markets with the new Percolator, vault and router:
  the same 638 succeed, all 11,578 resulting accounts byte-identical, compute +0.4%
  (`tools/replay/`).
- Migration rehearsed on a local validator with cloned X1 markets; after the real switch every
  market is in Live mode, passes the engine's shape check, and X1 fill/failure rates match the
  hours before.

## Deploy gotchas met on the day

- `deploy/release-check.sh` must pass before `deploy/upgrade-program.sh vault|router`.
- Pre-write a Percolator buffer with `app/scripts/write-buffer.ts` (same buffer key file the
  upgrade script uses) while services still run; the upgrade then only switches (seconds).
- Do not pipe `deploy/x1-services.sh start` into `tail`: the started services keep the pipe open
  and the command never returns.
