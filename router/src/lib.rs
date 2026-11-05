//! Percolator Vaults router: the only way to trade against a vault, and the reason nobody can
//! front-run one.
//!
//! A trade is a request first. The request lands on chain and gets a target time: the later of
//! the chain clock and the vault's current mark time, plus `DELAY_SECS`, rounded up to the next
//! `BATCH_SECS` mark (so trades sent close together share one price). It then fills at exactly
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

pub mod carry;
#[cfg(not(target_os = "solana"))]
pub mod client;
pub mod funding;
pub mod lazy;
pub mod risk;
pub mod social;
pub mod state;
pub mod swap;

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
/// Targets fall on a shared grid: a request's target is rounded up to the next multiple of this
/// many seconds. Every request in the same window, on every market, then fills at one price, so
/// one price move (and one re-valuation of the accounts on the market) serves all of them. The
/// wait only grows: the price is still unknown to everyone when the request lands.
pub const BATCH_SECS: i64 = 2;

/// Slot time (X1 builds, since 2026-11-05, see docs/SPEED-FORK.md). A request's target and the
/// mark's price are counted in slots: the target is a slot, and the price it fills at is the
/// first one posted in a slot at or after it (the router stamps each post with the slot it lands
/// in, so no key chooses it). The chain clock runs a second or more behind real time and has
/// one-second steps, so a delay counted on it has to be padded for both; a slot is exact and
/// about 0.35 s long on X1. Solana builds (verified Pyth prices, stamped in seconds) keep
/// counting in seconds.
pub const SLOT_TIME: bool = cfg!(feature = "x1");
/// The delay in slots at risk dial 1; it doubles with each step of the dial (`request_delay`).
/// Our price reaches the chain within about a slot of the exchanges, so three slots after a
/// request lands the price it fills at is still unknown to anyone.
pub const DELAY_SLOTS: i64 = 3;
/// Slot-time batch grid: targets are rounded up to a multiple of this many slots. Small: with
/// lazy settlement (`lazy`) a price move no longer means re-valuing every holder, so moving the
/// mark more often costs little.
pub const BATCH_SLOTS: i64 = 2;
/// Slot-time `GRACE_SECS` (about 90 s of X1 slots).
pub const GRACE_SLOTS: i64 = 250;
/// In slot time, a router time above this was written in unix seconds by a build before slot
/// time (X1 slots passed 200 million in November 2026 and add about 90 million a year).
pub const LEGACY_TIME: i64 = 1_000_000_000;

/// Now, in router time (slots or seconds, see `SLOT_TIME`).
pub fn router_now(clock: &Clock) -> i64 {
    if SLOT_TIME { clock.slot as i64 } else { clock.unix_timestamp }
}
/// The batch grid and the grace period in router time.
pub fn batch_step() -> i64 {
    if SLOT_TIME { BATCH_SLOTS } else { BATCH_SECS }
}
pub fn grace() -> i64 {
    if SLOT_TIME { GRACE_SLOTS } else { GRACE_SECS }
}
/// The (time, previous time) of the price the mark holds, in router time. In slot time a mark
/// set by a build before it (unix seconds) counts as long ago.
pub fn mark_times(b: &Book) -> (i64, i64) {
    if SLOT_TIME && b.mark_publish_time > LEGACY_TIME { (0, 0) } else { (b.mark_publish_time, b.mark_prev_publish_time) }
}
/// True when the mark holds the price a request with target `target` fills at.
pub fn mark_at_target(b: &Book, target: i64) -> bool {
    let (publish, prev) = mark_times(b);
    prev < target && target <= publish
}
/// The delay of a request in router time. Slot time: `DELAY_SLOTS` doubled for each step of the
/// risk dial above 1 (prices moving fast or sources disagreeing, a stock market closed), so the
/// wait is short in a calm market and longer exactly when knowing the price early is worth more.
pub fn request_delay(dial: u8) -> i64 {
    if SLOT_TIME { DELAY_SLOTS << (dial.clamp(1, 4) - 1) } else { DELAY_SECS }
}

/// The target time of a request landing at `now` while the mark is at `mark_publish`: at least
/// `delay` after both, rounded up to the batch grid (all in router time).
pub fn target_time(now: i64, mark_publish: i64, delay: i64) -> Option<i64> {
    let step = batch_step();
    let earliest = now.max(mark_publish).checked_add(delay)?;
    let over = earliest.rem_euclid(step);
    if over == 0 { Some(earliest) } else { earliest.checked_add(step - over) }
}
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
/// None since the per-asset tiers (2026-10-17): a position opens at its tier's margin, as on
/// other perp exchanges, and a fill the account can no longer afford after the price moved
/// during the delay trades nothing.
pub const STRESS_BPS: u128 = 0;

// ---- leverage tiers (per asset) ----
// The tier of each feed is the vault program's (`percolator_vault::feeds`), compiled in.
/// Default tier: up to 10x (10% margin to open), liquidated below 6%.
pub use percolator_vault::feeds::TIER_DEFAULT;
/// Majors (BTC, ETH): up to 20x (5% to open), liquidated below 3.5%.
pub use percolator_vault::feeds::TIER_MAJOR;
/// Stocks and the ETF (X1): up to 5x (20% to open), liquidated below 12%. Their price stands
/// still while their exchanges are closed and can jump at the open, past a thinner margin.
pub use percolator_vault::feeds::TIER_STOCK;
pub use percolator_vault::feeds::{tier_of_feed, MAJOR_FEEDS, STOCK_FEEDS};
/// The router liquidates at least this far (bps) above Percolator's own maintenance margin, and
/// a position opens at least this far above the router's liquidation level.
pub const LIQ_ABOVE_ENGINE_BPS: u64 = 100;
pub const OPEN_ABOVE_LIQ_BPS: u64 = 150;
/// (bps to open, bps below which it is liquidated) of a tier.
pub fn tier_levels(tier: u8) -> (u64, u64) {
    match tier {
        TIER_MAJOR => (500, 350),
        TIER_STOCK => (2_000, 1_200),
        _ => (1_000, 600),
    }
}
/// The levels (open, liquidate) that apply to `asset` on this market. Never below what
/// Percolator itself requires: the router liquidates `LIQ_ABOVE_ENGINE_BPS` above Percolator's
/// maintenance margin and opens `OPEN_ABOVE_LIQ_BPS` above that, whatever the tier says (on a
/// market created with 10% margins that is 12.5% to open and 11% to liquidate).
/// Without the asset's tier in the record the levels are the safe ones for each use: the
/// strictest tier (stocks) to open, so never more leverage than is sure, and, when the record
/// itself is left out, the major tier to liquidate (never an early liquidation). So leaving the
/// record out can neither buy leverage nor liquidate anyone sooner. The executor records every
/// market's tier (`SetTier`) as soon as it is listed.
pub fn levels(market: &[u8], tiers: Option<&state::Tiers>, asset: u16) -> Result<(u64, u64, u64), ProgramError> {
    let (im, _, _) = perc::margin_params(market)?;
    let mm = perc::maintenance_margin_bps(market)?;
    let (generation, _, _) = perc::asset_price(market, asset)?;
    let known = tiers.and_then(|t| {
        let i = asset as usize;
        (i < state::TIER_SLOTS && t.generation[i] == generation).then(|| t.tier[i])
    });
    let open_tier = known.unwrap_or(TIER_STOCK);
    let liq_tier = known.unwrap_or(if tiers.is_some() { TIER_DEFAULT } else { TIER_MAJOR });
    let liq_of = |tier: u8| core::cmp::max(tier_levels(tier).1, mm + LIQ_ABOVE_ENGINE_BPS);
    let open_liq = liq_of(open_tier);
    let open = core::cmp::max(core::cmp::max(tier_levels(open_tier).0, im), open_liq + OPEN_ABOVE_LIQ_BPS);
    Ok((open, liq_of(liq_tier), mm))
}
/// The market's tier record among the instruction's accounts, if it was given (found by owner,
/// size, magic and market: only `SetTier` creates such an account).
pub fn tiers_in(program_id: &Pubkey, accounts: &[AccountInfo], market: &Pubkey) -> Option<state::Tiers> {
    accounts.iter().find_map(|a| {
        if a.owner != program_id || a.data_len() != TIERS_LEN {
            return None;
        }
        let t: state::Tiers = bytemuck::pod_read_unaligned(&a.try_borrow_data().ok()?[..TIERS_LEN]);
        (t.magic == TIERS_MAGIC && t.market == *market).then_some(t)
    })
}
/// (Before the per-asset tiers: the one liquidation level of every position. Kept for the page's
/// older builds; the router itself now uses `levels`.)
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
/// ...except when the market was this many slots behind when the request expired (about a
/// minute): then nobody could fill it without first paying to bring the market current, which is
/// the service's failure (an executor down or catching up), not the trader's, and the deposit goes
/// back. A trader can then still let a request lapse after seeing its price, but only by paying
/// for that catch-up to fill the ones that suit them.
pub const BEHIND_REFUND_SLOTS: u64 = 150;
/// The chain's coin per atom of collateral (a 6-decimal dollar token), in lamports, for that
/// deposit. A fixed rate, set for SOL near $110 and XNT near $0.20: the deposit is a deterrent,
/// not a price, so being off by the coin's moves does not matter.
/// What a wallet pays the platform, in the chain's coin, to start copying a trader and to put a
/// picture of its own on its badge: 10 XNT on X1, 0.02 SOL elsewhere (test wallets hold little).
#[cfg(not(feature = "x1"))]
pub const SOCIAL_FEE_LAMPORTS: u64 = 20_000_000;
#[cfg(feature = "x1")]
pub const SOCIAL_FEE_LAMPORTS: u64 = 10_000_000_000;
pub const COPY_FEE_LAMPORTS: u64 = SOCIAL_FEE_LAMPORTS;
/// Paid to the copied trader (the leader) when a wallet starts copying them, on top of `COPY_FEE_LAMPORTS`.
pub const COPY_LEADER_FEE_LAMPORTS: u64 = SOCIAL_FEE_LAMPORTS;
pub const BADGE_IMAGE_FEE_LAMPORTS: u64 = SOCIAL_FEE_LAMPORTS;
/// A tenth of that (1 XNT on X1, 0.002 SOL elsewhere): what taking a name costs, what changing
/// it costs, and what one day in the leaderboard's featured row costs.
pub const NAME_FEE_LAMPORTS: u64 = SOCIAL_FEE_LAMPORTS / 10;
pub const FEATURE_FEE_LAMPORTS: u64 = SOCIAL_FEE_LAMPORTS / 10;
/// How long one `Feature` payment shows a wallet in the featured row, and how far ahead a
/// wallet can pay.
pub const FEATURE_SECS: i64 = 86_400;
pub const FEATURE_MAX_AHEAD_SECS: i64 = 30 * 86_400;

