//! Liquidation shield (2026-11-07). A wallet lets the router add margin from its own token
//! account to its own main trading account when that account gets close to liquidation, in steps,
//! instead of being liquidated.
//!
//! The wallet approves the router's authority as a delegate of its USDC account for at most a
//! total (an SPL token approval, which only the wallet can give and can revoke at any time), and
//! opens a shield here naming the step, the total and how close to liquidation it acts. From then
//! on anyone (the executors do) may send `TriggerShield`, which moves one step:
//!   - only from a token account the wallet owns, and only into that wallet's main trading account
//!     on the shield's market (the router's own deposit path);
//!   - only while the account's equity is under its liquidation floor plus `trigger_bps` (the same
//!     figures the router liquidates on, fees owed included);
//!   - never more than the step, what is left of the total, the approval or the balance.
//! Nothing else can use the approval: the router signs as delegate in this instruction only.
use bytemuck::{Pod, Zeroable};
use solana_program::{account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, msg, program::invoke_signed, program_pack::Pack, pubkey::Pubkey, system_program, sysvar::Sysvar};

use crate::state::*;
use crate::*;

pub const SHIELD_MAGIC: u64 = u64::from_le_bytes(*b"PRSHIELD");
pub const SEED_SHIELD: &[u8] = b"shield";
/// How close to liquidation a shield may act, in bps of the liquidation floor (50 = when equity
/// is within 0.5% of the floor ... 5,000 = within 50%).
pub const SHIELD_MIN_BPS: u16 = 50;
pub const SHIELD_MAX_BPS: u16 = 5_000;

#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Shield {
    pub magic: u64,
    pub market: Pubkey,
    pub wallet: Pubkey,
    /// Collateral atoms moved per trigger, the most in all, and what has been moved.
    pub step: u64,
    pub max_total: u64,
    pub used: u64,
    pub trigger_bps: u16,
    pub bump: u8,
    pub _pad: [u8; 5],
    /// When it last moved margin (unix seconds).
    pub last: i64,
}
pub const SHIELD_LEN: usize = core::mem::size_of::<Shield>();

pub fn shield_address(program_id: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_SHIELD, market.as_ref(), wallet.as_ref()], program_id)
}

/// SetShield: accounts [wallet (signer, pays), shield (writable), market, system];
/// data: step (u64), max_total (u64), trigger_bps (u16). Setting it again replaces the terms and
/// starts the total over.
pub fn set_shield(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 18 {
        return Err(RouterError::InvalidInstruction.into());
    }
    let (wallet, shield_ai, market, system) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?, acc(accounts, 3)?);
    signer(wallet)?;
    writable(wallet)?;
    writable(shield_ai)?;
    key_is(system, &system_program::ID)?;
    perc::expect_market(market)?;
    let step = u64::from_le_bytes(data[..8].try_into().unwrap());
    let max_total = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let trigger_bps = u16::from_le_bytes(data[16..18].try_into().unwrap());
    if step == 0 || max_total < step || !(SHIELD_MIN_BPS..=SHIELD_MAX_BPS).contains(&trigger_bps) {
        return Err(RouterError::InvalidInstruction.into());
    }
    let (sk, bump) = shield_address(program_id, market.key, wallet.key);
    key_is(shield_ai, &sk)?;
    if shield_ai.data_len() == 0 {
        create_pda(wallet, shield_ai, system, program_id, SHIELD_LEN, 0, &[SEED_SHIELD, market.key.as_ref(), wallet.key.as_ref(), &[bump]])?;
    } else {
        let s: Shield = load(shield_ai, program_id, SHIELD_MAGIC)?;
        if s.wallet != *wallet.key || s.market != *market.key {
            return Err(RouterError::BadAccount.into());
        }
    }
    store(shield_ai, &Shield { magic: SHIELD_MAGIC, market: *market.key, wallet: *wallet.key, step, max_total, used: 0, trigger_bps, bump, _pad: [0; 5], last: 0 })
}

/// RemoveShield: accounts [wallet (signer), shield (writable)]. The rent goes back to the wallet.
/// (The token approval is the wallet's own to revoke, which the page does in the same step.)
pub fn remove_shield(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (wallet, shield_ai) = (acc(accounts, 0)?, acc(accounts, 1)?);
    signer(wallet)?;
    writable(wallet)?;
    writable(shield_ai)?;
    let s: Shield = load(shield_ai, program_id, SHIELD_MAGIC)?;
    key_is(wallet, &s.wallet)?;
    close(shield_ai, 0, wallet, wallet)
}

