//! Router account layouts (packed plain old data) and addresses.

use bytemuck::{Pod, Zeroable};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use crate::RouterError;

pub const TRADER_MAGIC: u64 = u64::from_le_bytes(*b"PRTRADR1");
pub const BOOK_MAGIC: u64 = u64::from_le_bytes(*b"PRBOOK01");
pub const REQUEST_MAGIC: u64 = u64::from_le_bytes(*b"PRREQST1");
pub const ORDER_MAGIC: u64 = u64::from_le_bytes(*b"PRORDER1");
pub const MAX_PENDING: usize = 32;
/// Standing orders one wallet can have on one vault's market.
pub const MAX_ORDERS: u8 = 8;

pub const SEED_AUTHORITY: &[u8] = b"authority";
pub const SEED_TRADER: &[u8] = b"trader";
pub const SEED_PORTFOLIO: &[u8] = b"portfolio";
pub const SEED_COLLATERAL: &[u8] = b"collateral";
pub const SEED_BOOK: &[u8] = b"book";
pub const SEED_REQUEST: &[u8] = b"request";
pub const SEED_ORDER: &[u8] = b"order";

/// A trader's router account. Its address owns the trader's Percolator portfolio and collateral
/// token account; only the router can sign for it.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct TraderState {
    pub magic: u64,
    pub market: Pubkey,
    pub wallet: Pubkey,
    pub portfolio: Pubkey,
    pub collateral: Pubkey,
    pub bump: u8,
    pub has_pending: u8,
    /// 1 once the account has a track record (`OpenStats`): `Deposit` and `Withdraw` then book
    /// what they move in it.
    pub has_stats: u8,
    pub _pad: [u8; 5],
    pub pending_vault: Pubkey,
    pub pending_id: u64,
}
pub const TRADER_LEN: usize = core::mem::size_of::<TraderState>();

/// A vault's queue of pending requests and the Pyth update its mark currently holds.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Book {
    pub magic: u64,
    pub vault: Pubkey,
    pub market: Pubkey,
    pub bump: u8,
    pub len: u8,
    /// Chain time (unix seconds) at which the mark was last moved; 0 in a book last written by a
    /// build that did not record it. See `STALL_SECS`.
    pub mark_set_time: u32,
    pub _pad: [u8; 2],
    /// Publish time, previous publish time and price (e6) of the Pyth update the mark holds.
    pub mark_publish_time: i64,
    pub mark_prev_publish_time: i64,
    pub mark_price: u64,
    pub next_id: u64,
    /// Bonds of expired requests, kept in this account (nothing can withdraw them).
    pub forfeited_bonds: u64,
    pub pending_id: [u64; MAX_PENDING],
    pub pending_target: [i64; MAX_PENDING],
}
pub const BOOK_LEN: usize = core::mem::size_of::<Book>();

impl Book {
    pub fn earliest_target(&self) -> Option<i64> {
        let targets = self.pending_target;
        targets[..self.len as usize].iter().copied().min()
    }

    pub fn remove(&mut self, id: u64) -> Result<(), RouterError> {
        let n = self.len as usize;
        let (mut ids, mut targets) = (self.pending_id, self.pending_target);
        let i = ids[..n].iter().position(|x| *x == id).ok_or(RouterError::BadAccount)?;
        ids[i] = ids[n - 1];
        targets[i] = targets[n - 1];
        ids[n - 1] = 0;
        targets[n - 1] = 0;
        self.pending_id = ids;
        self.pending_target = targets;
        self.len -= 1;
        Ok(())
    }
}

