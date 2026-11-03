//! Close-only requests and isolated trading accounts.
//!
//! A close-only request may only shrink the position: it is refused when there is nothing on the
//! other side to shrink, cut to the position's size when it lands, and cut again at the fill to
//! what is held then. An isolated account is a second trading account of the same wallet on the
//! same market: its own money, its own margin, its own request and order addresses, and nothing
//! to do with copying or the wallet's track record.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_router::{
    client::{self as rclient, OrderParams},
    state::{self as rstate, Request, ORDER_STOP},
    RouterError,
};
use percolator_vault::percolator as perc;
use solana_sdk::{
    account::Account,
    signature::{Keypair, Signer},
};

const U: i128 = UNIT as i128;

fn code(e: RouterError) -> String {
    format!("custom program error: {:#x}", e as u32)
}
fn expect(r: Result<u64, String>, e: RouterError) {
    let msg = r.expect_err("expected the attempt to fail");
    assert!(msg.contains(&code(e)), "expected {e:?}, got:\n{msg}");
}

/// A listed, funded vault (50 USDC of NAV) on the devnet-like market, rolled live.
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

fn position(w: &World, taker: usize) -> i128 {
    let m = w.env.svm.get_account(&w.env.market).unwrap().data;
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    perc::positions(&m, &d).unwrap().iter().map(|p| p.size).sum()
}

fn close_only(w: &mut World, taker: usize, size: i128) -> Result<u64, String> {
    let t = w.trader(taker);
    let id = w.book().next_id;
    let ix = rclient::request_close_only(&t, &w.vault, size);
    let kp = w.trader_kp(taker);
    w.send(vec![ix], &[&kp])?;
    Ok(id)
}

#[test]
fn a_close_only_request_needs_a_position_on_the_other_side() {
    let mut w = live();
    // Flat: nothing to close.
    expect(close_only(&mut w, 0, -U), RouterError::NotReducing);
    expect(close_only(&mut w, 0, U), RouterError::NotReducing);
    // Long: a close-only buy would grow it.
    w.taker_trade(0, 4 * U).unwrap();
    expect(close_only(&mut w, 0, U), RouterError::NotReducing);
    assert_eq!({ w.book().len }, 0);
    assert_eq!(position(&w, 0), 4 * U);
}

#[test]
fn a_close_only_request_larger_than_the_position_is_cut_to_it_and_ends_flat() {
    let mut w = live();
    w.taker_trade(0, 4 * U).unwrap();
    let id = close_only(&mut w, 0, -10 * U).unwrap();
    let (_, r) = w.request_account(id);
    assert_eq!({ r.size }, -4 * U, "cut to the position when it lands");
    assert_eq!(r.reduce_only, 1);
    w.execute(0, id).unwrap();
    assert_eq!(position(&w, 0), 0, "closed, not flipped short");
}

#[test]
fn a_close_only_request_is_cut_again_at_the_fill_to_what_is_held_then() {
    let mut w = live();
    w.taker_trade(0, 4 * U).unwrap();
    let id = close_only(&mut w, 0, -4 * U).unwrap();
    // Say the request had been sized from an old view of the account: what the fill sees
    // decides. (Written straight into the request account; nothing in the router can.)
    let (k, mut r) = w.request_account(id);
    r.size = -10 * U;
    let a = w.env.svm.get_account(&k).unwrap();
    w.env.svm.set_account(k, Account { data: bytemuck::bytes_of::<Request>(&r).to_vec(), ..a }).unwrap();
    w.execute(0, id).unwrap();
    assert_eq!(position(&w, 0), 0, "a close never opens the other side");
    // And a plain request still trades through zero, as before.
    w.taker_trade(0, 2 * U).unwrap();
    w.taker_trade(0, -5 * U).unwrap();
    assert_eq!(position(&w, 0), -3 * U);
}

#[test]
fn an_isolated_account_has_its_own_money_margin_and_queue_place() {
    let mut w = live();
    w.trader(0);
    let main = w.traders[&0].1;
    let iso = w.isolated(0, 10, 1, 5_000_000);
    assert_ne!(iso.trader, main.trader);
    assert_ne!(iso.portfolio, main.portfolio);
    assert_eq!(iso.wallet, main.wallet);
    let a = w.env.svm.get_account(&iso.trader).unwrap();
    let t: rstate::TraderState = bytemuck::pod_read_unaligned(&a.data);
    assert_eq!(t.sub, 1);
    // Both accounts can wait in the queue at the same time (their requests have their own
    // addresses), and each fills into its own portfolio.
    let id_main = w.request(0, 20 * U).unwrap();
    let id_iso = w.request(10, -3 * U).unwrap();
    assert_eq!({ w.book().len }, 2);
    w.execute(0, id_main).unwrap();
    // (Queued in the same second: the price that filled the first is the second's too.)
    if w.request_target(id_iso) <= w.book().mark_publish_time {
        w.fill(10, id_iso).unwrap();
    } else {
        w.execute(10, id_iso).unwrap();
    }
    assert_eq!(position(&w, 0), 20 * U);
    assert_eq!(position(&w, 10), -3 * U);
    // The isolated account's margin is its own 5 USDC: the main account's 1,000 do not count.
    expect(w.request(10, -500 * U), RouterError::InsufficientMargin);
    w.request(0, 100 * U).map(|id| w.execute(0, id).unwrap()).unwrap();
}

