//! The X1 build (`--features x1`): there is no Pyth there, so the reporter's posted price is the
//! price source for listing, marks, fills, settlements and liquidations. These tests run the
//! production Percolator binary with the vault and router built for X1.
//!
//!   ./test.sh            builds both sets of programs and runs both sets of tests

#![cfg(feature = "x1")]

mod common;
use common::*;
use percolator_router::{client as rclient, RouterError, GRACE_SLOTS};
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
/// Moves the clock to `ts`, and the slots with it (2.5 a second; at least one).
fn at(w: &mut World, ts: i64) {
    let dt = (ts - w.clock_ts()).max(0) as u64;
    let slot = w.env.current_slot() + (dt * 5 / 2).max(1);
    w.env.set_clock(slot, ts.max(w.clock_ts()));
}
fn now(w: &World) -> i64 {
    w.clock_ts().max(w.pyth_time)
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
    let witness = w.witness();
    w.post_report(&witness, 1_050_000, now, w.pyth_time).unwrap();
    w.advance_to(report).unwrap();
    assert_eq!({ w.book().mark_price }, 1_050_000);
    // The same report cannot be applied twice.
    expect(w.advance_to(report), router_code(RouterError::WrongUpdate));
}

#[test]
fn a_trade_fills_at_the_first_reported_price_after_its_target_and_nothing_else() {
    // Slot time: a request's target is a slot, and it fills at the first price posted in a slot
    // at or after it. The router stamps each post with its slot, so no key picks which one.
    let mut w = live();
    let reporter_kp = w.reporter();
    let witness = w.witness();
    let size = 10 * UNIT as i128;
    w.trader(0);
    let equity0 = equity(&w, 0);
    // (The mark is a minute old: the price band takes the moves below.)
    let t = w.clock_ts();
    at(&mut w, t + 60);
    let landed = w.env.current_slot();
    let id = w.request(0, size).unwrap();
    let target = w.request_target(id);
    // Three slots at dial 1, rounded up to the batch grid.
    let grid = percolator_router::BATCH_SLOTS;
    assert!(target >= landed as i64 + 3 && target < landed as i64 + 3 + grid && target % grid == 0, "target slot {target} for a request in slot {landed}");

    // A price posted before the target can still move the mark, but cannot fill the request.
    w.goto_slot(target as u64 - 1);
    let n = now(&w);
    w.post_report(&witness, 1_100_000, n, n - 1).unwrap();
    let early = w.post_report(&reporter_kp, 1_100_000, n, n - 1).unwrap();
    w.advance_to(early).unwrap();
    w.pyth_time = n;
    expect(w.fill(0, id), router_code(RouterError::NotAtTarget));
    assert_eq!(reporter::posted_slots(&w.env.svm.get_account(&early).unwrap().data).0, target as u64 - 1);

    // The first price posted at or after the target is the fill price, whatever publish time the
    // reporter wrote.
    w.goto_slot(target as u64);
    let n = now(&w);
    w.post_report(&witness, 1_102_000, n, n - 1).unwrap();
    let first = w.post_report(&reporter_kp, 1_102_000, n, n - 1).unwrap();
    w.advance_to(first).unwrap();
    w.price = 1_102_000;
    w.pyth_time = n;
    w.converge();
    w.fill(0, id).unwrap();
    assert_eq!(position(&w, 0), size);
    // Bought at 1.102: no gain from the 1.10 price that was never the trade's price.
    w.move_price(5, 1_102_000);
    assert!(equity(&w, 0) <= equity0, "the trader paid fees and gained nothing: {} -> {}", equity0, equity(&w, 0));
    // The round trip closes at the next reported price.
    w.taker_trade(0, -size).unwrap();
    assert_eq!(position(&w, 0), 0);
    assert_eq!({ w.vault_state().inventory }, 0);
}

#[test]
fn a_later_post_cannot_stand_in_for_the_first_one_after_the_target() {
    let mut w = live();
    let reporter_kp = w.reporter();
    let witness = w.witness();
    w.trader(0);
    let t = w.clock_ts();
    at(&mut w, t + 60);
    let id = w.request(0, UNIT as i128).unwrap();
    let target = w.request_target(id) as u64;
    // Posted at the target, then again a slot later before anyone moved the mark: the second
    // post is not the first one at or after the target, and cannot move the mark past it.
    w.goto_slot(target);
    let n = now(&w);
    w.post_report(&witness, 1_200_000, n, n - 1).unwrap();
    w.post_report(&reporter_kp, 1_200_000, n, n - 1).unwrap();
    w.goto_slot(target + 1);
    let late = w.post_report(&reporter_kp, 1_210_000, n, n - 1).unwrap();
    let (slot, prev) = reporter::posted_slots(&w.env.svm.get_account(&late).unwrap().data);
    assert_eq!((slot, prev), (target + 1, target));
    expect(w.advance_to(late), router_code(RouterError::WrongUpdate));
    // Two posts in one slot: refused.
    expect(w.post_report(&reporter_kp, 1_210_000, n, n - 1).map(|_| 0), router_code(RouterError::WrongUpdate));
}

