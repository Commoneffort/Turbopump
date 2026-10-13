//! Percolator Vaults router: the only way to trade against a vault, and the reason nobody can
//! front-run one.
//!
//! A trade is a request first. The request lands on chain and gets a target time: the later of
//! the chain clock and the vault's current mark time, plus `DELAY_SECS`. It then fills at exactly
//! the first Pyth price published at or after that target, which nobody (the trader, a keeper, a
//! validator, a Pyth publisher) could have known when the request was made:
//!
//! - The price is a fully verified Pyth update, and it is the unique first one at or after the
//!   target (`prev_publish_time < target <= publish_time`), so whoever executes the fill, and
//!   whenever, the price is the same. Nobody gets to pick a price.
//! - The vault's mark only ever moves to verified Pyth prices, forward in time, and never past a
//!   pending request's target before that request is filled or has expired.
//! - The vault's matcher refuses every fill the router did not arm, so there is no other way in.
//! - A request cannot be cancelled. It fills, or it expires after `GRACE_SECS` and its bond is
//!   forfeited, and `Request` checks margin with a stress buffer, so a trader cannot back out of
//!   a fill after seeing its price.
//! - Filling is permissionless: anyone can execute any request, the trader included. Keepers
//!   cannot censor, and the executor earns the request's bond.
//!
//! Each trader's Percolator portfolio and collateral account are owned by a program address
//! derived from their wallet. Only the router can sign for it, and withdrawals only go back to
//! that wallet. There is no admin instruction.

#[cfg(not(target_os = "solana"))]
pub mod client;
pub mod social;
pub mod state;

use solana_program::msg;
use bytemuck::Zeroable;
use percolator_vault::{
    percolator::{self as perc, PERCOLATOR_PROGRAM_ID},
    processor::{TAG_ARM_FILL, TAG_FREEZE_REQUESTS, TAG_PUSH_MARK},
    pyth, reporter,
    state::{self as vstate, MODE_OPERATE, STATUS_ACTIVE},
};
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use state::*;

solana_program::declare_id!("DkK9TSMpVXLq26HeqxTXLysXyRKDYHTKU94SLFDWgjw3");

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Seconds between a request landing and the price it fills at. It must exceed the time for a
/// real-world price move to reach a published Pyth price, plus any lag of the chain clock.
pub const DELAY_SECS: i64 = 4;
/// How long after its target a request can still be filled before anyone may expire it.
pub const GRACE_SECS: i64 = 90;
/// A request whose price the mark already holds, and which nobody has filled this long after the
/// mark was moved there, may be expired early. The mark cannot move past a pending request, so a
/// request that cannot fill (Percolator refuses the trade) would otherwise hold up every request
/// behind it on that market, liquidations included, until `GRACE_SECS` had passed.
pub const STALL_SECS: i64 = 30;
/// Paid by the trader with each request: to the executor on a fill, forfeited on expiry.
#[cfg(not(feature = "x1"))]
pub const BOND_LAMPORTS: u64 = 2_000_000;
/// On X1 a transaction pays for the compute it asks for (10 lamports a unit), and a fill with
/// its cranks asks for about 1.5 million: the bond there is what a fill costs whoever sends it,
/// so each trade pays for its own.
#[cfg(feature = "x1")]
pub const BOND_LAMPORTS: u64 = 20_000_000;
/// Extra price move (bps) the margin check at request time must survive, on every position.
pub const STRESS_BPS: u128 = 1_000;
/// A trader whose equity is below this share (bps) of the notional of their positions can be
/// liquidated through the router: anyone queues it, and at the first Pyth price after its target
/// the position is closed against the vault if the account is still below this level. It sits
/// above Percolator's own maintenance margin on purpose. Percolator liquidates by reducing the
/// position unilaterally, which deleverages the other side and makes the market close-only
/// until every position on it is closed; closing against the vault first avoids that.
pub const LIQUIDATION_BPS: u128 = 1_500;
/// A trader's own request carries a deposit of this share (bps) of its notional, in the chain's
/// coin, on top of the bond. It comes back when the request fills (or ends without trading), and
/// when it expires without its price ever having reached the mark. It is kept if the request
/// expires after its price was the mark: by then everyone has seen that price and what the
/// market did after it, and a trader who could let such a request lapse for the price of a bond
/// would hold a free option whenever no executor filled it in time.
pub const EXPIRY_DEPOSIT_BPS: u128 = 10;
/// The chain's coin per atom of collateral (a 6-decimal dollar token), in lamports, for that
/// deposit. A fixed rate, set for SOL near $110 and XNT near $0.20: the deposit is a deterrent,
/// not a price, so being off by the coin's moves does not matter.
#[cfg(not(feature = "x1"))]
pub const LAMPORTS_PER_ATOM: u64 = 9;
#[cfg(feature = "x1")]
pub const LAMPORTS_PER_ATOM: u64 = 5_000;

/// The deposit (lamports) that goes with a request of `size` at `price` (see `EXPIRY_DEPOSIT_BPS`).
pub fn expiry_deposit(size: i128, price: u64) -> u64 {
    let notional = size.unsigned_abs().saturating_mul(price as u128) / POS_SCALE;
    let lamports = notional.saturating_mul(EXPIRY_DEPOSIT_BPS) / 10_000 * LAMPORTS_PER_ATOM as u128;
    u64::try_from(lamports).unwrap_or(u64::MAX)
}
const POS_SCALE: u128 = 1_000_000;
/// Places in a vault's queue that trades cannot take: they are kept for forced closes
/// (liquidations, close-outs) and epoch settlements. A trader about to be liquidated could
/// otherwise keep the queue full of small trades and never be reached.
pub const RESERVED_PENDING: usize = 4;

/// Circuit breaker on the mark. A new mark may differ from the one before it by at most
/// `BAND_BASE_BPS` plus `BAND_PER_SEC_BPS` for every second between the two prices' publish
/// times. A price further away than any market moves in that time (a broken feed, a wrong price
/// from the reporter) is refused; a real move that large is accepted once enough time has
/// passed, so the mark is held back for seconds, never stopped. While it is held back nothing
/// fills on that market, and a request whose own price is refused expires.
pub const BAND_BASE_BPS: u128 = 200;
pub const BAND_PER_SEC_BPS: u128 = 50;

/// Whether `price`, published `secs` after the mark `last`, is within the band around it.
pub fn within_band(last: u64, price: u64, secs: i64) -> bool {
    if last == 0 {
        return true; // the first mark of a book
    }
    let allowed_bps = BAND_BASE_BPS.saturating_add(BAND_PER_SEC_BPS.saturating_mul(secs.max(0) as u128));
    let diff = (price as u128).abs_diff(last as u128);
    diff.saturating_mul(10_000) <= (last as u128).saturating_mul(allowed_bps)
}

pub const TAG_OPEN_ACCOUNT: u8 = 0;
pub const TAG_DEPOSIT: u8 = 1;
pub const TAG_WITHDRAW: u8 = 2;
pub const TAG_OPEN_BOOK: u8 = 3;
pub const TAG_REQUEST: u8 = 4;
pub const TAG_ADVANCE: u8 = 5;
pub const TAG_FILL: u8 = 6;
pub const TAG_EXPIRE: u8 = 7;
pub const TAG_REQUEST_CLOSE: u8 = 8;
pub const TAG_REQUEST_SETTLE: u8 = 9;
pub const TAG_SETTLE: u8 = 10;
pub const TAG_POST_PRICE: u8 = 11;
pub const TAG_PLACE_ORDER: u8 = 12;
pub const TAG_CANCEL_ORDER: u8 = 13;
pub const TAG_TRIGGER_ORDER: u8 = 14;
pub const TAG_OPEN_STATS: u8 = 15;
pub const TAG_SET_PROFILE: u8 = 16;
pub const TAG_FOLLOW: u8 = 17;
pub const TAG_UNFOLLOW: u8 = 18;
pub const TAG_SET_COPY: u8 = 19;
pub const TAG_STOP_COPY: u8 = 20;
pub const TAG_TRIGGER_COPY: u8 = 21;
pub const TAG_CONVERT_PNL: u8 = 22;
pub const TAG_SWEEP: u8 = 23;
pub const TAG_SET_REFERRER: u8 = 24;
/// Widest trail, in basis points.
pub const MAX_TRAIL_BPS: u64 = 5_000;
/// Shortest time between two slices of a TWAP order, and the most slices one can have.
pub const MIN_TWAP_INTERVAL_SECS: i64 = 10;
pub const MAX_TWAP_SLICES: u32 = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum RouterError {
    InvalidInstruction = 0x5700,
    BadAccount,
    NotSigner,
    NotWritable,
    AlreadyInitialized,
    /// The trader already has a request pending.
    RequestPending,
    /// Margin would not cover the position after a stressed price move.
    InsufficientMargin,
    /// The book already holds the maximum number of pending requests.
    BookFull,
    /// A Pyth update that is not newer than the mark, or not the first one at a pending target.
    WrongUpdate,
    /// The mark is not yet the price this request fills at.
    NotAtTarget,
    /// Percolator's effective price has not converged to the mark yet (it moves a capped amount
    /// per slot); try again in a later slot.
    NotConverged,
    /// The request cannot expire yet.
    TooEarly,
    Overflow,
    NotActive,
    BadOracle,
    /// The market is close-only (a position on it was force-reduced): positions on it can only be
    /// closed, with `RequestClose`, until all are closed and it resets.
    CloseOnly,
    /// `RequestClose` when the market is not close-only and the trader is not liquidatable.
    NotCloseOnly,
    /// `PostPrice` by a key that is not the reporter.
    NotReporter,
    /// A reported price where only a Pyth price is accepted: no queued request has waited
    /// `FALLBACK_SECS` past its target for one.
    FallbackNotAllowed,
    /// `TriggerOrder` on an order whose condition does not hold (yet).
    NotTriggered,
    /// `PlaceOrder` with parameters that make no order.
    BadOrder,
    /// `SetProfile` with a name that is not 3 to 16 letters, digits or underscores.
    BadName,
    /// `SetProfile` with a name another wallet holds.
    NameTaken,
    /// `TriggerCopy` on a follower whose position is already in line with its leader's.
    InLine,
    /// A price too far from the mark for the time that has passed since it (see `within_band`).
    PriceBand,
}

