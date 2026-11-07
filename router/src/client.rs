//! Off-chain instruction builders for every router instruction (tests, keeper, tooling).

use percolator_vault::{client::VaultKeys, percolator as perc};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};

use crate::{state::*, *};

fn w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn ro(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}

/// A trader's router addresses on a market.
#[derive(Clone, Copy, Debug)]
pub struct TraderKeys {
    pub wallet: Pubkey,
    pub market: Pubkey,
    pub trader: Pubkey,
    pub portfolio: Pubkey,
    pub collateral: Pubkey,
    /// 0: the main account; 1..=255: an isolated one.
    pub sub: u8,
    /// What its request and order addresses are derived from (`TraderState::owner`).
    pub owner: Pubkey,
}

impl TraderKeys {
    pub fn new(market: Pubkey, wallet: Pubkey) -> Self {
        Self {
            wallet,
            market,
            trader: trader_address(&id(), &market, &wallet).0,
            portfolio: portfolio_address(&id(), &market, &wallet).0,
            collateral: collateral_address(&id(), &market, &wallet).0,
            sub: 0,
            owner: wallet,
        }
    }
    /// The wallet's isolated account number `sub` (1..=255) on `market`.
    pub fn isolated(market: Pubkey, wallet: Pubkey, sub: u8) -> Self {
        let trader = isolated_address(&id(), &market, &wallet, sub).0;
        Self {
            wallet,
            market,
            trader,
            portfolio: isolated_portfolio_address(&id(), &trader).0,
            collateral: isolated_collateral_address(&id(), &trader).0,
            sub,
            owner: trader,
        }
    }
}

pub fn open_account(t: &TraderKeys, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(t.wallet, true),
            w(t.trader),
            w(t.portfolio),
            w(t.collateral),
            w(t.market),
            ro(*mint),
            ro(perc::PERCOLATOR_PROGRAM_ID),
            ro(system_program::ID),
            ro(spl_token::ID),
            w(equities_address(&id(), &t.market, &t.wallet).0),
            w(trader_address(&id(), &t.market, &t.wallet).0),
            ro(portfolio_address(&id(), &t.market, &t.wallet).0),
        ],
        data: if t.sub == 0 { vec![TAG_OPEN_ACCOUNT] } else { vec![TAG_OPEN_ACCOUNT, t.sub] },
    }
}

pub fn deposit(t: &TraderKeys, source: &Pubkey, percolator_vault: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![TAG_DEPOSIT];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new_readonly(t.wallet, true),
            ro(t.trader),
            w(*source),
            w(t.collateral),
            w(t.portfolio),
            w(t.market),
            w(*percolator_vault),
            ro(spl_token::ID),
            ro(perc::PERCOLATOR_PROGRAM_ID),
            w(stats_address(&id(), &t.market, &t.wallet).0),
            w(equities_address(&id(), &t.market, &t.wallet).0),
        ],
        data,
    }
}

pub fn withdraw(t: &TraderKeys, dest: &Pubkey, percolator_vault: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![TAG_WITHDRAW];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: id(),
        accounts: vec![
            // Both writable: with no position left the keeper deposit goes back to the wallet.
            AccountMeta::new(t.wallet, true),
            w(t.trader),
            w(t.portfolio),
            w(t.market),
            w(t.collateral),
            w(*dest),
            w(*percolator_vault),
            ro(perc::vault_authority(&t.market)),
            ro(spl_token::ID),
            ro(perc::PERCOLATOR_PROGRAM_ID),
            w(stats_address(&id(), &t.market, &t.wallet).0),
            // The fee ledger (see `carry`): what is owed must be paid before a withdrawal.
            ro(ledger_address(&id(), &t.trader).0),
            // The copy address: empty (no copy running), the keeper deposit can go back.
            ro(copy_address(&id(), &t.market, &t.wallet).0),
            w(equities_address(&id(), &t.market, &t.wallet).0),
        ],
        data,
    }
}

pub fn open_book(payer: &Pubkey, vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*payer, true), ro(*vault), w(book_address(&id(), vault).0), ro(system_program::ID)],
        data: vec![TAG_OPEN_BOOK],
    }
}

pub fn request(t: &TraderKeys, vault: &Pubkey, size: i128) -> Instruction {
    request_with(t, vault, size, false)
}

/// A request that may only shrink the position (a close): see `Request::reduce_only`.
pub fn request_close_only(t: &TraderKeys, vault: &Pubkey, size: i128) -> Instruction {
    request_with(t, vault, size, true)
}

