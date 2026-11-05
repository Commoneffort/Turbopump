//! Makers (2026-11-06): accounts that sell and buy at prices they sign off chain. A taker carries
//! a maker's signed quote in its own transaction; the router checks it (`TakeQuote`) and the trade
//! fills in the slot the transaction lands in, at the quoted price, against the maker's Percolator
//! portfolio. Nobody can trade ahead of it: the price was fixed by the maker before the taker sent
//! anything, and the quote names the taker. The vault stays the counterparty of every trade that
//! comes without a quote.
//!
//! A maker keeps its own Percolator portfolio (its wallet owns it: deposits, withdrawals and its
//! margin are Percolator's as for any account) and registers it here (`OpenMaker`). The portfolio
//! names this program as its matcher, with the maker's account here as matcher context: the
//! maker sends Percolator's `SetMatcherConfig` itself, and renews it before it expires. This
//! program then prices a trade against it only as the router armed it (`ArmQuote`, router-signed,
//! for one slot, size and price), so the portfolio trades with takers at nothing but its signed
//! quotes.
//!
//! Each quote is used once: its id must be in the maker's window of `QUOTE_WINDOW` ids above
//! `quote_base` and not used before. A maker numbers its quotes upward.

use bytemuck::{Pod, Zeroable};
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, program::invoke_signed, pubkey::Pubkey, rent::Rent,
    system_instruction, system_program, sysvar::Sysvar,
};

use crate::{error::VaultError, matcher, percolator as perc, state};

pub const MAKER_MAGIC: u64 = u64::from_le_bytes(*b"TPMAKER1");
pub const SEED_MAKER: &[u8] = b"maker";
/// How many quote ids above `quote_base` a maker may have outstanding.
pub const QUOTE_WINDOW: u64 = 512;

#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct MakerState {
    pub magic: u64,
    pub market: Pubkey,
    /// The maker's wallet: owns the portfolio and signs the quotes.
    pub wallet: Pubkey,
    pub portfolio: Pubkey,
    /// Percolator's matcher delegate for this portfolio with this program and account.
    pub delegate: Pubkey,
    pub bump: u8,
    /// 1 while armed cohort-tolerant (the router's lazy settlement, see `matcher`).
    pub armed_tolerant: u8,
    pub _pad: [u8; 6],
    pub armed_slot: u64,
    /// Taker size (+ = taker buys) and price (e6) of the armed quote.
    pub armed_size: i128,
    pub armed_price: u64,
    pub quote_base: u64,
    pub used: [u64; 8],
    pub fills: u64,
}
pub const MAKER_STATE_OFF: usize = state::MATCHER_RETURN_LEN;
pub const MAKER_ACCOUNT_LEN: usize = MAKER_STATE_OFF + core::mem::size_of::<MakerState>();

pub fn maker_address(program_id: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_MAKER, market.as_ref(), wallet.as_ref()], program_id)
}

pub fn load(ai: &AccountInfo, program_id: &Pubkey) -> Result<MakerState, VaultError> {
    if ai.owner != program_id || ai.data_len() != MAKER_ACCOUNT_LEN {
        return Err(VaultError::BadAccount);
    }
    let d = ai.try_borrow_data().map_err(|_| VaultError::BadAccount)?;
    let m: MakerState = bytemuck::pod_read_unaligned(&d[MAKER_STATE_OFF..]);
    if m.magic != MAKER_MAGIC {
        return Err(VaultError::BadAccount);
    }
    Ok(m)
}

pub fn store(ai: &AccountInfo, m: &MakerState) -> ProgramResult {
    ai.try_borrow_mut_data()?[MAKER_STATE_OFF..].copy_from_slice(bytemuck::bytes_of(m));
    Ok(())
}

/// Marks quote `id` used. Ids below the window are spent; one above it moves the window up
/// (forgetting the oldest ids, which are spent from then on).
pub fn use_quote(m: &mut MakerState, id: u64) -> Result<(), VaultError> {
    if id < m.quote_base {
        return Err(VaultError::QuoteUsed);
    }
    if id >= m.quote_base.saturating_add(QUOTE_WINDOW) {
        let new_base = id - QUOTE_WINDOW + 1;
        let shift = new_base - m.quote_base;
        let mut used = m.used;
        if shift >= QUOTE_WINDOW {
            used = [0; 8];
        } else {
            for _ in 0..shift {
                // Shift the 512-bit window down by one id.
                let mut carry = 0u64;
                for w in used.iter_mut().rev() {
                    let next = *w & 1;
                    *w = (*w >> 1) | (carry << 63);
                    carry = next;
                }
            }
        }
        m.used = used;
        m.quote_base = new_base;
    }
    let bit = (id - m.quote_base) as usize;
    let mut used = m.used;
    if used[bit / 64] & (1 << (bit % 64)) != 0 {
        return Err(VaultError::QuoteUsed);
    }
    used[bit / 64] |= 1 << (bit % 64);
    m.used = used;
    Ok(())
}