#[cfg(not(feature = "x1"))]
pub const LAMPORTS_PER_ATOM: u64 = 9;
#[cfg(feature = "x1")]
pub const LAMPORTS_PER_ATOM: u64 = 5_000;

/// The most a request's deposit can be: about a dollar of the chain's coin at the rate above
/// (0.01 SOL, 5 XNT). With 20x leverage an uncapped 0.1% of notional is 2% of the margin, paid
/// in the coin: a $1,000 account opening $20,000 would need 100 XNT on X1 (2026-10-17, the crash
/// drill's bots could not open at the limit). The deposit only has to make lapsing cost
/// something, and a lapse on a market that was behind refunds it anyway (`BEHIND_REFUND_SLOTS`).
#[cfg(not(feature = "x1"))]
pub const EXPIRY_DEPOSIT_CAP: u64 = 10_000_000;
#[cfg(feature = "x1")]
pub const EXPIRY_DEPOSIT_CAP: u64 = 5_000_000_000;

/// The deposit (lamports) that goes with a request of `size` at `price` (see `EXPIRY_DEPOSIT_BPS`),
/// at most `EXPIRY_DEPOSIT_CAP`.
pub fn expiry_deposit(size: i128, price: u64) -> u64 {
    let notional = size.unsigned_abs().saturating_mul(price as u128) / POS_SCALE;
    let lamports = notional.saturating_mul(EXPIRY_DEPOSIT_BPS) / 10_000 * LAMPORTS_PER_ATOM as u128;
    core::cmp::min(u64::try_from(lamports).unwrap_or(u64::MAX), EXPIRY_DEPOSIT_CAP)
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
pub const TAG_SET_BADGE_IMAGE: u8 = 25;
pub const TAG_WRITE_BADGE_IMAGE: u8 = 26;
pub const TAG_REMOVE_BADGE_IMAGE: u8 = 27;
pub const TAG_FEATURE: u8 = 28;
pub const TAG_SET_TIER: u8 = 29;
pub const TAG_SWAP: u8 = 30;
pub const TAG_REFRESH_FUNDING: u8 = 31;
pub const TAG_OPEN_CARRY: u8 = 32;
pub const TAG_OPEN_LEDGER: u8 = 33;
pub const TAG_PAY_FEES: u8 = 34;
pub const TAG_REFRESH_RECORD: u8 = 35;
pub const TAG_OPEN_RANGE: u8 = 36;
pub const TAG_GROW_BOOK: u8 = 37;
pub const TAG_TAKE_QUOTE: u8 = 38;
/// Widest trail, in basis points.
pub const MAX_TRAIL_BPS: u64 = 5_000;
/// Shortest time between two slices of a TWAP order, and the most slices one can have.
pub const MIN_TWAP_INTERVAL_SECS: i64 = 10;
pub const MAX_TWAP_SLICES: u32 = 500;

// ---- executor rewards ----
// Every reward is paid by whoever needs the work done, never out of the platform's fees, and only
// by an instruction that succeeds: a failed or duplicate attempt earns nothing.
//
// - Fill: the request's bond (`BOND_LAMPORTS`), put up with the request.
// - Trigger a standing order: `KEEPER_FEE`, plus the request's bond and rent paid back, out of
//   the order's keeper budget (lamports above its rent, attached when it was placed). Removing an
//   order that can do nothing more earns `KEEPER_FEE` out of the same budget; the rest goes back.
// - Liquidate: `LIQ_REWARD`, plus the request's bond and rent paid back, out of the liquidated
//   account's keeper deposit (lamports above its trader account's rent, topped up by `Request`).
// - Expire a request nobody filled: `EXPIRE_SHARE_DIV`-th of its bond (the rest is forfeited as
//   before). Always less than filling it would have paid, so letting a request lapse never pays.

/// Paid to whoever carries out or removes a standing order, from the order's keeper budget.
#[cfg(not(feature = "x1"))]
pub const KEEPER_FEE: u64 = 100_000;
/// (On X1 a trigger asks for about 100,000 compute units: 0.001 XNT.)
#[cfg(feature = "x1")]
pub const KEEPER_FEE: u64 = 2_000_000;
/// Paid to whoever liquidates an account, from that account's keeper deposit: a fixed amount,
/// whatever the position's size, so no position is worth more to liquidate than another.
pub const LIQ_REWARD: u64 = BOND_LAMPORTS / 2;
/// The part of a request's bond paid to whoever expires it.
pub const EXPIRE_SHARE_DIV: u64 = 4;
/// The most lamports an order can hold for its keepers (every slice of the longest TWAP).
/// (Plus room for a keeper deposit, which an order that can open a position carries: see
/// `TriggerOrder`.)
pub const MAX_KEEPER_BUDGET: u64 = (MAX_TWAP_SLICES as u64 + 1) * (BOND_LAMPORTS + KEEPER_FEE) + 2 * BOND_LAMPORTS + 10_000_000;

/// What a request costs whoever queues it: its rent and its bond.
fn request_cost() -> Result<u64, ProgramError> {
    Ok(Rent::get()?.minimum_balance(REQUEST_LEN).saturating_add(BOND_LAMPORTS))
}
/// What a trading account keeps for whoever liquidates it: a liquidation's request and reward.
pub fn keeper_deposit(request_rent: u64) -> u64 {
    request_rent.saturating_add(BOND_LAMPORTS).saturating_add(LIQ_REWARD)
}
/// What the trading account's keeper deposit lacks (0 when it is whole).
fn deposit_short(trader_ai: &AccountInfo) -> Result<u64, ProgramError> {
    Ok(keeper_deposit(Rent::get()?.minimum_balance(REQUEST_LEN)).saturating_sub(spare(trader_ai, TRADER_LEN)?))
}
/// Tops the trading account's keeper deposit up from the wallet (a signer).
pub(crate) fn top_up_deposit<'a>(wallet: &AccountInfo<'a>, trader_ai: &AccountInfo<'a>, system: &AccountInfo<'a>) -> ProgramResult {
    let short = deposit_short(trader_ai)?;
    if short > 0 {
        invoke(&solana_program::system_instruction::transfer(wallet.key, trader_ai.key, short), &[wallet.clone(), trader_ai.clone(), system.clone()])?;
    }
    Ok(())
}
/// Lamports `ai` holds above its rent.
fn spare(ai: &AccountInfo, len: usize) -> Result<u64, ProgramError> {
    Ok(ai.lamports().saturating_sub(Rent::get()?.minimum_balance(len)))
}
/// Moves lamports out of an account this program owns.
fn pay(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    if amount == 0 || from.key == to.key {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? = from.lamports().checked_sub(amount).ok_or(RouterError::Overflow)?;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(amount).ok_or(RouterError::Overflow)?;
    Ok(())
}
/// Marks a request as paid for by its owner (an order's budget or a keeper deposit): its rent then
/// goes back there, not to whoever queued it.
fn mark_funded(program_id: &Pubkey, request_ai: &AccountInfo) -> ProgramResult {
    let mut r: Request = load(request_ai, program_id, REQUEST_MAGIC)?;
    r.funded = 1;
    store(request_ai, &r)
}

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
    /// `Feature` by a wallet that has already paid for the longest time allowed ahead.
    FeaturedEnough,
    /// A badge picture that is not a JPEG of at most `BADGE_MAX_BYTES`, or bytes written out of
    /// order or past its end.
    BadImage,
    /// `Swap` delivered less than its `min_out` to the output account.
    Slippage,
    /// X1: a reported price the witness has not confirmed (no recent witness price for the feed,
    /// or one too far from it).
    WitnessDisagrees,
    /// `Withdraw` while the account owes the vaults fees: `PayFees` first (see `carry`).
    FeesOwed,
    /// A close-only request (`Request` with the flag) when there is no position it would shrink.
    NotReducing,
    /// A trade that would add a second asset to an isolated account (one asset at a time), or a
    /// copy or track record asked of an isolated account (they belong to the main account).
    Isolated,
    /// `TakeQuote` without a maker's valid signature over exactly this quote, just before it.
    BadQuote,
    /// `TakeQuote` after the quote's last slot, or for a quote good for too long.
    QuoteExpired,
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
        TAG_OPEN_ACCOUNT => open_account(program_id, accounts, rest),
        TAG_DEPOSIT => deposit(program_id, accounts, u64_at(0)?),
        TAG_WITHDRAW => withdraw(program_id, accounts, u64_at(0)?),
        TAG_OPEN_BOOK => open_book(program_id, accounts),
        TAG_REQUEST => {
            let b = rest.get(..16).ok_or(RouterError::InvalidInstruction)?;
            let reduce_only = match rest.get(16..) {
                None | Some([]) => false,
                Some([f]) if *f <= 1 => *f == 1,
                _ => return Err(RouterError::InvalidInstruction.into()),
            };
            request(program_id, accounts, i128::from_le_bytes(b.try_into().unwrap()), reduce_only)
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
        TAG_SET_BADGE_IMAGE => social::set_badge_image(program_id, accounts, rest),
        TAG_WRITE_BADGE_IMAGE => social::write_badge_image(program_id, accounts, rest),
        TAG_REMOVE_BADGE_IMAGE => social::remove_badge_image(program_id, accounts),
        TAG_FEATURE => social::feature(program_id, accounts),
        TAG_SET_TIER => set_tier(program_id, accounts),
        TAG_SWAP => swap::swap(accounts, rest),
        TAG_REFRESH_FUNDING => funding::refresh_funding(program_id, accounts),
        TAG_OPEN_CARRY => carry::open_carry(program_id, accounts),
        TAG_OPEN_RANGE => lazy::open_range(program_id, accounts),
        TAG_GROW_BOOK => grow_book(program_id, accounts),
        TAG_TAKE_QUOTE => quote::take_quote(program_id, accounts, rest),
        #[cfg(not(feature = "devnet"))]
        quote::TEST_SIGNATURE_STANDIN => Ok(()),
        TAG_OPEN_LEDGER => carry::open_ledger(program_id, accounts),
        TAG_PAY_FEES => carry::pay_fees(program_id, accounts),
        TAG_REFRESH_RECORD => social::refresh_record(program_id, accounts),
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
    let _: Book = load_book(book_ai, program_id)?;
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
        &$t.signer().seeds()[..]
    };
}

