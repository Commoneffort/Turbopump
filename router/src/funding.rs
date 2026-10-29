//! Funding: what the crowded side pays the other, every slot, for holding.
//!
//! On our markets the mark is the oracle price itself (that is what makes trades impossible to
//! front-run), so there is no perp-against-index premium to read a rate from. The pressure that a
//! premium measures elsewhere shows here as the vault's position: the vault takes the other side
//! of every trade, so when traders crowd one side the vault holds the other, and how full it is
//! against its limit says how one-sided the market is. The rate follows that:
//!
//! - under `FUNDING_FREE_BPS` of the vault's limit used: no funding (ordinary two-way flow);
//! - from there to the whole limit: rising in a straight line to `FUNDING_MAX_E9` per slot;
//! - the crowded side pays: the vault long means traders are net short, so shorts pay
//!   (a negative rate, Percolator's sign: positive = longs pay).
//!
//! The rate moves toward that target gradually, as an average over about `FUNDING_TAU_SLOTS`
//! (an hour): a single large trade, or a whale opening and closing, cannot set the rate at once.
//! Percolator accrues it every slot on every position, inside its own accounting: funding is
//! part of an account's equity, so it counts toward margin and liquidation like any loss, and
//! what one side pays the other receives (the vault included, which holds the opposite side).
//! Percolator bounds every rate by the market's cap (the vault's `CANON_MAX_FUNDING_E9`).
use super::*;

/// The most the router's rate reaches (e9 per slot): 30 is about 0.027% an hour at 0.4 s slots,
/// 0.65% a day, at a vault on its whole limit.
pub const FUNDING_MAX_E9: i64 = 30;
/// Below this share (bps) of its limit the vault's position pays no one.
pub const FUNDING_FREE_BPS: u128 = 2_000;
/// The rate's time constant (slots): about an hour at 0.4 s slots.
pub const FUNDING_TAU_SLOTS: u64 = 9_000;

/// Where the rate is heading, for a vault holding `inventory` (units, positive = long) against a
/// position limit of `limit` units: zero under `FUNDING_FREE_BPS`, then in a line to
/// `FUNDING_MAX_E9` at the limit; signed so the crowded side (opposite the vault) pays.
pub fn target_rate(inventory: i128, limit: u128) -> i64 {
    if inventory == 0 || limit == 0 {
        return 0;
    }
    let used = (inventory.unsigned_abs().saturating_mul(10_000) / limit).min(10_000);
    if used <= FUNDING_FREE_BPS {
        return 0;
    }
    let rate = (FUNDING_MAX_E9 as u128 * (used - FUNDING_FREE_BPS) / (10_000 - FUNDING_FREE_BPS)) as i64;
    // The vault long: traders are net short, and shorts pay (negative). The vault short: longs pay.
    if inventory > 0 { -rate } else { rate }
}

/// The next rate: `current` moved toward `target` by the share of `FUNDING_TAU_SLOTS` that has
/// passed since it was set (`elapsed` slots), rounded toward the target, never past it.
pub fn next_rate(current: i64, target: i64, elapsed: u64) -> i64 {
    if elapsed >= FUNDING_TAU_SLOTS {
        return target;
    }
    let gap = target as i128 - current as i128;
    let step = gap * elapsed as i128 / FUNDING_TAU_SLOTS as i128;
    // At least one unit toward the target once any time has passed, so small gaps close.
    let step = if step == 0 && gap != 0 && elapsed > 0 { gap.signum() } else { step };
    (current as i128 + step) as i64
}

/// The vault's position limit (units) at `price_e6`, as its matcher counts it (`fill_caps`):
/// its tier's multiple of its value.
pub fn position_limit(v: &vstate::VaultState, price_e6: u64) -> u128 {
    let tier = percolator_vault::feeds::cap_tier(&v.oracle_feeds[0]);
    let bps = v.position_nav_bps.min(percolator_vault::feeds::position_nav_bps(tier));
    percolator_vault::math::nav_cap(v.last_nav, bps, price_e6)
}