/// Whether the account's equity (fees owed taken off) is under its liquidation floor plus
/// `extra_bps` of it: the router's own figures (`liquidatable`), with the margin to spare. A
/// position not yet settled at the current price counts at its last settled value (adding margin
/// to one's own account a little early does no harm).
fn near_liquidation(market: &[u8], portfolio: &[u8], tiers: Option<&state::Tiers>, debt: u64, extra_bps: u16) -> Result<bool, solana_program::program_error::ProgramError> {
    let (capital, pnl, _) = perc::portfolio_exposure(portfolio)?;
    let mut floor = 0u128;
    for p in perc::positions(market, portfolio)? {
        let (_, price, _) = perc::asset_price(market, p.asset)?;
        let n = p.size.unsigned_abs().checked_mul(price as u128).ok_or(RouterError::Overflow)? / POS_SCALE;
        let (_, liq, _) = levels(market, tiers, p.asset)?;
        floor = floor.checked_add(n.saturating_mul(liq as u128)).ok_or(RouterError::Overflow)?;
    }
    if floor == 0 {
        return Ok(false);
    }
    let equity = (capital as i128).checked_add(pnl).ok_or(RouterError::Overflow)? - debt as i128;
    let line = floor.saturating_mul(10_000 + extra_bps as u128) / 10_000;
    Ok(equity <= 0 || (equity as u128).saturating_mul(10_000) < line)
}

/// TriggerShield (anyone): moves one step of margin from the wallet's token account into its
/// main trading account, when it is near liquidation.
///
/// Accounts: 0 payer [s], 1 shield [w], 2 trader, 3 wallet's token account [w], 4 collateral [w],
/// 5 portfolio [w], 6 market [w], 7 Percolator collateral vault [w], 8 router authority, 9 token
/// program, 10 Percolator program; then optionally the trader's fee ledger, the market's tiers and
/// the wallet's track record [w] (a deposit is booked in it).
pub fn trigger_shield(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (payer, shield_ai, trader_ai, source, collateral) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?, acc(accounts, 3)?, acc(accounts, 4)?);
    let (portfolio, market, perc_vault, authority, token, percolator) = (acc(accounts, 5)?, acc(accounts, 6)?, acc(accounts, 7)?, acc(accounts, 8)?, acc(accounts, 9)?, acc(accounts, 10)?);
    signer(payer)?;
    writable(shield_ai)?;
    key_is(token, &spl_token::ID)?;
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    let (ak, abump) = authority_address(program_id);
    key_is(authority, &ak)?;
    let mut s: Shield = load(shield_ai, program_id, SHIELD_MAGIC)?;
    // The wallet's main account on the shield's market, and a token account of the wallet's.
    let t = load_trader(program_id, trader_ai, &s.wallet)?;
    if t.sub != 0 {
        return Err(RouterError::BadAccount.into());
    }
    key_is(market, &s.market)?;
    key_is(market, &t.market)?;
    key_is(collateral, &t.collateral)?;
    key_is(portfolio, &t.portfolio)?;
    perc::expect_market(market)?;
    let src = spl_token::state::Account::unpack(&source.try_borrow_data()?)?;
    if src.owner != s.wallet {
        return Err(RouterError::BadAccount.into());
    }
    // (The token program clears an approval once it is used up; the wallet may also revoke it.)
    if src.delegate != solana_program::program_option::COption::Some(ak) {
        return Err(RouterError::ShieldSpent.into());
    }
    let debt = carry::ledger_in(program_id, accounts, trader_ai.key).map_or(0, carry::total_owed);
    if !near_liquidation(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, tiers_in(program_id, accounts, market.key).as_ref(), debt, s.trigger_bps)? {
        return Err(RouterError::ShieldNotNeeded.into());
    }
    let amount = s.step.min(s.max_total.saturating_sub(s.used)).min(src.delegated_amount).min(src.amount);
    if amount == 0 {
        return Err(RouterError::ShieldSpent.into());
    }
    invoke_signed(
        &spl_token::instruction::transfer(&spl_token::ID, source.key, collateral.key, &ak, &[], amount)?,
        &[source.clone(), collateral.clone(), authority.clone(), token.clone()],
        &[&[SEED_AUTHORITY, &[abump]]],
    )?;
    let view = perc::read_portfolio(portfolio, market.key, trader_ai.key)?;
    invoke_signed(
        &perc::deposit(trader_ai.key, market.key, portfolio.key, collateral.key, perc_vault.key, view.portfolio_id, view.sequence, amount as u128),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), collateral.clone(), perc_vault.clone(), token.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )?;
    s.used = s.used.saturating_add(amount);
    s.last = Clock::get()?.unix_timestamp;
    store(shield_ai, &s)?;
    msg!("shield {} {}", s.wallet, amount);
    // Booked as the wallet's own deposit in its track record (required once it has one): money
    // put in is not profit, so a shield cannot make a record look better than it is.
    let sk = stats_address(program_id, &t.market, &t.wallet).0;
    social::book_flow_of(program_id, &t, accounts, accounts.iter().skip(11).find(|a| *a.key == sk).ok_or(RouterError::BadAccount), amount, 0)
}