fn request_with(t: &TraderKeys, vault: &Pubkey, size: i128, reduce_only: bool) -> Instruction {
    let mut data = vec![TAG_REQUEST];
    data.extend_from_slice(&size.to_le_bytes());
    if reduce_only {
        data.push(1);
    }
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(t.wallet, true),
            w(t.trader),
            ro(*vault),
            w(book_address(&crate::id(), vault).0),
            w(request_address(&crate::id(), vault, &t.owner, false).0),
            ro(t.market),
            ro(t.portfolio),
            ro(system_program::ID),
            ro(tiers_address(&id(), &t.market).0),
        ],
        data,
    }
}

/// Queues the close-out of `t`'s position on a close-only market; `payer` need not be the trader.
pub fn request_close(payer: &Pubkey, t: &TraderKeys, vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(t.trader),
            ro(t.wallet),
            ro(*vault),
            w(book_address(&crate::id(), vault).0),
            w(request_address(&crate::id(), vault, &t.owner, false).0),
            ro(t.market),
            ro(system_program::ID),
            ro(t.portfolio),
            ro(tiers_address(&id(), &t.market).0),
        ],
        data: vec![TAG_REQUEST_CLOSE],
    }
}

/// Posts a reported price for `feed` (signed by the reporter).
pub fn post_price(reporter: &Pubkey, feed: &[u8; 32], price_e6: u64, publish_time: i64, prev_publish_time: i64) -> Instruction {
    let mut data = vec![TAG_POST_PRICE];
    data.extend_from_slice(feed);
    data.extend_from_slice(&price_e6.to_le_bytes());
    data.extend_from_slice(&publish_time.to_le_bytes());
    data.extend_from_slice(&prev_publish_time.to_le_bytes());
    Instruction {
        program_id: crate::id(),
        accounts: vec![AccountMeta::new(*reporter, true), w(percolator_vault::reporter::report_address(feed).0), ro(system_program::ID)],
        data,
    }
}

/// The witness's `PostPrice` for a feed (its own account).
pub fn post_witness_price(witness: &Pubkey, feed: &[u8; 32], price_e6: u64, publish_time: i64, prev_publish_time: i64) -> Instruction {
    let mut ix = post_price(witness, feed, price_e6, publish_time, prev_publish_time);
    ix.accounts[1].pubkey = percolator_vault::reporter::witness_address(feed).0;
    ix
}

/// Queues the settlement of a vault's epoch at the first Pyth price after its target time.
pub fn request_settle(payer: &Pubkey, vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(*vault),
            w(book_address(&crate::id(), vault).0),
            w(request_address(&crate::id(), vault, payer, true).0),
            ro(system_program::ID),
            ro(authority_address(&crate::id()).0),
            ro(percolator_vault::id()),
        ],
        data: vec![TAG_REQUEST_SETTLE],
    }
}

/// Executes a queued settlement (rolls the vault's epoch `epoch` through the router).
pub fn settle(executor: &Pubkey, k: &VaultKeys, request_payer: &Pubkey, epoch: u64, frontier: u64) -> Instruction {
    let mut data = vec![TAG_SETTLE];
    data.extend_from_slice(&frontier.to_le_bytes());
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(*executor, true),
            w(request_address(&crate::id(), &k.vault, request_payer, true).0),
            w(*request_payer),
            w(book_address(&crate::id(), &k.vault).0),
            ro(authority_address(&crate::id()).0),
            w(k.vault),
            w(k.market),
            w(k.portfolio),
            w(k.buffer),
            w(k.percolator_vault),
            ro(k.percolator_vault_authority),
            w(k.share_mint),
            w(k.escrow),
            w(k.epoch_record(epoch)),
            ro(k.delegate),
            ro(PERCOLATOR_PROGRAM_ID),
            ro(k.program),
            ro(spl_token::ID),
            ro(system_program::ID),
        ],
        data,
    }
}

pub fn advance(k: &VaultKeys, pyth: &Pubkey, observation_sequence: u64, authority_epoch: u64) -> Instruction {
    let mut data = vec![TAG_ADVANCE];
    data.extend_from_slice(&observation_sequence.to_le_bytes());
    data.extend_from_slice(&authority_epoch.to_le_bytes());
    Instruction {
        program_id: id(),
        accounts: vec![
            ro(authority_address(&id()).0),
            ro(k.vault),
            w(book_address(&id(), &k.vault).0),
            w(k.market),
            ro(*pyth),
            ro(percolator_vault::id()),
            ro(perc::PERCOLATOR_PROGRAM_ID),
        ],
        data,
    }
}