impl From<RouterError> for ProgramError {
    fn from(e: RouterError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(RouterError::InvalidInstruction)?;
    let u64_at = |i: usize| -> Result<u64, RouterError> {
        rest.get(i..i + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap())).ok_or(RouterError::InvalidInstruction)
    };
    match *tag {
        TAG_OPEN_ACCOUNT => open_account(program_id, accounts),
        TAG_DEPOSIT => deposit(program_id, accounts, u64_at(0)?),
        TAG_WITHDRAW => withdraw(program_id, accounts, u64_at(0)?),
        TAG_OPEN_BOOK => open_book(program_id, accounts),
        TAG_REQUEST => {
            let b = rest.get(..16).ok_or(RouterError::InvalidInstruction)?;
            request(program_id, accounts, i128::from_le_bytes(b.try_into().unwrap()))
        }
        TAG_ADVANCE => advance(program_id, accounts, u64_at(0)?, u64_at(8)?),
        TAG_FILL => fill(program_id, accounts),
        TAG_EXPIRE => expire(program_id, accounts),
        TAG_REQUEST_CLOSE => request_close(program_id, accounts),
        TAG_REQUEST_SETTLE => request_settle(program_id, accounts),
        TAG_SETTLE => settle(program_id, accounts, u64_at(0)?),
        TAG_POST_PRICE => post_price(program_id, accounts, rest),
        TAG_PLACE_ORDER => place_order(program_id, accounts, rest),
        TAG_CANCEL_ORDER => cancel_order(program_id, accounts),
        TAG_TRIGGER_ORDER => trigger_order(program_id, accounts),
        TAG_OPEN_STATS => social::open_stats(program_id, accounts),
        TAG_SET_PROFILE => social::set_profile(program_id, accounts, rest),
        TAG_FOLLOW => social::follow(program_id, accounts),
        TAG_UNFOLLOW => social::unfollow(program_id, accounts),
        TAG_SET_COPY => social::set_copy(program_id, accounts, rest),
        TAG_STOP_COPY => social::stop_copy(program_id, accounts),
        TAG_TRIGGER_COPY => social::trigger_copy(program_id, accounts, rest),
        TAG_CONVERT_PNL => convert_pnl(program_id, accounts),
        TAG_SWEEP => sweep(program_id, accounts),
        TAG_SET_REFERRER => social::set_referrer(program_id, accounts),
        _ => Err(RouterError::InvalidInstruction.into()),
    }
}

/// Moves what expired requests left in a book (forfeited bonds and expiry deposits) to the
/// platform's treasury. Anyone may call it: the destination is fixed, and the book keeps the
/// rent it needs. The money never goes to whoever fills or expires requests, so nobody earns by
/// letting one lapse.
///
/// Accounts: 0 book [w], 1 treasury [w] (`percolator_vault::processor::TREASURY`).
fn sweep(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let book_ai = acc(accounts, 0)?;
    let treasury = acc(accounts, 1)?;
    writable(book_ai)?;
    writable(treasury)?;
    key_is(treasury, &percolator_vault::processor::TREASURY)?;
    let _: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    let keep = Rent::get()?.minimum_balance(book_ai.data_len());
    let spare = book_ai.lamports().saturating_sub(keep);
    if spare == 0 {
        return Err(RouterError::InvalidInstruction.into());
    }
    **book_ai.try_borrow_mut_lamports()? -= spare;
    **treasury.try_borrow_mut_lamports()? = treasury.lamports().checked_add(spare).ok_or(RouterError::Overflow)?;
    Ok(())
}

// ---- helpers ----

fn acc<'a, 'b>(accounts: &'a [AccountInfo<'b>], i: usize) -> Result<&'a AccountInfo<'b>, RouterError> {
    accounts.get(i).ok_or(RouterError::BadAccount)
}
fn signer(ai: &AccountInfo) -> Result<(), RouterError> {
    if ai.is_signer { Ok(()) } else { Err(RouterError::NotSigner) }
}
fn writable(ai: &AccountInfo) -> Result<(), RouterError> {
    if ai.is_writable { Ok(()) } else { Err(RouterError::NotWritable) }
}
fn key_is(ai: &AccountInfo, k: &Pubkey) -> Result<(), RouterError> {
    if ai.key == k { Ok(()) } else { Err(RouterError::BadAccount) }
}
fn token_amount(ai: &AccountInfo) -> Result<u64, RouterError> {
    if ai.owner != &spl_token::ID {
        return Err(RouterError::BadAccount);
    }
    let d = ai.try_borrow_data().map_err(|_| RouterError::BadAccount)?;
    Ok(spl_token::state::Account::unpack(&d).map_err(|_| RouterError::BadAccount)?.amount)
}

fn create_pda<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    owner: &Pubkey,
    space: usize,
    extra_lamports: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    if target.owner != &system_program::ID || target.data_len() != 0 {
        return Err(RouterError::AlreadyInitialized.into());
    }
    let need = Rent::get()?.minimum_balance(space).saturating_add(extra_lamports);
    let have = target.lamports();
    if have < need {
        invoke(
            &system_instruction::transfer(payer.key, target.key, need - have),
            &[payer.clone(), target.clone(), system.clone()],
        )?;
    }
    invoke_signed(&system_instruction::allocate(target.key, space as u64), &[target.clone(), system.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(target.key, owner), &[target.clone(), system.clone()], &[seeds])
}

/// Moves all lamports out of a router-owned account (closing it): `bond` to `bond_to`, the rest to `rest_to`.
fn close(account: &AccountInfo, bond: u64, bond_to: &AccountInfo, rest_to: &AccountInfo) -> ProgramResult {
    let total = account.lamports();
    let bond = bond.min(total);
    **bond_to.try_borrow_mut_lamports()? = bond_to.lamports().checked_add(bond).ok_or(RouterError::Overflow)?;
    **rest_to.try_borrow_mut_lamports()? = rest_to.lamports().checked_add(total - bond).ok_or(RouterError::Overflow)?;
    **account.try_borrow_mut_lamports()? = 0;
    account.assign(&system_program::ID);
    account.realloc(0, false)
}

fn load_vault(ai: &AccountInfo) -> Result<vstate::VaultState, ProgramError> {
    let v = vstate::load_vault(ai, &percolator_vault::id())?;
    if v.mode != MODE_OPERATE || v.status != STATUS_ACTIVE {
        return Err(RouterError::NotActive.into());
    }
    Ok(v)
}

fn load_trader(program_id: &Pubkey, ai: &AccountInfo, wallet: &Pubkey) -> Result<TraderState, ProgramError> {
    let t: TraderState = load(ai, program_id, TRADER_MAGIC)?;
    if t.wallet != *wallet {
        return Err(RouterError::BadAccount.into());
    }
    Ok(t)
}

macro_rules! trader_seeds {
    ($t:expr) => {
        &[SEED_TRADER, $t.market.as_ref(), $t.wallet.as_ref(), &[$t.bump]]
    };
}

// ---- accounts ----

/// Creates the trader's router account, its Percolator portfolio and its collateral account,
/// all owned by the trader's program address.
///
/// Accounts: 0 wallet [s, w], 1 trader [w], 2 portfolio [w], 3 collateral [w], 4 market [w],
/// 5 collateral mint, 6 Percolator program, 7 system program, 8 token program.
#[inline(never)]
fn open_account(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let trader_ai = acc(accounts, 1)?;
    let portfolio = acc(accounts, 2)?;
    let collateral = acc(accounts, 3)?;
    let market = acc(accounts, 4)?;
    let mint = acc(accounts, 5)?;
    let percolator = acc(accounts, 6)?;
    let system = acc(accounts, 7)?;
    let token = acc(accounts, 8)?;
    signer(wallet)?;
    for w in [wallet, trader_ai, portfolio, collateral, market] {
        writable(w)?;
    }
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    key_is(system, &system_program::ID)?;
    key_is(token, &spl_token::ID)?;
    if perc::market_collateral_mint(market)? != *mint.key {
        return Err(RouterError::BadAccount.into());
    }
    let (tk, bump) = trader_address(program_id, market.key, wallet.key);
    let (pk, pbump) = portfolio_address(program_id, market.key, wallet.key);
    let (ck, cbump) = collateral_address(program_id, market.key, wallet.key);
    key_is(trader_ai, &tk)?;
    key_is(portfolio, &pk)?;
    key_is(collateral, &ck)?;

    create_pda(wallet, trader_ai, system, program_id, TRADER_LEN, 0, &[SEED_TRADER, market.key.as_ref(), wallet.key.as_ref(), &[bump]])?;
    create_pda(wallet, portfolio, system, &PERCOLATOR_PROGRAM_ID, perc::PORTFOLIO_ACCOUNT_LEN, 0, &[SEED_PORTFOLIO, market.key.as_ref(), wallet.key.as_ref(), &[pbump]])?;
    create_pda(wallet, collateral, system, &spl_token::ID, spl_token::state::Account::LEN, 0, &[SEED_COLLATERAL, market.key.as_ref(), wallet.key.as_ref(), &[cbump]])?;
    invoke(
        &spl_token::instruction::initialize_account3(&spl_token::ID, collateral.key, mint.key, trader_ai.key)?,
        &[collateral.clone(), mint.clone(), token.clone()],
    )?;
    let t = TraderState {
        magic: TRADER_MAGIC,
        market: *market.key,
        wallet: *wallet.key,
        portfolio: pk,
        collateral: ck,
        bump,
        has_pending: 0,
        has_stats: 0,
        _pad: [0; 5],
        pending_vault: Pubkey::default(),
        pending_id: 0,
    };
    store(trader_ai, &t)?;
    invoke_signed(
        &perc::init_portfolio(trader_ai.key, market.key, portfolio.key),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )
}