/// Brings the rate of the vault's asset one step toward its target and has the vault push it.
/// Does nothing when the market has no funding cap, when the asset is not accrued to this slot
/// (Percolator would refuse the rate: it never applies one to elapsed slots), or when the rate
/// would not change. So it can never make the instruction it is part of fail for timing.
///
/// `accounts`: the vault, the market [w], the router authority, the vault program, Percolator.
pub fn refresh<'a>(vault_ai: &AccountInfo<'a>, market: &AccountInfo<'a>, authority: &AccountInfo<'a>, vault_program: &AccountInfo<'a>, percolator: &AccountInfo<'a>, abump: u8) -> ProgramResult {
    let v = load_vault(vault_ai)?;
    key_is(market, &v.market)?;
    key_is(vault_program, &percolator_vault::id())?;
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    let now = Clock::get()?.slot;
    let next = {
        let d = market.try_borrow_data()?;
        let cap = perc::max_abs_funding_e9(&d)?;
        let (_, price, slot_last) = perc::asset_price(&d, v.asset_index)?;
        if cap == 0 || slot_last != now || price == 0 {
            return Ok(());
        }
        let (current, set_at) = perc::authority_funding(&d, v.asset_index)?;
        let target = target_rate(v.inventory, position_limit(&v, price));
        let elapsed = if set_at == 0 { FUNDING_TAU_SLOTS } else { now.saturating_sub(set_at) };
        let bound = (cap as i64).min(FUNDING_MAX_E9);
        let next = next_rate(current, target, elapsed).clamp(-bound, bound);
        if next == current {
            return Ok(());
        }
        next
    };
    let mut data = vec![percolator_vault::processor::TAG_PUSH_FUNDING];
    data.extend_from_slice(&next.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: percolator_vault::id(),
            accounts: vec![
                AccountMeta::new_readonly(*authority.key, true),
                AccountMeta::new_readonly(*vault_ai.key, false),
                AccountMeta::new(*market.key, false),
                AccountMeta::new_readonly(PERCOLATOR_PROGRAM_ID, false),
            ],
            data,
        },
        &[authority.clone(), vault_ai.clone(), market.clone(), percolator.clone(), vault_program.clone()],
        &[&[SEED_AUTHORITY, &[abump]]],
    )
}

/// `RefreshFunding` (tag 31, anyone): one step of the rate for a market whose vault has not
/// traded for a while (a fill does the same step itself). Send it after the cranks that bring
/// the asset to the current slot, in the same transaction; otherwise it does nothing.
///
/// Accounts: 0 vault, 1 market [w], 2 router authority, 3 vault program, 4 Percolator.
#[inline(never)]
pub fn refresh_funding(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (vault_ai, market, authority, vault_program, percolator) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?, acc(accounts, 3)?, acc(accounts, 4)?);
    writable(market)?;
    let (ak, abump) = authority_address(program_id);
    key_is(authority, &ak)?;
    refresh(vault_ai, market, authority, vault_program, percolator, abump)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_crowded_side_pays_more_the_fuller_the_vault() {
        // Limit 100 units. Up to 20 used: nothing.
        assert_eq!(target_rate(20, 100), 0);
        assert_eq!(target_rate(-20, 100), 0);
        // Vault long 60 (traders net short): shorts pay half the maximum.
        assert_eq!(target_rate(60, 100), -FUNDING_MAX_E9 / 2);
        // Vault short 100 (traders net long): longs pay the maximum, and never more.
        assert_eq!(target_rate(-100, 100), FUNDING_MAX_E9);
        assert_eq!(target_rate(-500, 100), FUNDING_MAX_E9);
        assert_eq!(target_rate(5, 0), 0);
    }
    #[test]
    fn the_rate_moves_toward_its_target_over_an_hour() {
        assert_eq!(next_rate(0, 30, FUNDING_TAU_SLOTS), 30);
        assert_eq!(next_rate(0, 30, FUNDING_TAU_SLOTS / 2), 15);
        assert_eq!(next_rate(30, 0, FUNDING_TAU_SLOTS / 3), 20);
        // A small gap still closes, a unit at a time, never overshooting.
        assert_eq!(next_rate(29, 30, 1), 30);
        assert_eq!(next_rate(30, 30, 100), 30);
        assert_eq!(next_rate(-10, 10, 0), -10);
    }
}