/// One queued trade. Its target time is fixed when it lands; it fills at the first Pyth price
/// published at or after it, or expires.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Request {
    pub magic: u64,
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub id: u64,
    pub size: i128,
    pub target_time: i64,
    pub created_slot: u64,
    pub bump: u8,
    /// `KIND_TRADE` (a trade, or a forced close when `size` is 0), `KIND_SETTLE` (an epoch
    /// settlement of the vault: `wallet` is then whoever queued it, not a trader), `KIND_ORDER`
    /// (a trade queued by one of the trader's standing orders, `order_index`) or `KIND_COPY`.
    pub kind: u8,
    pub order_index: u8,
    pub _pad: [u8; 5],
}
pub const KIND_TRADE: u8 = 0;
pub const KIND_SETTLE: u8 = 1;
pub const KIND_ORDER: u8 = 2;
/// A trade queued by `TriggerCopy` (it fills like `KIND_TRADE`; the request's rent goes back to
/// whoever queued it, not to the trader).
pub const KIND_COPY: u8 = 3;
pub const REQUEST_LEN: usize = core::mem::size_of::<Request>();

/// Closes a position (all of it, or `size` of it) once the mark is at or through `trigger`
/// against the position: at or below it for a long, at or above it for a short.
pub const ORDER_STOP: u8 = 0;
/// The same, in the position's favour: at or above `trigger` for a long, at or below for a short.
pub const ORDER_TAKE: u8 = 1;
/// A stop that follows the price: it closes once the mark has come back `trigger` basis points
/// from the best mark recorded since the order was placed (`peak`).
pub const ORDER_TRAIL: u8 = 2;
/// Trades `size` once the mark is at `trigger` or better (at or below it for a buy, at or above
/// for a sell), and only fills at a price that is no worse than `trigger`.
pub const ORDER_LIMIT: u8 = 3;
/// Trades `size` in slices of `slice`, one every `interval` seconds.
pub const ORDER_TWAP: u8 = 4;

/// A standing order: an instruction the wallet signed once, which anyone may carry out when its
/// condition holds. Carrying it out only queues an ordinary request, so it fills like any trade:
/// at the first oracle price published at or after the request's target time. The condition is
/// checked against the vault's mark, which is itself a verified oracle price.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Order {
    pub magic: u64,
    pub vault: Pubkey,
    pub wallet: Pubkey,
    pub index: u8,
    pub kind: u8,
    /// The order may only shrink the position (always so for a stop, take-profit or trail).
    pub reduce_only: u8,
    pub bump: u8,
    /// Stop, take-profit, trail: the side of the position it protects (+1 long, -1 short).
    pub side: i8,
    pub _pad: [u8; 3],
    /// Limit, TWAP: what is left to trade (+ = buy). Stop, take-profit, trail: how much of the
    /// position to close (0 = all of it).
    pub size: i128,
    /// A price (e6), or for a trail the distance in basis points.
    pub trigger: u64,
    /// Trail: the best mark recorded since the order was placed.
    pub peak: u64,
    /// TWAP: the size of one slice, the seconds between slices, and when the next is due.
    pub slice: u64,
    pub interval: i64,
    pub next_time: i64,
    /// After this time (0 = never) the order is void and anyone may remove it.
    pub expiry: i64,
    /// The id of the request this order has in the queue, plus one (0 = none).
    pub queued_id: u64,
}
pub const ORDER_LEN: usize = core::mem::size_of::<Order>();

// ---- track record, profiles, following and copying ----

pub const STATS_MAGIC: u64 = u64::from_le_bytes(*b"PRSTATS1");
pub const PROFILE_MAGIC: u64 = u64::from_le_bytes(*b"PRPROFL1");
pub const NAME_MAGIC: u64 = u64::from_le_bytes(*b"PRNAME01");
pub const FOLLOW_MAGIC: u64 = u64::from_le_bytes(*b"PRFOLLW1");
pub const COPY_MAGIC: u64 = u64::from_le_bytes(*b"PRCOPY01");
pub const SEED_STATS: &[u8] = b"stats";
pub const SEED_PROFILE: &[u8] = b"profile";
pub const SEED_NAME: &[u8] = b"name";
pub const SEED_FOLLOW: &[u8] = b"follow";
pub const SEED_COPY: &[u8] = b"copy";
pub const REFERRAL_MAGIC: u64 = u64::from_le_bytes(*b"PRREFER1");
pub const SEED_REFERRAL: &[u8] = b"referral";
/// Trading days and fills a track record keeps (the newest replace the oldest).
pub const STATS_DAYS: usize = 30;
pub const STATS_FILLS: usize = 16;
pub const NAME_MAX: usize = 16;
pub const NAME_MIN: usize = 3;