#[test]
fn the_delay_grows_with_the_risk_dial() {
    // Prices moving fast (here 1% in a few slots) raise the dial, and the delay doubles with each
    // step: a calm market fills in about a second, a fast one waits longer.
    let mut w = live();
    let reporter_kp = w.reporter();
    let witness = w.witness();
    w.trader(0);
    let t = w.clock_ts();
    at(&mut w, t + 60);
    let calm = w.request(0, UNIT as i128).unwrap();
    let landed = w.env.current_slot() as i64;
    assert!(w.request_target(calm) - landed < 3 + percolator_router::BATCH_SLOTS);
    w.execute(0, calm).unwrap();
    // 1% in 3 slots (just inside the price band)...
    let mark_slot = { w.book().mark_publish_time } as u64;
    w.goto_slot(mark_slot + 3);
    let n = now(&w);
    w.post_report(&witness, 1_010_000, n, n - 1).unwrap();
    let r = w.post_report(&reporter_kp, 1_010_000, n, n - 1).unwrap();
    w.advance_to(r).unwrap();
    w.price = 1_010_000;
    w.pyth_time = n;
    w.converge();
    assert_eq!(w.book().price_dial, 4);
    // ...so the next request waits 24 slots (3 doubled three times), rounded up to the grid.
    let landed = w.env.current_slot() as i64;
    let fast = w.request(0, -(UNIT as i128)).unwrap();
    let target = w.request_target(fast);
    assert!(target >= landed + 24 && target < landed + 24 + percolator_router::BATCH_SLOTS, "target {target} from slot {landed}");
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
    let u = w.price_at_target(target);
    w.advance_to(u).unwrap();
    w.converge();
    let before = w.env.svm.get_balance(&executor.pubkey()).unwrap();
    let ix = w.fill_ix(0, id, &executor.pubkey());
    w.send(vec![ix], &[&executor]).unwrap();
    assert_eq!(w.env.svm.get_balance(&executor.pubkey()).unwrap() - before, BOND);
    // The rent of the request account goes back to the trader. (Its first request also put the
    // keeper deposit in its trader account, which stays the trader's.)
    let t = w.trader(0);
    let deposit = w.env.svm.get_balance(&t.trader).unwrap() - w.env.svm.minimum_balance_for_rent_exemption(percolator_router::state::TRADER_LEN);
    // (rent of a request + its bond + the liquidation reward, half a bond: the X1 build's values)
    assert_eq!(deposit, w.env.svm.minimum_balance_for_rent_exemption(percolator_router::state::REQUEST_LEN) + BOND + BOND / 2);
    assert!(trader_before - w.env.svm.get_balance(&trader).unwrap() <= BOND + deposit + 20_000);
}

#[test]
fn a_request_nobody_prices_expires() {
    let mut w = live();
    w.trader(0);
    let id = w.request(0, UNIT as i128).unwrap();
    let target = w.request_target(id);
    w.goto_slot((target + GRACE_SLOTS + 1) as u64);
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
    w.send(vec![rclient::open_account(&t, &mint), rclient::open_ledger(&t.wallet, &t), rclient::deposit(&t, &u.collateral, &w.env.vault, 5_000_000)], &[&u.kp]).unwrap();
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
    // At 0.84 the account is below the router's liquidation level (11% on this 10% market):
    // anyone liquidates it, as far as it takes (a quarter, here).
    w.move_price(20, 840_000);
    w.close_out(7).unwrap();
    assert_eq!(position(&w, 7), 15 * UNIT as i128);
    assert_eq!({ w.vault_state().inventory }, -15 * UNIT as i128);
}

#[test]
fn the_reporter_key_is_not_the_test_key_in_a_deployment_build() {
    assert_eq!(reporter::WITNESS, solana_sdk::signer::keypair::keypair_from_seed(&[43; 32]).unwrap().pubkey());
    // This build is the test one (x1 without devnet): its reporter is the fixed test key. A
    // deployment adds `devnet`, which compiles in the operator's reporter key and Percolator id.
    assert_eq!(reporter::REPORTER, solana_sdk::signer::keypair::keypair_from_seed(&[42; 32]).unwrap().pubkey());
    let _ = Pubkey::default();
}

