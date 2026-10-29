//! Fees owed to the vault besides Percolator's trading fee (router `carry`): the holding fee the
//! crowded side owes while the vault is lopsided, the fee on what grows the vault's position, and
//! the fee on liquidations. They are booked in the trader's ledger at each fill, count against
//! the trader's equity, and are paid into the vault before any withdrawal.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_router::{carry, client as rclient, state as rstate, RouterError};
use percolator_vault::percolator as perc;
use solana_sdk::signature::Signer;

const U: i128 = UNIT as i128;
const RID: fn() -> solana_sdk::pubkey::Pubkey = percolator_router::id;

fn expect(r: Result<u64, String>, e: RouterError) {
    let msg = r.expect_err("expected the attempt to fail");
    assert!(msg.contains(&format!("custom program error: {:#x}", e as u32)), "expected {e:?}, got:\n{msg}");
}

/// A vault with 50 USDC on the devnet-like market, rolled live, with its holding-fee meter.
/// (Its limit: 3x its value, 150 units at 1.00, of which ordinary trades use 80%.)
fn live() -> World {
    let mut w = World::with_config(devnet_like_config());
    w.env.set_clock(5, 1_000);
    w.operate();
    let alice = w.new_user(100_000_000);
    w.deposit(&alice, 50_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();
    let ix = rclient::open_carry(&w.payer.pubkey(), &w.vault);
    w.send(vec![ix], &[]).unwrap();
    w
}

fn meter(w: &World) -> rstate::Carry {
    let k = rstate::carry_address(&RID(), &w.vault).0;
    bytemuck::pod_read_unaligned(&w.env.svm.get_account(&k).unwrap().data)
}
/// (asset, owed, meter reading) of each entry in use in the taker's ledger.
fn ledger(w: &World, taker: usize) -> Vec<(u16, u64, u128)> {
    let k = rstate::ledger_address(&RID(), &w.traders[&taker].1.trader).0;
    let d = w.env.svm.get_account(&k).unwrap().data;
    (0..rstate::LEDGER_SLOTS)
        .map(|i| 48 + 32 * i)
        .map(|at| (u16::from_le_bytes(d[at..at + 2].try_into().unwrap()), u64::from_le_bytes(d[at + 8..at + 16].try_into().unwrap()), u128::from_le_bytes(d[at + 16..at + 32].try_into().unwrap())))
        .filter(|e| e.0 != rstate::LEDGER_FREE)
        .collect()
}
fn owed(w: &World, taker: usize) -> u64 {
    ledger(w, taker).iter().map(|e| e.1).sum()
}
fn position(w: &World, taker: usize) -> i128 {
    let m = w.env.svm.get_account(&w.env.market).unwrap().data;
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    perc::positions(&m, &d).unwrap().iter().map(|p| p.size).sum()
}
fn capital(w: &World, taker: usize) -> u128 {
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    perc::portfolio_exposure(&d).unwrap().0
}
/// Trades `size` in steps of 30 units (one fill may add at most 0.75x the vault's value, 37.5
/// units here).
fn trade(w: &mut World, taker: usize, size: i128) {
    let mut left = size;
    while left != 0 {
        let step = left.signum() * left.abs().min(30 * U);
        w.taker_trade(taker, step).unwrap();
        left -= step;
    }
}
/// Lets `secs` pass at the same price.
fn wait(w: &mut World, secs: i64) {
    let slot = w.env.current_slot() + 1;
    let ts = w.clock_ts() + secs;
    w.env.set_clock(slot, ts);
    let p = w.price;
    w.move_price(1, p);
}
/// A trading account opened the way the old page did: no fee ledger.
fn bare_trader(w: &mut World, taker: usize, usdc: u64) -> rclient::TraderKeys {
    let u = w.new_user(100_000_000);
    let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
    let mint = w.env.mint;
    w.send(vec![rclient::open_account(&t, &mint), rclient::deposit(&t, &u.collateral, &w.env.vault, usdc)], &[&u.kp]).unwrap();
    w.traders.insert(taker, (u, t));
    t
}

#[test]
fn without_a_fee_ledger_an_account_can_only_reduce() {
    let mut w = live();
    let t = bare_trader(&mut w, 7, 10_000_000);
    // Its request fills, but trades nothing: an opening would owe fees nobody could book.
    w.taker_trade(7, 10 * U).unwrap();
    assert_eq!(position(&w, 7), 0);
    // With a ledger (anyone may open one, and pays for it) it trades. Opening it twice does
    // nothing (the page and the executor may both send it).
    w.send(vec![rclient::open_ledger(&w.payer.pubkey(), &t)], &[]).unwrap();
    w.tick(1);
    w.send(vec![rclient::open_ledger(&w.payer.pubkey(), &t), rclient::open_carry(&w.payer.pubkey(), &w.vault)], &[]).unwrap();
    w.taker_trade(7, 10 * U).unwrap();
    assert_eq!(position(&w, 7), 10 * U);
    // From then on a fill that leaves out the ledger, or the vault's meter, is refused.
    let id = w.request(7, -5 * U).unwrap();
    let (k, tk) = (*w.keys.as_ref().unwrap(), w.traders[&7].1);
    let full = rclient::fill(&w.payer.pubkey(), &k, &tk);
    for skip in [rstate::ledger_address(&RID(), &tk.trader).0, rstate::carry_address(&RID(), &w.vault).0] {
        let mut ix = full.clone();
        ix.accounts.retain(|a| a.pubkey != skip);
        let target = w.request_target(id);
        let slot = w.env.current_slot() + 1;
        w.env.set_clock(slot, target.max(w.clock_ts()));
        let prev = w.pyth_time;
        w.pyth_time = target;
        let u = w.pyth_update(w.price, target, prev);
        let _ = w.advance_to(u);
        w.converge();
        expect(w.send(vec![ix], &[]), RouterError::BadAccount);
    }
    w.send(vec![full], &[]).unwrap();
    assert_eq!(position(&w, 7), 5 * U);
}

#[test]
fn the_crowded_side_owes_for_the_time_it_holds_and_the_other_side_owes_nothing() {
    let mut w = live();
    // Long about 80 at 1.00 (the vault scales fills down near its limit: 82.5 of 90 asked): the
    // vault is short 82.5 of its 150 (55%), and longs owe (55% - 10%) / 90% of the most, half:
    // 0.005% an hour.
    trade(&mut w, 0, 90 * U);
    let q = position(&w, 0);
    assert_eq!(q, 82_500_000);
    let m = meter(&w);
    let limit = percolator_router::funding::position_limit(&w.vault_state(), w.price);
    assert_eq!(limit, 150 * UNIT);
    assert_eq!({ m.rate_e12 }, carry::target_rate(-q, limit));
    assert_eq!({ m.rate_e12 }, carry::HOLD_MAX_E12 as i64 / 2);
    // The opening grew the vault's position by 82.5: 5 bps of it, 0.041, is owed at once. (The
    // fills of the way up also owed for the seconds between them: next to nothing.)
    let opening = owed(&w, 0);
    assert!((41_250..41_350).contains(&opening), "owed {opening}");
    // A day later, the close settles the day held: 82.5 x 1.00 x 0.005% x 24 = 0.099.
    wait(&mut w, 86_400);
    let snap = ledger(&w, 0)[0].2;
    let rate = { m.rate_e12 } as u128;
    w.taker_trade(0, -30 * U).unwrap();
    let held = carry::owed_between(q, snap, meter(&w).index_long) as u128;
    let day = q as u128 * rate * 86_400 / 1_000_000_000_000; // q units x 1e6 price x rate x secs / 1e18
    assert!(held >= day && held <= day + 100, "a day held owes {held}, expected about {day}");
    assert!((98_000..100_000).contains(&held), "{held}");
    let held = held as u64;
    trade(&mut w, 0, -(q - 30 * U));
    // Closing owes no side fee (it only closes the trader's own position).
    let total = owed(&w, 0);
    assert!(total >= opening + held && total < opening + held + 100, "owed {total}");
    assert_eq!({ meter(&w).rate_e12 }, 0, "the vault is flat again");

    // A short while the vault is long owes; a long that only brings the vault back owes nothing.
    trade(&mut w, 1, -60 * U); // the vault is long 60: 40%, shorts owe
    assert!({ meter(&w).rate_e12 } < 0);
    trade(&mut w, 2, 30 * U); // takes the vault from long 60 to long 30: no side fee
    assert_eq!(owed(&w, 2), 0);
    wait(&mut w, 86_400);
    trade(&mut w, 2, -30 * U);
    trade(&mut w, 1, 60 * U);
    assert_eq!(owed(&w, 2), 0, "the long side owed nothing for its day");
    assert!(owed(&w, 1) > 30_000 + 10_000, "the short owed its side fee and a day held: {}", owed(&w, 1));
}

#[test]
fn what_is_owed_is_paid_into_the_vault_before_anything_is_withdrawn() {
    let mut w = live();
    let t = w.trader(0);
    trade(&mut w, 0, 90 * U);
    wait(&mut w, 86_400);
    let (k, kp, dest) = (*w.keys.as_ref().unwrap(), w.trader_kp(0), w.traders[&0].0.collateral);
    let vault = w.env.vault;
    // Nothing leaves an account with a position (Percolator refuses it): not even the fees.
    assert!(w.send(vec![rclient::pay_fees(&k, &t)], &[]).is_err());
    let q = position(&w, 0);
    trade(&mut w, 0, -q);
    let due = owed(&w, 0);
    assert!(due > 130_000, "owed {due}");
    // Flat: the withdrawal waits for the fees, which anyone may pay in.
    expect(w.send(vec![rclient::withdraw(&t, &dest, &vault, 1_000_000)], &[&kp]), RouterError::FeesOwed);
    let (buffer, cap, nav) = (w.tokens(k.buffer), capital(&w, 0), { w.vault_state().last_nav });
    w.send(vec![rclient::pay_fees(&k, &t)], &[]).unwrap();
    assert_eq!(w.tokens(k.buffer) - buffer, due);
    assert_eq!(cap - capital(&w, 0), due as u128);
    assert!(ledger(&w, 0).is_empty(), "the slot is free again");
    w.send(vec![rclient::withdraw(&t, &dest, &vault, 1_000_000)], &[&kp]).unwrap();
    // The fees are the depositors': the vault is worth that much more at its next roll (it was
    // also paid the traders' losses and fees along the way, so at least that much).
    let p = w.price;
    w.advance(EPOCH_LEN, p);
    w.roll().unwrap();
    let after = { w.vault_state().last_nav };
    assert!(after >= nav + due, "value {nav} -> {after} (fees {due})");
}

#[test]
fn a_liquidation_owes_its_fee_and_a_debt_is_never_more_than_the_account() {
    let mut w = live();
    // 5 USDC on 20 long at 1.00 (25%), then a fall to 0.84 leaves it under the router's level.
    let t = bare_trader(&mut w, 7, 5_000_000);
    w.send(vec![rclient::open_ledger(&w.payer.pubkey(), &t)], &[]).unwrap();
    w.taker_trade(7, 20 * U).unwrap();
    let opening = owed(&w, 7);
    assert_eq!(opening, 10_000, "5 bps of 20");
    w.move_price(20, 840_000);
    w.close_out(7).unwrap();
    let left = position(&w, 7);
    assert!(left > 0 && left < 20 * U, "a partial liquidation, {left} left");
    // 0.5% of what it closed at 0.84, on top of what was owed.
    let closed = (20 * U - left) as u128;
    let fee = carry::fee_on(closed, 840_000, carry::LIQ_FEE_BPS);
    assert!(owed(&w, 7) >= opening + fee, "owed {} (liquidation fee {fee})", owed(&w, 7));

    // A debt is never more than what the account is worth after the fill that adds to it.
    let mut w = live();
    let t = bare_trader(&mut w, 8, 3_000_000);
    w.send(vec![rclient::open_ledger(&w.payer.pubkey(), &t)], &[]).unwrap();
    w.taker_trade(8, 14 * U).unwrap();
    trade(&mut w, 0, 90 * U); // the vault far into its limit: the longs owe
    // A year at that rate would owe far more than the 3 USDC the account holds.
    wait(&mut w, 365 * 86_400);
    w.taker_trade(8, -14 * U).unwrap();
    let d = w.env.svm.get_account(&w.taker_portfolio(8)).unwrap().data;
    let (c, p, _) = perc::portfolio_exposure(&d).unwrap();
    assert!(owed(&w, 8) > 0 && owed(&w, 8) as i128 <= c as i128 + p, "owed {} of {}", owed(&w, 8), c as i128 + p);
}

#[test]
fn a_debt_lowers_what_the_account_can_open() {
    let mut w = live();
    // An account with 5 USDC, long 20 for 90 days while the vault is short about 100 of 150: it
    // owes 20 x 1.00 x about 0.006% x 24 x 90, about 2.5.
    let a = bare_trader(&mut w, 7, 5_000_000);
    w.send(vec![rclient::open_ledger(&w.payer.pubkey(), &a)], &[]).unwrap();
    w.taker_trade(7, 20 * U).unwrap();
    trade(&mut w, 0, 90 * U);
    wait(&mut w, 90 * 86_400);
    let q = position(&w, 0);
    trade(&mut w, 0, -q);
    w.taker_trade(7, -20 * U).unwrap();
    assert!(owed(&w, 7) > 2_000_000, "owed {}", owed(&w, 7));
    // 24 units at 20% (the strictest tier: this market has no tier record) need 4.8 USDC: an
    // account with 5 and no debt opens them, the one that owes (5 less its debt) cannot.
    let fresh = bare_trader(&mut w, 9, 5_000_000);
    w.send(vec![rclient::open_ledger(&w.payer.pubkey(), &fresh)], &[]).unwrap();
    let ask = 24 * U;
    w.taker_trade(9, ask).unwrap();
    assert_eq!(position(&w, 9), ask);
    w.taker_trade(7, ask).unwrap();
    assert_eq!(position(&w, 7), 0, "refused for margin: it owes {}", owed(&w, 7));
}
