# Proposal (not submitted): an idle asset catches up in one accrual call

Status, 2026-10-02: **held back.** The engine change is small and its own tests and proofs
pass, but percolator-prog's suite pins the behaviour it changes in five tests, two of them
around backing expiry. Nothing was pushed or posted upstream. The change lives on the local
branch `pr/idle-asset-catchup` of the engine repository (commit `217c007`, based on upstream
`4db11a8`) and as `idle-asset-catchup.diff` here.

## The cost it addresses

Every asset has to be accrued in steps of at most `max_accrual_dt_slots`, traded or not. On a
chain that charges per compute unit this is paid continuously for every listed asset: about
26,000 units per asset per crank, 21,600 cranks a day at 10 slots a crank.

## The change

In `accrue_asset_path_to_not_atomic`, for an asset with no exposure:

- `canonical_accrual_price_step_v16` returns the target at once (`!exposed`);
- `accrual_activity_for_asset_segment` reports no price move and no funding (both need
  exposure);
- so every bounded call after the first changes `slot_last` and nothing else.

The patch moves `slot_last` to `now_slot` in the same call, after the cohort epoch has been
taken at the end of the bounded prefix (so `kf_epoch_*` is what a bounded call leaves today).
It applies only when the asset has no effective open interest, no stored positions, no stale
accounts and no pending obligations on either side, and its price has reached the target.
The work stays constant: no loop is added. The wrapper is unchanged; it reads `slot_last`
after the call. 25 lines in one function.

## What was checked

Engine (`aeyakovenko/percolator` at `4db11a8` plus the change):

- `cargo test` and `cargo test --features fuzz`: 248 pass, 0 fail.
- New test: one call equals one canonical call per slot, on the whole header and asset state,
  for gaps of 1 to 5,000 slots and prices up, down and unchanged (apart from the cohort
  epoch, pinned to the bounded call's value). This test caught the first version of the patch
  writing a later cohort epoch than today's code; the order was fixed.
- New test: an asset with stored positions, stale accounts or pending obligations is still
  accrued in bounded segments.
- New Kani proofs, both pass: `proof_v16_idle_asset_accrual_reaches_now_in_one_call` (any gap
  from 2 to 255 slots, price unchanged or moved; value, residual and epochs untouched; 100 s)
  and `proof_v16_exposed_asset_accrual_stays_bounded_under_idle_catch_up` (199 s).
- The plain Kani lane (`cargo kani --tests --features fuzz`): stopped at 173 of about 324
  harnesses. 171 passed; 2 hit the 30-minute limit on a machine running ten at once
  (`proof_v16_public_terminal_insurance_retirement_rejects_every_live_reservation_class` and
  `..._rejects_provider_earnings`; neither touches accrual, and neither was rerun alone).
  The closure and contracts lanes were not run.

Program (`aeyakovenko/percolator-prog` at `5cb331dd`, `cargo test --tests`, stable toolchain):

- Baseline: 1,787 pass, 262 fail. With the change: 1,771 pass, 278 fail. Nothing newly passes.
- 11 of the 16 new failures are guards that `Cargo.lock` names the certified engine revision;
  they fail for any engine other than the pinned one.
- **5 are real differences in behaviour**, all on assets with no positions:

| Test | What it expects | With the change |
|---|---|---|
| `inv_020 ... hybrid_soft_stale_boundary_uses_clock_not_caller_slot` | each of 4 cranks advances `slot_last` by one ("fallback catch-up must respect the configured one-slot accrual cap") | the first crank reaches the clock slot (14, expected 11) |
| `inv_027 ... reward_mapping_preserves_owner_local_first_risk_across_routes` | `slot_last == OPEN - 2` after a run of cranks | further along (7, expected 5) |
| `inv_073 ... mixed_backing_expiry_preserves_senior_and_live_domain_exit` | lapsed-source cleanup reaches `EXPIRY - 1`, then `EXPIRY` | reaches `EXPIRY` at once (4, expected 3) |
| `inv_074 ... v16_bpf_stale_asset_does_not_block_current_unrelated_trade` | a stale asset takes several cranks | the second crank has nothing to do (NonProgress) |
| `inv_063 ... v16_attack_backing_expiry_no_overpay` | two `CloseResolved` passes converge | the first pass pays everything, the second has nothing to do (NonProgress) |

In the last one the amount paid is the same either way (1,040: capital plus backing, the
test's bound); only the number of passes differs. That was checked by running the test on both
engines with the amounts printed. The other four were read, not instrumented.

## Why it is held back

- The engine-level statement ("only the clock moves") is proved. The program-level flows are
  not covered by it: an asset with no positions can still carry backing buckets with expiry
  slots and source-domain claims, and upstream's tests step such assets one bounded segment
  at a time. Whether bounded stepping there is a property the design relies on, or only what
  the code happened to do, is the maintainer's to say.
- A proposal would have to come with the five tests updated, which changes what upstream's
  invariant suite asserts.
- The idle condition may need to exclude assets whose domains hold backing or claims. That
  would keep the saving for a market nobody has ever touched and lose it for one that is
  winding down.

## What it would save (measured on a local validator, 19 markets)

An asset idle since listing was current after one crank; trades on such assets filled
normally; epochs rolled. Idle assets then cost nothing to keep; an asset with positions costs
what it does today (its accrual cranks, and a settlement crank per holder after each price
move).

## If it is taken further

The cheapest next step is a question to the maintainer, with the measurements and the five
tests named: is one bounded accrual segment per call required for an asset with no exposure?
The executor and keeper have the matching switches (`IDLE_JUMP=1`, `PERCOLATOR_SKIP_IDLE=1`),
off by default and only meaningful against an engine with this change.
