//! Trading keys ("one-click trading", 2026-11-06). A wallet lets a key of its own choosing sign
//! its trades through the router, so a page can trade for it without asking the wallet each time.
//!
//! The key is the page's own random key (never derived from a signature: a signature over a known
//! text can be obtained by any site, and so would the key). The wallet approves it on chain with
//! `OpenSession`, for at most `MAX_SESSION_SECS`, with a largest trade (`max_notional`) and a
//! number of trades a day (`max_trades`). What the key may do:
//!   - queue a trade (`Request`) and take a maker's quote (`TakeQuote`) for the wallet's trading
//!     accounts on the session's market, within those limits; a trade that only reduces a position
//!     is never limited (a user can always get out);
//! and nothing else: deposits, withdrawals, copying, profiles and orders still need the wallet,
//! and a withdrawal only ever pays the wallet. Approving a new key replaces the old one at once
//! (one key per wallet and market); `CloseSession`, by the wallet or by the key itself, ends it and
//! returns the account's rent to the wallet.
use bytemuck::{Pod, Zeroable};
use solana_program::{account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, msg, program::invoke, pubkey::Pubkey, rent::Rent, system_instruction, system_program, sysvar::Sysvar};

use crate::state::*;
use crate::*;

pub const SESSION_MAGIC: u64 = u64::from_le_bytes(*b"PRSESSN1");
pub const SEED_SESSION: &[u8] = b"session";
/// The longest a key may be approved for.
pub const MAX_SESSION_SECS: i64 = 30 * 86_400;
/// The most trades a day a key may be allowed.
pub const MAX_SESSION_TRADES: u32 = 10_000;
/// The length of the window `max_trades` counts in.
pub const SESSION_WINDOW_SECS: i64 = 86_400;

#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Session {
    pub magic: u64,
    pub market: Pubkey,
    pub wallet: Pubkey,
    /// The key that may sign the wallet's trades.
    pub key: Pubkey,
    /// Unix time after which the key signs nothing.
    pub expires: i64,
    /// The largest trade the key may open or grow a position by (collateral atoms of notional).
    pub max_notional: u64,
    /// Trades a day the key may make, and how many it made in the current window.
    pub max_trades: u32,
    pub trades: u32,
    pub window_start: i64,
    pub opened: i64,
    pub bump: u8,
    pub _pad: [u8; 7],
    // Since 2026-11-07 (sessions opened before have 152 bytes and read these as 0):
    /// The most notional the key may open or grow positions by in the current window (0: no cap).
    pub max_day_notional: u64,
    /// What it has opened or grown by in the current window.
    pub day_notional: u64,
    /// How far (bps) from Percolator's price a maker's quote taken by the key may be (0: the
    /// default, `DEFAULT_SLIPPAGE_BPS`). A quote is the price paid, so this is the most a key can
    /// lose to a bad quote on one trade.
    pub max_slippage_bps: u16,
    pub _pad2: [u8; 6],
}
pub const SESSION_LEN: usize = core::mem::size_of::<Session>();
/// The length of sessions opened before 2026-11-07.
pub const LEGACY_SESSION_LEN: usize = 152;
const _: () = assert!(SESSION_LEN == 176);
/// A key's quote band when the wallet set none.
pub const DEFAULT_SLIPPAGE_BPS: u16 = 50;

/// Reads a session of either length (a legacy one with the newer fields 0).
fn load_session(ai: &AccountInfo, program_id: &Pubkey) -> Result<Session, solana_program::program_error::ProgramError> {
    let n = ai.data_len();
    if ai.owner != program_id || (n != SESSION_LEN && n != LEGACY_SESSION_LEN) {
        return Err(RouterError::BadAccount.into());
    }
    let mut buf = [0u8; SESSION_LEN];
    buf[..n].copy_from_slice(&ai.try_borrow_data()?);
    if buf[..8] != SESSION_MAGIC.to_le_bytes() {
        return Err(RouterError::BadAccount.into());
    }
    Ok(bytemuck::pod_read_unaligned(&buf))
}
/// Writes a session back at its account's length.
fn store_session(ai: &AccountInfo, s: &Session) -> ProgramResult {
    let n = ai.data_len();
    ai.try_borrow_mut_data()?.copy_from_slice(&bytemuck::bytes_of(s)[..n]);
    Ok(())
}

pub fn session_address(program_id: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_SESSION, market.as_ref(), wallet.as_ref()], program_id)
}

