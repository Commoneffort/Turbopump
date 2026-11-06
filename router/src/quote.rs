//! Maker quotes (2026-11-06): the instant lane. A maker (see the vault program's `maker`) signs a
//! price for one taker off chain; the taker's transaction carries the signature (an Ed25519
//! verification instruction just before this one) and `TakeQuote` trades it at once, in the slot
//! it lands in, against the maker's portfolio.
//!
//! Why nobody is front-run: the maker fixed the price before the taker sent anything, the quote
//! names the taker's trading account and is good once, and the maker chose how long it stays
//! good (`MAX_QUOTE_SLOTS` at most). The vault takes no part; a trade without a quote goes
//! through the queue and its delay as before.
//!
//! The taker is held to everything a router fill holds it to: its margin at its tier (with the
//! risk dial), the fees owed to the vaults (`carry`), close-only markets and isolated accounts.
//! The quoted price must be within `QUOTE_BAND_BPS` of Percolator's price.

use percolator_vault::{maker, percolator as perc, processor::TAG_ARM_QUOTE};
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    ed25519_program,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    pubkey::Pubkey,
    sysvar::{instructions as ixs, Sysvar},
};

use crate::state::*;
use crate::*;

/// Signed bytes: domain, maker account, taker's trading account, asset, taker size (+ = taker
/// buys), price (e6), last slot it is good for, quote id.
pub const QUOTE_DOMAIN: &[u8; 8] = b"TPQUOTE1";
pub const QUOTE_MSG_LEN: usize = 8 + 32 + 32 + 2 + 16 + 8 + 8 + 8;
/// The longest a quote may be good for (about a minute of X1 slots).
pub const MAX_QUOTE_SLOTS: u64 = 150;
/// How far a quoted price may be from Percolator's price.
pub const QUOTE_BAND_BPS: u128 = 100;
/// Test builds: the tag of the no-op instruction standing in for the Ed25519 precompile.
pub const TEST_SIGNATURE_STANDIN: u8 = 250;

#[allow(clippy::too_many_arguments)]
pub fn quote_message(maker: &Pubkey, taker: &Pubkey, asset: u16, size: i128, price: u64, expiry: u64, id: u64) -> [u8; QUOTE_MSG_LEN] {
    let mut m = [0u8; QUOTE_MSG_LEN];
    m[..8].copy_from_slice(QUOTE_DOMAIN);
    m[8..40].copy_from_slice(maker.as_ref());
    m[40..72].copy_from_slice(taker.as_ref());
    m[72..74].copy_from_slice(&asset.to_le_bytes());
    m[74..90].copy_from_slice(&size.to_le_bytes());
    m[90..98].copy_from_slice(&price.to_le_bytes());
    m[98..106].copy_from_slice(&expiry.to_le_bytes());
    m[106..114].copy_from_slice(&id.to_le_bytes());
    m
}

/// The key and message of the Ed25519 verification just before this instruction (one
/// signature, all of it inside that instruction's own data). The runtime has checked the
/// signature if this transaction runs at all.
fn signed_before(sysvar: &AccountInfo) -> Result<(Pubkey, Vec<u8>), ProgramError> {
    if *sysvar.key != ixs::ID {
        return Err(RouterError::BadAccount.into());
    }
    let here = ixs::load_current_index_checked(sysvar)?;
    if here == 0 {
        return Err(RouterError::BadQuote.into());
    }
    let ix = ixs::load_instruction_at_checked(here as usize - 1, sysvar)?;
    let d: &[u8] = if ix.program_id == ed25519_program::ID {
        &ix.data
    } else if cfg!(not(feature = "devnet")) && ix.program_id == crate::id() && ix.data.first() == Some(&TEST_SIGNATURE_STANDIN) {
        // Test builds only (no `devnet`, so never deployed): the test chain cannot load the Ed25519
        // precompile, so the same data comes in a no-op router instruction. The key and message
        // are still checked here; only the signature itself goes unverified.
        &ix.data[1..]
    } else {
        return Err(RouterError::BadQuote.into());
    };
    if d.len() < 16 || d[0] != 1 {
        return Err(RouterError::BadQuote.into());
    }
    let u = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]) as usize;
    let (sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) = (u(4), u(6), u(8), u(10), u(12), u(14));
    // Offsets into this same instruction only (u16::MAX), so the checked key and message are
    // the ones read here.
    if sig_ix != u16::MAX as usize || pk_ix != u16::MAX as usize || msg_ix != u16::MAX as usize {
        return Err(RouterError::BadQuote.into());
    }
    let pk = d.get(pk_off..pk_off + 32).ok_or(RouterError::BadQuote)?;
    let msg = d.get(msg_off..msg_off + msg_len).ok_or(RouterError::BadQuote)?;
    Ok((Pubkey::new_from_array(pk.try_into().unwrap()), msg.to_vec()))
}