/// One day on which the account traded: the day (unix time / 86,400) and what the account made
/// or lost between its last fill before that day and its last fill of that day.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct DayRec {
    pub day: u32,
    pub _pad: u32,
    pub pnl: i64,
}

/// One fill: when, at what price (e6), how much (position units, + = bought) and on which asset.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct FillRec {
    pub time: i64,
    pub price: u64,
    pub size: i64,
    pub asset: u16,
    pub _pad: [u8; 6],
}

/// A trading account's track record, written by the router itself: what was paid in and out
/// since it was opened (`Deposit`, `Withdraw`) and, at every fill, the account's equity. Profit
/// is equity minus the equity at the start minus what was paid in since, so nobody can report a
/// result they did not have. Anyone may open it for any trading account (`OpenStats`).
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Stats {
    pub magic: u64,
    pub wallet: Pubkey,
    pub market: Pubkey,
    pub bump: u8,
    /// Where the newest entries of `days` and `fills` are.
    pub day_at: u8,
    pub fill_at: u8,
    pub _pad: [u8; 5],
    pub start_time: i64,
    /// Equity (capital + PnL, collateral atoms) when the record was opened.
    pub start_equity: i64,
    pub deposited: u64,
    pub withdrawn: u64,
    /// Notional traded (collateral atoms) and number of fills that traded.
    pub volume: u128,
    pub trades: u32,
    /// Trading days that ended with a profit, and with a loss (the day in progress not counted).
    pub days_up: u16,
    pub days_down: u16,
    pub last_time: i64,
    /// Profit at the last fill, and at the last fill before the newest day in `days`.
    pub last_pnl: i64,
    pub day_open_pnl: i64,
    /// The highest profit seen at a fill, and the largest fall from it.
    pub peak_pnl: i64,
    pub max_drawdown: u64,
    pub best_day: i64,
    pub worst_day: i64,
    pub days: [DayRec; STATS_DAYS],
    pub fills: [FillRec; STATS_FILLS],
}
pub const STATS_LEN: usize = core::mem::size_of::<Stats>();

/// A name and a badge a wallet chose for itself. Names are unique (see `NameRec`).
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Profile {
    pub magic: u64,
    pub wallet: Pubkey,
    pub name: [u8; NAME_MAX],
    pub name_len: u8,
    /// Which of the page's badge shapes, and which of its colours.
    pub badge: u8,
    pub color: u8,
    pub bump: u8,
    pub _pad: [u8; 4],
    pub created: i64,
}
pub const PROFILE_LEN: usize = core::mem::size_of::<Profile>();

/// Who holds a name: the account lives at the address of the name in lower case.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct NameRec {
    pub magic: u64,
    pub wallet: Pubkey,
    pub bump: u8,
    pub _pad: [u8; 7],
}
pub const NAME_LEN: usize = core::mem::size_of::<NameRec>();

/// `follower` follows `leader` (a list of who to watch; it moves no money).
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Follow {
    pub magic: u64,
    pub follower: Pubkey,
    pub leader: Pubkey,
    pub since: i64,
    pub bump: u8,
    pub _pad: [u8; 7],
}
pub const FOLLOW_LEN: usize = core::mem::size_of::<Follow>();