/// Moves collateral from the wallet into the trader's Percolator portfolio.
///
/// Accounts: 0 wallet [s], 1 trader, 2 wallet token account [w], 3 collateral [w], 4 portfolio [w],
/// 5 market [w], 6 Percolator collateral vault [w], 7 token program, 8 Percolator program,
/// 9 the trader's track record [w] (needed once it has one, see `OpenStats`).
#[inline(never)]
fn deposit(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let trader_ai = acc(accounts, 1)?;
    let source = acc(accounts, 2)?;
    let collateral = acc(accounts, 3)?;
    let portfolio = acc(accounts, 4)?;
    let market = acc(accounts, 5)?;
    let perc_vault = acc(accounts, 6)?;
    let token = acc(accounts, 7)?;
    let percolator = acc(accounts, 8)?;
    signer(wallet)?;
    key_is(token, &spl_token::ID)?;
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    let t = load_trader(program_id, trader_ai, wallet.key)?;
    key_is(collateral, &t.collateral)?;
    key_is(portfolio, &t.portfolio)?;
    key_is(market, &t.market)?;
    if amount == 0 {
        return Err(RouterError::InvalidInstruction.into());
    }
    invoke(
        &spl_token::instruction::transfer(&spl_token::ID, source.key, collateral.key, wallet.key, &[], amount)?,
        &[source.clone(), collateral.clone(), wallet.clone(), token.clone()],
    )?;
    let view = perc::read_portfolio(portfolio, market.key, trader_ai.key)?;
    invoke_signed(
        &perc::deposit(trader_ai.key, market.key, portfolio.key, collateral.key, perc_vault.key, view.portfolio_id, view.sequence, amount as u128),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), collateral.clone(), perc_vault.clone(), token.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )?;
    social::book_flow(program_id, &t, acc(accounts, 9), amount, 0)
}

/// Moves collateral from the trader's portfolio back to a token account the wallet owns. Refused
/// while a request is pending, so margin cannot leave between a request and its fill.
///
/// Accounts: 0 wallet [s], 1 trader, 2 portfolio [w], 3 market [w], 4 collateral [w],
/// 5 destination token account [w] (owned by the wallet), 6 Percolator collateral vault [w],
/// 7 Percolator vault authority, 8 token program, 9 Percolator program, 10 the trader's track
/// record [w] (needed once it has one, see `OpenStats`).
#[inline(never)]
fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let trader_ai = acc(accounts, 1)?;
    let portfolio = acc(accounts, 2)?;
    let market = acc(accounts, 3)?;
    let collateral = acc(accounts, 4)?;
    let dest = acc(accounts, 5)?;
    let perc_vault = acc(accounts, 6)?;
    let perc_vault_auth = acc(accounts, 7)?;
    let token = acc(accounts, 8)?;
    let percolator = acc(accounts, 9)?;
    signer(wallet)?;
    key_is(token, &spl_token::ID)?;
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    let t = load_trader(program_id, trader_ai, wallet.key)?;
    key_is(collateral, &t.collateral)?;
    key_is(portfolio, &t.portfolio)?;
    key_is(market, &t.market)?;
    if t.has_pending != 0 {
        return Err(RouterError::RequestPending.into());
    }
    {
        let d = dest.try_borrow_data().map_err(|_| RouterError::BadAccount)?;
        let a = spl_token::state::Account::unpack(&d).map_err(|_| RouterError::BadAccount)?;
        if dest.owner != &spl_token::ID || a.owner != *wallet.key || a.mint != perc::market_collateral_mint(market)? {
            return Err(RouterError::BadAccount.into());
        }
    }
    let view = perc::read_portfolio(portfolio, market.key, trader_ai.key)?;
    let before = token_amount(collateral)?;
    invoke_signed(
        &perc::withdraw(trader_ai.key, market.key, portfolio.key, collateral.key, perc_vault.key, perc_vault_auth.key, view.portfolio_id, view.sequence, amount as u128),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), collateral.clone(), perc_vault.clone(), perc_vault_auth.clone(), token.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )?;
    let received = token_amount(collateral)?.checked_sub(before).ok_or(RouterError::Overflow)?;
    invoke_signed(
        &spl_token::instruction::transfer(&spl_token::ID, collateral.key, dest.key, trader_ai.key, &[], received)?,
        &[collateral.clone(), dest.clone(), trader_ai.clone(), token.clone()],
        &[trader_seeds!(t)],
    )?;
    social::book_flow(program_id, &t, acc(accounts, 10), 0, received)
}

/// Turns the trader's released profit into capital, which is what a withdrawal pays out and what
/// margin is counted from. Percolator books a gain as profit first and only its owner can ask
/// for the conversion; the owner of a trading account is its program address, so without this
/// nobody could, and a trader's winnings would stay in the account for good. Anyone may call it:
/// it only moves a trader's own money from one of its own pockets to the other.
///
/// Accounts: 0 trader, 1 market [w], 2 trader portfolio [w], 3 Percolator program.
#[inline(never)]
fn convert_pnl(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let trader_ai = acc(accounts, 0)?;
    let market = acc(accounts, 1)?;
    let portfolio = acc(accounts, 2)?;
    let percolator = acc(accounts, 3)?;
    writable(market)?;
    writable(portfolio)?;
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    let t: TraderState = load(trader_ai, program_id, TRADER_MAGIC)?;
    key_is(market, &t.market)?;
    key_is(portfolio, &t.portfolio)?;
    let view = perc::read_portfolio(portfolio, market.key, trader_ai.key)?;
    invoke_signed(
        &perc::convert_released_pnl(trader_ai.key, market.key, portfolio.key, view.portfolio_id, view.position_epoch),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )
}

// ---- the book ----

/// Creates a vault's book (its queue of pending requests and its mark). Anyone can.
///
/// Accounts: 0 payer [s, w], 1 vault, 2 book [w], 3 system program.
#[inline(never)]
fn open_book(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let payer = acc(accounts, 0)?;
    let vault_ai = acc(accounts, 1)?;
    let book_ai = acc(accounts, 2)?;
    let system = acc(accounts, 3)?;
    signer(payer)?;
    writable(book_ai)?;
    key_is(system, &system_program::ID)?;
    let v = load_vault(vault_ai)?;
    let (bk, bump) = book_address(program_id, vault_ai.key);
    key_is(book_ai, &bk)?;
    create_pda(payer, book_ai, system, program_id, BOOK_LEN, 0, &[SEED_BOOK, vault_ai.key.as_ref(), &[bump]])?;
    let mut b = Book::zeroed();
    b.magic = BOOK_MAGIC;
    b.vault = *vault_ai.key;
    b.market = v.market;
    b.bump = bump;
    store(book_ai, &b)
}

/// Stressed margin check: after the trade, equity must cover initial margin plus fees on every
/// position with prices `STRESS_BPS` higher, and a `STRESS_BPS` loss on all of them.
fn margin_covers(market: &[u8], portfolio: &[u8], v: &vstate::VaultState, size: i128) -> Result<bool, ProgramError> {
    margin_covers_at(market, portfolio, v, size, STRESS_BPS)
}

/// The same check with a price move of `stress_bps` (0: at the current price, which is what
/// Percolator itself asks for at the fill).
fn margin_covers_at(market: &[u8], portfolio: &[u8], v: &vstate::VaultState, size: i128, stress_bps: u128) -> Result<bool, ProgramError> {
    let asset = v.asset_index;
    let (im_bps, min_im, fee_bps) = perc::margin_params(market)?;
    let (capital, pnl, _) = perc::portfolio_exposure(portfolio)?;
    let legs: Vec<(u16, i128)> = perc::positions(market, portfolio)?.iter().map(|p| (p.asset, p.size)).collect();
    let notional = |a: u16, q: u128| -> Result<u128, ProgramError> {
        let (_, price, _) = perc::asset_price(market, a)?;
        Ok(q.checked_mul(price as u128).ok_or(RouterError::Overflow)? / POS_SCALE)
    };
    // The position on the traded asset after the fill. A trade that only shrinks it (without
    // crossing zero) takes risk off and is never refused for margin: refusing it would stop a
    // trader with thin margin from closing.
    let held = legs.iter().find(|(a, _)| *a == asset).map_or(0, |(_, q)| *q);
    let after = held.checked_add(size).ok_or(RouterError::Overflow)?;
    if after == 0 || ((after > 0) == (held > 0) && held != 0 && after.unsigned_abs() < held.unsigned_abs()) {
        return Ok(true);
    }
    let mut total = notional(asset, after.unsigned_abs())?;
    for (a, q) in legs {
        if a != asset {
            total = total.checked_add(notional(a, q.unsigned_abs())?).ok_or(RouterError::Overflow)?;
        }
    }
    let stressed = total * (10_000 + stress_bps) / 10_000;
    let need = stressed * im_bps as u128 / 10_000
        + total * stress_bps / 10_000
        + stressed * fee_bps as u128 / 10_000
        + min_im;
    let equity = (capital as i128).checked_add(pnl).ok_or(RouterError::Overflow)?;
    Ok(equity >= 0 && equity as u128 >= need)
}

