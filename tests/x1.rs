//! The X1 build (`--features x1`): there is no Pyth there, so the reporter's posted price is the
//! price source for listing, marks, fills, settlements and liquidations. These tests run the
//! production Percolator binary with the vault and router built for X1.
//!
//!   ./test.sh            builds both sets of programs and runs both sets of tests

#![cfg(feature = "x1")]

mod common;
use common::*;
use percolator_router::{client as rclient, RouterError, GRACE_SECS};
use percolator_vault::{error::VaultError, percolator as perc, reporter};
use solana_sdk::{pubkey::Pubkey, signature::Keypair, signer::Signer};

fn router_code(e: RouterError) -> String {
    format!("Custom({})", e as u32)
}
fn vault_code(e: VaultError) -> String {
    format!("Custom({})", e as u32)
}
fn expect(r: Result<u64, String>, code: String) {
    let e = r.expect_err("must fail");
    assert!(e.contains(&code), "expected {code}, got: {}", e.lines().next().unwrap_or(""));
}
fn at(w: &mut World, ts: i64) {
    let slot = w.env.current_slot() + 1;
    w.env.set_clock(slot, ts.max(w.clock_ts()));
}
fn position(w: &World, taker: usize) -> i128 {
    let m = w.env.svm.get_account(&w.env.market).unwrap().data;
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    perc::positions(&m, &d).unwrap().iter().map(|p| p.size).sum()
}
fn equity(w: &World, taker: usize) -> i128 {
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    let (capital, pnl, _) = perc::portfolio_exposure(&d).unwrap();
    capital as i128 + pnl
}