// (After `trader_seeds`, which it uses.)
pub mod quote;

// ---- accounts ----

/// Creates the trader's router account, its Percolator portfolio and its collateral account,
/// all owned by the trader's program address.
///
/// With a number `sub` (1..=255) it creates one of the wallet's isolated accounts on the market
/// instead: a second, separate trading account with its own margin, which holds a position on one
/// asset at a time. A loss there can only take the money in it, and a loss in the main account
/// cannot reach it. Its addresses: `isolated_address`, `isolated_portfolio_address`,
/// `isolated_collateral_address`.
///
/// The wallet's accounts on the market count as one in its track record (see `Equities`): an
/// isolated account creates the wallet's record of values the first time, and marks the main
/// account as having one.
///
/// Accounts: 0 wallet [s, w], 1 trader [w], 2 portfolio [w], 3 collateral [w], 4 market [w],
/// 5 collateral mint, 6 Percolator program, 7 system program, 8 token program, then
/// 9 the wallet's record of values [w] (optional for a main account), and for an isolated one
/// 10 the wallet's main trader account [w] and 11 its main portfolio (whether or not they exist).
/// Data: optionally `sub` (u8, 1..=255).
#[inline(never)]
fn open_account(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
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
    let sub = match data {
        [] => 0,
        [n] if *n != 0 => *n,
        _ => return Err(RouterError::InvalidInstruction.into()),
    };
    let (tk, bump) = if sub == 0 { trader_address(program_id, market.key, wallet.key) } else { isolated_address(program_id, market.key, wallet.key, sub) };
    let ((pk, pbump), (ck, cbump)) = if sub == 0 {
        (portfolio_address(program_id, market.key, wallet.key), collateral_address(program_id, market.key, wallet.key))
    } else {
        (isolated_portfolio_address(program_id, &tk), isolated_collateral_address(program_id, &tk))
    };
    key_is(trader_ai, &tk)?;
    key_is(portfolio, &pk)?;
    key_is(collateral, &ck)?;

    // The wallet's record of values: an isolated account needs it (created now if it is the
    // first); a main account opened after it is marked as having one.
    let mut has_equities = 0u8;
    let (ek, ebump) = equities_address(program_id, market.key, wallet.key);
    if sub != 0 {
        let eq_ai = acc(accounts, 9)?;
        let main_ai = acc(accounts, 10)?;
        let main_pf = acc(accounts, 11)?;
        key_is(eq_ai, &ek)?;
        key_is(main_ai, &trader_address(program_id, market.key, wallet.key).0)?;
        key_is(main_pf, &portfolio_address(program_id, market.key, wallet.key).0)?;
        writable(eq_ai)?;
        if eq_ai.owner != program_id {
            create_pda(wallet, eq_ai, system, program_id, EQUITIES_LEN, 0, &[SEED_EQUITIES, market.key.as_ref(), wallet.key.as_ref(), &[ebump]])?;
            // (Written in place: the record does not fit on the stack.)
            {
                let mut d = eq_ai.try_borrow_mut_data()?;
                d[..8].copy_from_slice(&EQUITIES_MAGIC.to_le_bytes());
                d[8..40].copy_from_slice(wallet.key.as_ref());
                d[40..72].copy_from_slice(market.key.as_ref());
                d[72] = ebump;
            }
            if *main_pf.owner == PERCOLATOR_PROGRAM_ID {
                let (capital, pnl, _) = perc::portfolio_exposure(&main_pf.try_borrow_data()?)?;
                social::set_equity(program_id, eq_ai, 0, Some((capital as i128).saturating_add(pnl)), 0)?;
            }
        }
        if main_ai.owner == program_id {
            writable(main_ai)?;
            let mut m = load_trader(program_id, main_ai, wallet.key)?;
            if m.has_equities == 0 {
                m.has_equities = 1;
                store(main_ai, &m)?;
            }
        }
    } else if let Some(eq_ai) = accounts.get(9) {
        key_is(eq_ai, &ek)?;
        if eq_ai.owner == program_id {
            has_equities = 1;
        }
    }
    let t = TraderState {
        magic: TRADER_MAGIC,
        market: *market.key,
        wallet: *wallet.key,
        portfolio: pk,
        collateral: ck,
        bump,
        has_pending: 0,
        has_stats: 0,
        has_ledger: 0,
        sub,
        has_equities,
        _pad: [0; 2],
        pending_vault: Pubkey::default(),
        pending_id: 0,
    };
    create_pda(wallet, trader_ai, system, program_id, TRADER_LEN, 0, trader_seeds!(t))?;
    if sub == 0 {
        create_pda(wallet, portfolio, system, &PERCOLATOR_PROGRAM_ID, perc::PORTFOLIO_ACCOUNT_LEN, 0, &[SEED_PORTFOLIO, market.key.as_ref(), wallet.key.as_ref(), &[pbump]])?;
        create_pda(wallet, collateral, system, &spl_token::ID, spl_token::state::Account::LEN, 0, &[SEED_COLLATERAL, market.key.as_ref(), wallet.key.as_ref(), &[cbump]])?;
    } else {
        create_pda(wallet, portfolio, system, &PERCOLATOR_PROGRAM_ID, perc::PORTFOLIO_ACCOUNT_LEN, 0, &[SEED_PORTFOLIO, tk.as_ref(), &[pbump]])?;
        create_pda(wallet, collateral, system, &spl_token::ID, spl_token::state::Account::LEN, 0, &[SEED_COLLATERAL, tk.as_ref(), &[cbump]])?;
    }
    invoke(
        &spl_token::instruction::initialize_account3(&spl_token::ID, collateral.key, mint.key, trader_ai.key)?,
        &[collateral.clone(), mint.clone(), token.clone()],
    )?;
    store(trader_ai, &t)?;
    invoke_signed(
        &perc::init_portfolio(trader_ai.key, market.key, portfolio.key),
        &[trader_ai.clone(), market.clone(), portfolio.clone(), percolator.clone()],
        &[trader_seeds!(t)],
    )
}