/// `advance` with a reported price in an X1 build: the witness's account for the feed goes last.
pub fn advance_reported(k: &VaultKeys, feed: &[u8; 32], observation_sequence: u64, authority_epoch: u64) -> Instruction {
    let mut ix = advance(k, &percolator_vault::reporter::report_address(feed).0, observation_sequence, authority_epoch);
    ix.accounts.push(ro(percolator_vault::reporter::witness_address(feed).0));
    ix
}

pub fn fill(executor: &Pubkey, k: &VaultKeys, t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*executor, true),
            w(request_address(&id(), &k.vault, &t.owner, false).0),
            w(t.trader),
            w(t.wallet),
            w(book_address(&id(), &k.vault).0),
            w(k.vault),
            w(k.market),
            w(t.portfolio),
            w(k.portfolio),
            ro(k.delegate),
            ro(authority_address(&id()).0),
            ro(percolator_vault::id()),
            ro(perc::PERCOLATOR_PROGRAM_ID),
            // The vault's holding-fee meter and the trader's fee ledger (see `carry`), the
            // market's leverage-tier record (see `levels`), then last the trader's track record
            // (ignored when the trader has none).
            w(carry_address(&id(), &k.vault).0),
            w(ledger_address(&id(), &t.trader).0),
            ro(tiers_address(&id(), &k.market).0),
            // The wallet's record of values (see `Equities`), then last its track record.
            w(equities_address(&id(), &t.market, &t.wallet).0),
            w(stats_address(&id(), &t.market, &t.wallet).0),
        ],
        data: vec![TAG_FILL],
    }
}

/// `fill` with the vault's price range (`lazy`): the fill may then go through without the
/// asset's other accounts re-valued first, while the range allows it.
pub fn fill_lazy(executor: &Pubkey, k: &VaultKeys, t: &TraderKeys) -> Instruction {
    let mut ix = fill(executor, k, t);
    let at = ix.accounts.len() - 1;
    ix.accounts.insert(at, w(range_address(&id(), &k.vault).0));
    ix
}

/// `advance` with the vault's price range (`lazy`), so that it takes the new mark in.
pub fn with_range(mut ix: Instruction, vault: &Pubkey) -> Instruction {
    ix.accounts.push(w(range_address(&id(), vault).0));
    ix
}

/// Takes a maker's signed quote (`quote::take_quote`); the Ed25519 verification of the quote goes
/// just before it in the transaction.
#[allow(clippy::too_many_arguments)]
pub fn take_quote(k: &VaultKeys, t: &TraderKeys, maker: &Pubkey, maker_portfolio: &Pubkey, maker_delegate: &Pubkey, size: i128, price: u64, expiry: u64, quote_id: u64) -> Instruction {
    let mut data = vec![TAG_TAKE_QUOTE];
    data.extend_from_slice(&size.to_le_bytes());
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&expiry.to_le_bytes());
    data.extend_from_slice(&quote_id.to_le_bytes());
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(t.wallet, true),
            w(t.trader),
            w(t.portfolio),
            ro(k.vault),
            ro(book_address(&id(), &k.vault).0),
            w(k.market),
            w(*maker),
            w(*maker_portfolio),
            ro(*maker_delegate),
            ro(authority_address(&id()).0),
            ro(percolator_vault::id()),
            ro(perc::PERCOLATOR_PROGRAM_ID),
            ro(solana_program::sysvar::instructions::ID),
            w(carry_address(&id(), &k.vault).0),
            w(ledger_address(&id(), &t.trader).0),
            ro(tiers_address(&id(), &k.market).0),
            w(range_address(&id(), &k.vault).0),
            w(equities_address(&id(), &t.market, &t.wallet).0),
            w(stats_address(&id(), &t.market, &t.wallet).0),
        ],
        data,
    }
}

/// Grows a vault's book made before 2026-11-05 to `MAX_PENDING` requests (anyone may).
pub fn grow_book(payer: &Pubkey, vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*payer, true), w(book_address(&id(), vault).0), ro(system_program::ID)],
        data: vec![TAG_GROW_BOOK],
    }
}

/// Starts a vault's price range account (`lazy`; anyone may, and pays for it).
pub fn open_range(payer: &Pubkey, vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*payer, true), ro(*vault), ro(book_address(&id(), vault).0), w(range_address(&id(), vault).0), ro(system_program::ID)],
        data: vec![TAG_OPEN_RANGE],
    }
}

pub fn expire(caller: &Pubkey, vault: &Pubkey, t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            // Writable, so the router can pay the caller its share of the bond.
            AccountMeta::new(*caller, true),
            w(request_address(&id(), vault, &t.owner, false).0),
            w(t.trader),
            w(t.wallet),
            w(book_address(&id(), vault).0),
        ],
        data: vec![TAG_EXPIRE],
    }
}