/// True when the account can be liquidated through the router: every position is settled at the
/// current price (so capital and PnL reflect it) and equity is below `LIQUIDATION_BPS` of the
/// positions' notional.
fn liquidatable(market: &[u8], portfolio: &[u8]) -> Result<bool, ProgramError> {
    let (capital, pnl, _) = perc::portfolio_exposure(portfolio)?;
    let mut notional = 0u128;
    for p in perc::positions(market, portfolio)? {
        if !p.settled {
            return Ok(false);
        }
        let (_, price, _) = perc::asset_price(market, p.asset)?;
        notional = notional
            .checked_add(p.size.unsigned_abs().checked_mul(price as u128).ok_or(RouterError::Overflow)? / POS_SCALE)
            .ok_or(RouterError::Overflow)?;
    }
    let equity = (capital as i128).checked_add(pnl).ok_or(RouterError::Overflow)?;
    Ok(notional != 0 && (equity <= 0 || (equity as u128).saturating_mul(10_000) < notional.saturating_mul(LIQUIDATION_BPS)))
}

/// Queues a trade. It fills at the first Pyth price published at or after its target time, which
/// is set here and cannot be changed or cancelled.
///
/// Accounts: 0 wallet [s, w], 1 trader [w], 2 vault, 3 book [w], 4 request [w], 5 market,
/// 6 trader portfolio, 7 system program. Data: size (i128, + = buy).
#[inline(never)]
fn request(program_id: &Pubkey, accounts: &[AccountInfo], size: i128) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let trader_ai = acc(accounts, 1)?;
    let vault_ai = acc(accounts, 2)?;
    let book_ai = acc(accounts, 3)?;
    let request_ai = acc(accounts, 4)?;
    let market = acc(accounts, 5)?;
    let portfolio = acc(accounts, 6)?;
    let system = acc(accounts, 7)?;
    signer(wallet)?;
    for w in [wallet, trader_ai, book_ai, request_ai] {
        writable(w)?;
    }
    key_is(system, &system_program::ID)?;
    let mut t = load_trader(program_id, trader_ai, wallet.key)?;
    let v = load_vault(vault_ai)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    key_is(market, &v.market)?;
    key_is(market, &t.market)?;
    key_is(portfolio, &t.portfolio)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    if t.has_pending != 0 {
        return Err(RouterError::RequestPending.into());
    }
    if size == 0 || size == i128::MIN {
        return Err(RouterError::InvalidInstruction.into());
    }
    if b.len as usize >= MAX_PENDING - RESERVED_PENDING {
        return Err(RouterError::BookFull.into());
    }
    perc::expect_market(market)?;
    if perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)? {
        return Err(RouterError::CloseOnly.into());
    }
    if !margin_covers(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, &v, size)? {
        return Err(RouterError::InsufficientMargin.into());
    }
    // The deposit is counted at the mark (Percolator's price for a book that has none yet).
    let price = if b.mark_price != 0 { b.mark_price } else { perc::asset_price(&market.try_borrow_data()?, v.asset_index)?.1 };
    enqueue(program_id, wallet, wallet.key, Some((trader_ai, &mut t)), vault_ai, book_ai, &mut b, request_ai, system, size, None, expiry_deposit(size, price))
}

/// Stores a request for `owner`'s trading account (paid for by `payer`) and adds it to the book.
/// `size` 0 marks a forced close (see `request_close`); without a trader it is an epoch
/// settlement (see `request_settle`); with `order` it was queued by that standing order.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn enqueue<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    owner: &Pubkey,
    trader: Option<(&AccountInfo<'a>, &mut TraderState)>,
    vault_ai: &AccountInfo<'a>,
    book_ai: &AccountInfo<'a>,
    b: &mut Book,
    request_ai: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    size: i128,
    order: Option<u8>,
    deposit: u64,
) -> ProgramResult {
    let clock = Clock::get()?;
    let target = clock.unix_timestamp.max(b.mark_publish_time).checked_add(DELAY_SECS).ok_or(RouterError::Overflow)?;
    let id = b.next_id;
    let settlement = trader.is_none();
    let (rk, rbump) = request_address(program_id, vault_ai.key, owner, settlement);
    key_is(request_ai, &rk)?;
    create_pda(payer, request_ai, system, program_id, REQUEST_LEN, BOND_LAMPORTS.saturating_add(deposit), &[SEED_REQUEST, vault_ai.key.as_ref(), owner.as_ref(), &[settlement as u8], &[rbump]])?;
    store(
        request_ai,
        &Request {
            magic: REQUEST_MAGIC,
            vault: *vault_ai.key,
            wallet: *owner,
            id,
            size,
            target_time: target,
            created_slot: clock.slot,
            bump: rbump,
            kind: if trader.is_none() { KIND_SETTLE } else if order.is_some() { KIND_ORDER } else { KIND_TRADE },
            order_index: order.unwrap_or(0),
            _pad: [0; 5],
        },
    )?;
    b.next_id = id.checked_add(1).ok_or(RouterError::Overflow)?;
    let (mut ids, mut targets) = (b.pending_id, b.pending_target);
    ids[b.len as usize] = id;
    targets[b.len as usize] = target;
    b.pending_id = ids;
    b.pending_target = targets;
    b.len += 1;
    store(book_ai, &*b)?;
    if let Some((trader_ai, t)) = trader {
        t.has_pending = 1;
        t.pending_vault = *vault_ai.key;
        t.pending_id = id;
        store(trader_ai, &*t)?;
    }
    Ok(())
}

/// Queues the forced close of a trader's position on a vault's market. Anyone may queue it (paying
/// the bond and the request's rent, which goes to the trader when it closes), in two cases:
///
/// - The market is close-only. Percolator refuses every risk-increasing trade on such a market,
///   so the vault cannot take the other side of a close; the fill reduces the position
///   unilaterally instead (Percolator's `RebalanceReduce`). The market only reopens once every
///   position on it is closed.
/// - The trader is below `LIQUIDATION_BPS` (see `liquidatable`). The fill closes the position
///   against the vault, if the account is still below that level at the fill price.
///
/// Either way it executes at the same price as any request: the first Pyth price published at or
/// after its target time.
///
/// Accounts: 0 payer [s, w], 1 trader [w], 2 trader wallet, 3 vault, 4 book [w], 5 request [w],
/// 6 market, 7 system program, 8 trader portfolio.
#[inline(never)]
fn request_close(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let payer = acc(accounts, 0)?;
    let trader_ai = acc(accounts, 1)?;
    let wallet = acc(accounts, 2)?;
    let vault_ai = acc(accounts, 3)?;
    let book_ai = acc(accounts, 4)?;
    let request_ai = acc(accounts, 5)?;
    let market = acc(accounts, 6)?;
    let system = acc(accounts, 7)?;
    signer(payer)?;
    for w in [payer, trader_ai, book_ai, request_ai] {
        writable(w)?;
    }
    key_is(system, &system_program::ID)?;
    let mut t = load_trader(program_id, trader_ai, wallet.key)?;
    let v = load_vault(vault_ai)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    key_is(market, &v.market)?;
    key_is(market, &t.market)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    if t.has_pending != 0 {
        return Err(RouterError::RequestPending.into());
    }
    if b.len as usize >= MAX_PENDING {
        return Err(RouterError::BookFull.into());
    }
    perc::expect_market(market)?;
    if !perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)? {
        let portfolio = acc(accounts, 8)?;
        key_is(portfolio, &t.portfolio)?;
        if !liquidatable(&market.try_borrow_data()?, &portfolio.try_borrow_data()?)? {
            return Err(RouterError::NotCloseOnly.into());
        }
    }
    enqueue(program_id, payer, wallet.key, Some((trader_ai, &mut t)), vault_ai, book_ai, &mut b, request_ai, system, 0, None, 0)
}

// ---- standing orders: stop, take-profit, trailing stop, limit, TWAP ----

fn position_on(market: &AccountInfo, portfolio: &AccountInfo, asset: u16) -> Result<i128, ProgramError> {
    Ok(perc::positions(&market.try_borrow_data()?, &portfolio.try_borrow_data()?)?.iter().find(|x| x.asset == asset).map_or(0, |x| x.size))
}

/// The trade that closes `amount` of a position (all of it when `amount` is 0 or larger than it).
fn closing(held: i128, amount: i128) -> i128 {
    let all = held.unsigned_abs();
    let q = if amount <= 0 || amount.unsigned_abs() > all { all } else { amount.unsigned_abs() } as i128;
    if held > 0 { -q } else { q }
}