/// Whether an isolated account (see `open_account`) holds a position on an asset other than
/// `asset`: it may then only reduce, not trade `asset` (one asset at a time).
fn holds_other_asset(t: &TraderState, market: &[u8], portfolio: &[u8], asset: u16) -> Result<bool, ProgramError> {
    Ok(t.sub != 0 && perc::positions(market, portfolio)?.iter().any(|p| p.asset != asset && p.size != 0))
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
    social::book_flow_of(program_id, &t, accounts, acc(accounts, 9), amount, 0)
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
    // Fees owed to the vaults are paid first (`PayFees`), out of the same money.
    if t.has_ledger != 0 {
        let l = carry::ledger_in(program_id, accounts, trader_ai.key).ok_or(RouterError::BadAccount)?;
        if carry::total_owed(l) > 0 {
            return Err(RouterError::FeesOwed.into());
        }
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
    // With no position left the keeper deposit has nothing to pay for: it goes back to the
    // wallet (when the wallet and the trader account are passed writable; the next trade tops
    // it up again).
    // A copy, while it runs, can open a position for the account at any time without the wallet:
    // the deposit stays then. So the refund needs the account's copy address passed, and empty.
    let copy_key = state::copy_address(program_id, &t.market, wallet.key).0;
    // (An isolated account is never copied into.)
    let no_copy = t.sub != 0 || accounts.iter().any(|a| *a.key == copy_key && a.owner != program_id);
    if no_copy && wallet.is_writable && trader_ai.is_writable && perc::positions(&market.try_borrow_data()?, &portfolio.try_borrow_data()?)?.iter().all(|p| p.size == 0) {
        pay(trader_ai, wallet, spare(trader_ai, TRADER_LEN)?)?;
    }
    social::book_flow_of(program_id, &t, accounts, acc(accounts, 10), 0, received)
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
    create_pda(payer, book_ai, system, program_id, BOOK_ACCOUNT_LEN, 0, &[SEED_BOOK, vault_ai.key.as_ref(), &[bump]])?;
    let mut b = Book::zeroed();
    b.magic = BOOK_MAGIC;
    b.vault = *vault_ai.key;
    b.market = v.market;
    b.bump = bump;
    store_book(book_ai, &b)
}

/// `GrowBook` (anyone; the payer pays the extra rent): grows a book made when books held
/// `OLD_MAX_PENDING` requests to `MAX_PENDING`, keeping every queued request. Until then the book
/// cannot be used (every instruction checks its size). Does nothing to a book already grown.
///
/// Accounts: 0 payer [s, w], 1 book [w], 2 system program.
#[inline(never)]
fn grow_book(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (payer, book_ai, system) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?);
    signer(payer)?;
    writable(book_ai)?;
    key_is(system, &system_program::ID)?;
    if book_ai.owner != program_id {
        return Err(RouterError::BadAccount.into());
    }
    if book_ai.data_len() == BOOK_ACCOUNT_LEN {
        return Ok(());
    }
    if book_ai.data_len() != OLD_BOOK_LEN || book_ai.try_borrow_data()?[..8] != BOOK_MAGIC.to_le_bytes() {
        return Err(RouterError::BadAccount.into());
    }
    let old = book_ai.try_borrow_data()?.to_vec();
    let need = Rent::get()?.minimum_balance(BOOK_ACCOUNT_LEN).saturating_sub(book_ai.lamports());
    if need > 0 {
        invoke(&system_instruction::transfer(payer.key, book_ai.key, need), &[payer.clone(), book_ai.clone(), system.clone()])?;
    }
    book_ai.realloc(BOOK_ACCOUNT_LEN, true)?;
    let mut d = book_ai.try_borrow_mut_data()?;
    let (h, n) = (BOOK_HEADER_LEN, OLD_MAX_PENDING);
    d[..h].copy_from_slice(&old[..h]);
    // The ids, then the targets, each list now MAX_PENDING long (addresses unknown: zeros).
    d[BOOK_IDS_OFF..BOOK_IDS_OFF + 8 * n].copy_from_slice(&old[h..h + 8 * n]);
    d[BOOK_IDS_OFF + 8 * n..BOOK_TARGETS_OFF].fill(0);
    d[BOOK_TARGETS_OFF..BOOK_TARGETS_OFF + 8 * n].copy_from_slice(&old[h + 8 * n..h + 16 * n]);
    Ok(())
}

/// Margin check: after the trade, equity must cover every position's opening margin (its tier's,
/// see `levels`) plus fees, with prices `STRESS_BPS` higher and a `STRESS_BPS` loss on all of them.
fn margin_covers(market: &[u8], portfolio: &[u8], v: &vstate::VaultState, size: i128, tiers: Option<&state::Tiers>) -> Result<bool, ProgramError> {
    margin_covers_at(market, portfolio, v, size, STRESS_BPS, tiers)
}

/// The same check with a price move of `stress_bps` (0: at the current price, which is what the
/// fill asks for).
fn margin_covers_at(market: &[u8], portfolio: &[u8], v: &vstate::VaultState, size: i128, stress_bps: u128, tiers: Option<&state::Tiers>) -> Result<bool, ProgramError> {
    margin_covers_owing(market, portfolio, v, size, stress_bps, tiers, 0, 1)
}

/// The same check for an account that owes the vaults `debt` (see `carry`): it counts against
/// the account's equity.
#[allow(clippy::too_many_arguments)]
/// `dial` (see `risk`) multiplies the margin to open the traded asset's position.
#[allow(clippy::too_many_arguments)]
fn margin_covers_owing(market: &[u8], portfolio: &[u8], v: &vstate::VaultState, size: i128, stress_bps: u128, tiers: Option<&state::Tiers>, debt: u64, dial: u8) -> Result<bool, ProgramError> {
    let asset = v.asset_index;
    let (_, min_im, fee_bps) = perc::margin_params(market)?;
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
    let mut each = vec![(asset, notional(asset, after.unsigned_abs())?)];
    for (a, q) in legs {
        if a != asset {
            each.push((a, notional(a, q.unsigned_abs())?));
        }
    }
    let mut total = 0u128;
    let mut need = min_im;
    for (a, n) in each {
        let (open, _, _) = levels(market, tiers, a)?;
        let open = if a == asset { open.saturating_mul(dial.max(1) as u64).min(10_000) } else { open };
        let stressed = n * (10_000 + stress_bps) / 10_000;
        need = need + stressed * open as u128 / 10_000 + stressed * fee_bps as u128 / 10_000;
        total += n;
    }
    need += total * stress_bps / 10_000;
    let equity = (capital as i128).checked_add(pnl).ok_or(RouterError::Overflow)? - debt as i128;
    Ok(equity >= 0 && equity as u128 >= need)
}

/// True when the account can be liquidated through the router: every position is settled at the
/// current price (so capital and PnL reflect it) and equity is below the sum of each position's
/// notional times its tier's liquidation level (see `levels`).
fn liquidatable(market: &[u8], portfolio: &[u8], tiers: Option<&state::Tiers>, debt: u64) -> Result<bool, ProgramError> {
    let (capital, pnl, _) = perc::portfolio_exposure(portfolio)?;
    let (mut notional, mut floor) = (0u128, 0u128);
    for p in perc::positions(market, portfolio)? {
        if !p.settled {
            return Ok(false);
        }
        let (_, price, _) = perc::asset_price(market, p.asset)?;
        let n = p.size.unsigned_abs().checked_mul(price as u128).ok_or(RouterError::Overflow)? / POS_SCALE;
        let (_, liq, _) = levels(market, tiers, p.asset)?;
        notional = notional.checked_add(n).ok_or(RouterError::Overflow)?;
        floor = floor.checked_add(n.saturating_mul(liq as u128)).ok_or(RouterError::Overflow)?;
    }
    let equity = (capital as i128).checked_add(pnl).ok_or(RouterError::Overflow)? - debt as i128;
    Ok(notional != 0 && (equity <= 0 || (equity as u128).saturating_mul(10_000) < floor))
}

/// A liquidation closes only as much as it takes: the size (signed, the opposite of the
/// position's sign) that leaves the account's equity covering every position at its liquidation
/// level plus `OPEN_ABOVE_LIQ_BPS` and `LIQ_TARGET_EXTRA_BPS` (its opening margin and a little
/// more, for a recorded tier), so it is not liquidatable again at the next tick. It closes
/// at least `LIQ_MIN_PART_BPS` of the position, and all of it when what would be left is under
/// `LIQ_MIN_KEEP_BPS` of it, when equity is gone, or when the other positions alone need more
/// than the equity. A partial close leaves the trader a smaller position instead of none, and
/// asks the vault for less in one fill.
fn liquidation_size(market: &[u8], portfolio: &[u8], tiers: Option<&state::Tiers>, asset: u16, before: i128, debt: u64) -> Result<i128, ProgramError> {
    let all = before.checked_neg().ok_or(RouterError::Overflow)?;
    let (capital, pnl, _) = perc::portfolio_exposure(portfolio)?;
    let equity = (capital as i128).checked_add(pnl).ok_or(RouterError::Overflow)? - debt as i128;
    if equity <= 0 || before == 0 {
        return Ok(all);
    }
    let (mut others, mut price_here) = (0u128, 0u64);
    for p in perc::positions(market, portfolio)? {
        let (_, price, _) = perc::asset_price(market, p.asset)?;
        if p.asset == asset {
            price_here = price;
            continue;
        }
        let n = p.size.unsigned_abs().saturating_mul(price as u128) / POS_SCALE;
        let (_, liq, _) = levels(market, tiers, p.asset)?;
        others = others.saturating_add(n.saturating_mul(liq as u128 + OPEN_ABOVE_LIQ_BPS as u128 + LIQ_TARGET_EXTRA_BPS));
    }
    let (_, liq_here, _) = levels(market, tiers, asset)?;
    let room = (equity as u128).saturating_mul(10_000);
    if price_here == 0 || room <= others {
        return Ok(all);
    }
    let keep_notional = (room - others) / (liq_here as u128 + OPEN_ABOVE_LIQ_BPS as u128 + LIQ_TARGET_EXTRA_BPS);
    let held = before.unsigned_abs();
    let keep = (keep_notional.saturating_mul(POS_SCALE) / price_here as u128).min(held);
    let close = (held - keep).max(held * LIQ_MIN_PART_BPS / 10_000);
    if close >= held || held - close < held * LIQ_MIN_KEEP_BPS / 10_000 {
        return Ok(all);
    }
    let close = i128::try_from(close).map_err(|_| RouterError::Overflow)?;
    Ok(if before > 0 { -close } else { close })
}
/// See `liquidation_size`.
pub const LIQ_TARGET_EXTRA_BPS: u128 = 50;
pub const LIQ_MIN_PART_BPS: u128 = 2_500;
pub const LIQ_MIN_KEEP_BPS: u128 = 1_000;