/// `expire` for a trader's own request, naming its vault and the Percolator market: a request
/// whose market was more than `BEHIND_REFUND_SLOTS` behind gets its deposit back.
pub fn expire_trade(caller: &Pubkey, vault: &Pubkey, market: &Pubkey, t: &TraderKeys) -> Instruction {
    let mut ix = expire(caller, vault, t);
    ix.accounts.push(ro(*vault));
    ix.accounts.push(ro(*market));
    ix
}

/// Records the leverage tier of `vault`'s asset for its market (anyone may; see `SetTier`).
pub fn set_tier(payer: &Pubkey, vault: &Pubkey, market: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(tiers_address(&id(), market).0),
            ro(*vault),
            ro(*market),
            ro(system_program::ID),
        ],
        data: vec![crate::TAG_SET_TIER],
    }
}

/// Sends what expired requests left in a vault's book to the platform's treasury.
pub fn sweep(vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![w(book_address(&id(), vault).0), w(percolator_vault::processor::TREASURY)],
        data: vec![TAG_SWEEP],
    }
}

/// Removes a settlement request `payer` queued (see `expire`); with the vault named, as here, it
/// can go as soon as its epoch has rolled.
pub fn expire_settle(caller: &Pubkey, vault: &Pubkey, payer: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new_readonly(*caller, true),
            w(request_address(&id(), vault, payer, true).0),
            ro(*payer),
            w(*payer),
            w(book_address(&id(), vault).0),
            ro(*vault),
        ],
        data: vec![TAG_EXPIRE],
    }
}

/// What a standing order is (see `state::Order`). `size` is signed for a limit or TWAP order
/// (+ = buy) and the amount to close for a stop, take-profit or trail (0 = the whole position).
#[derive(Clone, Copy, Debug, Default)]
pub struct OrderParams {
    pub index: u8,
    pub kind: u8,
    pub reduce_only: bool,
    pub size: i128,
    pub trigger: u64,
    pub interval: i64,
    pub slices: u32,
    pub expiry: i64,
    /// Lamports for whoever carries the order out (see `KEEPER_FEE`); 0 sends the older form.
    pub keeper_budget: u64,
}

/// The keeper budget that pays for every execution an order can need: once for a stop,
/// take-profit, trail or limit, once a slice for a TWAP (plus one request's rent, which each
/// fill returns to the order). A limit or TWAP order, which can open a position, also carries a
/// keeper deposit, which its first execution moves into a trading account that lacks one.
pub fn keeper_budget(kind: u8, slices: u32, request_rent: u64) -> u64 {
    let n = if kind == crate::state::ORDER_TWAP { slices.max(1) as u64 } else { 1 };
    let opens = kind == crate::state::ORDER_LIMIT || kind == crate::state::ORDER_TWAP;
    n * (crate::BOND_LAMPORTS + crate::KEEPER_FEE) + request_rent + if opens { crate::keeper_deposit(request_rent) } else { 0 }
}

pub fn place_order(t: &TraderKeys, vault: &Pubkey, o: &OrderParams) -> Instruction {
    let mut data = vec![TAG_PLACE_ORDER, o.index, o.kind, o.reduce_only as u8];
    data.extend_from_slice(&o.size.to_le_bytes());
    data.extend_from_slice(&o.trigger.to_le_bytes());
    data.extend_from_slice(&o.interval.to_le_bytes());
    data.extend_from_slice(&o.slices.to_le_bytes());
    data.extend_from_slice(&o.expiry.to_le_bytes());
    if o.keeper_budget > 0 {
        data.extend_from_slice(&o.keeper_budget.to_le_bytes());
    }
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(t.wallet, true),
            ro(t.trader),
            ro(*vault),
            ro(book_address(&id(), vault).0),
            w(order_address(&id(), vault, &t.owner, o.index).0),
            ro(t.market),
            ro(t.portfolio),
            ro(system_program::ID),
        ],
        data,
    }
}

pub fn cancel_order(wallet: &Pubkey, vault: &Pubkey, index: u8) -> Instruction {
    cancel_order_of(&TraderKeys { owner: *wallet, wallet: *wallet, ..TraderKeys::new(Pubkey::default(), *wallet) }, vault, index)
}

/// Cancels an order of `t` (the main account or an isolated one).
pub fn cancel_order_of(t: &TraderKeys, vault: &Pubkey, index: u8) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(t.wallet, true), w(order_address(&id(), vault, &t.owner, index).0)],
        data: vec![TAG_CANCEL_ORDER],
    }
}