/// Places a standing order on a vault's market. The wallet signs once, here; from then on anyone
/// may carry the order out when its condition holds (`TriggerOrder`), and only the wallet can
/// cancel it. A stop, take-profit or trailing stop is tied to the position the wallet holds now.
///
/// Accounts: 0 wallet [s, w], 1 trader, 2 vault, 3 book, 4 order [w], 5 market, 6 trader
/// portfolio, 7 system program.
/// Data: index (u8), kind (u8), reduce-only (u8), size (i128), trigger (u64), TWAP interval
/// seconds (i64), TWAP slices (u32), expiry time (i64, 0 = none).
#[inline(never)]
fn place_order(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let trader_ai = acc(accounts, 1)?;
    let vault_ai = acc(accounts, 2)?;
    let book_ai = acc(accounts, 3)?;
    let order_ai = acc(accounts, 4)?;
    let market = acc(accounts, 5)?;
    let portfolio = acc(accounts, 6)?;
    let system = acc(accounts, 7)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(order_ai)?;
    key_is(system, &system_program::ID)?;
    if data.len() != 47 {
        return Err(RouterError::InvalidInstruction.into());
    }
    let (index, kind, reduce_only) = (data[0], data[1], data[2]);
    let size = i128::from_le_bytes(data[3..19].try_into().unwrap());
    let trigger = u64::from_le_bytes(data[19..27].try_into().unwrap());
    let interval = i64::from_le_bytes(data[27..35].try_into().unwrap());
    let slices = u32::from_le_bytes(data[35..39].try_into().unwrap());
    let expiry = i64::from_le_bytes(data[39..47].try_into().unwrap());

    let t = load_trader(program_id, trader_ai, wallet.key)?;
    let v = load_vault(vault_ai)?;
    let b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    key_is(market, &v.market)?;
    key_is(market, &t.market)?;
    key_is(portfolio, &t.portfolio)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    perc::expect_market(market)?;
    let now = Clock::get()?.unix_timestamp;
    if index >= MAX_ORDERS || reduce_only > 1 || size == i128::MIN || (expiry != 0 && expiry <= now) {
        return Err(RouterError::BadOrder.into());
    }
    let (bk, bump) = order_address(program_id, vault_ai.key, wallet.key, index);
    key_is(order_ai, &bk)?;
    let mut o = Order::zeroed();
    o.magic = ORDER_MAGIC;
    o.vault = *vault_ai.key;
    o.wallet = *wallet.key;
    o.index = index;
    o.kind = kind;
    o.reduce_only = reduce_only;
    o.bump = bump;
    o.size = size;
    o.trigger = trigger;
    o.expiry = expiry;
    match kind {
        ORDER_STOP | ORDER_TAKE | ORDER_TRAIL => {
            // Tied to the position held now: without one there is nothing to protect.
            let held = position_on(market, portfolio, v.asset_index)?;
            if held == 0 || size < 0 || trigger == 0 {
                return Err(RouterError::BadOrder.into());
            }
            o.reduce_only = 1;
            o.side = if held > 0 { 1 } else { -1 };
            if kind == ORDER_TRAIL {
                if trigger > MAX_TRAIL_BPS || b.mark_price == 0 {
                    return Err(RouterError::BadOrder.into());
                }
                o.peak = b.mark_price;
            }
        }
        ORDER_LIMIT => {
            if size == 0 || trigger == 0 {
                return Err(RouterError::BadOrder.into());
            }
        }
        ORDER_TWAP => {
            let slice = size.unsigned_abs() / (slices.max(1) as u128);
            if size == 0 || !(2..=MAX_TWAP_SLICES).contains(&slices) || interval < MIN_TWAP_INTERVAL_SECS || slice == 0 || slice > u64::MAX as u128 {
                return Err(RouterError::BadOrder.into());
            }
            o.slice = slice as u64;
            o.interval = interval;
            o.next_time = now;
        }
        _ => return Err(RouterError::BadOrder.into()),
    }
    create_pda(wallet, order_ai, system, program_id, ORDER_LEN, 0, &[SEED_ORDER, vault_ai.key.as_ref(), wallet.key.as_ref(), &[index], &[bump]])?;
    store(order_ai, &o)
}

/// Removes a standing order; its rent goes back to the wallet. Not while a request it queued is
/// still waiting to fill: that request cannot be cancelled, like any other.
///
/// Accounts: 0 wallet [s, w], 1 order [w].
#[inline(never)]
fn cancel_order(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let order_ai = acc(accounts, 1)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(order_ai)?;
    let o: Order = load(order_ai, program_id, ORDER_MAGIC)?;
    if o.wallet != *wallet.key {
        return Err(RouterError::BadAccount.into());
    }
    if o.queued_id != 0 {
        return Err(RouterError::RequestPending.into());
    }
    close(order_ai, 0, wallet, wallet)
}

/// Carries out a standing order whose condition holds: queues the trade it stands for as an
/// ordinary request, which then fills at the first oracle price at or after its target time.
/// Anyone may call it; the caller pays the request's rent and bond and gets both back from
/// whoever fills it (usually themselves). The condition is checked against the vault's mark:
///
/// - stop: mark at or through the trigger against the position;
/// - take-profit: mark at or through the trigger in the position's favour;
/// - trail: mark has come back the trail's distance from the best mark recorded. A call that
///   finds a better mark than the one recorded records it instead, and queues nothing;
/// - limit: mark at the limit or better (the fill refuses a worse price);
/// - TWAP: the next slice is due.
///
/// An order that can no longer do anything (its position is gone or changed side, it expired, a
/// reduce-only order has nothing to reduce) is removed instead, its rent going to the wallet.
///
/// Accounts: 0 payer [s, w], 1 order [w], 2 trader [w], 3 trader wallet [w], 4 vault, 5 book [w],
/// 6 request [w], 7 market, 8 trader portfolio, 9 system program.
#[inline(never)]
fn trigger_order(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let payer = acc(accounts, 0)?;
    let order_ai = acc(accounts, 1)?;
    let trader_ai = acc(accounts, 2)?;
    let wallet = acc(accounts, 3)?;
    let vault_ai = acc(accounts, 4)?;
    let book_ai = acc(accounts, 5)?;
    let request_ai = acc(accounts, 6)?;
    let market = acc(accounts, 7)?;
    let portfolio = acc(accounts, 8)?;
    let system = acc(accounts, 9)?;
    signer(payer)?;
    for w in [payer, order_ai, trader_ai, wallet, book_ai, request_ai] {
        writable(w)?;
    }
    key_is(system, &system_program::ID)?;
    let mut o: Order = load(order_ai, program_id, ORDER_MAGIC)?;
    key_is(wallet, &o.wallet)?;
    key_is(vault_ai, &o.vault)?;
    let mut t = load_trader(program_id, trader_ai, wallet.key)?;
    let v = load_vault(vault_ai)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    key_is(market, &v.market)?;
    key_is(market, &t.market)?;
    key_is(portfolio, &t.portfolio)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    if o.queued_id != 0 {
        return Err(RouterError::RequestPending.into());
    }
    perc::expect_market(market)?;
    let now = Clock::get()?.unix_timestamp;
    let held = position_on(market, portfolio, v.asset_index)?;
    let protective = matches!(o.kind, ORDER_STOP | ORDER_TAKE | ORDER_TRAIL);
    if (o.expiry != 0 && now > o.expiry) || (protective && (held == 0 || (held > 0) != (o.side > 0))) {
        return close(order_ai, 0, wallet, wallet);
    }
    let mark = b.mark_price;
    if mark == 0 {
        return Err(RouterError::NotTriggered.into());
    }
    let long = held > 0;
    let mut size = match o.kind {
        ORDER_STOP | ORDER_TAKE => {
            // A stop fires against the position, a take-profit in its favour.
            let below = (o.kind == ORDER_STOP) == long;
            if if below { mark > o.trigger } else { mark < o.trigger } {
                return Err(RouterError::NotTriggered.into());
            }
            closing(held, o.size)
        }
        ORDER_TRAIL => {
            if if long { mark > o.peak } else { mark < o.peak } {
                o.peak = mark;
                return store(order_ai, &o);
            }
            let (m, p, d) = (mark as u128 * 10_000, o.peak as u128, o.trigger as u128);
            if if long { m > p * (10_000 - d) } else { m < p * (10_000 + d) } {
                return Err(RouterError::NotTriggered.into());
            }
            closing(held, o.size)
        }
        ORDER_LIMIT => {
            if if o.size > 0 { mark > o.trigger } else { mark < o.trigger } {
                return Err(RouterError::NotTriggered.into());
            }
            o.size
        }
        _ => {
            if now < o.next_time {
                return Err(RouterError::NotTriggered.into());
            }
            o.next_time = now.checked_add(o.interval).ok_or(RouterError::Overflow)?;
            let q = (o.slice as u128).min(o.size.unsigned_abs()) as i128;
            if o.size > 0 { q } else { -q }
        }
    };
    if !protective && o.reduce_only != 0 {
        if held == 0 || (held > 0) == (size > 0) {
            return close(order_ai, 0, wallet, wallet);
        }
        if size.unsigned_abs() > held.unsigned_abs() {
            size = -held;
        }
    }
    if t.has_pending != 0 {
        return Err(RouterError::RequestPending.into());
    }
    if b.len as usize >= MAX_PENDING - RESERVED_PENDING {
        return Err(RouterError::BookFull.into());
    }
    if perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)? {
        return Err(RouterError::CloseOnly.into());
    }
    if !margin_covers(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, &v, size)? {
        return Err(RouterError::InsufficientMargin.into());
    }
    o.queued_id = b.next_id.checked_add(1).ok_or(RouterError::Overflow)?;
    store(order_ai, &o)?;
    enqueue(program_id, payer, wallet.key, Some((trader_ai, &mut t)), vault_ai, book_ai, &mut b, request_ai, system, size, Some(o.index), 0)
}