/// Records an asset's leverage tier for its market (anyone may send it; the tier comes from the
/// vault's own feed and the compiled `MAJOR_FEEDS`). Creates the market's record the first time.
///
/// Accounts: 0 payer [s, w], 1 tiers record [w], 2 vault, 3 market, 4 system program.
#[inline(never)]
fn set_tier(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let payer = acc(accounts, 0)?;
    let tiers_ai = acc(accounts, 1)?;
    let vault_ai = acc(accounts, 2)?;
    let market = acc(accounts, 3)?;
    let system = acc(accounts, 4)?;
    signer(payer)?;
    writable(tiers_ai)?;
    key_is(system, &system_program::ID)?;
    let v = load_vault(vault_ai)?;
    key_is(market, &v.market)?;
    perc::expect_market(market)?;
    if v.status != vstate::STATUS_ACTIVE {
        return Err(RouterError::BadAccount.into());
    }
    let (tk, bump) = tiers_address(program_id, market.key);
    key_is(tiers_ai, &tk)?;
    if tiers_ai.data_len() == 0 {
        create_pda(payer, tiers_ai, system, program_id, TIERS_LEN, 0, &[SEED_TIERS, market.key.as_ref(), &[bump]])?;
        let mut t = state::Tiers::zeroed();
        t.magic = TIERS_MAGIC;
        t.market = *market.key;
        t.bump = bump;
        store(tiers_ai, &t)?;
    }
    let mut t: state::Tiers = load(tiers_ai, program_id, TIERS_MAGIC)?;
    let i = v.asset_index as usize;
    if i >= state::TIER_SLOTS {
        return Err(RouterError::BadAccount.into());
    }
    let (generation, _, _) = perc::asset_price(&market.try_borrow_data()?, v.asset_index)?;
    t.tier[i] = tier_of_feed(&v.oracle_feeds[0]);
    t.generation[i] = generation;
    msg!("tier {} {} {}", i, t.tier[i], generation);
    store(tiers_ai, &t)
}

/// Queues a trade. It fills at the first Pyth price published at or after its target time, which
/// is set here and cannot be changed or cancelled.
///
/// With `reduce_only` (a close) the trade may only shrink the position held: it must be on the
/// other side of it, is cut to its size here, and again at the fill to what is held then (a stop
/// or take-profit that filled in between leaves it nothing to do).
///
/// Accounts: 0 wallet [s, w], 1 trader [w], 2 vault, 3 book [w], 4 request [w], 5 market,
/// 6 trader portfolio, 7 system program. Data: size (i128, + = buy), then optionally a flag
/// (u8, 1 = close only).
#[inline(never)]
fn request(program_id: &Pubkey, accounts: &[AccountInfo], mut size: i128, reduce_only: bool) -> ProgramResult {
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
    let mut b: Book = load_book(book_ai, program_id)?;
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
    if reduce_only {
        let held = position_on(market, portfolio, v.asset_index)?;
        if held == 0 || (held > 0) == (size > 0) {
            return Err(RouterError::NotReducing.into());
        }
        if size.unsigned_abs() > held.unsigned_abs() {
            size = held.checked_neg().ok_or(RouterError::Overflow)?;
        }
    }
    if perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)? {
        return Err(RouterError::CloseOnly.into());
    }
    if !reduce_only && holds_other_asset(&t, &market.try_borrow_data()?, &portfolio.try_borrow_data()?, v.asset_index)? {
        return Err(RouterError::Isolated.into());
    }
    if !margin_covers(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, &v, size, tiers_in(program_id, accounts, market.key).as_ref())? {
        return Err(RouterError::InsufficientMargin.into());
    }
    // The deposit is counted at the mark (Percolator's price for a book that has none yet).
    let price = if b.mark_price != 0 { b.mark_price } else { perc::asset_price(&market.try_borrow_data()?, v.asset_index)?.1 };
    // The account's keeper deposit: what whoever liquidates it is paid (see `keeper_deposit`),
    // topped up from the wallet when a liquidation has used it. Paid once; it stays the trader's.
    top_up_deposit(wallet, trader_ai, system)?;
    enqueue(program_id, wallet, wallet.key, Some((trader_ai, &mut t)), vault_ai, book_ai, &mut b, request_ai, system, size, None, expiry_deposit(size, price))?;
    if reduce_only {
        let mut r: Request = load(request_ai, program_id, REQUEST_MAGIC)?;
        r.reduce_only = 1;
        store(request_ai, &r)?;
    }
    Ok(())
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
    let delay = if SLOT_TIME {
        let v = load_vault(vault_ai)?;
        request_delay(risk::dial(b.price_dial, tier_of_feed(&v.oracle_feeds[0]), Clock::get()?.unix_timestamp))
    } else {
        DELAY_SECS
    };
    enqueue_after(program_id, payer, owner, trader, vault_ai, book_ai, b, request_ai, system, size, order, deposit, delay)
}

/// `enqueue` with its own delay (router time after the later of now and the mark's time).
#[allow(clippy::too_many_arguments)]
fn enqueue_after<'a>(
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
    delay: i64,
) -> ProgramResult {
    let clock = Clock::get()?;
    let target = target_time(router_now(&clock), mark_times(b).0, delay).ok_or(RouterError::Overflow)?;
    let id = b.next_id;
    let settlement = trader.is_none();
    // An isolated account's requests live at addresses of its own (see `TraderState::owner`).
    let at = trader.as_ref().map_or(*owner, |(ai, t)| t.owner(ai.key));
    let (rk, rbump) = request_address(program_id, vault_ai.key, &at, settlement);
    key_is(request_ai, &rk)?;
    create_pda(payer, request_ai, system, program_id, REQUEST_LEN, BOND_LAMPORTS.saturating_add(deposit), &[SEED_REQUEST, vault_ai.key.as_ref(), at.as_ref(), &[settlement as u8], &[rbump]])?;
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
            funded: 0,
            reduce_only: 0,
            _pad: [0; 3],
        },
    )?;
    b.next_id = id.checked_add(1).ok_or(RouterError::Overflow)?;
    book_push(book_ai, b, id, target, request_ai.key)?;
    store_book(book_ai, &*b)?;
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
/// - The trader is below its liquidation level (see `liquidatable` and `levels`). The fill closes the position
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
    let mut b: Book = load_book(book_ai, program_id)?;
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
    let liquidation = !perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)?;
    let portfolio = acc(accounts, 8)?;
    key_is(portfolio, &t.portfolio)?;
    // A close-out needs a position to close on this market: without one the request would do
    // nothing but hold the trader's queue place (and cost its keeper deposit).
    if !liquidation && position_on(market, portfolio, v.asset_index)? == 0 {
        return Err(RouterError::NotCloseOnly.into());
    }
    if liquidation {
        let debt = carry::ledger_in(program_id, accounts, trader_ai.key).map_or(0, carry::total_owed);
        if !liquidatable(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, tiers_in(program_id, accounts, market.key).as_ref(), debt)? {
            return Err(RouterError::NotCloseOnly.into());
        }
    }
    // No delay: the trader chooses nothing here, so there is no one to trade ahead of; the close
    // takes the next price.
    enqueue_after(program_id, payer, wallet.key, Some((trader_ai, &mut t)), vault_ai, book_ai, &mut b, request_ai, system, 0, None, 0, 1)?;
    // Whoever queued it is paid back the request's rent and bond out of the account's keeper
    // deposit. The liquidation reward itself (`LIQ_REWARD`) is paid only by a fill that does
    // liquidate the account: an account that recovers before the fill pays no reward.
    if payer.key != wallet.key {
        let cost = request_cost()?;
        if spare(trader_ai, TRADER_LEN)? >= cost {
            pay(trader_ai, payer, cost)?;
            mark_funded(program_id, request_ai)?;
        }
    }
    Ok(())
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
/// seconds (i64), TWAP slices (u32), expiry time (i64, 0 = none), then optionally the keeper
/// budget (u64 lamports, at most `MAX_KEEPER_BUDGET`): kept in the order's account and paid to
/// whoever carries it out (see `KEEPER_FEE`); what is left goes back with the order's rent.
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
    if data.len() != 47 && data.len() != 55 {
        return Err(RouterError::InvalidInstruction.into());
    }
    let budget = if data.len() == 55 { u64::from_le_bytes(data[47..55].try_into().unwrap()) } else { 0 };
    if budget > MAX_KEEPER_BUDGET {
        return Err(RouterError::BadOrder.into());
    }
    let (index, kind, reduce_only) = (data[0], data[1], data[2]);
    let size = i128::from_le_bytes(data[3..19].try_into().unwrap());
    let trigger = u64::from_le_bytes(data[19..27].try_into().unwrap());
    let interval = i64::from_le_bytes(data[27..35].try_into().unwrap());
    let slices = u32::from_le_bytes(data[35..39].try_into().unwrap());
    let expiry = i64::from_le_bytes(data[39..47].try_into().unwrap());

    let t = load_trader(program_id, trader_ai, wallet.key)?;
    let v = load_vault(vault_ai)?;
    let b: Book = load_book(book_ai, program_id)?;
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
    let at = t.owner(trader_ai.key);
    let (bk, bump) = order_address(program_id, vault_ai.key, &at, index);
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
    create_pda(wallet, order_ai, system, program_id, ORDER_LEN, budget, &[SEED_ORDER, vault_ai.key.as_ref(), at.as_ref(), &[index], &[bump]])?;
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
    // The order belongs to this trading account (a wallet may have isolated ones too).
    key_is(order_ai, &order_address(program_id, vault_ai.key, &t.owner(trader_ai.key), o.index).0)?;
    let v = load_vault(vault_ai)?;
    let mut b: Book = load_book(book_ai, program_id)?;
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
        return remove_order(order_ai, payer, wallet);
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
            return remove_order(order_ai, payer, wallet);
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
    if !protective && o.reduce_only == 0 && holds_other_asset(&t, &market.try_borrow_data()?, &portfolio.try_borrow_data()?, v.asset_index)? {
        return Err(RouterError::Isolated.into());
    }
    if !margin_covers(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, &v, size, tiers_in(program_id, accounts, market.key).as_ref())? {
        return Err(RouterError::InsufficientMargin.into());
    }
    o.queued_id = b.next_id.checked_add(1).ok_or(RouterError::Overflow)?;
    store(order_ai, &o)?;
    enqueue(program_id, payer, wallet.key, Some((trader_ai, &mut t)), vault_ai, book_ai, &mut b, request_ai, system, size, Some(o.index), 0)?;
    // Out of the order's keeper budget: the request's rent and bond back to whoever queued it,
    // and `KEEPER_FEE` for doing so. (An order placed without a budget pays nothing: the caller
    // gets the rent and bond back only by filling the request too, as before.)
    let cost = request_cost()?;
    // An order that can open a position fills in the account's keeper deposit first, when it
    // lacks one (the wallet may have had it refunded while flat): out of the order's budget,
    // which the page sizes to hold it, and only when the keeper's share is still there after.
    if matches!(o.kind, ORDER_LIMIT | ORDER_TWAP) && o.reduce_only == 0 {
        let short = deposit_short(trader_ai)?;
        if short > 0 && spare(order_ai, ORDER_LEN)? >= short.saturating_add(cost + KEEPER_FEE) {
            pay(order_ai, trader_ai, short)?;
        }
    }
    if spare(order_ai, ORDER_LEN)? >= cost + KEEPER_FEE {
        pay(order_ai, payer, cost + KEEPER_FEE)?;
        mark_funded(program_id, request_ai)?;
        msg!("reward trigger {}", KEEPER_FEE);
    }
    Ok(())
}