/// Carries out a standing order.
pub fn trigger_order(payer: &Pubkey, t: &TraderKeys, vault: &Pubkey, index: u8) -> Instruction {
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(order_address(&crate::id(), vault, &t.owner, index).0),
            w(t.trader),
            w(t.wallet),
            ro(*vault),
            w(book_address(&crate::id(), vault).0),
            w(request_address(&crate::id(), vault, &t.owner, false).0),
            ro(t.market),
            ro(t.portfolio),
            ro(system_program::ID),
            ro(tiers_address(&id(), &t.market).0),
        ],
        data: vec![TAG_TRIGGER_ORDER],
    }
}

/// `fill` for a request that a standing order queued.
pub fn fill_order(executor: &Pubkey, k: &VaultKeys, t: &TraderKeys, index: u8) -> Instruction {
    let mut ix = fill(executor, k, t);
    ix.accounts.insert(13, w(order_address(&id(), &k.vault, &t.owner, index).0));
    ix
}

/// `expire` for a request that a standing order queued.
pub fn expire_order(caller: &Pubkey, vault: &Pubkey, t: &TraderKeys, index: u8) -> Instruction {
    let mut ix = expire(caller, vault, t);
    ix.accounts.push(w(order_address(&id(), vault, &t.owner, index).0));
    ix
}

// ---- track record, profiles, following and copying ----

/// Opens `t`'s track record (anyone may, and pays for it).
pub fn open_stats(payer: &Pubkey, t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(t.trader),
            ro(t.wallet),
            w(stats_address(&id(), &t.market, &t.wallet).0),
            ro(t.market),
            ro(t.portfolio),
            ro(system_program::ID),
            w(equities_address(&id(), &t.market, &t.wallet).0),
        ],
        data: vec![TAG_OPEN_STATS],
    }
}

/// Sets `wallet`'s name and badge. `old_name` is the name it holds now, if any.
pub fn set_profile(wallet: &Pubkey, name: &str, old_name: Option<&str>, badge: u8, color: u8) -> Instruction {
    let mut data = vec![TAG_SET_PROFILE, name.len() as u8];
    let mut padded = [0u8; NAME_MAX];
    padded[..name.len().min(NAME_MAX)].copy_from_slice(&name.as_bytes()[..name.len().min(NAME_MAX)]);
    data.extend_from_slice(&padded);
    data.extend_from_slice(&[badge, color]);
    let rec = |n: &str| name_address(&id(), n.to_ascii_lowercase().as_bytes()).0;
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*wallet, true),
            w(profile_address(&id(), wallet).0),
            w(rec(name)),
            w(rec(old_name.unwrap_or(name))),
            ro(system_program::ID),
            w(percolator_vault::processor::TREASURY),
        ],
        data,
    }
}

pub fn follow(wallet: &Pubkey, leader: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*wallet, true), w(follow_address(&id(), wallet, leader).0), ro(*leader), ro(system_program::ID)],
        data: vec![TAG_FOLLOW],
    }
}

pub fn set_referrer(wallet: &Pubkey, referrer: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*wallet, true), w(referral_address(&id(), wallet).0), ro(*referrer), ro(system_program::ID)],
        data: vec![TAG_SET_REFERRER],
    }
}

pub fn unfollow(wallet: &Pubkey, leader: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*wallet, true), w(follow_address(&id(), wallet, leader).0)],
        data: vec![TAG_UNFOLLOW],
    }
}

/// Starts copying `leader` (or changes the terms): `ratio_bps` of the leader's leverage, at most
/// `max_notional` on one market (0 = no limit).
pub fn set_copy(t: &TraderKeys, leader: &Pubkey, ratio_bps: u32, max_notional: u64) -> Instruction {
    let mut data = vec![TAG_SET_COPY];
    data.extend_from_slice(&ratio_bps.to_le_bytes());
    data.extend_from_slice(&max_notional.to_le_bytes());
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(t.wallet, true),
            w(copy_address(&id(), &t.market, &t.wallet).0),
            // Writable: setting a copy fills in the account's keeper deposit.
            w(t.trader),
            w(*leader),
            ro(trader_address(&id(), &t.market, leader).0),
            ro(system_program::ID),
            w(percolator_vault::processor::TREASURY),
        ],
        data,
    }
}