#[test]
fn an_isolated_account_cannot_be_copied_or_carry_a_track_record() {
    let mut w = live();
    w.trader(0);
    w.trader(1);
    let iso = w.isolated(0, 10, 7, 5_000_000);
    let kp = w.trader_kp(0);
    let payer = w.payer.insecure_clone();
    expect(w.send(vec![rclient::open_stats(&payer.pubkey(), &iso)], &[]), RouterError::Isolated);
    // Copying into it, or from it, is refused; between main accounts it works as before.
    let leader = w.traders[&1].1.wallet;
    expect(w.send(vec![rclient::set_copy(&iso, &leader, 10_000, 0)], &[&kp]), RouterError::Isolated);
    let follower_kp = w.trader_kp(1);
    let follower = w.traders[&1].1;
    let mut from_iso = rclient::set_copy(&follower, &iso.wallet, 10_000, 0);
    from_iso.accounts[4].pubkey = iso.trader;
    expect(w.send(vec![from_iso], &[&follower_kp]), RouterError::Isolated);
}

#[test]
fn an_isolated_accounts_orders_are_its_own() {
    let mut w = live();
    w.taker_trade(0, 10 * U).unwrap();
    let iso = w.isolated(0, 10, 2, 50_000_000);
    w.taker_trade(10, 5 * U).unwrap();
    let kp = w.trader_kp(0);
    let vault = w.vault;
    let main = w.traders[&0].1;
    // A stop at index 0 on each account: two orders, two addresses.
    let stop = OrderParams { kind: ORDER_STOP, trigger: 950_000, ..Default::default() };
    w.send(vec![rclient::place_order(&main, &vault, &stop), rclient::place_order(&iso, &vault, &stop)], &[&kp]).unwrap();
    let main_order = rstate::order_address(&percolator_router::id(), &vault, &main.wallet, 0).0;
    let iso_order = rstate::order_address(&percolator_router::id(), &vault, &iso.trader, 0).0;
    assert_ne!(main_order, iso_order);
    assert!(w.env.svm.get_account(&iso_order).is_some_and(|a| !a.data.is_empty()));
    w.move_price(20, 950_000);
    // The main account's order cannot be carried out on the isolated account.
    let payer = w.payer.pubkey();
    let mut crossed = rclient::trigger_order(&payer, &iso, &vault, 0);
    crossed.accounts[1].pubkey = main_order;
    expect(w.send(vec![crossed], &[]), RouterError::BadAccount);
    // Its own order closes its own position, and only that.
    let id = w.book().next_id;
    w.send(vec![rclient::trigger_order(&payer, &iso, &vault, 0)], &[]).unwrap();
    let target = w.request_target(id);
    let slot = w.env.current_slot() + 1;
    w.env.set_clock(slot, target.max(w.clock_ts()));
    let prev = w.pyth_time;
    w.pyth_time = target;
    let u = w.pyth_update(950_000, target, prev);
    w.advance_to(u).unwrap();
    w.converge();
    let ix = rclient::fill_order(&payer, w.keys.as_ref().unwrap(), &iso, 0);
    w.send(vec![ix], &[]).unwrap();
    assert_eq!(position(&w, 10), 0);
    assert_eq!(position(&w, 0), 10 * U);
    // The isolated account's order is done and gone; cancelling the main one still works.
    assert!(w.env.svm.get_account(&iso_order).is_none_or(|a| a.data.is_empty()));
    w.send(vec![rclient::cancel_order(&main.wallet, &vault, 0)], &[&kp]).unwrap();
}

#[test]
fn a_flat_isolated_account_pays_its_money_back_to_the_wallet() {
    let mut w = live();
    let iso = w.isolated(0, 10, 3, 5_000_000);
    w.taker_trade(10, 2 * U).unwrap();
    w.taker_trade(10, -2 * U).unwrap();
    let kp: Keypair = w.trader_kp(0);
    let dest = w.traders[&0].0.collateral;
    let before = w.tokens(dest);
    let pv = w.env.vault;
    // A flat account's whole capital goes back, once it has paid the vault what it owes.
    let pay = rclient::pay_fees(w.keys.as_ref().unwrap(), &iso);
    w.send(vec![pay], &[]).unwrap();
    let (capital, _, _) = perc::portfolio_exposure(&w.env.svm.get_account(&iso.portfolio).unwrap().data).unwrap();
    w.send(vec![rclient::withdraw(&iso, &dest, &pv, capital as u64)], &[&kp]).unwrap();
    assert_eq!(w.tokens(dest) - before, capital as u64);
}
