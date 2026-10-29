//! Standing orders: stop, take-profit, trailing stop, limit and TWAP. The wallet signs an order
//! once; anyone may carry it out when its condition holds, which only queues an ordinary request.
//! These tests check each kind fires when it should and only then, that an order never does more
//! than it was signed for, and that nothing about it lets anyone pick a price.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_router::{
    client::{self as rclient, OrderParams},
    state::{self as rstate, Order, ORDER_LIMIT, ORDER_STOP, ORDER_TAKE, ORDER_TRAIL, ORDER_TWAP},
    RouterError, BOND_LAMPORTS, GRACE_SECS,
};
use percolator_vault::percolator as perc;
use solana_sdk::signature::{Keypair, Signer};

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
fn order(w: &World, taker: usize, index: u8) -> Option<Order> {
    let k = rstate::order_address(&percolator_router::id(), &w.vault, &w.traders[&taker].1.wallet, index).0;
    w.env.svm.get_account(&k).filter(|a| !a.data.is_empty()).map(|a| bytemuck::pod_read_unaligned(&a.data))
}
fn place(w: &mut World, taker: usize, o: OrderParams) -> Result<u64, String> {
    let t = w.trader(taker);
    let kp = w.trader_kp(taker);
    let vault = w.vault;
    w.send(vec![rclient::place_order(&t, &vault, &o)], &[&kp])
}
/// Anyone (here the harness payer) carries the order out; returns the id of the request it queued.
fn trigger(w: &mut World, taker: usize, index: u8) -> Result<u64, String> {
    let t = w.trader(taker);
    let id = w.book().next_id;
    let ix = rclient::trigger_order(&w.payer.pubkey(), &t, &w.vault, index);
    w.send(vec![ix], &[]).map(|_| id)
}
/// Brings an order's request to its fill at `price`: the first Pyth update at its target.
fn fill_at(w: &mut World, taker: usize, id: u64, index: u8, price: u64) -> Result<u64, String> {
    let target = w.request_target(id);
    let slot = w.env.current_slot() + 1;
    w.env.set_clock(slot, target.max(w.clock_ts()));
    let prev = w.pyth_time;
    w.pyth_time = target;
    w.price = price;
    let u = w.pyth_update(price, target, prev);
    w.advance_to(u)?;
    w.converge();
    let ix = rclient::fill_order(&w.payer.pubkey(), w.keys.as_ref().unwrap(), &w.traders[&taker].1, index);
    w.send(vec![ix], &[])
}
fn stop(trigger: u64) -> OrderParams {
    OrderParams { kind: ORDER_STOP, trigger, ..Default::default() }
}