#[test]
fn a_reported_price_needs_the_witness() {
    let mut w = live();
    let reporter_kp = w.reporter();
    let witness = w.witness();
    let start = w.clock_ts().max(w.pyth_time) + 1;
    at(&mut w, start);
    // The witness posts to its own account; a stranger cannot.
    let mallory = Keypair::new();
    w.env.svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    expect(w.post_report(&mallory, 1_010_000, start, start - 1).map(|_| 0), router_code(RouterError::NotReporter));
    let wacc = w.post_report(&witness, 1_010_000, start, start - 1).unwrap();
    assert_eq!(wacc, reporter::witness_address(&FEED).0);
    // Agrees (within 1.5%, a few seconds apart): the mark moves.
    let t1 = start + 4;
    at(&mut w, t1);
    let report = w.post_report(&reporter_kp, 1_020_000, t1, w.pyth_time).unwrap();
    w.pyth_time = t1;
    w.advance_to(report).unwrap();
    assert_eq!({ w.book().mark_price }, 1_020_000);
    // ...but 1% apart is wide (the risk dial, `percolator_router::risk`): opening is held at 4x.
    assert_eq!(w.book().price_dial, 4);
    // A reported price 3% away from the witness's: refused.
    let t2 = t1 + 4;
    at(&mut w, t2);
    let report = w.post_report(&reporter_kp, 1_041_000, t2, t1).unwrap();
    expect(w.advance_to(report), router_code(RouterError::WitnessDisagrees));
    // The witness silent for more than WITNESS_SECS: refused even at its price.
    let t3 = start + reporter::WITNESS_SECS + 5;
    at(&mut w, t3);
    let report = w.post_report(&reporter_kp, 1_010_000, t3, t2).unwrap();
    expect(w.advance_to(report), router_code(RouterError::WitnessDisagrees));
    // Without the witness account at all: refused.
    w.post_report(&witness, 1_010_000, t3, start).unwrap();
    let mut ix = w.advance_ix(&report);
    ix.accounts.pop();
    expect(w.send(vec![ix], &[]), router_code(RouterError::WitnessDisagrees));
    // With it, the same price is accepted.
    w.advance_to(report).unwrap();
    assert_eq!({ w.book().mark_price }, 1_010_000);
    assert_eq!(w.book().price_dial, 1, "the sources agree again");
}

// ---- Lazy settlement (router `lazy`, engine fork `execute_trade_with_fee_cohort_tolerant_not_atomic`) ----

fn crank_one(w: &mut World, portfolio: Pubkey) -> Result<u64, String> {
    let slot = w.env.current_slot();
    let asset = w.asset();
    let payer = w.payer.pubkey();
    let ix = solana_sdk::instruction::Instruction {
        program_id: perc::PERCOLATOR_PROGRAM_ID,
        accounts: vec![
            solana_sdk::instruction::AccountMeta::new(payer, true),
            solana_sdk::instruction::AccountMeta::new(w.env.market, false),
            solana_sdk::instruction::AccountMeta::new(portfolio, false),
        ],
        data: percolator_prog::ix::Instruction::PermissionlessCrank {
            now_slot: slot,
            observations: vec![percolator_prog::ix::CrankObservationHint { asset_index: asset, oracle_accounts: 0 }],
        }
        .encode(),
    };
    w.send(vec![ix], &[])
}

fn stale_accounts(w: &World) -> u64 {
    let m = w.env.svm.get_account(&w.env.market).unwrap().data;
    perc::asset_cohort(&m, w.asset()).unwrap().0
}

/// Posts `price` (reporter and witness) in the next slot and moves the mark to it with the
/// vault's price range, then accrues the asset until Percolator's price is there, re-valuing
/// nobody.
fn lazy_move(w: &mut World, price: u64) {
    let (reporter_kp, witness) = (w.reporter(), w.witness());
    let slot = w.env.current_slot() + 1;
    w.goto_slot(slot);
    let n = now(w);
    w.post_report(&witness, price, n, n - 1).unwrap();
    let report = w.post_report(&reporter_kp, price, n, n - 1).unwrap();
    let ix = rclient::with_range(w.advance_ix(&report), &w.vault);
    w.send(vec![ix], &[]).expect("advance with the range");
    w.price = price;
    w.pyth_time = n;
    let asset = w.asset();
    for _ in 0..20 {
        let eff = w.env.primary_market_state().1.assets[asset as usize].effective_price;
        if eff == price {
            return;
        }
        let s = w.env.current_slot() + 1;
        w.goto_slot(s);
        w.catch_up(asset, s, &[]);
    }
    panic!("the price did not converge");
}