/// Starts a badge picture of `len` bytes for `wallet` with its first bytes (the fee is paid here).
pub fn set_badge_image(wallet: &Pubkey, len: u16, first: &[u8]) -> Instruction {
    let mut data = vec![TAG_SET_BADGE_IMAGE, BADGE_FORMAT_JPEG];
    data.extend_from_slice(&len.to_le_bytes());
    data.extend_from_slice(first);
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*wallet, true), w(badge_address(&id(), wallet).0), w(percolator_vault::processor::TREASURY), ro(system_program::ID)],
        data,
    }
}

/// The picture's next bytes, starting at `offset`.
pub fn write_badge_image(wallet: &Pubkey, offset: u16, bytes: &[u8]) -> Instruction {
    let mut data = vec![TAG_WRITE_BADGE_IMAGE];
    data.extend_from_slice(&offset.to_le_bytes());
    data.extend_from_slice(bytes);
    Instruction { program_id: id(), accounts: vec![AccountMeta::new_readonly(*wallet, true), w(badge_address(&id(), wallet).0)], data }
}

/// One more day in the leaderboard's featured row for `wallet`.
pub fn feature(wallet: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*wallet, true), w(profile_address(&id(), wallet).0), w(percolator_vault::processor::TREASURY), ro(system_program::ID)],
        data: vec![TAG_FEATURE],
    }
}

pub fn remove_badge_image(wallet: &Pubkey) -> Instruction {
    Instruction { program_id: id(), accounts: vec![AccountMeta::new(*wallet, true), w(badge_address(&id(), wallet).0)], data: vec![TAG_REMOVE_BADGE_IMAGE] }
}

pub fn stop_copy(t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(t.wallet, true), w(copy_address(&id(), &t.market, &t.wallet).0)],
        data: vec![TAG_STOP_COPY],
    }
}

/// Brings follower `t` in line with `leader` on a vault's market (`size` 0 = the whole difference).
pub fn trigger_copy(payer: &Pubkey, t: &TraderKeys, leader: &Pubkey, vault: &Pubkey, size: i128) -> Instruction {
    let l = TraderKeys::new(t.market, *leader);
    let mut data = vec![TAG_TRIGGER_COPY];
    data.extend_from_slice(&size.to_le_bytes());
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(copy_address(&id(), &t.market, &t.wallet).0),
            w(t.trader),
            ro(t.wallet),
            ro(*vault),
            w(book_address(&id(), vault).0),
            w(request_address(&id(), vault, &t.owner, false).0),
            ro(t.market),
            ro(t.portfolio),
            ro(l.trader),
            ro(l.portfolio),
            ro(system_program::ID),
            ro(tiers_address(&id(), &t.market).0),
        ],
        data,
    }
}

/// Turns `t`'s released profit into capital (anyone may send it).
pub fn convert_pnl(t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![ro(t.trader), w(t.market), w(t.portfolio), ro(perc::PERCOLATOR_PROGRAM_ID)],
        data: vec![TAG_CONVERT_PNL],
    }
}

/// An xDEX pool's accounts, read from its pool account (Raydium CP-Swap layout).
#[derive(Clone, Copy, Debug)]
pub struct XdexPool {
    /// The xDEX program the pool belongs to (`swap::XDEX_PROGRAM` for this build's network).
    pub program: Pubkey,
    pub pool: Pubkey,
    pub amm_config: Pubkey,
    pub vault0: Pubkey,
    pub vault1: Pubkey,
    pub mint0: Pubkey,
    pub mint1: Pubkey,
    pub program0: Pubkey,
    pub program1: Pubkey,
    pub observation: Pubkey,
}

impl XdexPool {
    pub fn from_data(program: Pubkey, pool: Pubkey, d: &[u8]) -> Self {
        let k = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
        Self { program, pool, amm_config: k(8), vault0: k(72), vault1: k(104), mint0: k(168), mint1: k(200), program0: k(232), program1: k(264), observation: k(296) }
    }
    /// The pool's signing address for its vaults.
    pub fn authority(&self) -> Pubkey {
        Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], &self.program).0
    }
}

/// Swaps `amount_in` (fee included) of token 0 for token 1 (`zero_for_one`) or the reverse, for
/// at least `min_out` arriving in `output`. `fee_account` is the treasury's account of the input mint.
pub fn swap(wallet: &Pubkey, fee_account: &Pubkey, p: &XdexPool, zero_for_one: bool, input: &Pubkey, output: &Pubkey, amount_in: u64, min_out: u64) -> Instruction {
    let (in_vault, out_vault, in_prog, out_prog, in_mint, out_mint) = if zero_for_one {
        (p.vault0, p.vault1, p.program0, p.program1, p.mint0, p.mint1)
    } else {
        (p.vault1, p.vault0, p.program1, p.program0, p.mint1, p.mint0)
    };
    let mut data = vec![TAG_SWAP];
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*wallet, true),
            w(*fee_account),
            ro(p.program),
            AccountMeta::new(*wallet, true),
            ro(p.authority()),
            ro(p.amm_config),
            w(p.pool),
            w(*input),
            w(*output),
            w(in_vault),
            w(out_vault),
            ro(in_prog),
            ro(out_prog),
            ro(in_mint),
            ro(out_mint),
            w(p.observation),
        ],
        data,
    }
}