/// Cranks `portfolio` (paid by `payer`) until it and every asset it holds, and `asset`, are at
/// the current slot: each crank moves an asset at most 10 slots. Nothing when they are.
pub fn bring_current<'a>(payer: &AccountInfo<'a>, market: &AccountInfo<'a>, portfolio: &AccountInfo<'a>, percolator: &AccountInfo<'a>, asset: u16) -> ProgramResult {
    let now = Clock::get()?.slot;
    for _ in 0..6 {
        let (work, assets) = perc::crank_work(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, asset, now)?;
        if !work {
            return Ok(());
        }
        solana_program::program::invoke(&perc::crank(payer.key, market.key, portfolio.key, &assets), &[payer.clone(), market.clone(), portfolio.clone(), percolator.clone()])?;
    }
    Ok(())
}

/// `TakeQuote` (tag 38): trades a maker's signed quote now.
///
/// Accounts: 0 wallet [s, w], 1 trader [w], 2 trader portfolio [w], 3 vault, 4 book, 5 market [w],
/// 6 maker account [w], 7 maker portfolio [w], 8 maker's matcher delegate, 9 router authority,
/// 10 vault program, 11 Percolator program, 12 instructions sysvar; then the vault's holding-fee
/// meter and the trader's fee ledger (when they exist), the tier record, the vault's price
/// range and the wallet's record of values, found by what they are.
/// Data: size i128 (+ = buy), price u64 (e6), expiry slot u64, quote id u64.
#[inline(never)]
pub fn take_quote(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 40 {
        return Err(RouterError::InvalidInstruction.into());
    }
    let size = i128::from_le_bytes(data[..16].try_into().unwrap());
    let price = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let expiry = u64::from_le_bytes(data[24..32].try_into().unwrap());
    let id = u64::from_le_bytes(data[32..40].try_into().unwrap());
    let (wallet, trader_ai, portfolio, vault_ai, book_ai, market) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?, acc(accounts, 3)?, acc(accounts, 4)?, acc(accounts, 5)?);
    let (maker_ai, maker_pf, delegate, authority, vault_program, percolator, sysvar) =
        (acc(accounts, 6)?, acc(accounts, 7)?, acc(accounts, 8)?, acc(accounts, 9)?, acc(accounts, 10)?, acc(accounts, 11)?, acc(accounts, 12)?);
    signer(wallet)?;
    for w in [trader_ai, portfolio, market, maker_ai, maker_pf] {
        writable(w)?;
    }
    key_is(vault_program, &percolator_vault::id())?;
    key_is(percolator, &perc::PERCOLATOR_PROGRAM_ID)?;
    let (ak, abump) = authority_address(program_id);
    key_is(authority, &ak)?;
    if size == 0 || size == i128::MIN || price == 0 {
        return Err(RouterError::BadQuote.into());
    }
    let t = load_trader(program_id, trader_ai, wallet.key)?;
    let v = load_vault(vault_ai)?;
    let b = load_book(book_ai, program_id)?;
    key_is(market, &v.market)?;
    key_is(market, &t.market)?;
    key_is(portfolio, &t.portfolio)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    let [m_market, m_wallet, m_portfolio, m_delegate] = maker::keys(maker_ai, &percolator_vault::id())?;
    if m_market != *market.key || m_portfolio != *maker_pf.key || m_delegate != *delegate.key || m_wallet == *wallet.key {
        return Err(RouterError::BadAccount.into());
    }
    // The maker signed exactly this, for this trading account.
    let (pk, signed) = signed_before(sysvar)?;
    if pk != m_wallet || signed != quote_message(maker_ai.key, trader_ai.key, v.asset_index, size, price, expiry, id) {
        return Err(RouterError::BadQuote.into());
    }
    let clock = Clock::get()?;
    if clock.slot > expiry || expiry > clock.slot.saturating_add(MAX_QUOTE_SLOTS) {
        return Err(RouterError::QuoteExpired.into());
    }
    perc::expect_market(market)?;
    let (market_id, effective, _) = perc::asset_price(&market.try_borrow_data()?, v.asset_index)?;
    if (price as u128).abs_diff(effective as u128).saturating_mul(10_000) > (effective as u128).saturating_mul(QUOTE_BAND_BPS) {
        return Err(RouterError::PriceBand.into());
    }
    // The taker as a router fill holds it: fees settled first, then what the trade may do.
    let before = perc::positions(&market.try_borrow_data()?, &portfolio.try_borrow_data()?)?.iter().find(|x| x.asset == v.asset_index).map_or(0, |x| x.size);
    let mut fees = carry::Fees::load(program_id, accounts, &b, &t, vault_ai.key, trader_ai.key)?;
    let debt = fees.settle(v.asset_index, market_id, before, effective, clock.unix_timestamp)?;
    let reduces = before != 0 && (before > 0) != (size > 0) && size.unsigned_abs() <= before.unsigned_abs();
    if !reduces {
        if perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)? {
            return Err(RouterError::CloseOnly.into());
        }
        if holds_other_asset(&t, &market.try_borrow_data()?, &portfolio.try_borrow_data()?, v.asset_index)? {
            return Err(RouterError::Isolated.into());
        }
        if !fees.can_book(v.asset_index, market_id)? {
            return Err(RouterError::FeesOwed.into());
        }
    }
    let tiers = tiers_in(program_id, accounts, market.key);
    let dial = risk::dial(b.price_dial, tier_of_feed(&v.oracle_feeds[0]), clock.unix_timestamp);
    if !margin_covers_owing(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, &v, size, 0, tiers.as_ref(), debt, if reduces { 1 } else { dial })? {
        return Err(RouterError::InsufficientMargin.into());
    }
    // Lazy settlement, as for a fill (`lazy`).
    let tolerant = match lazy::find(program_id, accounts, vault_ai.key) {
        Some(ai) => {
            let mut r: PriceRange = load(ai, program_id, RANGE_MAGIC)?;
            lazy::restart_if_current(&mut r, &market.try_borrow_data()?, v.asset_index, &b)?;
            store(ai, &r)?;
            lazy::tolerant(&r, &market.try_borrow_data()?, v.asset_index, &b)?
        }
        None => false,
    };
    // The maker's and the taker's accounts, and the asset, brought to the current slot here, as
    // far as they need it: the taker sends no cranks (which fail when another transaction in the
    // same slot did the work first).
    bring_current(wallet, market, maker_pf, percolator, v.asset_index)?;
    bring_current(wallet, market, portfolio, percolator, v.asset_index)?;
    // Arm the maker for exactly this quote (used up there), then trade it through Percolator.
    let mut arm = vec![TAG_ARM_QUOTE];
    arm.extend_from_slice(&size.to_le_bytes());
    arm.extend_from_slice(&price.to_le_bytes());
    arm.extend_from_slice(&id.to_le_bytes());
    arm.push(tolerant as u8);
    invoke_signed(
        &Instruction { program_id: percolator_vault::id(), accounts: vec![AccountMeta::new_readonly(ak, true), AccountMeta::new(*maker_ai.key, false)], data: arm },
        &[authority.clone(), maker_ai.clone(), vault_program.clone()],
        &[&[SEED_AUTHORITY, &[abump]]],
    )?;
    let (_, _, fee_bps) = perc::margin_params(&market.try_borrow_data()?)?;
    let taker_view = perc::read_portfolio(portfolio, market.key, trader_ai.key)?;
    let maker_view = perc::read_portfolio(maker_pf, market.key, &m_wallet)?;
    invoke_signed(
        &perc::trade_cpi(trader_ai.key, market.key, portfolio.key, maker_pf.key, &percolator_vault::id(), maker_ai.key, delegate.key, &taker_view, &maker_view, v.asset_index, market_id, size, fee_bps),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), maker_pf.clone(), vault_program.clone(), maker_ai.clone(), delegate.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )?;
    let after = perc::positions(&market.try_borrow_data()?, &portfolio.try_borrow_data()?)?.iter().find(|x| x.asset == v.asset_index).map_or(0, |x| x.size);
    let traded = after - before;
    msg!("quote {} {} {}", id, traded, price);
    let owed = book_fees(fees, vault_ai, portfolio, v.asset_index, market_id, v.inventory, before, traded, price, false)?;
    if let Some(e) = social::equities_for(program_id, accounts, &t)? {
        let (capital, pnl, _) = perc::portfolio_exposure(&portfolio.try_borrow_data()?)?;
        let here = (capital as i128).saturating_add(pnl).saturating_sub(owed as i128);
        social::set_equity(program_id, e, t.sub, Some(here), 0)?;
    }
    Ok(())
}