#[test]
fn a_stop_closes_a_long_once_the_mark_is_at_or_below_it_and_not_before() {
    let mut w = live();
    w.taker_trade(0, 10 * U).unwrap();
    place(&mut w, 0, stop(950_000)).unwrap();
    let o = order(&w, 0, 0).unwrap();
    assert_eq!((o.side, o.reduce_only, { o.trigger }), (1, 1, 950_000));

    // At 1.00 and at 0.96 the condition does not hold: nobody can queue anything.
    expect(trigger(&mut w, 0, 0), RouterError::NotTriggered);
    w.move_price(20, 960_000);
    expect(trigger(&mut w, 0, 0), RouterError::NotTriggered);
    assert_eq!({ w.book().len }, 0);

    // At 0.95 anyone may carry it out. It becomes an ordinary request: it fills at the first
    // price after its target (0.94 here), not at the stop's own price.
    w.move_price(20, 950_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    assert_eq!({ w.book().len }, 1);
    // It is queued once: a second call, and the trader's own cancel, are refused meanwhile.
    expect(trigger(&mut w, 0, 0), RouterError::RequestPending);
    let kp = w.trader_kp(0);
    let cancel = rclient::cancel_order(&kp.pubkey(), &w.vault, 0);
    expect(w.send(vec![cancel], &[&kp]), RouterError::RequestPending);

    fill_at(&mut w, 0, id, 0, 940_000).unwrap();
    assert_eq!(position(&w, 0), 0);
    assert_eq!({ w.vault_state().inventory }, 0);
    assert!(order(&w, 0, 0).is_none(), "a stop that fired is gone");
}

#[test]
fn a_take_profit_closes_part_of_a_short_in_its_favour() {
    let mut w = live();
    w.taker_trade(0, -10 * U).unwrap();
    // Close 4 of the 10 once the price is at or below 0.95 (a short gains as it falls).
    place(&mut w, 0, OrderParams { kind: ORDER_TAKE, trigger: 950_000, size: 4 * U, index: 3, ..Default::default() }).unwrap();
    assert_eq!(order(&w, 0, 3).unwrap().side, -1);
    w.move_price(20, 1_040_000);
    expect(trigger(&mut w, 0, 3), RouterError::NotTriggered); // against it: that would be a stop
    w.move_price(20, 950_000);
    let id = trigger(&mut w, 0, 3).unwrap();
    fill_at(&mut w, 0, id, 3, 950_000).unwrap();
    assert_eq!(position(&w, 0), -6 * U);
    assert!(order(&w, 0, 3).is_none());
}

#[test]
fn a_stop_and_a_take_profit_bracket_one_position_and_the_survivor_is_swept() {
    let mut w = live();
    w.taker_trade(0, 10 * U).unwrap();
    place(&mut w, 0, OrderParams { index: 0, ..stop(950_000) }).unwrap();
    place(&mut w, 0, OrderParams { kind: ORDER_TAKE, trigger: 1_050_000, index: 1, ..Default::default() }).unwrap();
    w.move_price(20, 1_050_000);
    expect(trigger(&mut w, 0, 0), RouterError::NotTriggered);
    let id = trigger(&mut w, 0, 1).unwrap();
    fill_at(&mut w, 0, id, 1, 1_050_000).unwrap();
    assert_eq!(position(&w, 0), 0);
    // The stop protects nothing now. Whoever calls it removes it, and the rent goes to the wallet.
    let wallet = w.traders[&0].1.wallet;
    let before = w.env.svm.get_balance(&wallet).unwrap();
    w.move_price(20, 900_000);
    trigger(&mut w, 0, 0).unwrap();
    assert!(order(&w, 0, 0).is_none());
    assert_eq!({ w.book().len }, 0, "nothing was queued");
    assert!(w.env.svm.get_balance(&wallet).unwrap() > before);
    // And it cannot outlive the position into a new one on the other side.
    assert_eq!(position(&w, 0), 0);
}

#[test]
fn a_protective_order_needs_a_position_and_only_its_wallet_can_cancel_it() {
    let mut w = live();
    w.trader(0);
    expect(place(&mut w, 0, stop(950_000)), RouterError::BadOrder);
    w.taker_trade(0, 5 * U).unwrap();
    expect(place(&mut w, 0, OrderParams { index: 8, ..stop(950_000) }), RouterError::BadOrder);
    expect(place(&mut w, 0, stop(0)), RouterError::BadOrder);
    expect(place(&mut w, 0, OrderParams { kind: 9, trigger: 1, size: 1, ..Default::default() }), RouterError::BadOrder);
    expect(place(&mut w, 0, OrderParams { kind: ORDER_TRAIL, trigger: 5_001, ..Default::default() }), RouterError::BadOrder);
    place(&mut w, 0, stop(950_000)).unwrap();
    expect(place(&mut w, 0, stop(940_000)), RouterError::AlreadyInitialized);

    // A stranger cannot cancel it (the order's address is derived from the owner's wallet, and
    // the owner must sign).
    let stranger = Keypair::new();
    w.env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let owner = w.traders[&0].1.wallet;
    let mut forged = rclient::cancel_order(&owner, &w.vault, 0);
    forged.accounts[0] = solana_sdk::instruction::AccountMeta::new(stranger.pubkey(), true);
    expect(w.send(vec![forged], &[&stranger]), RouterError::BadAccount);

    let kp = w.trader_kp(0);
    let before = w.env.svm.get_balance(&owner).unwrap();
    w.send(vec![rclient::cancel_order(&owner, &w.vault, 0)], &[&kp]).unwrap();
    assert!(order(&w, 0, 0).is_none());
    assert!(w.env.svm.get_balance(&owner).unwrap() > before, "the rent came back");
}

#[test]
fn a_trailing_stop_follows_the_best_mark_and_fires_on_the_way_back() {
    let mut w = live();
    w.taker_trade(0, 10 * U).unwrap();
    place(&mut w, 0, OrderParams { kind: ORDER_TRAIL, trigger: 300, ..Default::default() }).unwrap(); // 3%
    assert_eq!({ order(&w, 0, 0).unwrap().peak }, 1_000_000);
    expect(trigger(&mut w, 0, 0), RouterError::NotTriggered);

    // A better mark is recorded by whoever calls; nothing is queued.
    w.move_price(20, 1_050_000);
    trigger(&mut w, 0, 0).unwrap();
    assert_eq!({ order(&w, 0, 0).unwrap().peak }, 1_050_000);
    assert_eq!({ w.book().len }, 0);

    // 3% back from 1.05 is 1.0185: 1.03 is not there yet, 1.018 is.
    w.move_price(20, 1_030_000);
    expect(trigger(&mut w, 0, 0), RouterError::NotTriggered);
    assert_eq!({ order(&w, 0, 0).unwrap().peak }, 1_050_000, "the recorded best never comes down");
    w.move_price(20, 1_018_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    fill_at(&mut w, 0, id, 0, 1_018_000).unwrap();
    assert_eq!(position(&w, 0), 0);
    assert!(order(&w, 0, 0).is_none());
}

#[test]
fn a_limit_order_never_fills_at_a_price_worse_than_its_limit() {
    let mut w = live();
    w.trader(0);
    place(&mut w, 0, OrderParams { kind: ORDER_LIMIT, trigger: 970_000, size: 5 * U, ..Default::default() }).unwrap();
    expect(trigger(&mut w, 0, 0), RouterError::NotTriggered);

    // The mark touches 0.96: the order is carried out. But the price it would fill at, the first
    // one after its target, is 0.98: it trades nothing and stays, free to be carried out again.
    w.move_price(20, 960_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    fill_at(&mut w, 0, id, 0, 980_000).unwrap();
    assert_eq!(position(&w, 0), 0);
    let o = order(&w, 0, 0).unwrap();
    assert_eq!(({ o.size }, { o.queued_id }), (5 * U, 0));
    expect(trigger(&mut w, 0, 0), RouterError::NotTriggered); // the mark is 0.98 now

    // Next time the price holds: it fills, at 0.965, and is gone.
    w.move_price(20, 965_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    fill_at(&mut w, 0, id, 0, 965_000).unwrap();
    assert_eq!(position(&w, 0), 5 * U);
    assert!(order(&w, 0, 0).is_none());
}

#[test]
fn a_sell_limit_and_a_limit_that_the_margin_cannot_carry() {
    let mut w = live();
    w.trader(0);
    place(&mut w, 0, OrderParams { kind: ORDER_LIMIT, trigger: 1_030_000, size: -5 * U, ..Default::default() }).unwrap();
    w.move_price(20, 1_020_000);
    expect(trigger(&mut w, 0, 0), RouterError::NotTriggered);
    w.move_price(20, 1_030_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    fill_at(&mut w, 0, id, 0, 1_031_000).unwrap();
    assert_eq!(position(&w, 0), -5 * U);

    // Margin is checked when an order is carried out, with the same rule as any request.
    let u = w.new_user(100_000_000);
    let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
    let mint = w.env.mint;
    w.send(vec![rclient::open_account(&t, &mint), rclient::open_ledger(&t.wallet, &t), rclient::deposit(&t, &u.collateral, &w.env.vault, 1_000_000)], &[&u.kp]).unwrap();
    w.traders.insert(5, (u, t));
    place(&mut w, 5, OrderParams { kind: ORDER_LIMIT, trigger: 1_100_000, size: 30 * U, ..Default::default() }).unwrap();
    expect(trigger(&mut w, 5, 0), RouterError::InsufficientMargin);
    assert!(order(&w, 5, 0).is_some());
}

#[test]
fn a_twap_trades_one_slice_per_interval_until_it_is_done() {
    let mut w = live();
    w.trader(0);
    place(&mut w, 0, OrderParams { kind: ORDER_TWAP, size: 6 * U, slices: 3, interval: 60, ..Default::default() }).unwrap();
    expect(place(&mut w, 0, OrderParams { kind: ORDER_TWAP, size: 6 * U, slices: 1, interval: 60, index: 1, ..Default::default() }), RouterError::BadOrder);
    expect(place(&mut w, 0, OrderParams { kind: ORDER_TWAP, size: 6 * U, slices: 3, interval: 5, index: 1, ..Default::default() }), RouterError::BadOrder);
    for n in 1..=3i128 {
        let id = trigger(&mut w, 0, 0).unwrap();
        fill_at(&mut w, 0, id, 0, 1_000_000).unwrap();
        assert_eq!(position(&w, 0), 2 * n * U);
        if n < 3 {
            // The next slice is not due yet.
            expect(trigger(&mut w, 0, 0), RouterError::NotTriggered);
            let due = { order(&w, 0, 0).unwrap().next_time };
            let slot = w.env.current_slot() + 1;
            w.env.set_clock(slot, due);
        }
    }
    assert!(order(&w, 0, 0).is_none(), "done after the third slice");
}

#[test]
fn a_reduce_only_order_never_opens_or_flips_a_position() {
    let mut w = live();
    w.taker_trade(0, 4 * U).unwrap();
    // Sell 10 at 1.02 or better, reduce-only: at most the 4 held.
    place(&mut w, 0, OrderParams { kind: ORDER_LIMIT, trigger: 1_020_000, size: -10 * U, reduce_only: true, ..Default::default() }).unwrap();
    w.move_price(20, 1_020_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    fill_at(&mut w, 0, id, 0, 1_020_000).unwrap();
    assert_eq!(position(&w, 0), 0);
    // What is left of it has nothing to reduce: it is removed, not carried out.
    assert!(order(&w, 0, 0).is_some());
    trigger(&mut w, 0, 0).unwrap();
    assert!(order(&w, 0, 0).is_none());
    assert_eq!({ w.book().len }, 0);
}

#[test]
fn an_orders_request_is_bound_to_its_order() {
    let mut w = live();
    w.taker_trade(0, 10 * U).unwrap();
    place(&mut w, 0, OrderParams { index: 0, ..stop(950_000) }).unwrap();
    place(&mut w, 0, OrderParams { kind: ORDER_TAKE, trigger: 2_000_000, index: 1, ..Default::default() }).unwrap();
    w.move_price(20, 950_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    let target = w.request_target(id);
    let slot = w.env.current_slot() + 1;
    w.env.set_clock(slot, target.max(w.clock_ts()));
    let prev = w.pyth_time;
    w.pyth_time = target;
    let u = w.pyth_update(950_000, target, prev);
    w.advance_to(u).unwrap();
    w.converge();
    // Without the order, or with another order of the same wallet, the fill is refused. (Without
    // it, the account in the order's place is the vault's fee meter: not the order.)
    expect(w.fill(0, id), RouterError::BadAccount);
    let wrong = rclient::fill_order(&w.payer.pubkey(), w.keys.as_ref().unwrap(), &w.traders[&0].1, 1);
    expect(w.send(vec![wrong], &[]), RouterError::BadAccount);
    let right = rclient::fill_order(&w.payer.pubkey(), w.keys.as_ref().unwrap(), &w.traders[&0].1, 0);
    w.send(vec![right], &[]).unwrap();
    assert_eq!(position(&w, 0), 0);
}

#[test]
fn whoever_carries_an_order_out_gets_their_money_back_and_the_trader_gains_nothing() {
    let mut w = live();
    w.taker_trade(0, 10 * U).unwrap();
    place(&mut w, 0, stop(950_000)).unwrap();
    w.move_price(20, 950_000);
    let wallet = w.traders[&0].1.wallet;
    let (payer0, wallet0) = (w.env.svm.get_balance(&w.payer.pubkey()).unwrap(), w.env.svm.get_balance(&wallet).unwrap());
    let id = trigger(&mut w, 0, 0).unwrap();
    let after_trigger = w.env.svm.get_balance(&w.payer.pubkey()).unwrap();
    assert!(payer0 - after_trigger >= BOND_LAMPORTS, "the caller put up the bond and the request's rent");
    fill_at(&mut w, 0, id, 0, 950_000).unwrap();
    // The request's bond and rent both come back to whoever fills it; only fees were spent.
    let spent = payer0 - w.env.svm.get_balance(&w.payer.pubkey()).unwrap();
    assert!(spent < BOND_LAMPORTS / 4, "spent {spent}");
    // The trader got the order's own rent back (they paid it) and nothing of the request's.
    let order_rent = w.env.svm.minimum_balance_for_rent_exemption(rstate::ORDER_LEN);
    assert_eq!(w.env.svm.get_balance(&wallet).unwrap() - wallet0, order_rent);
}

#[test]
fn an_order_whose_request_expired_can_be_carried_out_again() {
    let mut w = live();
    w.taker_trade(0, 10 * U).unwrap();
    place(&mut w, 0, stop(950_000)).unwrap();
    w.move_price(20, 950_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    let target = w.request_target(id);
    let slot = w.env.current_slot() + 1;
    w.env.set_clock(slot, target + GRACE_SECS + 1);
    let t = w.traders[&0].1;
    let payer = w.payer.pubkey();
    // Expiring it needs the order, so the order is never left thinking it is still queued.
    expect(w.send(vec![rclient::expire(&payer, &w.vault, &t)], &[]), RouterError::BadAccount);
    w.send(vec![rclient::expire_order(&payer, &w.vault, &t, 0)], &[]).unwrap();
    assert_eq!({ order(&w, 0, 0).unwrap().queued_id }, 0);
    assert_eq!(position(&w, 0), 10 * U);
    w.move_price(20, 940_000);
    let id = trigger(&mut w, 0, 0).unwrap();
    fill_at(&mut w, 0, id, 0, 940_000).unwrap();
    assert_eq!(position(&w, 0), 0);
}

#[test]
fn an_expired_order_is_removed_instead_of_carried_out() {
    let mut w = live();
    w.trader(0);
    let now = w.clock_ts();
    expect(place(&mut w, 0, OrderParams { kind: ORDER_LIMIT, trigger: 970_000, size: 5 * U, expiry: now, ..Default::default() }), RouterError::BadOrder);
    place(&mut w, 0, OrderParams { kind: ORDER_LIMIT, trigger: 970_000, size: 5 * U, expiry: now + 30, ..Default::default() }).unwrap();
    w.move_price(200, 960_000);
    assert!(w.clock_ts() > now + 30);
    trigger(&mut w, 0, 0).unwrap();
    assert!(order(&w, 0, 0).is_none());
    assert_eq!({ w.book().len }, 0);
    assert_eq!(position(&w, 0), 0);
}