/// Removes an order that can do nothing more: `KEEPER_FEE` of its keeper budget to whoever
/// noticed, the rest and its rent to the wallet.
fn remove_order<'a>(order_ai: &AccountInfo<'a>, payer: &AccountInfo<'a>, wallet: &AccountInfo<'a>) -> ProgramResult {
    let fee = KEEPER_FEE.min(spare(order_ai, ORDER_LEN)?);
    if fee > 0 && payer.key != wallet.key {
        pay(order_ai, payer, fee)?;
        msg!("reward cleanup {}", fee);
    }
    close(order_ai, 0, wallet, wallet)
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
    // The reporter and the witness each write their own account for the feed.
    let witness = *reporter_ai.key == reporter::WITNESS;
    if *reporter_ai.key != reporter::REPORTER && !witness {
        return Err(RouterError::NotReporter.into());
    }
    if data.len() != 56 {
        return Err(RouterError::InvalidInstruction.into());
    }
    let feed: [u8; 32] = data[..32].try_into().unwrap();
    let price = u64::from_le_bytes(data[32..40].try_into().unwrap());
    let publish = i64::from_le_bytes(data[40..48].try_into().unwrap());
    let mut prev = i64::from_le_bytes(data[48..56].try_into().unwrap());
    let clock = Clock::get()?;
    // A positive price, published after the one before it and not in the future (a few seconds
    // of clock difference are allowed). In slot time the post's slot orders prices, and several
    // posts can fall in one second: the publish time only must not go back.
    if price == 0 || price > i64::MAX as u64 || (!SLOT_TIME && prev >= publish) || publish > clock.unix_timestamp.saturating_add(5) {
        return Err(RouterError::BadOracle.into());
    }
    let (key, bump) = if witness { reporter::witness_address(&feed) } else { reporter::report_address(&feed) };
    let seed = if witness { reporter::SEED_WITNESS } else { reporter::SEED_REPORT };
    key_is(report_ai, &key)?;
    // The slot of the post before this one (0 for the first).
    let mut prev_slot = 0u64;
    if report_ai.owner == program_id {
        let stored = reporter::decode(&report_ai.try_borrow_data()?).map_err(|_| RouterError::BadOracle)?;
        let (stored_slot, _) = reporter::posted_slots(&report_ai.try_borrow_data()?);
        if SLOT_TIME {
            // One post per slot, and its publish time never goes back.
            if clock.slot <= stored_slot || publish < stored.publish_time {
                return Err(RouterError::WrongUpdate.into());
            }
            prev = stored.publish_time.min(publish.saturating_sub(1));
        } else if publish <= stored.publish_time {
            return Err(RouterError::WrongUpdate.into());
        }
        prev_slot = stored_slot;
        // An account written before posts recorded their slot: extended to hold them.
        if report_ai.data_len() < reporter::REPORT_LEN {
            let need = Rent::get()?.minimum_balance(reporter::REPORT_LEN).saturating_sub(report_ai.lamports());
            if need > 0 {
                invoke(&system_instruction::transfer(reporter_ai.key, report_ai.key, need), &[reporter_ai.clone(), report_ai.clone(), system.clone()])?;
            }
            report_ai.realloc(reporter::REPORT_LEN, false)?;
        }
    } else {
        create_pda(reporter_ai, report_ai, system, program_id, reporter::REPORT_LEN, 0, &[seed, &feed, &[bump]])?;
    }
    let mut d = report_ai.try_borrow_mut_data()?;
    d[..8].copy_from_slice(&reporter::REPORT_MAGIC.to_le_bytes());
    d[reporter::REPORT_FEED_OFF..reporter::REPORT_FEED_OFF + 32].copy_from_slice(&feed);
    d[reporter::REPORT_PRICE_OFF..reporter::REPORT_PRICE_OFF + 8].copy_from_slice(&price.to_le_bytes());
    d[reporter::REPORT_PUBLISH_OFF..reporter::REPORT_PUBLISH_OFF + 8].copy_from_slice(&publish.to_le_bytes());
    d[reporter::REPORT_PREV_OFF..reporter::REPORT_PREV_OFF + 8].copy_from_slice(&prev.to_le_bytes());
    d[reporter::REPORT_BUMP_OFF] = bump;
    d[reporter::REPORT_SLOT_OFF..reporter::REPORT_SLOT_OFF + 8].copy_from_slice(&clock.slot.to_le_bytes());
    d[reporter::REPORT_PREV_SLOT_OFF..reporter::REPORT_PREV_SLOT_OFF + 8].copy_from_slice(&prev_slot.to_le_bytes());
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
    let mut b: Book = load_book(book_ai, program_id)?;
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
    // The price's place in router time: in slot time the slot it was posted in, and the slot of
    // the post before it (see `SLOT_TIME`); otherwise its publish times.
    let (at, at_prev) = if SLOT_TIME {
        let (slot, prev_slot) = if reported { reporter::posted_slots(&pyth_ai.try_borrow_data()?) } else { (0, 0) };
        if slot == 0 {
            return Err(RouterError::BadOracle.into());
        }
        (slot as i64, prev_slot as i64)
    } else {
        (u.publish_time, u.prev_publish_time)
    };
    let (mark_at, _) = mark_times(&b);
    if at <= mark_at {
        return Err(RouterError::WrongUpdate.into());
    }
    // A reported price is the reporter's word. Where Pyth exists it only rescues a queued request
    // that Pyth has not served for `FALLBACK_SECS` after its target, and only as that request's
    // price. In an X1 build it is the price source and follows the same rules as a Pyth update.
    // In an X1 build the witness must confirm it (account 7): recent, and within its band.
    // How far the price's sources disagree (see `risk`): Pyth's own confidence interval, and on
    // X1 the gap to the witness.
    let mut disagreement = u.conf_bps();
    if reported && cfg!(feature = "x1") {
        let w = accounts.get(7).ok_or(RouterError::WitnessDisagrees)?;
        let wu = reporter::read_witness(w, &v.oracle_feeds[0]).map_err(|_| RouterError::WitnessDisagrees)?;
        if !reporter::witness_agrees(&u, &wu) {
            return Err(RouterError::WitnessDisagrees.into());
        }
        disagreement = disagreement.max(reporter::witness_gap_bps(&u, &wu));
    }
    if reported && !cfg!(feature = "x1") {
        let now = Clock::get()?.unix_timestamp;
        let rescues = earliest_target(book_ai, &b)?.is_some_and(|t| now >= t.saturating_add(reporter::FALLBACK_SECS) && u.is_first_at_or_after(t));
        if !rescues {
            return Err(RouterError::FallbackNotAllowed.into());
        }
    }
    if let Some(earliest) = earliest_target(book_ai, &b)? {
        // (A request queued by a build before slot time has a target in unix seconds, far above
        // any slot: it does not hold the mark back, and it expires by the clock.)
        if earliest <= at && !(at_prev < earliest && earliest <= at) {
            return Err(RouterError::WrongUpdate.into());
        }
    }
    // Seconds between the two prices, for the band: slot time counts 0.4 s a slot (rounded
    // up), and a mark set before slot time as no time at all (the narrowest band).
    let band_secs = if SLOT_TIME {
        if mark_at == 0 && b.mark_price != 0 { 0 } else { (at.saturating_sub(mark_at).saturating_mul(2) + 4) / 5 }
    } else {
        u.publish_time.saturating_sub(b.mark_publish_time)
    };
    if !within_band(b.mark_price, price, band_secs) {
        return Err(RouterError::PriceBand.into());
    }
    // Slot time: how fast the price is moving raises the dial too (`risk::speed_bps`).
    if SLOT_TIME && mark_at != 0 && b.mark_price != 0 {
        disagreement = disagreement.max(risk::speed_bps(b.mark_price, price, at.saturating_sub(mark_at)));
    }
    // Lazy settlement (`lazy`): the vault's price range, when passed, restarts if every account
    // is up to date now, and takes this mark in below.
    let range_ai = lazy::find(program_id, accounts, vault_ai.key);
    let mut range = match range_ai {
        Some(ai) => {
            let mut r: PriceRange = load(ai, program_id, RANGE_MAGIC)?;
            lazy::restart_if_current(&mut r, &market.try_borrow_data()?, v.asset_index, &b)?;
            Some(r)
        }
        None => None,
    };
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
    if let (Some(ai), Some(r)) = (range_ai, range.as_mut()) {
        lazy::take_mark(r, mark_at, at, price);
        store(ai, r)?;
    }
    b.mark_publish_time = at;
    b.mark_prev_publish_time = at_prev;
    b.mark_price = price;
    b.price_dial = risk::price_dial(disagreement);
    b.mark_set_time = Clock::get()?.unix_timestamp.clamp(1, u32::MAX as i64) as u32;
    store_book(book_ai, &b)
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
    if t.has_pending == 0 {
        return Err(RouterError::BadAccount.into());
    }
    // A request queued by a standing order comes with that order (account 13).
    let order = if r.kind == KIND_ORDER {
        let order_ai = acc(accounts, 13)?;
        writable(order_ai)?;
        key_is(order_ai, &order_address(program_id, &r.vault, &t.owner(trader_ai.key), r.order_index).0)?;
        let o: Order = load(order_ai, program_id, ORDER_MAGIC)?;
        if o.queued_id != r.id.wrapping_add(1) {
            return Err(RouterError::BadAccount.into());
        }
        Some((order_ai, o))
    } else {
        None
    };
    let order_ai = order.as_ref().map(|(a, _)| *a);
    let mut b: Book = load_book(book_ai, program_id)?;
    let v = load_vault(vault_ai)?;
    if r.vault != *vault_ai.key || b.vault != *vault_ai.key || t.pending_vault != *vault_ai.key || t.pending_id != r.id {
        return Err(RouterError::BadAccount.into());
    }
    key_is(market, &v.market)?;
    key_is(portfolio, &t.portfolio)?;
    key_is(lp_portfolio, &v.lp_portfolio)?;
    key_is(delegate, &v.matcher_delegate)?;

    // The mark is the unique first Pyth price at or after the target, and Percolator's price is it.
    if !mark_at_target(&b, r.target_time) {
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
    // What the account owes the vaults (see `carry`): the time it has held this asset since its
    // last fill is settled first, and the total counts against its equity in every check below.
    let mut fees = carry::Fees::load(program_id, accounts, &b, &t, vault_ai.key, trader_ai.key)?;
    let debt = fees.settle(v.asset_index, market_id, before, effective, Clock::get()?.unix_timestamp)?;
    let mut liquidation_fee = false;
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
    // A close-only request likewise only shrinks what is held now, and does nothing on a
    // position that is gone or has changed side since it was queued.
    if r.reduce_only != 0 && size != 0 {
        if before == 0 || (before > 0) == (size > 0) {
            size = 0;
        } else if size.unsigned_abs() > before.unsigned_abs() {
            size = before.checked_neg().ok_or(RouterError::Overflow)?;
        }
    }
    if r.size != 0 && size != 0 {
        // A trade Percolator would refuse is not attempted: the request ends here having traded
        // nothing, instead of staying in the queue (unfillable, and in the way of every request
        // behind it) until it expires. That is a trade that adds risk on a market that has become
        // close-only, or one the account no longer has the margin for at this price.
        let close_only = perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)?;
        let reduces = before != 0 && (before > 0) != (size > 0) && size.unsigned_abs() <= before.unsigned_abs();
        let tiers = tiers_in(program_id, accounts, market.key);
        let dial = risk::dial(b.price_dial, tier_of_feed(&v.oracle_feeds[0]), Clock::get()?.unix_timestamp);
        if !close_only && liquidatable(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, tiers.as_ref(), debt)? {
            // Below the liquidation level at this price: the one thing a fill does for such an
            // account is close its position here, whatever was asked. A trader has one place in
            // the queue, so while a request of its own waits nobody can queue its liquidation;
            // without this, an account kept busy with small requests could not be liquidated
            // through the router at all.
            liquidated = before != 0;
            liquidation_fee = liquidated;
            size = liquidation_size(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, tiers.as_ref(), v.asset_index, before, debt)?;
        } else if !reduces && holds_other_asset(&t, &market.try_borrow_data()?, &portfolio.try_borrow_data()?, v.asset_index)? {
            // An isolated account holds one asset at a time.
            size = 0;
        } else if (close_only && !reduces) || !margin_covers_owing(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, &v, size, 0, tiers.as_ref(), debt, dial)? {
            size = 0;
        } else if !reduces && !fees.can_book(v.asset_index, market_id)? {
            // Without a fee ledger (`OpenLedger`), or with all its slots in use, an account can
            // only reduce: what it adds would owe fees nobody could book.
            size = 0;
        }
    } else if r.size == 0 {
        let close_only = perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)?;
        if close_only && before != 0 {
            // Reduce the whole position unilaterally at Percolator's price, which is the mark.
            reduce_unilaterally(trader_ai, market, portfolio, percolator, &t, v.asset_index)?;
        } else if !close_only && before != 0 && liquidatable(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, tiers_in(program_id, accounts, market.key).as_ref(), debt)? {
            // Still below the liquidation level at the fill price: close against the vault, as
            // much as it takes (anyone may queue another if the account is still below after).
            let tiers = tiers_in(program_id, accounts, market.key);
            size = liquidation_size(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, tiers.as_ref(), v.asset_index, before, debt)?;
            liquidation_fee = true;
        }
    }
    if size != 0 {
        // A fill that only reduces the trader's own position is marked for the vault, which
        // takes it even while it accepts nothing else that grows its position.
        let closing = before != 0 && (before > 0) != (size > 0) && size.unsigned_abs() <= before.unsigned_abs();
        let dial = risk::dial(b.price_dial, tier_of_feed(&v.oracle_feeds[0]), Clock::get()?.unix_timestamp);
        // Lazy settlement (`lazy`): with the vault's price range passed and narrow enough, the
        // fill goes through without the asset's other accounts re-valued first.
        let tolerant = match lazy::find(program_id, accounts, vault_ai.key) {
            Some(ai) => {
                let mut r: PriceRange = load(ai, program_id, RANGE_MAGIC)?;
                lazy::restart_if_current(&mut r, &market.try_borrow_data()?, v.asset_index, &b)?;
                store(ai, &r)?;
                lazy::tolerant(&r, &market.try_borrow_data()?, v.asset_index, &b)?
            }
            None => false,
        };
        trade_against_vault(accounts, &t, &v, abump, market_id, size, closing, fee_bps, dial, tolerant)?;
        // The vault's position just changed: one step of its funding rate toward the new target
        // (the asset is accrued to this slot, which Percolator requires to take a rate).
        funding::refresh(acc(accounts, 5)?, acc(accounts, 6)?, acc(accounts, 10)?, acc(accounts, 11)?, acc(accounts, 12)?, abump)?;
    }
    // What actually traded (the vault may fill less than requested) and at what price.
    let traded = held(portfolio, market)? - before;
    msg!("fill {} {} {}", { r.id }, traded, effective);
    let owed = book_fees(fees, vault_ai, portfolio, v.asset_index, market_id, v.inventory, before, traded, effective, liquidation_fee)?;
    // This account's value in the wallet's record of values (required once the wallet has one),
    // and the others', which the track record counts too.
    let mut others = 0i128;
    if let Some(e) = social::equities_for(program_id, accounts, &t)? {
        let (capital, pnl, _) = perc::portfolio_exposure(&portfolio.try_borrow_data()?)?;
        let here = (capital as i128).saturating_add(pnl).saturating_sub(owed as i128);
        others = social::set_equity(program_id, e, t.sub, Some(here), 0)?;
    }
    // The trader's track record, when the fill names it (its last account).
    if let Some(stats_ai) = accounts.last() {
        social::record_fill(program_id, stats_ai, &t, portfolio, v.asset_index, traded, effective, owed, others);
    }

    book_remove(book_ai, &mut b, r.id)?;
    store_book(book_ai, &b)?;
    t.has_pending = 0;
    store(trader_ai, &t)?;
    if let Some((order_ai, o)) = order {
        // A liquidation is not the order's trade: a limit or TWAP order keeps what it had left.
        let protective = matches!(o.kind, ORDER_STOP | ORDER_TAKE | ORDER_TRAIL);
        settle_order(order_ai, o, if liquidated && !protective { 0 } else { traded }, wallet)?;
    }
    // A fill that liquidated the account (a trader's own request turned into a liquidation, or a
    // queued forced close while the account is still below its level) pays the executor
    // `LIQ_REWARD` from its keeper deposit.
    if liquidation_fee && traded != 0 {
        let reward = LIQ_REWARD.min(spare(trader_ai, TRADER_LEN)?);
        if reward > 0 {
            pay(trader_ai, executor, reward)?;
            msg!("reward liquidate {}", reward);
        }
    }
    // The bond is the executor's. The rent goes back to who paid it: the trader; for a request
    // paid for by its owner, the order's budget (or the wallet, once the order is done) or the
    // account's keeper deposit; otherwise, for a standing order's or a copy's request, whoever
    // queued it, who is paid back only by filling it.
    let rent_to = if r.funded != 0 {
        match order_ai {
            Some(oa) if oa.data_len() > 0 => oa,
            Some(_) => wallet,
            None => trader_ai,
        }
    } else if order_ai.is_some() || r.kind == KIND_COPY {
        executor
    } else {
        wallet
    };
    close(request_ai, BOND_LAMPORTS, executor, rent_to)
}