/// Books what a request queued by a standing order traded, and removes the order once it has
/// nothing left to do (its rent goes to the wallet).
#[inline(never)]
fn settle_order(order_ai: &AccountInfo, mut o: Order, traded: i128, wallet: &AccountInfo) -> ProgramResult {
    o.queued_id = 0;
    let done = match o.kind {
        ORDER_STOP | ORDER_TAKE | ORDER_TRAIL => traded != 0,
        _ => {
            let left = o.size.checked_sub(traded).ok_or(RouterError::Overflow)?;
            // Never past zero: what is left keeps the order's side.
            let over = left != 0 && (left > 0) != (o.size > 0);
            o.size = if over { 0 } else { left };
            o.size == 0
        }
    };
    if done { close(order_ai, 0, wallet, wallet) } else { store(order_ai, &o) }
}

/// Posts a price for a feed into the router's account for it. Only the reporter can, and the
/// price is not verifiable on chain (see `percolator_vault::reporter`); `advance` decides when
/// such a price may move a mark.
///
/// Accounts: 0 reporter [s, w], 1 the feed's price account [w], 2 system program.
/// Data: feed id [32], price (e6, u64), publish time (i64), previous publish time (i64).
#[inline(never)]
fn post_price(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let reporter_ai = acc(accounts, 0)?;
    let report_ai = acc(accounts, 1)?;
    let system = acc(accounts, 2)?;
    signer(reporter_ai)?;
    writable(report_ai)?;
    key_is(system, &system_program::ID)?;
    if *reporter_ai.key != reporter::REPORTER {
        return Err(RouterError::NotReporter.into());
    }
    if data.len() != 56 {
        return Err(RouterError::InvalidInstruction.into());
    }
    let feed: [u8; 32] = data[..32].try_into().unwrap();
    let price = u64::from_le_bytes(data[32..40].try_into().unwrap());
    let publish = i64::from_le_bytes(data[40..48].try_into().unwrap());
    let prev = i64::from_le_bytes(data[48..56].try_into().unwrap());
    // A positive price, published after the one before it and not in the future (a few seconds
    // of clock difference are allowed).
    if price == 0 || price > i64::MAX as u64 || prev >= publish || publish > Clock::get()?.unix_timestamp.saturating_add(5) {
        return Err(RouterError::BadOracle.into());
    }
    let (key, bump) = reporter::report_address(&feed);
    key_is(report_ai, &key)?;
    if report_ai.owner == program_id {
        let stored = reporter::decode(&report_ai.try_borrow_data()?).map_err(|_| RouterError::BadOracle)?;
        if publish <= stored.publish_time {
            return Err(RouterError::WrongUpdate.into());
        }
    } else {
        create_pda(reporter_ai, report_ai, system, program_id, reporter::REPORT_LEN, 0, &[reporter::SEED_REPORT, &feed, &[bump]])?;
    }
    let mut d = report_ai.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&reporter::REPORT_MAGIC.to_le_bytes());
    d[reporter::REPORT_FEED_OFF..reporter::REPORT_FEED_OFF + 32].copy_from_slice(&feed);
    d[reporter::REPORT_PRICE_OFF..reporter::REPORT_PRICE_OFF + 8].copy_from_slice(&price.to_le_bytes());
    d[reporter::REPORT_PUBLISH_OFF..reporter::REPORT_PUBLISH_OFF + 8].copy_from_slice(&publish.to_le_bytes());
    d[reporter::REPORT_PREV_OFF..reporter::REPORT_PREV_OFF + 8].copy_from_slice(&prev.to_le_bytes());
    d[reporter::REPORT_BUMP_OFF] = bump;
    Ok(())
}

/// Moves the vault's mark to a verified Pyth price (or, where allowed, a reported one). The update must be newer than the current
/// mark. If a pending request's target is at or before it, it must be the first update at or
/// after the earliest such target: the mark never skips over the price a request fills at.
///
/// Accounts: 0 router authority, 1 vault, 2 book [w], 3 market [w], 4 Pyth update,
/// 5 vault program, 6 Percolator program. Data: the asset's next oracle observation sequence and
/// its authority epoch (Percolator checks both).
#[inline(never)]
fn advance(program_id: &Pubkey, accounts: &[AccountInfo], observation_sequence: u64, authority_epoch: u64) -> ProgramResult {
    let authority = acc(accounts, 0)?;
    let vault_ai = acc(accounts, 1)?;
    let book_ai = acc(accounts, 2)?;
    let market = acc(accounts, 3)?;
    let pyth_ai = acc(accounts, 4)?;
    let vault_program = acc(accounts, 5)?;
    let percolator = acc(accounts, 6)?;
    writable(book_ai)?;
    writable(market)?;
    key_is(vault_program, &percolator_vault::id())?;
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    let (ak, abump) = authority_address(program_id);
    key_is(authority, &ak)?;
    let v = load_vault(vault_ai)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    key_is(market, &v.market)?;
    let reported = reporter::is_report(pyth_ai);
    let u = if reported {
        reporter::read(pyth_ai, &v.oracle_feeds[0])
    } else {
        pyth::read(pyth_ai, &v.oracle_feeds[0])
    }
    .map_err(|_| RouterError::BadOracle)?;
    let price = u.price_e6().ok_or(RouterError::BadOracle)?;
    if u.publish_time <= b.mark_publish_time {
        return Err(RouterError::WrongUpdate.into());
    }
    // A reported price is the reporter's word. Where Pyth exists it only rescues a queued request
    // that Pyth has not served for `FALLBACK_SECS` after its target, and only as that request's
    // price. In an X1 build it is the price source and follows the same rules as a Pyth update.
    if reported && !cfg!(feature = "x1") {
        let now = Clock::get()?.unix_timestamp;
        let rescues = b.earliest_target().is_some_and(|t| now >= t.saturating_add(reporter::FALLBACK_SECS) && u.is_first_at_or_after(t));
        if !rescues {
            return Err(RouterError::FallbackNotAllowed.into());
        }
    }
    if let Some(earliest) = b.earliest_target() {
        if earliest <= u.publish_time && !u.is_first_at_or_after(earliest) {
            return Err(RouterError::WrongUpdate.into());
        }
    }
    if !within_band(b.mark_price, price, u.publish_time.saturating_sub(b.mark_publish_time)) {
        return Err(RouterError::PriceBand.into());
    }
    let mut data = vec![TAG_PUSH_MARK];
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&observation_sequence.to_le_bytes());
    data.extend_from_slice(&authority_epoch.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: percolator_vault::id(),
            accounts: vec![
                AccountMeta::new_readonly(ak, true),
                AccountMeta::new_readonly(*vault_ai.key, false),
                AccountMeta::new(*market.key, false),
                AccountMeta::new_readonly(PERCOLATOR_PROGRAM_ID, false),
            ],
            data,
        },
        &[authority.clone(), vault_ai.clone(), market.clone(), percolator.clone(), vault_program.clone()],
        &[&[SEED_AUTHORITY, &[abump]]],
    )?;
    b.mark_publish_time = u.publish_time;
    b.mark_prev_publish_time = u.prev_publish_time;
    b.mark_price = price;
    b.mark_set_time = Clock::get()?.unix_timestamp.clamp(1, u32::MAX as i64) as u32;
    store(book_ai, &b)
}