/// `OpenMaker` (the maker's wallet signs, the payer pays the rent): registers the wallet's
/// Percolator portfolio on `market` as a maker. The maker then points the portfolio's matcher at
/// this program with the account made here as context (Percolator `SetMatcherConfig`).
///
/// Accounts: 0 payer [s, w], 1 wallet [s], 2 maker account [w], 3 market, 4 the wallet's
/// portfolio, 5 system program.
pub fn open_maker(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let get = |i: usize| accounts.get(i).ok_or(VaultError::BadAccount);
    let (payer, wallet, maker_ai, market, portfolio, system) = (get(0)?, get(1)?, get(2)?, get(3)?, get(4)?, get(5)?);
    if !payer.is_signer || !wallet.is_signer {
        return Err(VaultError::NotSigner.into());
    }
    if !maker_ai.is_writable {
        return Err(VaultError::NotWritable.into());
    }
    if *system.key != system_program::ID {
        return Err(VaultError::BadAccount.into());
    }
    perc::expect_market(market)?;
    // The portfolio is the wallet's, on this market.
    perc::read_portfolio(portfolio, market.key, wallet.key)?;
    let (key, bump) = maker_address(program_id, market.key, wallet.key);
    if *maker_ai.key != key {
        return Err(VaultError::BadAccount.into());
    }
    if maker_ai.owner == program_id {
        return Err(VaultError::AlreadyInitialized.into());
    }
    let rent = Rent::get()?.minimum_balance(MAKER_ACCOUNT_LEN);
    invoke_signed(
        &system_instruction::create_account(payer.key, maker_ai.key, rent.saturating_sub(maker_ai.lamports()), MAKER_ACCOUNT_LEN as u64, program_id),
        &[payer.clone(), maker_ai.clone(), system.clone()],
        &[&[SEED_MAKER, market.key.as_ref(), wallet.key.as_ref(), &[bump]]],
    )?;
    let mut m = MakerState::zeroed();
    m.magic = MAKER_MAGIC;
    m.market = *market.key;
    m.wallet = *wallet.key;
    m.portfolio = *portfolio.key;
    m.delegate = perc::matcher_delegate(market.key, portfolio.key, wallet.key, program_id, maker_ai.key);
    m.bump = bump;
    store(maker_ai, &m)
}

/// `ArmQuote` (router only): the next trade against this maker, in this slot, is `size` at
/// `price`, for quote `id` (used up here). Data: size i128, price u64, id u64, tolerant u8.
///
/// Accounts: 0 router authority [s], 1 maker account [w].
pub fn arm_quote(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let router = accounts.first().ok_or(VaultError::BadAccount)?;
    let maker_ai = accounts.get(1).ok_or(VaultError::BadAccount)?;
    if !router.is_signer || *router.key != crate::router_authority().0 {
        return Err(VaultError::NotRouter.into());
    }
    if !maker_ai.is_writable || data.len() != 33 {
        return Err(VaultError::InvalidInstruction.into());
    }
    let size = i128::from_le_bytes(data[..16].try_into().unwrap());
    let price = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let id = u64::from_le_bytes(data[24..32].try_into().unwrap());
    if size == 0 || size == i128::MIN || price == 0 || data[32] > 1 {
        return Err(VaultError::InvalidParams.into());
    }
    let mut m = load(maker_ai, program_id)?;
    use_quote(&mut m, id)?;
    m.armed_size = size;
    m.armed_price = price;
    m.armed_slot = Clock::get()?.slot;
    m.armed_tolerant = data[32];
    store(maker_ai, &m)
}

/// The matcher for a maker's portfolio: exactly the armed quote, in its slot, once.
pub fn process_match(program_id: &Pubkey, accounts: &[AccountInfo], req: &matcher::Request) -> ProgramResult {
    let delegate = accounts.first().ok_or(VaultError::BadAccount)?;
    let ctx = accounts.get(1).ok_or(VaultError::BadAccount)?;
    if !ctx.is_writable {
        return Err(VaultError::NotWritable.into());
    }
    let mut m = load(ctx, program_id)?;
    if !delegate.is_signer || *delegate.key != m.delegate {
        return Err(VaultError::UnauthorizedMatcherCaller.into());
    }
    if m.armed_slot != Clock::get()?.slot || m.armed_size != req.req_size {
        return Err(VaultError::NotArmed.into());
    }
    let (price, tolerant) = (m.armed_price, m.armed_tolerant != 0);
    m.armed_slot = 0;
    m.armed_size = 0;
    m.armed_price = 0;
    m.armed_tolerant = 0;
    m.fills = m.fills.saturating_add(1);
    store(ctx, &m)?;
    matcher::write_return(ctx, req, price, req.req_size, 0, tolerant)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_quote_once_and_the_window_moves_up() {
        let mut m = MakerState::zeroed();
        use_quote(&mut m, 5).unwrap();
        assert!(use_quote(&mut m, 5).is_err());
        use_quote(&mut m, 3).unwrap();
        use_quote(&mut m, 600).unwrap();
        assert_eq!({ m.quote_base }, 600 - QUOTE_WINDOW + 1);
        assert!(use_quote(&mut m, 5).is_err(), "below the window: spent");
        assert!(use_quote(&mut m, 600).is_err());
        use_quote(&mut m, 200).unwrap();
        use_quote(&mut m, 100_000).unwrap();
        assert!(use_quote(&mut m, 600).is_err());
        use_quote(&mut m, 99_999).unwrap();
    }
}