/// Who brought `wallet` to the platform. Written once by the wallet itself and never changed; it
/// moves no money. The platform pays referrers a part of its own share of the fees the wallet
/// pays from `since` on, worked out from the wallets' track records.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Referral {
    pub magic: u64,
    pub wallet: Pubkey,
    pub referrer: Pubkey,
    pub since: i64,
    pub bump: u8,
    pub _pad: [u8; 23],
}
pub const REFERRAL_LEN: usize = core::mem::size_of::<Referral>();

/// `follower`'s instruction to keep its positions in line with `leader`'s: the same leverage on
/// every market, times `ratio_bps` / 10,000, and at most `max_notional` (collateral atoms, 0 = no
/// limit) on any one market. Signed once by the follower; from then on anyone may bring the
/// account in line (`TriggerCopy`), which only queues an ordinary request.
#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Copy {
    pub magic: u64,
    pub market: Pubkey,
    pub follower: Pubkey,
    pub leader: Pubkey,
    pub ratio_bps: u32,
    pub bump: u8,
    pub _pad: [u8; 3],
    pub max_notional: u64,
    pub since: i64,
    /// How many times the account was brought in line.
    pub triggers: u32,
    pub _pad2: u32,
}
pub const COPY_LEN: usize = core::mem::size_of::<Copy>();

pub fn stats_address(program_id: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_STATS, market.as_ref(), wallet.as_ref()], program_id)
}
pub fn profile_address(program_id: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_PROFILE, wallet.as_ref()], program_id)
}
/// `lower`: the name in lower case.
pub fn name_address(program_id: &Pubkey, lower: &[u8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_NAME, lower], program_id)
}
pub fn follow_address(program_id: &Pubkey, follower: &Pubkey, leader: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_FOLLOW, follower.as_ref(), leader.as_ref()], program_id)
}
pub fn referral_address(program_id: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_REFERRAL, wallet.as_ref()], program_id)
}
pub fn copy_address(program_id: &Pubkey, market: &Pubkey, follower: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_COPY, market.as_ref(), follower.as_ref()], program_id)
}

pub fn load<T: Pod>(ai: &AccountInfo, program_id: &Pubkey, magic: u64) -> Result<T, ProgramError> {
    if ai.owner != program_id || ai.data_len() != core::mem::size_of::<T>() {
        return Err(RouterError::BadAccount.into());
    }
    let d = ai.try_borrow_data()?;
    if d[..8] != magic.to_le_bytes() {
        return Err(RouterError::BadAccount.into());
    }
    Ok(bytemuck::pod_read_unaligned(&d))
}

pub fn store<T: Pod>(ai: &AccountInfo, v: &T) -> Result<(), ProgramError> {
    ai.try_borrow_mut_data()?.copy_from_slice(bytemuck::bytes_of(v));
    Ok(())
}

pub fn authority_address(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_AUTHORITY], program_id)
}
pub fn trader_address(program_id: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_TRADER, market.as_ref(), wallet.as_ref()], program_id)
}
pub fn portfolio_address(program_id: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_PORTFOLIO, market.as_ref(), wallet.as_ref()], program_id)
}
pub fn collateral_address(program_id: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_COLLATERAL, market.as_ref(), wallet.as_ref()], program_id)
}
pub fn book_address(program_id: &Pubkey, vault: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_BOOK, vault.as_ref()], program_id)
}
pub fn order_address(program_id: &Pubkey, vault: &Pubkey, wallet: &Pubkey, index: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_ORDER, vault.as_ref(), wallet.as_ref(), &[index]], program_id)
}
/// A request lives at an address of its own owner: the trader's wallet (one request at a time,
/// whoever queued it), or for an epoch settlement whoever queued it. Two people who send requests
/// to the same market at the same moment therefore never compete for one address. (The request's
/// place in the queue, its id, is still given by the book when it lands.)
pub fn request_address(program_id: &Pubkey, vault: &Pubkey, owner: &Pubkey, settlement: bool) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_REQUEST, vault.as_ref(), owner.as_ref(), &[settlement as u8]], program_id)
}