/// Fills a request at the mark, once the mark is the first Pyth price at or after the request's
/// target and Percolator's effective price has reached it. Anyone can call it; the caller earns
/// the request's bond.
///
/// Accounts: 0 executor [s, w], 1 request [w], 2 trader [w], 3 trader wallet [w] (gets the
/// request's rent back), 4 book [w], 5 vault [w], 6 market [w], 7 trader portfolio [w],
/// 8 vault LP portfolio [w], 9 matcher delegate, 10 router authority, 11 vault program,
/// 12 Percolator program, (13 the standing order [w], for a request one queued,) and last,
/// optionally, the trader's track record [w].
#[inline(never)]
fn fill(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let executor = acc(accounts, 0)?;
    let request_ai = acc(accounts, 1)?;
    let trader_ai = acc(accounts, 2)?;
    let wallet = acc(accounts, 3)?;
    let book_ai = acc(accounts, 4)?;
    let vault_ai = acc(accounts, 5)?;
    let market = acc(accounts, 6)?;
    let portfolio = acc(accounts, 7)?;
    let lp_portfolio = acc(accounts, 8)?;
    let delegate = acc(accounts, 9)?;
    let authority = acc(accounts, 10)?;
    let vault_program = acc(accounts, 11)?;
    let percolator = acc(accounts, 12)?;
    signer(executor)?;
    for w in [executor, request_ai, trader_ai, wallet, book_ai, vault_ai, market, portfolio, lp_portfolio] {
        writable(w)?;
    }
    key_is(vault_program, &percolator_vault::id())?;
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    let (ak, abump) = authority_address(program_id);
    key_is(authority, &ak)?;
    let r: Request = load(request_ai, program_id, REQUEST_MAGIC)?;
    if r.kind != KIND_TRADE && r.kind != KIND_ORDER && r.kind != KIND_COPY {
        return Err(RouterError::BadAccount.into());
    }
    let mut t = load_trader(program_id, trader_ai, &r.wallet)?;
    key_is(wallet, &r.wallet)?;
    // A request queued by a standing order comes with that order (account 13).
    let order = if r.kind == KIND_ORDER {
        let order_ai = acc(accounts, 13)?;
        writable(order_ai)?;
        key_is(order_ai, &order_address(program_id, &r.vault, &r.wallet, r.order_index).0)?;
        let o: Order = load(order_ai, program_id, ORDER_MAGIC)?;
        if o.queued_id != r.id.wrapping_add(1) {
            return Err(RouterError::BadAccount.into());
        }
        Some((order_ai, o))
    } else {
        None
    };
    // The rent of a request goes back to who paid it: the trader, or for a standing order's
    // request whoever carried the order out (the executor earns it by filling).
    let rent_to = if order.is_some() || r.kind == KIND_COPY { executor } else { wallet };
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    let v = load_vault(vault_ai)?;
    if r.vault != *vault_ai.key || b.vault != *vault_ai.key || t.pending_vault != *vault_ai.key || t.pending_id != r.id {
        return Err(RouterError::BadAccount.into());
    }
    key_is(market, &v.market)?;
    key_is(portfolio, &t.portfolio)?;
    key_is(lp_portfolio, &v.lp_portfolio)?;
    key_is(delegate, &v.matcher_delegate)?;

    // The mark is the unique first Pyth price at or after the target, and Percolator's price is it.
    if !(b.mark_prev_publish_time < r.target_time && r.target_time <= b.mark_publish_time) {
        return Err(RouterError::NotAtTarget.into());
    }
    perc::expect_market(market)?;
    let (market_id, effective, _) = perc::asset_price(&market.try_borrow_data()?, v.asset_index)?;
    if effective != b.mark_price {
        return Err(RouterError::NotConverged.into());
    }
    // (Percolator charges a trade against a matcher the market's base fee whatever is passed
    // here: "only the market base fee may debit the unsigned LP". The vault's spread setting
    // therefore cannot be charged as a fee from the router.)
    let (_, _, fee_bps) = perc::margin_params(&market.try_borrow_data()?)?;

    let held = |p: &AccountInfo, m: &AccountInfo| -> Result<i128, ProgramError> {
        Ok(perc::positions(&m.try_borrow_data()?, &p.try_borrow_data()?)?.iter().find(|x| x.asset == v.asset_index).map_or(0, |x| x.size))
    };
    let before = held(portfolio, market)?;
    // A forced close (size 0) trades whatever closes the position, or nothing at all.
    let mut size = r.size;
    let mut liquidated = false;
    if let Some((_, o)) = &order {
        // The position may have changed since the order was carried out: a reduce-only order
        // never opens or enlarges one. A limit order does not trade at a price worse than its limit.
        if o.reduce_only != 0 {
            if before == 0 || (before > 0) == (size > 0) {
                size = 0;
            } else if size.unsigned_abs() > before.unsigned_abs() {
                size = before.checked_neg().ok_or(RouterError::Overflow)?;
            }
        }
        if o.kind == ORDER_LIMIT && ((size > 0 && effective > o.trigger) || (size < 0 && effective < o.trigger)) {
            size = 0;
        }
    }
    if r.size != 0 && size != 0 {
        // A trade Percolator would refuse is not attempted: the request ends here having traded
        // nothing, instead of staying in the queue (unfillable, and in the way of every request
        // behind it) until it expires. That is a trade that adds risk on a market that has become
        // close-only, or one the account no longer has the margin for at this price.
        let close_only = perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)?;
        let reduces = before != 0 && (before > 0) != (size > 0) && size.unsigned_abs() <= before.unsigned_abs();
        if !close_only && liquidatable(&market.try_borrow_data()?, &portfolio.try_borrow_data()?)? {
            // Below the liquidation level at this price: the one thing a fill does for such an
            // account is close its position here, whatever was asked. A trader has one place in
            // the queue, so while a request of its own waits nobody can queue its liquidation;
            // without this, an account kept busy with small requests could not be liquidated
            // through the router at all.
            liquidated = before != 0;
            size = before.checked_neg().ok_or(RouterError::Overflow)?;
        } else if (close_only && !reduces) || !margin_covers_at(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, &v, size, 0)? {
            size = 0;
        }
    } else if r.size == 0 {
        let close_only = perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)?;
        if close_only && before != 0 {
            // Reduce the whole position unilaterally at Percolator's price, which is the mark.
            reduce_unilaterally(trader_ai, market, portfolio, percolator, &t, v.asset_index)?;
        } else if !close_only && before != 0 && liquidatable(&market.try_borrow_data()?, &portfolio.try_borrow_data()?)? {
            // Still below the liquidation level at the fill price: close against the vault.
            size = before.checked_neg().ok_or(RouterError::Overflow)?;
        }
    }
    if size != 0 {
        // A fill that only reduces the trader's own position is marked for the vault, which
        // takes it even while it accepts nothing else that grows its position.
        let closing = before != 0 && (before > 0) != (size > 0) && size.unsigned_abs() <= before.unsigned_abs();
        trade_against_vault(accounts, &t, &v, abump, market_id, size, closing, fee_bps)?;
    }
    // What actually traded (the vault may fill less than requested) and at what price.
    let traded = held(portfolio, market)? - before;
    msg!("fill {} {} {}", { r.id }, traded, effective);
    // The trader's track record, when the fill names it (its last account).
    if let Some(stats_ai) = accounts.last() {
        social::record_fill(program_id, stats_ai, &t, portfolio, v.asset_index, traded, effective);
    }

    b.remove(r.id)?;
    store(book_ai, &b)?;
    t.has_pending = 0;
    store(trader_ai, &t)?;
    if let Some((order_ai, o)) = order {
        // A liquidation is not the order's trade: a limit or TWAP order keeps what it had left.
        let protective = matches!(o.kind, ORDER_STOP | ORDER_TAKE | ORDER_TRAIL);
        settle_order(order_ai, o, if liquidated && !protective { 0 } else { traded }, wallet)?;
    }
    close(request_ai, BOND_LAMPORTS, executor, rent_to)
}

/// A forced close on a close-only market: Percolator's `RebalanceReduce` on the whole position.
#[inline(never)]
fn reduce_unilaterally<'a>(trader_ai: &AccountInfo<'a>, market: &AccountInfo<'a>, portfolio: &AccountInfo<'a>, percolator: &AccountInfo<'a>, t: &TraderState, asset: u16) -> ProgramResult {
    let view = perc::read_portfolio(portfolio, market.key, trader_ai.key)?;
    invoke_signed(
        &perc::rebalance_reduce(trader_ai.key, market.key, portfolio.key, view.portfolio_id, view.position_epoch, asset, u128::MAX >> 1),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )
}

/// Arms the vault's matcher for `size` and trades it against the vault through Percolator.
/// `accounts` are `fill`'s, already checked there.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn trade_against_vault(accounts: &[AccountInfo], t: &TraderState, v: &vstate::VaultState, abump: u8, market_id: u64, size: i128, closing: bool, fee_bps: u64) -> ProgramResult {
    let (trader_ai, vault_ai, market, portfolio) = (acc(accounts, 2)?, acc(accounts, 5)?, acc(accounts, 6)?, acc(accounts, 7)?);
    let (lp_portfolio, delegate, authority, vault_program, percolator) = (acc(accounts, 8)?, acc(accounts, 9)?, acc(accounts, 10)?, acc(accounts, 11)?, acc(accounts, 12)?);
    let mut arm = vec![TAG_ARM_FILL];
    arm.extend_from_slice(&size.to_le_bytes());
    arm.push(closing as u8);
    invoke_signed(
        &Instruction {
            program_id: percolator_vault::id(),
            accounts: vec![AccountMeta::new_readonly(*authority.key, true), AccountMeta::new(*vault_ai.key, false)],
            data: arm,
        },
        &[authority.clone(), vault_ai.clone(), vault_program.clone()],
        &[&[SEED_AUTHORITY, &[abump]]],
    )?;
    let taker_view = perc::read_portfolio(portfolio, market.key, trader_ai.key)?;
    let lp_view = perc::read_portfolio(lp_portfolio, market.key, vault_ai.key)?;
    invoke_signed(
        &perc::trade_cpi(
            trader_ai.key,
            market.key,
            portfolio.key,
            lp_portfolio.key,
            &percolator_vault::id(),
            vault_ai.key,
            delegate.key,
            &taker_view,
            &lp_view,
            v.asset_index,
            market_id,
            size,
            fee_bps,
        ),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), lp_portfolio.clone(), vault_program.clone(), vault_ai.clone(), delegate.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )
}

