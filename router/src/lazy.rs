//! Lazy settlement (speed work, 2026-11-05: docs/SPEED-FORK.md).
//!
//! Percolator marks every position on an asset out of date at each price move and refuses
//! every trade that adds risk until all of them are re-valued. With many holders that is most
//! of the time and cost of a fill. Our engine fork can take a trade without waiting for the
//! others (`execute_trade_with_fee_cohort_tolerant_not_atomic`, asked for by the vault's matcher
//! with `FLAG_COHORT_TOLERANT`): the trader and the vault are still re-valued in the trade.
//!
//! What that risks is a hidden bankruptcy. An account that is out of date may already owe more
//! than it holds, and when it is finally re-valued its deficit is shared out among positions on
//! the other side, including ones opened meanwhile. This module lets a fill skip the others only
//! while that cannot have happened:
//!
//! - A `PriceRange` account per vault records the lowest and highest price the asset can have
//!   been at since the last moment every account on it was up to date: it restarts whenever the
//!   router sees no account out of date, and takes in every mark the router moves to (the mark
//!   only moves through the router, and Percolator's price only walks toward the mark).
//! - A fill may skip the others while that range is within `RANGE_SHARE` of Percolator's own
//!   maintenance margin: an account that was up to date and above maintenance cannot have lost
//!   all of its margin since. And only while the asset's funding and social-loss indices have
//!   not moved since the restart (no funding paid, no deficit shared out).
//! - The range must have seen every mark since the restart (`mark_at`): a mark move without it
//!   (an executor that does not pass it) spoils it until everyone is up to date again.
//!
//! Accounts that were already below maintenance when last re-valued are not covered by this:
//! as today, the executor finds and liquidates them (it re-values accounts near their level on
//! every pass), and the router liquidates before Percolator's own level.

use percolator_vault::percolator as perc;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use crate::state::*;
use crate::RouterError;

/// The most the range may span, as a share of Percolator's maintenance margin (1/4: on a 2.5%
/// market, 62 bps).
pub const RANGE_SHARE_DIV: u64 = 4;

/// The vault's range account among `accounts` (any position: it is recognised by its owner,
/// layout and vault), if one was passed writable.
pub fn find<'a, 'b>(program_id: &Pubkey, accounts: &'b [AccountInfo<'a>], vault: &Pubkey) -> Option<&'b AccountInfo<'a>> {
    accounts.iter().find(|a| {
        a.owner == program_id
            && a.is_writable
            && a.data_len() == RANGE_LEN
            && a.try_borrow_data().is_ok_and(|d| d[..8] == RANGE_MAGIC.to_le_bytes() && d[8..40] == vault.to_bytes())
    })
}

/// Restarts the range when every account on the asset is up to date: at the effective price and
/// the mark the price is walking to, with the funding and social-loss indices as they are now.
pub fn restart_if_current(r: &mut PriceRange, market: &[u8], asset: u16, b: &Book) -> Result<(), ProgramError> {
    let (stale, indices) = perc::asset_cohort(market, asset)?;
    if stale != 0 {
        return Ok(());
    }
    let (_, effective, _) = perc::asset_price(market, asset)?;
    let mark = if b.mark_price != 0 { b.mark_price } else { effective };
    r.low = effective.min(mark);
    r.high = effective.max(mark);
    r.indices = indices;
    r.mark_at = crate::mark_times(b).0;
    r.valid = 1;
    Ok(())
}

/// After the mark moved from `before` (its router time) to `price` at `at`: the range takes the
/// new price in, or is spoilt if it had missed a move.
pub fn take_mark(r: &mut PriceRange, before: i64, at: i64, price: u64) {
    if r.valid == 1 && r.mark_at == before {
        r.low = r.low.min(price);
        r.high = r.high.max(price);
        r.mark_at = at;
    } else {
        r.valid = 0;
    }
}

/// Whether a fill now may skip re-valuing the asset's other accounts.
pub fn tolerant(r: &PriceRange, market: &[u8], asset: u16, b: &Book) -> Result<bool, ProgramError> {
    let (stale, indices) = perc::asset_cohort(market, asset)?;
    if stale == 0 || r.valid != 1 || r.mark_at != crate::mark_times(b).0 || { r.indices } != indices || r.low == 0 {
        return Ok(false);
    }
    let mm = perc::maintenance_margin_bps(market)?;
    let span = (r.high as u128 - r.low as u128).saturating_mul(10_000);
    Ok(span <= (r.low as u128).saturating_mul((mm / RANGE_SHARE_DIV) as u128))
}

/// `OpenRange` (anyone, the payer pays the rent): starts a vault's range account. It is spoilt
/// until the router first sees every account on the asset up to date.
///
/// Accounts: 0 payer [s, w], 1 vault, 2 book, 3 range [w], 4 system program.
pub fn open_range(program_id: &Pubkey, accounts: &[AccountInfo]) -> solana_program::entrypoint::ProgramResult {
    let (payer, vault_ai, book_ai, range_ai, system) = (crate::acc(accounts, 0)?, crate::acc(accounts, 1)?, crate::acc(accounts, 2)?, crate::acc(accounts, 3)?, crate::acc(accounts, 4)?);
    crate::signer(payer)?;
    crate::writable(range_ai)?;
    crate::key_is(system, &solana_program::system_program::ID)?;
    crate::load_vault(vault_ai)?;
    let b: Book = load_book(book_ai, program_id)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    let (rk, bump) = range_address(program_id, vault_ai.key);
    crate::key_is(range_ai, &rk)?;
    if range_ai.owner == program_id {
        return Ok(()); // already open
    }
    crate::create_pda(payer, range_ai, system, program_id, RANGE_LEN, 0, &[SEED_RANGE, vault_ai.key.as_ref(), &[bump]])?;
    let mut r = <PriceRange as bytemuck::Zeroable>::zeroed();
    r.magic = RANGE_MAGIC;
    r.vault = *vault_ai.key;
    r.bump = bump;
    store(range_ai, &r)
}