/// A request of `taker` brought to its price lazily: the price at its target with the range,
/// the asset accrued, and only the taker and the vault re-valued.
fn lazy_target(w: &mut World, taker: usize, id: u64) {
    let target = w.request_target(id) as u64;
    let mark_slot = { w.book().mark_publish_time } as u64;
    // (lazy_move posts in the next slot: the one before the target at the latest.)
    w.goto_slot(target.max(mark_slot + 1) - 1);
    let p = w.price;
    lazy_move(w, p);
    let pf = w.traders[&taker].1.portfolio;
    let _ = crank_one(w, pf);
    let lp = w.portfolio;
    let _ = crank_one(w, lp);
}

#[test]
fn a_fill_skips_revaluing_the_other_holders_while_the_price_range_is_narrow() {
    let mut w = live();
    w.trader(0);
    w.trader(1);
    w.taker_trade(1, 5 * UNIT as i128).unwrap();
    w.taker_trade(0, 5 * UNIT as i128).unwrap();
    let payer = w.payer.pubkey();
    w.send(vec![rclient::open_range(&payer, &w.vault)], &[]).unwrap();
    // Everyone is up to date (the trades above re-valued all): the range restarts at the next
    // mark move, which leaves both traders out of date.
    lazy_move(&mut w, 1_003_000);
    assert!(stale_accounts(&w) >= 2, "the move left accounts to re-value: {}", stale_accounts(&w));
    let id = w.request(0, 2 * UNIT as i128).unwrap();
    lazy_target(&mut w, 0, id);
    assert!(stale_accounts(&w) >= 1, "trader 1 is still out of date");
    // The ordinary fill: Percolator refuses to add risk while anyone is out of date.
    let k = w.keys.clone().unwrap();
    let t0 = w.traders[&0].1;
    assert!(w.send(vec![rclient::fill(&payer, &k, &t0)], &[]).is_err());
    // With the range: it fills.
    w.send(vec![rclient::fill_lazy(&payer, &k, &t0)], &[]).expect("lazy fill");
    assert_eq!(position(&w, 0), 7 * UNIT as i128);
    // Trader 1 is re-valued later, at the same prices: the cohort empties and it can trade.
    let t1 = w.traders[&1].1.portfolio;
    crank_one(&mut w, t1).unwrap();
    assert_eq!(stale_accounts(&w), 0);
    w.taker_trade(1, -(5 * UNIT as i128)).unwrap();
    assert_eq!(position(&w, 1), 0);
}

#[test]
fn a_wide_price_range_or_a_missed_mark_means_everyone_is_revalued_first() {
    let mut w = live();
    w.trader(0);
    w.trader(1);
    w.taker_trade(1, 5 * UNIT as i128).unwrap();
    w.taker_trade(0, 5 * UNIT as i128).unwrap();
    let payer = w.payer.pubkey();
    w.send(vec![rclient::open_range(&payer, &w.vault)], &[]).unwrap();
    let k = w.keys.clone().unwrap();
    let t0 = w.traders[&0].1;
    // A move of a quarter of the maintenance margin or more, while someone is out of date.
    let mm = perc::maintenance_margin_bps(&w.env.svm.get_account(&w.env.market).unwrap().data).unwrap();
    let wide = 1_000_000 + 1_000_000 * (mm / lazy_div() + 10) / 10_000;
    // (In steps the price band takes.)
    let mut p = 1_000_000u64;
    while p < wide {
        p = (p + 15_000).min(wide);
        lazy_move(&mut w, p);
        w.goto_slot(w.env.current_slot() + 8);
    }
    let id = w.request(0, UNIT as i128).unwrap();
    lazy_target(&mut w, 0, id);
    assert!(stale_accounts(&w) >= 1);
    assert!(w.send(vec![rclient::fill_lazy(&payer, &k, &t0)], &[]).is_err(), "the range is too wide");
    // Everyone re-valued: the range restarts and the fill goes through.
    let t1 = w.traders[&1].1.portfolio;
    crank_one(&mut w, t1).unwrap();
    w.send(vec![rclient::fill_lazy(&payer, &k, &t0)], &[]).expect("fill once everyone is current");

    // A mark move made without the range spoils it until everyone is current again.
    let (reporter_kp, witness) = (w.reporter(), w.witness());
    let s = w.env.current_slot() + 1;
    w.goto_slot(s);
    let n = now(&w);
    w.post_report(&witness, p + 1_000, n, n - 1).unwrap();
    let report = w.post_report(&reporter_kp, p + 1_000, n, n - 1).unwrap();
    w.advance_to(report).unwrap();
    w.price = p + 1_000;
    w.pyth_time = n;
    let s = w.env.current_slot() + 1;
    w.goto_slot(s);
    let asset = w.asset();
    w.catch_up(asset, s, &[]);
    let id = w.request(0, UNIT as i128).unwrap();
    lazy_target(&mut w, 0, id);
    if stale_accounts(&w) > 0 {
        assert!(w.send(vec![rclient::fill_lazy(&payer, &k, &t0)], &[]).is_err(), "the range missed a mark move");
    }
}