/// After a fill: the fees it adds (see `carry`), on what grew the vault's position (unless the
/// trader only closed part or all of their own) and on what a liquidation closed; then the
/// ledger and the meter are brought up to the new positions. Returns what the account owes.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn book_fees(fees: carry::Fees, vault_ai: &AccountInfo, portfolio: &AccountInfo, asset: u16, generation: u64, inventory_before: i128, before: i128, traded: i128, price: u64, liquidation: bool) -> Result<u64, ProgramError> {
    let after = load_vault(vault_ai)?;
    let own_close = before != 0 && traded != 0 && (before > 0) != (traded > 0) && traded.unsigned_abs() <= before.unsigned_abs();
    let grown = after.inventory.unsigned_abs().saturating_sub(inventory_before.unsigned_abs());
    let mut extra = if own_close { 0 } else { carry::fee_on(grown, price, carry::SIDE_FEE_BPS) };
    if liquidation {
        extra = extra.saturating_add(carry::fee_on(traded.unsigned_abs(), price, carry::LIQ_FEE_BPS));
    }
    let (capital, pnl, _) = perc::portfolio_exposure(&portfolio.try_borrow_data()?)?;
    let equity = (capital as i128).saturating_add(pnl);
    let limit = funding::position_limit(&after, price);
    let held_after = before.checked_add(traded).ok_or(RouterError::Overflow)?;
    fees.finish(asset, generation, held_after, extra, equity, after.inventory, limit)
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
#[allow(clippy::too_many_arguments)]
fn trade_against_vault(accounts: &[AccountInfo], t: &TraderState, v: &vstate::VaultState, abump: u8, market_id: u64, size: i128, closing: bool, fee_bps: u64, dial: u8, tolerant: bool) -> ProgramResult {
    let (trader_ai, vault_ai, market, portfolio) = (acc(accounts, 2)?, acc(accounts, 5)?, acc(accounts, 6)?, acc(accounts, 7)?);
    let (lp_portfolio, delegate, authority, vault_program, percolator) = (acc(accounts, 8)?, acc(accounts, 9)?, acc(accounts, 10)?, acc(accounts, 11)?, acc(accounts, 12)?);
    let mut arm = vec![TAG_ARM_FILL];
    arm.extend_from_slice(&size.to_le_bytes());
    arm.push(closing as u8);
    arm.push(dial);
    if tolerant {
        arm.push(1);
    }
    invoke_signed(
        &Instruction {
            program_id: percolator_vault::id(),
            accounts: vec![
                AccountMeta::new_readonly(*authority.key, true),
                AccountMeta::new(*vault_ai.key, false),
                AccountMeta::new_readonly(*market.key, false),
                AccountMeta::new_readonly(*lp_portfolio.key, false),
            ],
            data: arm,
        },
        &[authority.clone(), vault_ai.clone(), market.clone(), lp_portfolio.clone(), vault_program.clone()],
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
    let mut b: Book = load_book(book_ai, program_id)?;
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
    // (The vault counts in unix seconds. In slot time a slot is counted as a whole second, more
    // than any X1 slot takes, so the freeze lasts at least until the request can expire.)
    let until = if SLOT_TIME {
        let clock = Clock::get()?;
        clock.unix_timestamp.saturating_add(r.target_time.saturating_sub(clock.slot as i64)).saturating_add(GRACE_SLOTS).saturating_add(5)
    } else {
        r.target_time.saturating_add(GRACE_SECS).saturating_add(5)
    }
    .clamp(1, u32::MAX as i64) as u32;
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
    let mut b: Book = load_book(book_ai, program_id)?;
    let v = load_vault(vault_ai)?;
    if r.kind != KIND_SETTLE || r.vault != *vault_ai.key || b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    key_is(market, &v.market)?;
    if !mark_at_target(&b, r.target_time) {
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

    book_remove(book_ai, &mut b, r.id)?;
    store_book(book_ai, &b)?;
    close(request_ai, BOND_LAMPORTS, executor, wallet)
}

/// For `expire`: whether the request's market was more than `BEHIND_REFUND_SLOTS` behind, read
/// from accounts 5 (its vault) and 6 (the Percolator market) when they are given. Without them
/// the deposit is kept, as before.
fn market_was_behind(accounts: &[AccountInfo], r: &Request) -> Result<bool, ProgramError> {
    let (Some(vault_ai), Some(market)) = (accounts.get(5), accounts.get(6)) else { return Ok(false) };
    if *vault_ai.key != r.vault {
        return Err(RouterError::BadAccount.into());
    }
    let v = vstate::load_vault(vault_ai, &percolator_vault::id())?;
    if *market.key != v.market || *market.owner != perc::PERCOLATOR_PROGRAM_ID {
        return Err(RouterError::BadAccount.into());
    }
    let (_, _, slot_last) = perc::asset_price(&market.try_borrow_data()?, v.asset_index)?;
    Ok(Clock::get()?.slot.saturating_sub(slot_last) > BEHIND_REFUND_SLOTS)
}

/// Removes a request nobody filled within `GRACE_SECS` of its target. Its bond is forfeited
/// (kept in the book account, which nothing can withdraw); its rent goes back to the trader.
///
/// A request queued by a standing order frees that order to be carried out again; its rent stays
/// in the book with the bond (the trader did not pay it).
///
/// Accounts: 0 caller [s], 1 request [w], 2 trader [w], 3 trader wallet [w], 4 book [w],
/// 5 the standing order [w] (only for a request one queued), or for a settlement, optionally,
/// its vault (to remove it early once its epoch has rolled), or for a trader's own request,
/// optionally, its vault and 6 the Percolator market (so a market that was behind refunds the
/// deposit: `BEHIND_REFUND_SLOTS`).
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
    let mut b: Book = load_book(book_ai, program_id)?;
    if b.vault != r.vault {
        return Err(RouterError::BadAccount.into());
    }
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    // Past its grace period; or its price has been the mark for `STALL_SECS` and nobody filled it.
    let at_mark = mark_at_target(&b, r.target_time);
    let stalled = at_mark && b.mark_set_time != 0 && now > (b.mark_set_time as i64).saturating_add(STALL_SECS);
    // The grace period in the request's own time: slots, or (queued before slot time, or a
    // Solana build) unix seconds.
    let (since, grace_left) = if SLOT_TIME && r.target_time <= LEGACY_TIME { (clock.slot as i64, GRACE_SLOTS) } else { (now, GRACE_SECS) };
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
    if since <= r.target_time.saturating_add(grace_left) && !stalled && !dead {
        return Err(RouterError::TooEarly.into());
    }
    // A settlement request belongs to no trader (account 2 is then ignored).
    let mut owner = r.wallet;
    if r.kind != KIND_SETTLE {
        let mut t = load_trader(program_id, trader_ai, &r.wallet)?;
        if t.pending_vault != r.vault || t.pending_id != r.id {
            return Err(RouterError::BadAccount.into());
        }
        owner = t.owner(trader_ai.key);
        t.has_pending = 0;
        store(trader_ai, &t)?;
    }
    // A share of the bond to whoever expires it (when they let the router credit them); the
    // rest is forfeited.
    let share = if caller.is_writable && caller.key != book_ai.key && caller.key != request_ai.key { BOND_LAMPORTS / EXPIRE_SHARE_DIV } else { 0 };
    let bond = BOND_LAMPORTS - share;
    if share > 0 {
        pay(request_ai, caller, share)?;
        msg!("reward expire {}", share);
    }
    book_remove(book_ai, &mut b, r.id)?;
    b.forfeited_bonds = b.forfeited_bonds.saturating_add(bond);
    store_book(book_ai, &b)?;
    if r.kind == KIND_ORDER {
        let order_ai = acc(accounts, 5)?;
        writable(order_ai)?;
        key_is(order_ai, &order_address(program_id, &r.vault, &owner, r.order_index).0)?;
        let mut o: Order = load(order_ai, program_id, ORDER_MAGIC)?;
        o.queued_id = 0;
        store(order_ai, &o)?;
        // Paid for out of the order's budget: its rent goes back there.
        return close(request_ai, bond, book_ai, if r.funded != 0 { order_ai } else { book_ai });
    }
    if r.kind == KIND_COPY {
        return close(request_ai, bond, book_ai, book_ai);
    }
    // A forced close paid for out of the keeper deposit gives its rent back to the deposit.
    let rent_to = if r.funded != 0 && r.kind == KIND_TRADE { trader_ai } else { wallet };
    // Its price was the mark and it still was not filled: the deposit that came with it stays
    // here with the bond (see `EXPIRY_DEPOSIT_BPS`); only the account's rent goes back. A request
    // whose price never arrived (no oracle price, no executor) lost nothing but its bond.
    if r.kind == KIND_TRADE && at_mark && !market_was_behind(accounts, &r)? {
        let rent = Rent::get()?.minimum_balance(REQUEST_LEN);
        let kept = request_ai.lamports().saturating_sub(rent).max(bond);
        let mut b: Book = load_book(book_ai, program_id)?;
        b.forfeited_bonds = b.forfeited_bonds.saturating_add(kept - bond);
        store_book(book_ai, &b)?;
        return close(request_ai, kept, book_ai, rent_to);
    }
    close(request_ai, bond, book_ai, rent_to)
}