// ---- fees owed to the vaults (see `carry`) ----

/// Starts a vault's holding-fee meter (anyone may, and pays for it).
pub fn open_carry(payer: &Pubkey, vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(carry_address(&id(), vault).0),
            ro(*vault),
            w(book_address(&id(), vault).0),
            ro(system_program::ID),
        ],
        data: vec![TAG_OPEN_CARRY],
    }
}

/// Starts `t`'s fee ledger (anyone may, and pays for it).
pub fn open_ledger(payer: &Pubkey, t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*payer, true), w(t.trader), w(ledger_address(&id(), &t.trader).0), ro(system_program::ID)],
        data: vec![TAG_OPEN_LEDGER],
    }
}

/// Pays what `t` owes the vault `k` out of its capital (anyone may; only while it is flat).
pub fn pay_fees(k: &VaultKeys, t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            ro(t.trader),
            w(ledger_address(&id(), &t.trader).0),
            w(t.market),
            w(t.portfolio),
            w(t.collateral),
            w(k.percolator_vault),
            ro(k.percolator_vault_authority),
            ro(k.vault),
            w(k.buffer),
            ro(spl_token::ID),
            ro(perc::PERCOLATOR_PROGRAM_ID),
        ],
        data: vec![TAG_PAY_FEES],
    }
}

/// Brings `t`'s track record up to its value now (anyone may).
pub fn refresh_record(t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            ro(t.trader),
            ro(t.portfolio),
            ro(t.market),
            w(equities_address(&id(), &t.market, &t.wallet).0),
            w(stats_address(&id(), &t.market, &t.wallet).0),
            ro(ledger_address(&id(), &t.trader).0),
        ],
        data: vec![TAG_REFRESH_RECORD],
    }
}

/// Approves `key` to sign `wallet`'s trades on `market` until `expires` (unix), at most
/// `max_notional` (collateral atoms) a trade and `max_trades` trades a day (`session`).
pub fn open_session(wallet: &Pubkey, market: &Pubkey, key: &Pubkey, expires: i64, max_notional: u64, max_trades: u32) -> Instruction {
    let mut data = vec![crate::TAG_OPEN_SESSION];
    data.extend_from_slice(key.as_ref());
    data.extend_from_slice(&expires.to_le_bytes());
    data.extend_from_slice(&max_notional.to_le_bytes());
    data.extend_from_slice(&max_trades.to_le_bytes());
    Instruction {
        program_id: crate::id(),
        accounts: vec![AccountMeta::new(*wallet, true), w(crate::session::session_address(&crate::id(), market, wallet).0), ro(*market), ro(solana_program::system_program::ID)],
        data,
    }
}

/// Ends `wallet`'s trading key on `market`; `signer` is the wallet or the key.
pub fn close_session(signer: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> Instruction {
    Instruction {
        program_id: crate::id(),
        accounts: vec![AccountMeta::new(*signer, true), w(crate::session::session_address(&crate::id(), market, wallet).0), w(*wallet)],
        data: vec![crate::TAG_CLOSE_SESSION],
    }
}

/// `ix` (a `Request` or `TakeQuote` of `wallet`'s) signed by its trading `key` instead: the key
/// takes the wallet's place first, and the session account goes last.
pub fn by_key(mut ix: Instruction, key: &Pubkey, market: &Pubkey, wallet: &Pubkey) -> Instruction {
    ix.accounts[0] = AccountMeta::new(*key, true);
    ix.accounts.push(w(crate::session::session_address(&crate::id(), market, wallet).0));
    ix
}

/// `open_session` with a cap on what the key may open in a day (`max_day_notional`, 0 = none)
/// and the band its quotes must be within (`max_slippage_bps`, 0 = the default).
pub fn open_session_with(wallet: &Pubkey, market: &Pubkey, key: &Pubkey, expires: i64, max_notional: u64, max_trades: u32, max_day_notional: u64, max_slippage_bps: u16) -> Instruction {
    let mut ix = open_session(wallet, market, key, expires, max_notional, max_trades);
    ix.data.extend_from_slice(&max_day_notional.to_le_bytes());
    ix.data.extend_from_slice(&max_slippage_bps.to_le_bytes());
    ix
}

/// Cancels a standing order of `wallet`'s main account, signed by its trading `key`.
pub fn cancel_order_by_key(key: &Pubkey, market: &Pubkey, wallet: &Pubkey, vault: &Pubkey, index: u8) -> Instruction {
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(*key, true),
            w(order_address(&crate::id(), vault, wallet, index).0),
            w(*wallet),
            ro(*vault),
            w(crate::session::session_address(&crate::id(), market, wallet).0),
        ],
        data: vec![crate::TAG_CANCEL_ORDER],
    }
}

