# Draft PRs for aeyakovenko/percolator-prog #455 (AuthMark funding) — not submitted

Two changes, one per repository. Both are on our forks' branches and deployed nowhere yet.

## 1. percolator-prog: `PushAuthFunding` and `UpdateFundingCap` (branch `funding/authority-rate`)

**Problem (#455).** On an `AuthMark` asset the pushed mark is both the price target and the funding
mark, and the funding index is the effective price, so the premium is non-zero only while the
effective price walks to a new mark. `AuthMark` assets have no persistent funding, whatever
`max_abs_funding_e9_per_slot` is; and that cap is fixed at `InitMarket`.

**Change.**
- Tag 71 `PushAuthFunding { asset_index, market_id, now_slot, rate_e9: i64, observation_sequence, authority_epoch }`,
  signed by the asset's oracle authority. Accepted only when the asset is `AuthMark`, `asset_index >= 1`,
  the market is live, `|rate_e9| <= max_abs_funding_e9_per_slot`, and the asset is accrued to the
  authenticated slot (so a new rate never applies to elapsed slots: no pending/checkpoint state is
  needed). Shares the asset's `OracleObservation` sequence lane with `PushAuthMark`.
- For `AuthMark` profiles, `funding_rate_from_checkpoint_view` returns the authority's rate (bounded
  by the cap) instead of the convergence premium. Both call sites already have the group and asset.
- Storage: assets >= 1 never use the market-wide policy lanes of their control sequences (asset 0
  owns them). The rate (i64 bits) goes in `trade_fee`, the asset generation it was set for in
  `liquidation_fee` (a rate never survives an asset retirement), the slot in `maintenance_fee`. No
  account changes size; a typed overlay would be cleaner if you prefer.
- Tag 72 `UpdateFundingCap { max_abs_funding_e9_per_slot, policy_sequence, authority_epoch }`, signed
  by `marketauth`; rebuilds the runtime config and runs `validate_public_user_fund` (the solvency
  envelope, including `validate_funding_headroom` over `min_funding_lifetime_slots`) before writing.
  Sequence on asset 0's `TradeFee` lane, shared with `UpdateTradeFeePolicy`.
- Both tags added to `public_tag_is_known`.

**Behaviour with no cap.** `max_abs_funding_e9_per_slot == 0` returns before the new branch, so an
upgraded market behaves exactly as before until its cap is raised. Replayed on saved copies of two
live markets: same outcomes, same compute within 0.1%.

## 2. percolator (engine): exact funding indices (branch `funding/precision`)

**Problem.** Both accrual paths compute `funding_index_delta = floor(rate_e9 * dt * price / FUNDING_DEN)`
and only then scale it by `A`. Anything below one price unit per unit of position per segment is
lost. On the canonical path a segment is one slot, so a rate below `1e9 / price_e6` e9 per slot accrues
nothing: at $1 that is 1000 e9/slot (about 1% an hour at 0.4 s slots). Realistic rates pay nothing on
any asset under roughly $1,000.

**Change.** `kernel_funding_index_deltas_exact(funding_n, a_long, a_short)`: each side's delta is
`funding_n * a_side / FUNDING_DEN`, rounded toward minus infinity (`floor_div_signed_conservative_i128`),
so the payer pays at least its share and the receiver gets at most. K deltas are unchanged.

**Effect on invariants.** Funding is no longer exactly zero-sum: settling it can leave up to one atom
per settled leg that nobody is owed (always in the market's favour). Two spec tests pinned the old
rounding and are updated (exact expected values; zero-sum up to that dust). The rest of the engine
suites (spec, unit, fuzz incl. rounding residue, reference conformance, backing double-claim,
resolved insolvent, issue 172) pass unchanged. Kani harnesses for the new kernel function are not
written yet.