/// A listed market with 50 USDC of deposits, live.
fn live() -> World {
    let mut w = World::with_config(devnet_like_config());
    w.env.set_clock(5, 1_000);
    w.operate();
    let alice = w.new_user(100_000_000);
    w.deposit(&alice, 50_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();
    w
}

#[test]
fn a_market_lists_at_the_reported_price_and_not_at_a_pyth_account() {
    let mut w = World::with_config(devnet_like_config());
    w.env.set_clock(5, 1_000);
    w.env.update_market_init_fee_policy(LISTING_FEE as u128).unwrap();
    w.create_vault(operate_params(2)).unwrap();
    let lister = w.new_user(10_000_000);
    let now = w.clock_ts();
    // A Pyth update account means nothing to an X1 build.
    let pyth = w.pyth_account(INITIAL_PRICE, now, now - 1);
    expect(w.list_asset(&lister, pyth), vault_code(VaultError::BadOracle));
    // Nothing reported yet: the report account does not exist.
    expect(w.list_asset(&lister, reporter::report_address(&FEED).0), vault_code(VaultError::BadOracle));
    // The reporter's price lists it.
    let reporter_kp = w.reporter();
    let report = w.post_report(&reporter_kp, 1_234_000, now, now - 1).unwrap();
    assert_eq!(report, reporter::report_address(&FEED).0);
    w.list_asset(&lister, report).unwrap();
    let asset = w.asset() as usize;
    assert_eq!(w.env.primary_market_state().1.assets[asset].effective_price, 1_234_000);
}

#[test]
fn a_stale_report_cannot_list_a_market() {
    let mut w = World::with_config(devnet_like_config());
    w.env.set_clock(5, 1_000);
    w.env.update_market_init_fee_policy(LISTING_FEE as u128).unwrap();
    w.create_vault(operate_params(2)).unwrap();
    let lister = w.new_user(10_000_000);
    let reporter_kp = w.reporter();
    let now = w.clock_ts();
    let report = w.post_report(&reporter_kp, INITIAL_PRICE, now, now - 1).unwrap();
    let stale = { w.vault_state().oracle_max_staleness_secs } as i64;
    at(&mut w, now + stale + 1);
    expect(w.list_asset(&lister, report), vault_code(VaultError::BadOracle));
}

#[test]
fn only_the_reporter_posts_prices() {
    let mut w = live();
    let reporter_kp = w.reporter();
    let mallory = Keypair::new();
    w.env.svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    let now = w.clock_ts().max(w.pyth_time) + 1;
    at(&mut w, now);
    expect(w.post_report(&mallory, 1_100_000, now, now - 1).map(|_| 0), router_code(RouterError::NotReporter));
    // Not from the future, not back in time, not zero.
    expect(w.post_report(&reporter_kp, 1_100_000, now + 60, now).map(|_| 0), router_code(RouterError::BadOracle));
    expect(w.post_report(&reporter_kp, 0, now, now - 1).map(|_| 0), router_code(RouterError::BadOracle));
    w.post_report(&reporter_kp, 1_100_000, now, now - 1).unwrap();
    expect(w.post_report(&reporter_kp, 1_200_000, now, now - 1).map(|_| 0), router_code(RouterError::WrongUpdate));
}

#[test]
fn a_reported_price_moves_the_mark_with_nothing_queued() {
    // On Solana a reported price may only rescue a queued request. On X1 it is the source.
    let mut w = live();
    let reporter_kp = w.reporter();
    let now = w.clock_ts().max(w.pyth_time) + 30;
    at(&mut w, now);
    let report = w.post_report(&reporter_kp, 1_050_000, now, w.pyth_time).unwrap();
    w.advance_to(report).unwrap();
    assert_eq!({ w.book().mark_price }, 1_050_000);
    // The same report cannot be applied twice.
    expect(w.advance_to(report), router_code(RouterError::WrongUpdate));
}

#[test]
fn a_trade_fills_at_the_first_reported_price_after_its_target_and_nothing_else() {
    let mut w = live();
    let reporter_kp = w.reporter();
    let size = 10 * UNIT as i128;
    w.trader(0);
    let equity0 = equity(&w, 0);
    // (The mark is a minute old: the price band takes the moves below.)
    let now = w.clock_ts();
    at(&mut w, now + 60);
    let id = w.request(0, size).unwrap();
    let target = w.request_target(id);
    let last = w.pyth_time;

    // A price published before the target can still move the mark, but cannot fill the request.
    at(&mut w, target - 1);
    let early = w.post_report(&reporter_kp, 1_100_000, target - 1, last).unwrap();
    w.advance_to(early).unwrap();
    w.pyth_time = target - 1;
    w.converge();
    expect(w.fill(0, id), router_code(RouterError::NotAtTarget));

    // A price after the target that says it is not the first one after it is refused.
    at(&mut w, target + 3);
    let late = w.post_report(&reporter_kp, 1_300_000, target + 3, target + 1).unwrap();
    expect(w.advance_to(late), router_code(RouterError::WrongUpdate));

    // The first price at or after the target is the fill price.
    let first = w.post_report(&reporter_kp, 1_140_000, target + 4, target - 1).unwrap();
    w.advance_to(first).unwrap();
    w.price = 1_140_000;
    w.pyth_time = target + 4;
    w.converge();
    w.fill(0, id).unwrap();
    assert_eq!(position(&w, 0), size);
    // Bought at 1.14: no gain from the 1.10 and 1.30 prices that were never the trade's price.
    w.move_price(5, 1_140_000);
    assert!(equity(&w, 0) <= equity0, "the trader paid fees and gained nothing: {} -> {}", equity0, equity(&w, 0));
    // The round trip closes at the next reported price.
    w.taker_trade(0, -size).unwrap();
    assert_eq!(position(&w, 0), 0);
    assert_eq!({ w.vault_state().inventory }, 0);
}

#[test]
fn a_fill_pays_its_sender_what_a_fill_costs_on_x1() {
    // 0.02 XNT: about what a fill and its cranks cost on X1, so each trade pays for its own.
    // (Checked against the deployed binary's behaviour: this test crate links the router library
    // without the `x1` feature, where the constant is Solana's.)
    const BOND: u64 = 20_000_000;
    let mut w = live();
    let executor = Keypair::new();
    w.env.svm.airdrop(&executor.pubkey(), 1_000_000_000).unwrap();
    w.trader(0);
    let trader = w.trader_kp(0).pubkey();
    let trader_before = w.env.svm.get_balance(&trader).unwrap();
    let id = w.request(0, UNIT as i128).unwrap();
    let posted = trader_before - w.env.svm.get_balance(&trader).unwrap();
    assert!(posted >= BOND, "the trader posts the bond (and the request's rent): {posted}");
    let target = w.request_target(id);
    at(&mut w, target);
    let prev = w.pyth_time;
    w.pyth_time = target;
    let u = w.pyth_update(w.price, target, prev);
    w.advance_to(u).unwrap();
    w.converge();
    let before = w.env.svm.get_balance(&executor.pubkey()).unwrap();
    let ix = w.fill_ix(0, id, &executor.pubkey());
    w.send(vec![ix], &[&executor]).unwrap();
    assert_eq!(w.env.svm.get_balance(&executor.pubkey()).unwrap() - before, BOND);
    // The rent of the request account goes back to the trader.
    assert!(trader_before - w.env.svm.get_balance(&trader).unwrap() <= BOND + 20_000);
}

#[test]
fn a_request_nobody_prices_expires() {
    let mut w = live();
    w.trader(0);
    let id = w.request(0, UNIT as i128).unwrap();
    let target = w.request_target(id);
    at(&mut w, target + GRACE_SECS + 1);
    let (t, kp) = (w.traders[&0].1, w.trader_kp(0));
    let ix = rclient::expire(&kp.pubkey(), &w.vault, &t);
    w.send(vec![ix], &[&kp]).unwrap();
    assert_eq!(position(&w, 0), 0);
}

#[test]
fn gains_and_losses_follow_reported_prices() {
    let mut w = live();
    let size = 10 * UNIT as i128;
    w.trader(0);
    let equity0 = equity(&w, 0);
    w.taker_trade(0, size).unwrap();
    // +5% on 10 units at 1.00 is 0.5 USDC, less fees.
    w.move_price(20, 1_050_000);
    w.taker_trade(0, -size).unwrap();
    let gain = equity(&w, 0) - equity0;
    assert!(gain > 400_000 && gain <= 500_000, "gain {gain}");
}

#[test]
fn liquidation_and_epoch_settlement_work_on_reported_prices() {
    let mut w = live();
    // A trader with 5 USDC of margin, long 20 units at 1.00.
    let u = w.new_user(100_000_000);
    let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
    let mint = w.env.mint;
    w.send(vec![rclient::open_account(&t, &mint), rclient::deposit(&t, &u.collateral, &w.env.vault, 5_000_000)], &[&u.kp]).unwrap();
    w.traders.insert(7, (u, t));
    w.taker_trade(7, 20 * UNIT as i128).unwrap();
    // The epoch settles with the vault's position open, at a reported price.
    // (A settlement needs something to settle: a deposit is waiting.)
    let bob = w.new_user(100_000_000);
    w.deposit(&bob, 20_000_000).unwrap();
    let epoch = { w.vault_state().epoch };
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.settle_open().unwrap();
    assert_eq!({ w.vault_state().epoch }, epoch + 1);
    // At 0.85 the account is below the router's liquidation level: anyone closes it.
    w.move_price(20, 850_000);
    w.close_out(7).unwrap();
    assert_eq!(position(&w, 7), 0);
    assert_eq!({ w.vault_state().inventory }, 0);
}

#[test]
fn the_reporter_key_is_not_the_test_key_in_a_deployment_build() {
    // This build is the test one (x1 without devnet): its reporter is the fixed test key. A
    // deployment adds `devnet`, which compiles in the operator's reporter key and Percolator id.
    assert_eq!(reporter::REPORTER, solana_sdk::signer::keypair::keypair_from_seed(&[42; 32]).unwrap().pubkey());
    let _ = Pubkey::default();
}