/// Queues the settlement of a vault's epoch at a price nobody can choose. A vault that holds a
/// position is worth more or less depending on the price, so its deposits and withdrawals are
/// priced at the first Pyth price published at or after this request's target time, exactly
/// like a trade. Anyone can queue it once the epoch is over and has requests waiting.
///
/// From here until the epoch rolls (or this request has expired) the vault takes no new deposit
/// or withdrawal requests: the settlement's price is fixed at the target time, and a request
/// that could still join the epoch after that would be priced at a price its sender knows.
///
/// Accounts: 0 payer [s, w], 1 vault [w], 2 book [w], 3 request [w], 4 system program,
/// 5 router authority, 6 vault program.
#[inline(never)]
fn request_settle(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let payer = acc(accounts, 0)?;
    let vault_ai = acc(accounts, 1)?;
    let book_ai = acc(accounts, 2)?;
    let request_ai = acc(accounts, 3)?;
    let system = acc(accounts, 4)?;
    let authority = acc(accounts, 5)?;
    let vault_program = acc(accounts, 6)?;
    signer(payer)?;
    for w in [payer, vault_ai, book_ai, request_ai] {
        writable(w)?;
    }
    key_is(system, &system_program::ID)?;
    key_is(vault_program, &percolator_vault::id())?;
    let (ak, abump) = authority_address(program_id);
    key_is(authority, &ak)?;
    let v = load_vault(vault_ai)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    let over = Clock::get()?.slot >= v.epoch_start_slot.saturating_add(v.epoch_len_slots);
    if !over || (v.pending_deposit_assets == 0 && v.pending_withdraw_shares == 0) {
        return Err(RouterError::TooEarly.into());
    }
    if b.len as usize >= MAX_PENDING {
        return Err(RouterError::BookFull.into());
    }
    enqueue(program_id, payer, payer.key, None, vault_ai, book_ai, &mut b, request_ai, system, 0, None, 0)?;
    let r: Request = load(request_ai, program_id, REQUEST_MAGIC)?;
    let until = r.target_time.saturating_add(GRACE_SECS).saturating_add(5).clamp(1, u32::MAX as i64) as u32;
    let mut data = vec![TAG_FREEZE_REQUESTS];
    data.extend_from_slice(&until.to_le_bytes());
    invoke_signed(
        &Instruction {
            program_id: percolator_vault::id(),
            accounts: vec![AccountMeta::new_readonly(ak, true), AccountMeta::new(*vault_ai.key, false)],
            data,
        },
        &[authority.clone(), vault_ai.clone(), vault_program.clone()],
        &[&[SEED_AUTHORITY, &[abump]]],
    )
}

/// Executes a queued settlement: with the mark at the request's target price and Percolator's
/// price at the mark, rolls the vault's epoch (the vault accepts a roll with its position open
/// only from the router). Pays the executor the bond.
///
/// Accounts: 0 executor [s, w], 1 request [w], 2 the request's payer [w], 3 book [w],
/// 4 router authority, then the vault's `RollEpoch` accounts 1..=14 in order: 5 vault [w],
/// 6 market [w], 7 LP portfolio [w], 8 buffer [w], 9 Percolator collateral vault [w],
/// 10 Percolator vault authority, 11 share mint [w], 12 share escrow [w], 13 epoch record [w],
/// 14 matcher delegate, 15 Percolator program, 16 vault program, 17 token program,
/// 18 system program. Data: the market's asset-generation frontier.
#[inline(never)]
fn settle(program_id: &Pubkey, accounts: &[AccountInfo], frontier: u64) -> ProgramResult {
    let executor = acc(accounts, 0)?;
    let request_ai = acc(accounts, 1)?;
    let wallet = acc(accounts, 2)?;
    let book_ai = acc(accounts, 3)?;
    let authority = acc(accounts, 4)?;
    let vault_ai = acc(accounts, 5)?;
    let market = acc(accounts, 6)?;
    let vault_program = acc(accounts, 16)?;
    signer(executor)?;
    for w in [executor, request_ai, wallet, book_ai] {
        writable(w)?;
    }
    key_is(vault_program, &percolator_vault::id())?;
    let (ak, abump) = authority_address(program_id);
    key_is(authority, &ak)?;
    let r: Request = load(request_ai, program_id, REQUEST_MAGIC)?;
    key_is(wallet, &r.wallet)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    let v = load_vault(vault_ai)?;
    if r.kind != KIND_SETTLE || r.vault != *vault_ai.key || b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    key_is(market, &v.market)?;
    if !(b.mark_prev_publish_time < r.target_time && r.target_time <= b.mark_publish_time) {
        return Err(RouterError::NotAtTarget.into());
    }
    perc::expect_market(market)?;
    let (_, effective, _) = perc::asset_price(&market.try_borrow_data()?, v.asset_index)?;
    if effective != b.mark_price {
        return Err(RouterError::NotConverged.into());
    }

    // RollEpoch with the executor as its cranker and the router's authority as account 15.
    let mut metas = vec![AccountMeta::new(*executor.key, true)];
    let mut infos = vec![executor.clone()];
    for ai in accounts.get(5..19).ok_or(ProgramError::NotEnoughAccountKeys)? {
        metas.push(if ai.is_writable { AccountMeta::new(*ai.key, false) } else { AccountMeta::new_readonly(*ai.key, false) });
        infos.push(ai.clone());
    }
    metas.push(AccountMeta::new_readonly(ak, true));
    infos.push(authority.clone());
    let mut data = vec![percolator_vault::processor::TAG_ROLL_EPOCH];
    data.extend_from_slice(&frontier.to_le_bytes());
    invoke_signed(&Instruction { program_id: percolator_vault::id(), accounts: metas, data }, &infos, &[&[SEED_AUTHORITY, &[abump]]])?;

    b.remove(r.id)?;
    store(book_ai, &b)?;
    close(request_ai, BOND_LAMPORTS, executor, wallet)
}

/// Removes a request nobody filled within `GRACE_SECS` of its target. Its bond is forfeited
/// (kept in the book account, which nothing can withdraw); its rent goes back to the trader.
///
/// A request queued by a standing order frees that order to be carried out again; its rent stays
/// in the book with the bond (the trader did not pay it).
///
/// Accounts: 0 caller [s], 1 request [w], 2 trader [w], 3 trader wallet [w], 4 book [w],
/// 5 the standing order [w] (only for a request one queued), or for a settlement, optionally,
/// its vault (to remove it early once its epoch has rolled).
#[inline(never)]
fn expire(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let caller = acc(accounts, 0)?;
    let request_ai = acc(accounts, 1)?;
    let trader_ai = acc(accounts, 2)?;
    let wallet = acc(accounts, 3)?;
    let book_ai = acc(accounts, 4)?;
    signer(caller)?;
    for w in [request_ai, wallet, book_ai] {
        writable(w)?;
    }
    let r: Request = load(request_ai, program_id, REQUEST_MAGIC)?;
    key_is(wallet, &r.wallet)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    if b.vault != r.vault {
        return Err(RouterError::BadAccount.into());
    }
    let now = Clock::get()?.unix_timestamp;
    // Past its grace period; or its price has been the mark for `STALL_SECS` and nobody filled it.
    let at_mark = b.mark_prev_publish_time < r.target_time && r.target_time <= b.mark_publish_time;
    let stalled = at_mark && b.mark_set_time != 0 && now > (b.mark_set_time as i64).saturating_add(STALL_SECS);
    // Or a settlement with nothing left to settle: the epoch it was queued for has rolled (another
    // settlement, or the keeper's flat roll, got there first). The mark cannot move past a request
    // in the queue, so it would otherwise hold every trade behind it up for the stall time.
    let dead = r.kind == KIND_SETTLE
        && match accounts.get(5) {
            Some(vault_ai) if *vault_ai.key == r.vault => {
                let v = vstate::load_vault(vault_ai, &percolator_vault::id())?;
                let over = Clock::get()?.slot >= v.epoch_start_slot.saturating_add(v.epoch_len_slots);
                !over || (v.pending_deposit_assets == 0 && v.pending_withdraw_shares == 0)
            }
            _ => false,
        };
    if now <= r.target_time.saturating_add(GRACE_SECS) && !stalled && !dead {
        return Err(RouterError::TooEarly.into());
    }
    // A settlement request belongs to no trader (account 2 is then ignored).
    if r.kind != KIND_SETTLE {
        let mut t = load_trader(program_id, trader_ai, &r.wallet)?;
        if t.pending_vault != r.vault || t.pending_id != r.id {
            return Err(RouterError::BadAccount.into());
        }
        t.has_pending = 0;
        store(trader_ai, &t)?;
    }
    b.remove(r.id)?;
    b.forfeited_bonds = b.forfeited_bonds.saturating_add(BOND_LAMPORTS);
    store(book_ai, &b)?;
    if r.kind == KIND_ORDER {
        let order_ai = acc(accounts, 5)?;
        writable(order_ai)?;
        key_is(order_ai, &order_address(program_id, &r.vault, &r.wallet, r.order_index).0)?;
        let mut o: Order = load(order_ai, program_id, ORDER_MAGIC)?;
        o.queued_id = 0;
        store(order_ai, &o)?;
        return close(request_ai, BOND_LAMPORTS, book_ai, book_ai);
    }
    if r.kind == KIND_COPY {
        return close(request_ai, BOND_LAMPORTS, book_ai, book_ai);
    }
    // Its price was the mark and it still was not filled: the deposit that came with it stays
    // here with the bond (see `EXPIRY_DEPOSIT_BPS`); only the account's rent goes back. A request
    // whose price never arrived (no oracle price, no executor) lost nothing but its bond.
    if r.kind == KIND_TRADE && at_mark {
        let rent = Rent::get()?.minimum_balance(REQUEST_LEN);
        let kept = request_ai.lamports().saturating_sub(rent).max(BOND_LAMPORTS);
        let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
        b.forfeited_bonds = b.forfeited_bonds.saturating_add(kept - BOND_LAMPORTS);
        store(book_ai, &b)?;
        return close(request_ai, kept, book_ai, wallet);
    }
    close(request_ai, BOND_LAMPORTS, book_ai, wallet)
}