/// `trigger_copy` for a leader trading on `leader_market`: its trader account and portfolio are
/// on that market, and `leader_vault` is that market's vault for the same feed as `vault`.
pub fn trigger_copy_across(payer: &Pubkey, t: &TraderKeys, leader: &Pubkey, leader_market: &Pubkey, vault: &Pubkey, leader_vault: &Pubkey, size: i128) -> Instruction {
    let mut ix = trigger_copy(payer, t, leader, vault, size);
    let l = TraderKeys::new(*leader_market, *leader);
    ix.accounts[9] = ro(l.trader);
    ix.accounts[10] = ro(l.portfolio);
    ix.accounts.insert(12, ro(*leader_market));
    ix.accounts.insert(13, ro(*leader_vault));
    ix
}

/// Opens or renews `wallet`'s liquidation shield on `market` (see `shield`): `step` collateral
/// atoms at a time, at most `max_total`, acting within `trigger_bps` of the liquidation floor.
/// The wallet also approves the router's authority as delegate of its token account
/// (`spl_token::instruction::approve`) for up to `max_total`.
pub fn set_shield(wallet: &Pubkey, market: &Pubkey, step: u64, max_total: u64, trigger_bps: u16) -> Instruction {
    let mut data = vec![crate::TAG_SET_SHIELD];
    data.extend_from_slice(&step.to_le_bytes());
    data.extend_from_slice(&max_total.to_le_bytes());
    data.extend_from_slice(&trigger_bps.to_le_bytes());
    Instruction {
        program_id: crate::id(),
        accounts: vec![AccountMeta::new(*wallet, true), w(crate::shield::shield_address(&crate::id(), market, wallet).0), ro(*market), ro(solana_program::system_program::ID)],
        data,
    }
}

/// Ends `wallet`'s shield on `market` (the rent back to the wallet).
pub fn remove_shield(wallet: &Pubkey, market: &Pubkey) -> Instruction {
    Instruction { program_id: crate::id(), accounts: vec![AccountMeta::new(*wallet, true), w(crate::shield::shield_address(&crate::id(), market, wallet).0)], data: vec![crate::TAG_REMOVE_SHIELD] }
}

/// Moves one step of margin into `t` (a main account) from `source` (the wallet's token
/// account), when it is near liquidation; anyone may send it.
pub fn trigger_shield(payer: &Pubkey, t: &TraderKeys, source: &Pubkey, percolator_vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(crate::shield::shield_address(&crate::id(), &t.market, &t.wallet).0),
            ro(t.trader),
            w(*source),
            w(t.collateral),
            w(t.portfolio),
            w(t.market),
            w(*percolator_vault),
            ro(authority_address(&crate::id()).0),
            ro(spl_token::ID),
            ro(perc::PERCOLATOR_PROGRAM_ID),
            w(ledger_address(&crate::id(), &t.trader).0),
            ro(tiers_address(&crate::id(), &t.market).0),
            w(stats_address(&crate::id(), &t.market, &t.wallet).0),
        ],
        data: vec![crate::TAG_TRIGGER_SHIELD],
    }
}

/// Starts `vault`'s liquidation tape (anyone; the payer pays the rent).
pub fn open_liq_tape(payer: &Pubkey, vault: &Pubkey) -> Instruction {
    Instruction {
        program_id: crate::id(),
        accounts: vec![AccountMeta::new(*payer, true), ro(*vault), w(crate::liqtape::tape_address(&crate::id(), vault).0), ro(solana_program::system_program::ID)],
        data: vec![crate::TAG_OPEN_LIQ_TAPE],
    }
}

/// `ix` (a fill, a trigger) with `vault`'s liquidation tape added (writable), just before its last
/// account (a fill's last account is the trader's track record, which it finds there).
pub fn with_tape(mut ix: Instruction, vault: &Pubkey) -> Instruction {
    let at = ix.accounts.len().saturating_sub(1);
    ix.accounts.insert(at, w(crate::liqtape::tape_address(&crate::id(), vault).0));
    ix
}