/// OpenSession: accounts [wallet (signer, pays), session (writable), market, system];
/// data: key (32), expires (i64, unix), max_notional (u64), max_trades (u32), then optionally
/// max_day_notional (u64, 0 = no cap) and max_slippage_bps (u16, 0 = the default, at most the
/// router's quote band).
pub fn open_session(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 52 && data.len() != 62 {
        return Err(RouterError::InvalidInstruction.into());
    }
    let (wallet, session_ai, market, system) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?, acc(accounts, 3)?);
    signer(wallet)?;
    writable(wallet)?;
    writable(session_ai)?;
    key_is(system, &system_program::ID)?;
    perc::expect_market(market)?;
    let key = Pubkey::new_from_array(data[..32].try_into().unwrap());
    let expires = i64::from_le_bytes(data[32..40].try_into().unwrap());
    let max_notional = u64::from_le_bytes(data[40..48].try_into().unwrap());
    let max_trades = u32::from_le_bytes(data[48..52].try_into().unwrap());
    let (max_day_notional, max_slippage_bps) = if data.len() == 62 {
        (u64::from_le_bytes(data[52..60].try_into().unwrap()), u16::from_le_bytes(data[60..62].try_into().unwrap()))
    } else {
        (0, 0)
    };
    if max_slippage_bps as u128 > crate::quote::QUOTE_BAND_BPS || (max_day_notional != 0 && max_day_notional < max_notional) {
        return Err(RouterError::SessionLimit.into());
    }
    let now = Clock::get()?.unix_timestamp;
    // The key must be a key of its own: not the wallet, not empty. (A key that is not a real
    // public key could never sign, so approving one only approves nothing.)
    if key == *wallet.key || key == Pubkey::default() {
        return Err(RouterError::SessionInvalid.into());
    }
    if expires <= now || expires > now.saturating_add(MAX_SESSION_SECS) || max_notional == 0 || max_trades == 0 || max_trades > MAX_SESSION_TRADES {
        return Err(RouterError::SessionLimit.into());
    }
    let (sk, bump) = session_address(program_id, market.key, wallet.key);
    key_is(session_ai, &sk)?;
    if session_ai.data_len() == 0 {
        create_pda(wallet, session_ai, system, program_id, SESSION_LEN, 0, &[SEED_SESSION, market.key.as_ref(), wallet.key.as_ref(), &[bump]])?;
    } else {
        // A key approved before is replaced: it signs nothing from now on.
        let old = load_session(session_ai, program_id)?;
        if old.wallet != *wallet.key || old.market != *market.key {
            return Err(RouterError::BadAccount.into());
        }
        // A session from before the daily cap grows to the current layout (the wallet pays).
        if session_ai.data_len() == LEGACY_SESSION_LEN {
            let need = Rent::get()?.minimum_balance(SESSION_LEN).saturating_sub(session_ai.lamports());
            if need > 0 {
                invoke(&system_instruction::transfer(wallet.key, session_ai.key, need), &[wallet.clone(), session_ai.clone(), system.clone()])?;
            }
            session_ai.realloc(SESSION_LEN, true)?;
        }
    }
    store_session(session_ai, &Session {
        magic: SESSION_MAGIC, market: *market.key, wallet: *wallet.key, key, expires, max_notional, max_trades, trades: 0, window_start: now, opened: now, bump, _pad: [0; 7],
        max_day_notional, day_notional: 0, max_slippage_bps, _pad2: [0; 6],
    })?;
    msg!("session {} until {}", key, expires);
    Ok(())
}

/// CloseSession: accounts [wallet or the key (signer), session (writable), wallet (writable)].
pub fn close_session(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (who, session_ai, wallet) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?);
    signer(who)?;
    writable(session_ai)?;
    writable(wallet)?;
    let s = load_session(session_ai, program_id)?;
    key_is(wallet, &s.wallet)?;
    if *who.key != s.wallet && *who.key != s.key {
        return Err(RouterError::SessionInvalid.into());
    }
    close(session_ai, 0, wallet, wallet)
}

/// Whether `actor` may trade for `wallet` on `market` (a trade of `notional`, or one that only
/// reduces): the wallet itself, or its approved key within the key's limits. A trade by the key
/// counts toward its daily limits (the session account must then be passed, writable). Returns
/// the band (bps) a quote taken by the key must be within, or `None` for the wallet itself.
pub(crate) fn authorize(program_id: &Pubkey, accounts: &[AccountInfo], actor: &AccountInfo, wallet: &Pubkey, market: &Pubkey, notional: u128, reducing: bool) -> Result<Option<u16>, solana_program::program_error::ProgramError> {
    signer(actor)?;
    if actor.key == wallet {
        return Ok(None);
    }
    let sk = session_address(program_id, market, wallet).0;
    let session_ai = accounts.iter().find(|a| *a.key == sk).ok_or(RouterError::SessionInvalid)?;
    writable(session_ai)?;
    let mut s = load_session(session_ai, program_id)?;
    if s.wallet != *wallet || s.market != *market || s.key != *actor.key {
        return Err(RouterError::SessionInvalid.into());
    }
    let now = Clock::get()?.unix_timestamp;
    if now >= s.expires {
        return Err(RouterError::SessionExpired.into());
    }
    if !reducing && notional > s.max_notional as u128 {
        return Err(RouterError::SessionLimit.into());
    }
    if now.saturating_sub(s.window_start) >= SESSION_WINDOW_SECS {
        s.window_start = now;
        s.trades = 0;
        s.day_notional = 0;
    }
    if !reducing && s.trades >= s.max_trades {
        return Err(RouterError::SessionLimit.into());
    }
    if !reducing {
        let day = (s.day_notional as u128).saturating_add(notional);
        if s.max_day_notional != 0 && day > s.max_day_notional as u128 {
            return Err(RouterError::SessionLimit.into());
        }
        s.day_notional = day.min(u64::MAX as u128) as u64;
    }
    s.trades = s.trades.saturating_add(1);
    store_session(session_ai, &s)?;
    Ok(Some(if s.max_slippage_bps == 0 { DEFAULT_SLIPPAGE_BPS } else { s.max_slippage_bps }))
}

/// The notional of `size` (asset atoms, e6) at `price` (e6 per unit): collateral atoms.
pub(crate) fn notional(size: i128, price: u64) -> u128 {
    size.unsigned_abs().saturating_mul(price as u128) / 1_000_000
}

/// When the trading key `actor` stops being approved for `wallet` on `market` (None when the
/// wallet signs itself, or without a session). An order a key places expires by then: its orders
/// do not outlive its approval.
pub(crate) fn key_expiry(program_id: &Pubkey, accounts: &[AccountInfo], actor: &Pubkey, wallet: &Pubkey, market: &Pubkey) -> Option<i64> {
    if actor == wallet {
        return None;
    }
    let sk = session_address(program_id, market, wallet).0;
    let ai = accounts.iter().find(|a| *a.key == sk)?;
    load_session(ai, program_id).ok().map(|s| s.expires)
}
