//! The loss cover (`InitCover`, `CoverLoss`, `WithdrawCover`) and `TopUpMargin`.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_vault::{client, error::VaultError, processor};
use solana_sdk::signature::{Keypair, Signer};

fn code(e: VaultError) -> String {
    format!("custom program error: {:#x}", e as u32)
}

fn expect_err(r: Result<u64, String>, e: VaultError) {
    let msg = r.expect_err("unexpectedly succeeded");
    assert!(msg.contains(&code(e)), "expected {e:?}, got:\n{msg}");
}

/// A funded vault (Alice, 50 units) rolled into epoch 1, with a loss cover holding `cover`.
fn covered(cover: u64) -> (World, User, client::VaultKeys) {
    let mut w = World::new();
    w.env.warp_to_slot(5);
    w.operate();
    let alice = w.new_user(100_000_000);
    w.deposit(&alice, 50_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();
    let k = *w.keys.as_ref().unwrap();
    let payer = w.payer.pubkey();
    let mint = w.env.mint;
    w.send(vec![client::init_cover(&k, &payer, &mint)], &[]).unwrap();
    let tokens = client::cover_tokens_address(&k);
    let have = w.tokens(tokens);
    set_token(&mut w.env.svm, tokens, mint, w.vault, have + cover);
    (w, alice, k)
}

#[test]
fn the_cover_pays_back_a_loss_once_per_roll() {
    let (mut w, _alice, k) = covered(20_000_000);
    let (nav0, supply0) = ({ w.vault_state().last_nav }, w.share_supply());
    // Too early: nothing rolled since the cover was made.
    expect_err(w.send(vec![client::cover_loss(&k)], &[]), VaultError::CoverNotDue);
    // A trader buys from the vault, the price rises 10%: the vault loses.
    w.taker_trade(0, 3 * TEN_M).unwrap();
    w.move_price(5, INITIAL_PRICE * 11 / 10);
    w.settle();
    // An epoch only settles with a request in it.
    let bob = w.new_user(10_000_000);
    w.deposit(&bob, 1_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE * 11 / 10);
    w.settle_open().unwrap();
    let (nav1, supply1) = ({ w.vault_state().last_nav }, w.share_supply());
    let price = |nav: u64, supply: u64| nav as f64 / supply as f64;
    assert!(price(nav1, supply1) < price(nav0, supply0), "the vault lost");
    let buffer = w.tokens(w.buffer);
    w.send(vec![client::cover_loss(&k)], &[]).unwrap();
    let paid = w.tokens(w.buffer) - buffer;
    assert!(paid > 0);
    // Back to the share price it had, within rounding.
    let back = price(nav1 + paid, supply1) / price(nav0, supply0);
    assert!((0.99999..=1.0).contains(&back), "paid {paid}, share price now {back} of before");
    // Not twice for the same roll.
    expect_err(w.send(vec![client::cover_loss(&k)], &[]), VaultError::CoverNotDue);
}

#[test]
fn the_cover_pays_no_more_than_it_holds_and_nothing_on_a_gain() {
    let (mut w, _alice, k) = covered(1_000);
    w.taker_trade(0, 3 * TEN_M).unwrap();
    w.move_price(5, INITIAL_PRICE * 11 / 10);
    w.settle();
    // An epoch only settles with a request in it.
    let bob = w.new_user(10_000_000);
    w.deposit(&bob, 1_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE * 11 / 10);
    w.settle_open().unwrap();
    let buffer = w.tokens(w.buffer);
    w.send(vec![client::cover_loss(&k)], &[]).unwrap();
    assert_eq!(w.tokens(w.buffer) - buffer, 1_000, "all it had");
    assert_eq!(w.tokens(client::cover_tokens_address(&k)), 0);
}

#[test]
fn only_the_treasury_takes_money_out_of_a_cover() {
    let (mut w, alice, k) = covered(5_000_000);
    let thief = Keypair::new();
    w.env.svm.airdrop(&thief.pubkey(), 1_000_000_000).unwrap();
    let ix = client::withdraw_cover(&k, &thief.pubkey(), &alice.collateral, 5_000_000);
    assert!(w.send(vec![ix], &[&thief]).is_err());
    assert_eq!(w.tokens(client::cover_tokens_address(&k)), 5_000_000);
    // A second cover for the same vault cannot be made.
    let payer = w.payer.pubkey();
    let mint = w.env.mint;
    assert!(w.send(vec![client::init_cover(&k, &payer, &mint)], &[]).is_err());
}

#[test]
fn top_up_only_when_the_margin_is_thin() {
    let (mut w, _alice, k) = covered(0);
    // Flat: nothing to margin.
    expect_err(w.send(vec![client::top_up_margin(&k)], &[]), VaultError::MarginNotThin);
    w.taker_trade(0, 3 * TEN_M).unwrap();
    // Open, but most of its value is still in Percolator.
    expect_err(w.send(vec![client::top_up_margin(&k)], &[]), VaultError::MarginNotThin);
    // A large move against the vault: its equity there falls under 40% of its value.
    let mut price = INITIAL_PRICE;
    let nav = { w.vault_state().last_nav } as i128;
    loop {
        price = price * 105 / 100;
        w.move_price(5, price);
        w.settle();
        let lp = w.portfolio_view();
        if (lp.capital as i128 + lp.pnl) * 10_000 < nav * processor::TOPUP_BELOW_BPS as i128 || price > INITIAL_PRICE * 3 {
            break;
        }
    }
    let lp = w.portfolio_view();
    assert!((lp.capital as i128 + lp.pnl) * 10_000 < nav * processor::TOPUP_BELOW_BPS as i128, "the move did not thin the margin");
    let cash = w.tokens(w.buffer) - { w.vault_state().reserved_assets };
    let before = lp.capital;
    w.send(vec![client::top_up_margin(&k)], &[]).unwrap();
    let after = w.portfolio_view().capital;
    assert!(after > before, "capital {before} -> {after}");
    assert_eq!(after - before, cash.min((after - before) as u64) as u128, "no more than the cash");
}