fn lazy_div() -> u64 {
    percolator_router::lazy::RANGE_SHARE_DIV
}

#[test]
fn a_book_and_a_request_from_before_slot_time_keep_working() {
    // The router upgrade to slot time finds marks and targets in unix seconds. An old mark counts
    // as long ago (the next price moves it, within the narrowest band), and an old request does
    // not hold the mark back and expires by the clock.
    let mut w = live();
    // (A real date: the test chain's clock starts at 1,000 seconds, which looks like a slot.)
    let s = w.env.current_slot() + 1;
    w.env.set_clock(s, 1_800_000_000);
    w.trader(0);
    let id = w.request(0, UNIT as i128).unwrap();
    let rk = percolator_router::state::request_address(&percolator_router::id(), &w.vault, &w.traders[&0].1.owner, false).0;
    let bk = percolator_router::state::book_address(&percolator_router::id(), &w.vault).0;
    let unix_target = w.clock_ts() + 4;
    let mut acct = w.env.svm.get_account(&rk).unwrap();
    let mut r: percolator_router::state::Request = bytemuck::pod_read_unaligned(&acct.data);
    r.target_time = unix_target;
    acct.data.copy_from_slice(bytemuck::bytes_of(&r));
    w.env.svm.set_account(rk, acct).unwrap();
    let mut acct = w.env.svm.get_account(&bk).unwrap();
    let mut b: percolator_router::state::Book = bytemuck::pod_read_unaligned(&acct.data);
    let mut targets = b.pending_target;
    targets[0] = unix_target;
    b.pending_target = targets;
    b.mark_publish_time = unix_target - 10;
    b.mark_prev_publish_time = unix_target - 11;
    acct.data.copy_from_slice(bytemuck::bytes_of(&b));
    w.env.svm.set_account(bk, acct).unwrap();
    assert_eq!(w.request_target(id), unix_target);

    // The next price moves the old mark, at a small move...
    let (reporter_kp, witness) = (w.reporter(), w.witness());
    w.goto_slot(w.env.current_slot() + 1);
    let n = now(&w);
    w.post_report(&witness, 1_010_000, n, n - 1).unwrap();
    let report = w.post_report(&reporter_kp, 1_010_000, n, n - 1).unwrap();
    w.advance_to(report).expect("an old mark is moved by the next price");
    assert!({ w.book().mark_publish_time } < percolator_router::LEGACY_TIME, "the mark is in slots now");
    // ...but not a big one (the band counts no time since an old mark).
    w.goto_slot(w.env.current_slot() + 1);
    let n = now(&w);
    let big = 1_010_000 * 103 / 100;
    w.post_report(&witness, big, n, n - 1).unwrap();
    let report = w.post_report(&reporter_kp, big, n, n - 1).unwrap();
    expect(w.advance_to(report), router_code(RouterError::PriceBand));

    // The old request cannot fill at a slot-time mark, and expires by the clock.
    expect(w.fill(0, id), router_code(RouterError::NotAtTarget));
    let (t, kp) = (w.traders[&0].1, w.trader_kp(0));
    expect(w.send(vec![rclient::expire(&kp.pubkey(), &w.vault, &t)], &[&kp]), router_code(RouterError::TooEarly));
    let ts = unix_target + percolator_router::GRACE_SECS + 1;
    at(&mut w, ts);
    w.send(vec![rclient::expire(&kp.pubkey(), &w.vault, &t)], &[&kp]).expect("expires by the clock");
    assert_eq!({ w.book().len }, 0);
}
