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
}

impl TraderKeys {
    pub fn new(market: Pubkey, wallet: Pubkey) -> Self {
        Self {
            wallet,
            market,
            trader: trader_address(&id(), &market, &wallet).0,
            portfolio: portfolio_address(&id(), &market, &wallet).0,
            collateral: collateral_address(&id(), &market, &wallet).0,
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
        ],
        data: vec![TAG_OPEN_ACCOUNT],
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
            AccountMeta::new_readonly(t.wallet, true),
            ro(t.trader),
            w(t.portfolio),
            w(t.market),
            w(t.collateral),
            w(*dest),
            w(*percolator_vault),
            ro(perc::vault_authority(&t.market)),
            ro(spl_token::ID),
            ro(perc::PERCOLATOR_PROGRAM_ID),
            w(stats_address(&id(), &t.market, &t.wallet).0),
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
    let mut data = vec![TAG_REQUEST];
    data.extend_from_slice(&size.to_le_bytes());
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(t.wallet, true),
            w(t.trader),
            ro(*vault),
            w(book_address(&crate::id(), vault).0),
            w(request_address(&crate::id(), vault, &t.wallet, false).0),
            ro(t.market),
            ro(t.portfolio),
            ro(system_program::ID),
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
            w(request_address(&crate::id(), vault, &t.wallet, false).0),
            ro(t.market),
            ro(system_program::ID),
            ro(t.portfolio),
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

pub fn fill(executor: &Pubkey, k: &VaultKeys, t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(*executor, true),
            w(request_address(&id(), &k.vault, &t.wallet, false).0),
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
            // Last: the trader's track record (ignored when the trader has none).
            w(stats_address(&id(), &t.market, &t.wallet).0),
        ],
        data: vec![TAG_FILL],
    }
}

pub fn expire(caller: &Pubkey, vault: &Pubkey, t: &TraderKeys) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new_readonly(*caller, true),
            w(request_address(&id(), vault, &t.wallet, false).0),
            w(t.trader),
            w(t.wallet),
            w(book_address(&id(), vault).0),
        ],
        data: vec![TAG_EXPIRE],
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
}

pub fn place_order(t: &TraderKeys, vault: &Pubkey, o: &OrderParams) -> Instruction {
    let mut data = vec![TAG_PLACE_ORDER, o.index, o.kind, o.reduce_only as u8];
    data.extend_from_slice(&o.size.to_le_bytes());
    data.extend_from_slice(&o.trigger.to_le_bytes());
    data.extend_from_slice(&o.interval.to_le_bytes());
    data.extend_from_slice(&o.slices.to_le_bytes());
    data.extend_from_slice(&o.expiry.to_le_bytes());
    Instruction {
        program_id: id(),
        accounts: vec![
            AccountMeta::new(t.wallet, true),
            ro(t.trader),
            ro(*vault),
            ro(book_address(&id(), vault).0),
            w(order_address(&id(), vault, &t.wallet, o.index).0),
            ro(t.market),
            ro(t.portfolio),
            ro(system_program::ID),
        ],
        data,
    }
}

pub fn cancel_order(wallet: &Pubkey, vault: &Pubkey, index: u8) -> Instruction {
    Instruction {
        program_id: id(),
        accounts: vec![AccountMeta::new(*wallet, true), w(order_address(&id(), vault, wallet, index).0)],
        data: vec![TAG_CANCEL_ORDER],
    }
}

/// Carries out a standing order.
pub fn trigger_order(payer: &Pubkey, t: &TraderKeys, vault: &Pubkey, index: u8) -> Instruction {
    Instruction {
        program_id: crate::id(),
        accounts: vec![
            AccountMeta::new(*payer, true),
            w(order_address(&crate::id(), vault, &t.wallet, index).0),
            w(t.trader),
            w(t.wallet),
            ro(*vault),
            w(book_address(&crate::id(), vault).0),
            w(request_address(&crate::id(), vault, &t.wallet, false).0),
            ro(t.market),
            ro(t.portfolio),
            ro(system_program::ID),
        ],
        data: vec![TAG_TRIGGER_ORDER],
    }
}

/// `fill` for a request that a standing order queued.
pub fn fill_order(executor: &Pubkey, k: &VaultKeys, t: &TraderKeys, index: u8) -> Instruction {
    let mut ix = fill(executor, k, t);
    ix.accounts.insert(13, w(order_address(&id(), &k.vault, &t.wallet, index).0));
    ix
}

/// `expire` for a request that a standing order queued.
pub fn expire_order(caller: &Pubkey, vault: &Pubkey, t: &TraderKeys, index: u8) -> Instruction {
    let mut ix = expire(caller, vault, t);
    ix.accounts.push(w(order_address(&id(), vault, &t.wallet, index).0));
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
            ro(t.trader),
            ro(*leader),
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
            w(request_address(&id(), vault, &t.wallet, false).0),
            ro(t.market),
            ro(t.portfolio),
            ro(l.trader),
            ro(l.portfolio),
            ro(system_program::ID),
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
