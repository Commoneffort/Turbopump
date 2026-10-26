//! The router: every trade against a vault fills at the first Pyth price published at or after
//! a target time fixed when the request landed. These tests try to trade at a known price in
//! every way we could think of and assert each one fails.

// These flows publish Pyth updates; an X1 build has its own tests (x1.rs).
#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_prog::ix::Instruction as ProgIx;
use percolator_router::{client as rclient, state as rstate, RouterError, BATCH_SECS, BOND_LAMPORTS, DELAY_SECS, GRACE_SECS, STALL_SECS};
use percolator_vault::{error::VaultError, percolator as perc, processor};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

fn router_code(e: RouterError) -> String {
    format!("custom program error: {:#x}", e as u32)
}
fn vault_code(e: VaultError) -> String {
    format!("custom program error: {:#x}", e as u32)
}
fn expect(r: Result<u64, String>, code: String) {
    let msg = r.expect_err("expected the attempt to fail");
    assert!(msg.contains(&code), "expected {code}, got:\n{msg}");
}

/// A listed, funded vault (50 USDC of NAV) on the devnet-like market, rolled live.
fn live() -> World {
    live_at(devnet_like_config())
}
fn live_at(config: MarketConfig) -> World {
    let mut w = World::with_config(config);
    w.env.set_clock(5, 1_000);
    w.operate();
    let alice = w.new_user(100_000_000);
    w.deposit(&alice, 50_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();
    w
}

/// Capital + PnL of a taker's router portfolio.
fn equity(w: &World, taker: usize) -> i128 {
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    let (capital, pnl, _) = perc::portfolio_exposure(&d).unwrap();
    capital as i128 + pnl
}

/// Moves the clock to `ts` (one slot later).
fn at(w: &mut World, ts: i64) {
    let slot = w.env.current_slot() + 1;
    w.env.set_clock(slot, ts.max(w.clock_ts()));
}

#[test]
fn a_trade_fills_at_the_first_pyth_price_after_its_target_and_nothing_else() {
    let mut w = live();
    let size = 10 * UNIT as i128;
    w.trader(0);
    let equity0 = equity(&w, 0);

    // (The mark is a minute old: the price band takes the moves below.)
    let now = w.clock_ts();
    at(&mut w, now + 60);
    // The trader "knows" the real price is 1.10 while the mark still says 1.00, and buys.
    let id = w.request(0, size).unwrap();
    let target = w.request_target(id);
    let earliest = w.clock_ts().max(w.book().mark_publish_time) + DELAY_SECS;
    assert!(target >= earliest && target < earliest + BATCH_SECS && target % BATCH_SECS == 0);

    // Before the target: the mark can move forward, but the request cannot fill yet.
    at(&mut w, target - 2);
    let before = w.next_pyth(1.max(target - 2 - w.pyth_time), 1_080_000);
    w.advance_to(before).unwrap();
    w.converge();
    expect(w.fill(0, id), router_code(RouterError::NotAtTarget));

    // An update past the target that is not the first one after it cannot be used: the mark
    // never skips over the price a request fills at.
    at(&mut w, target + 3);
    let late = w.pyth_update(1_200_000, target + 3, target + 1);
    expect(w.advance_to(late), router_code(RouterError::WrongUpdate));

    // The first update at or after the target is the price, and nothing else can move the mark.
    let first = w.pyth_update(1_100_000, target + 1, target - 1);
    w.pyth_time = target + 1;
    w.price = 1_100_000;
    w.advance_to(first).unwrap();
    let newer = w.pyth_update(1_300_000, target + 2, target + 1);
    expect(w.advance_to(newer), router_code(RouterError::WrongUpdate));

    // Whoever fills it, whenever: it fills at 1.10. A stranger executes it and earns the bond.
    w.converge();
    let stranger = Keypair::new();
    w.env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let before_lamports = w.env.svm.get_balance(&stranger.pubkey()).unwrap();
    let ix = w.fill_ix(0, id, &stranger.pubkey());
    w.send(vec![ix], &[&stranger]).unwrap();
    assert_eq!(w.env.svm.get_balance(&stranger.pubkey()).unwrap() - before_lamports, BOND_LAMPORTS);
    assert_eq!({ w.vault_state().inventory }, -size);

    // Close at 1.10: the round trip is flat. Knowing 1.10 before the request earned nothing.
    w.taker_trade(0, -size).unwrap();
    let pnl = equity(&w, 0) - equity0;
    println!("trader equity change after buying on 'knowledge' of 1.10: {pnl}");
    assert!(pnl <= 0, "no profit from knowing the price in advance: {pnl}");
}

#[test]
fn filling_needs_the_effective_price_to_have_reached_the_mark() {
    let mut w = live();
    w.taker_trade(1, 5 * UNIT as i128).unwrap(); // open interest, so the per-slot cap applies
    let id = w.request(0, UNIT as i128).unwrap();
    let target = w.request_target(id);
    at(&mut w, target);
    let prev = w.pyth_time;
    w.pyth_time = target;
    w.price = INITIAL_PRICE * 103 / 100; // +3%: more than one slot of the 49 bps cap
    let u = w.pyth_update(w.price, target, prev);
    w.advance_to(u).unwrap();
    w.tick(1);
    let slot = w.env.current_slot();
    let asset = w.asset();
    w.catch_up(asset, slot, &[]);
    expect(w.fill(0, id), router_code(RouterError::NotConverged));
    w.converge();
    w.fill(0, id).unwrap();
}

#[test]
fn a_request_cannot_be_cancelled_or_withdrawn_from_and_expires_with_its_bond() {
    let mut w = live();
    let t = w.trader(0);
    let kp = w.trader_kp(0);
    let id = w.request(0, UNIT as i128).unwrap();
    let target = w.request_target(id);

    // Margin cannot leave while the request is pending.
    let dest = w.traders[&0].0.collateral;
    let ix = rclient::withdraw(&t, &dest, &w.env.vault, 1);
    expect(w.send(vec![ix], &[&kp]), router_code(RouterError::RequestPending));
    // A second request is refused too.
    expect(w.request(0, UNIT as i128).map(|_| 0), router_code(RouterError::RequestPending));

    // Nobody can expire it early (the trader included).
    let book = rstate::book_address(&percolator_router::id(), &w.vault).0;
    let book_before = w.env.svm.get_balance(&book).unwrap();
    at(&mut w, target + GRACE_SECS);
    let ix = rclient::expire(&kp.pubkey(), &w.vault, &t);
    expect(w.send(vec![ix.clone()], &[&kp]), router_code(RouterError::TooEarly));

    // After the grace period it expires; the bond is forfeited to the book, never to the trader.
    at(&mut w, target + GRACE_SECS + 1);
    w.send(vec![ix], &[&kp]).unwrap();
    assert_eq!(w.env.svm.get_balance(&book).unwrap() - book_before, BOND_LAMPORTS);
    assert_eq!({ w.book().len }, 0);
    // The trader is unlocked, and nothing was filled.
    assert_eq!({ w.vault_state().inventory }, 0);
    let ix = rclient::withdraw(&t, &dest, &w.env.vault, 1);
    w.send(vec![ix], &[&kp]).unwrap();
}

#[test]
fn a_request_needs_margin_for_a_stressed_price_move() {
    let mut w = live();
    let u = w.new_user(100_000_000);
    let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
    let mint = w.env.mint;
    let open = rclient::open_account(&t, &mint);
    let dep = rclient::deposit(&t, &u.collateral, &w.env.vault, 1_000_000); // 1 USDC
    w.send(vec![open, dep], &[&u.kp]).unwrap();
    // 10 units at 1.00 with 10% margin needs 1 USDC, plus the stress buffer: refused.
    let ix = rclient::request(&t, &w.vault, 10 * UNIT as i128);
    expect(w.send(vec![ix], &[&u.kp]), router_code(RouterError::InsufficientMargin));
    let ix = rclient::request(&t, &w.vault, 3 * UNIT as i128);
    w.send(vec![ix], &[&u.kp]).unwrap();
}

#[test]
fn a_trade_that_only_shrinks_a_position_is_not_refused_for_margin() {
    let mut w = live();
    // A trader with 1.5 USDC of margin: enough for 6 units at 1.00 (12.5% each on this market,
    // see `levels`), not for 15.
    let u = w.new_user(100_000_000);
    let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
    let mint = w.env.mint;
    let open = rclient::open_account(&t, &mint);
    let dep = rclient::deposit(&t, &u.collateral, &w.env.vault, 1_500_000);
    w.send(vec![open, dep], &[&u.kp]).unwrap();
    w.traders.insert(7, (u, t));
    let size = 6 * UNIT as i128;
    w.taker_trade(7, size).unwrap();
    // Growing or flipping the position is refused.
    expect(w.request(7, 9 * UNIT as i128), router_code(RouterError::InsufficientMargin));
    expect(w.request(7, -(size + 13 * UNIT as i128)), router_code(RouterError::InsufficientMargin));
    // Reducing and closing are accepted and fill, although the old and the new position
    // together would not pass the check.
    w.taker_trade(7, -size / 3).unwrap();
    w.taker_trade(7, -(size - size / 3)).unwrap();
    let d = w.env.svm.get_account(&w.taker_portfolio(7)).unwrap().data;
    assert!(perc::portfolio_exposure(&d).unwrap().2.iter().all(|(_, q)| *q == 0));
}

#[test]
fn only_the_router_moves_the_mark_or_arms_a_fill() {
    let mut w = live();
    let attacker = Keypair::new();
    w.env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let seq = w.env.primary_control_sequences(w.asset() as usize);
    let mut data = vec![processor::TAG_PUSH_MARK];
    data.extend_from_slice(&2_000_000u64.to_le_bytes());
    data.extend_from_slice(&(seq.oracle_observation + 1).to_le_bytes());
    data.extend_from_slice(&seq.authority_epoch.to_le_bytes());
    let push = Instruction {
        program_id: pid(),
        accounts: vec![
            AccountMeta::new_readonly(attacker.pubkey(), true),
            AccountMeta::new_readonly(w.vault, false),
            AccountMeta::new(w.env.market, false),
            AccountMeta::new_readonly(perc::PERCOLATOR_PROGRAM_ID, false),
        ],
        data,
    };
    expect(w.send(vec![push], &[&attacker]), vault_code(VaultError::NotRouter));
    let mut data = vec![processor::TAG_ARM_FILL];
    data.extend_from_slice(&(5 * UNIT as i128).to_le_bytes());
    let arm = Instruction {
        program_id: pid(),
        accounts: vec![AccountMeta::new_readonly(attacker.pubkey(), true), AccountMeta::new(w.vault, false)],
        data,
    };
    expect(w.send(vec![arm], &[&attacker]), vault_code(VaultError::NotRouter));
    // Nor can anyone push the vault's asset mark directly on Percolator: the vault is its oracle authority.
    assert!(w.env.push_auth_mark(w.asset(), w.env.current_slot(), 2_000_000).is_err());
}

#[test]
fn forged_or_unverified_pyth_updates_are_refused() {
    let mut w = live();
    w.tick(2);
    let ts = w.clock_ts();
    let mut forged = w.pyth_update(2_000_000, ts, ts - 1);
    // Same bytes, but not owned by the Pyth receiver.
    let mut a = w.env.svm.get_account(&forged).unwrap();
    a.owner = Pubkey::new_unique();
    forged = Pubkey::new_unique();
    w.env.svm.set_account(forged, a.clone()).unwrap();
    expect(w.advance_to(forged), router_code(RouterError::BadOracle));
    // Owned by the receiver but only partially verified.
    let partial = Pubkey::new_unique();
    a.owner = percolator_vault::pyth::PYTH_RECEIVER_PROGRAM_ID;
    a.data[40] = 0;
    w.env.svm.set_account(partial, a.clone()).unwrap();
    expect(w.advance_to(partial), router_code(RouterError::BadOracle));
    // Fully verified, but for another feed.
    let other = Pubkey::new_unique();
    a.data[40] = 1;
    a.data[41..73].copy_from_slice(&[9; 32]);
    w.env.svm.set_account(other, a).unwrap();
    expect(w.advance_to(other), router_code(RouterError::BadOracle));
}

#[test]
fn trading_against_the_vault_directly_is_refused() {
    let mut w = live();
    let taker = w.env.actors[0].signer.insecure_clone();
    let pv = w.portfolio_view();
    let asset = w.asset();
    let market_id = w.env.primary_market_state().1.assets[asset as usize].market_id;
    let trade = Instruction {
        program_id: perc::PERCOLATOR_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(taker.pubkey(), true),
            AccountMeta::new(w.env.market, false),
            AccountMeta::new(w.env.actors[0].portfolio, false),
            AccountMeta::new(w.portfolio, false),
            AccountMeta::new_readonly(pid(), false),
            AccountMeta::new(w.vault, false),
            AccountMeta::new_readonly(w.delegate, false),
        ],
        data: ProgIx::TradeCpi {
            account_a_portfolio_id: w.env.primary_portfolio_id(0),
            account_a_position_epoch: w.env.primary_portfolio_position_epoch(0),
            account_b_portfolio_id: pv.portfolio_id,
            account_b_position_epoch: pv.position_epoch,
            account_b_matcher_sequence: pv.sequence,
            asset_index: asset,
            market_id,
            size_q: 5 * UNIT as i128,
            fee_bps: 10_000,
            limit_price: 0,
            backing_fee_cap_bps: 0,
        }
        .encode(),
    };
    expect(w.send(vec![trade], &[&taker]), vault_code(VaultError::NotArmed));
    assert_eq!({ w.vault_state().inventory }, 0);
}

#[test]
fn withdrawals_only_go_to_the_owners_wallet() {
    let mut w = live();
    let t = w.trader(0);
    let kp = w.trader_kp(0);
    // Someone else's token account as destination.
    let thief_dest = Pubkey::new_unique();
    let (mint, thief) = (w.env.mint, Pubkey::new_unique());
    set_token(&mut w.env.svm, thief_dest, mint, thief, 0);
    let ix = rclient::withdraw(&t, &thief_dest, &w.env.vault, 1_000);
    expect(w.send(vec![ix], &[&kp]), router_code(RouterError::BadAccount));
    // Someone else signing for the trader's account.
    let mallory = Keypair::new();
    w.env.svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    let mut forged = rclient::TraderKeys::new(w.env.market, mallory.pubkey());
    forged.trader = t.trader;
    forged.portfolio = t.portfolio;
    forged.collateral = t.collateral;
    let mdest = Pubkey::new_unique();
    set_token(&mut w.env.svm, mdest, mint, mallory.pubkey(), 0);
    let ix = rclient::withdraw(&forged, &mdest, &w.env.vault, 1_000);
    expect(w.send(vec![ix], &[&mallory]), router_code(RouterError::BadAccount));
    // The owner can.
    let dest = w.traders[&0].0.collateral;
    let before = w.tokens(dest);
    let ix = rclient::withdraw(&t, &dest, &w.env.vault, 1_000);
    w.send(vec![ix], &[&kp]).unwrap();
    assert_eq!(w.tokens(dest) - before, 1_000);
}

#[test]
fn a_market_with_a_queued_request_cannot_be_retired() {
    let mut w = World::with_config(devnet_like_config());
    w.env.set_clock(5, 1_000);
    w.operate();
    w.env.update_market_authority_from_admin(4).unwrap();
    let admin = w.env.actors[4].signer.insecure_clone();
    let epoch0 = w.env.primary_control_sequences(0).authority_epoch;
    let ix = percolator_vault::client::accept_governance(&pid(), &admin.pubkey(), &w.env.market, epoch0);
    w.send(vec![ix], &[&admin]).unwrap();
    w.advance(EPOCH_LEN * processor::RETIRE_IDLE_EPOCHS + 1, INITIAL_PRICE);
    let retire = |w: &World| {
        let v = w.vault_state();
        let asset_epoch = w.env.primary_control_sequences(v.asset_index as usize).authority_epoch;
        let market_epoch = w.env.primary_control_sequences(0).authority_epoch;
        percolator_vault::client::retire_market(&w.keys.unwrap(), asset_epoch, market_epoch)
    };
    // Idle (no depositors), but a trader has a request queued on it.
    let id = w.request(0, UNIT as i128).unwrap();
    expect(w.send(vec![retire(&w)], &[]), vault_code(VaultError::NotIdle));
    // Once it has expired, the market can be retired.
    let target = w.request_target(id);
    at(&mut w, target + GRACE_SECS + 1);
    let (t, kp) = (w.traders[&0].1, w.trader_kp(0));
    let ix = rclient::expire(&kp.pubkey(), &w.vault, &t);
    w.send(vec![ix], &[&kp]).unwrap();
    w.send(vec![retire(&w)], &[]).unwrap();
}

/// The frontend and executor read an asset's control sequences at
/// `MARKET_SLOTS_OFF + asset * MARKET_ASSET_SLOT_LEN + ASSET_CONTROL_SEQUENCES_OFF`.
#[test]
fn control_sequence_offsets_match_percolator() {
    let mut w = live();
    w.taker_trade(0, UNIT as i128).unwrap(); // moves the observation sequence past its initial value
    let d = w.env.market_data(false);
    for asset in [0usize, w.asset() as usize] {
        let seq = percolator_prog::state::read_asset_control_sequences(&d, asset).unwrap();
        let base = perc::MARKET_SLOTS_OFF + asset * perc::MARKET_ASSET_SLOT_LEN + percolator_prog::constants::ASSET_CONTROL_SEQUENCES_OFF;
        let rd = |o: usize| u64::from_le_bytes(d[base + o..base + o + 8].try_into().unwrap());
        assert_eq!(rd(0), seq.oracle_observation);
        assert_eq!(rd(16), seq.authority_epoch);
    }
}

/// Where Pyth exists, a reported price is only a fallback: it may serve a queued request that
/// has waited `FALLBACK_SECS` past its target without a Pyth price, as that request's price,
/// and nothing else.
#[test]
fn a_reported_price_only_rescues_a_request_pyth_did_not_serve() {
    use percolator_vault::reporter::FALLBACK_SECS;
    let mut w = live();
    let reporter = w.reporter();
    // Only the reporter posts, and not a price from the future or one that goes back in time.
    let mallory = Keypair::new();
    w.env.svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    let now = w.clock_ts();
    expect(w.post_report(&mallory, 1_100_000, now, now - 1).map(|_| 0), router_code(RouterError::NotReporter));
    expect(w.post_report(&reporter, 1_100_000, now + 60, now).map(|_| 0), router_code(RouterError::BadOracle));
    let report = w.post_report(&reporter, 1_100_000, now, now - 1).unwrap();
    expect(w.post_report(&reporter, 1_200_000, now, now - 1).map(|_| 0), router_code(RouterError::WrongUpdate));
    // With nothing queued it cannot move the mark at all.
    expect(w.advance_to(report), router_code(RouterError::FallbackNotAllowed));

    // A request is queued. Before the fallback delay the reporter cannot serve it...
    w.trader(0);
    let id = w.request(0, 5 * UNIT as i128).unwrap();
    let target = w.request_target(id);
    at(&mut w, target + 1);
    let report = w.post_report(&reporter, 1_020_000, target, target - 1).unwrap();
    expect(w.advance_to(report), router_code(RouterError::FallbackNotAllowed));
    // ...and afterwards only with the first price at or after its target, not a later one.
    at(&mut w, target + FALLBACK_SECS);
    let late = w.post_report(&reporter, 1_050_000, target + 5, target + 4).unwrap();
    expect(w.advance_to(late), router_code(RouterError::FallbackNotAllowed));
    let first = w.post_report(&reporter, 1_020_000, target + 6, target - 1).unwrap();
    w.advance_to(first).unwrap();
    assert_eq!({ w.book().mark_price }, 1_020_000);
    w.price = 1_020_000;
    w.pyth_time = target + 6;
    w.converge();
    w.fill(0, id).unwrap();
    assert_eq!(position(&w, 0), 5 * UNIT as i128);
    // Pyth carries on from there.
    w.taker_trade(0, -5 * UNIT as i128).unwrap();
}

/// A trader with 5 USDC of margin, long 20 units at 1.00, on a market with 10x margin.
fn leveraged_long(w: &mut World) {
    let u = w.new_user(100_000_000);
    let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
    let mint = w.env.mint;
    w.send(vec![rclient::open_account(&t, &mint), rclient::deposit(&t, &u.collateral, &w.env.vault, 5_000_000)], &[&u.kp]).unwrap();
    w.traders.insert(7, (u, t));
    w.taker_trade(7, 20 * UNIT as i128).unwrap();
}

fn asset_state(w: &World) -> percolator::AssetStateV16 {
    w.env.primary_market_state().1.assets[w.asset() as usize]
}

fn position(w: &World, taker: usize) -> i128 {
    let m = w.env.svm.get_account(&w.env.market).unwrap().data;
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    perc::positions(&m, &d).unwrap().iter().map(|p| p.size).sum()
}

#[test]
fn a_trader_below_the_liquidation_level_is_closed_against_the_vault() {
    let mut w = live();
    leveraged_long(&mut w);
    // Healthy (25% of notional), then 11.8% at 0.85: a forced close is refused.
    expect(w.close_out(7), router_code(RouterError::NotCloseOnly));
    w.move_price(20, 850_000);
    expect(w.close_out(7), router_code(RouterError::NotCloseOnly));
    // At 0.84 the account holds 1.8 USDC against 16.8 of notional: 10.7%, below the router's 11%
    // on this market (1% above Percolator's own 10%) and still above that 10%.
    w.move_price(20, 840_000);
    assert_eq!(position(&w, 7), 20 * UNIT as i128, "Percolator has not liquidated it");
    // Anyone queues the liquidation; it closes against the vault at the next price only as much as
    // it takes: what is left (1.8 USDC against 12.6 of notional, 14%) is back above 12.5% to open
    // plus 0.5%, so 3.5 units would do; a liquidation closes at least a quarter, so 5 go.
    w.close_out(7).unwrap();
    assert_eq!(position(&w, 7), 15 * UNIT as i128, "a partial liquidation");
    assert_eq!({ w.vault_state().inventory }, -15 * UNIT as i128, "the vault's side shrank with it");
    expect(w.close_out(7), router_code(RouterError::NotCloseOnly));
    // Nothing was deleveraged, so the market stays open, and the trader keeps what was left.
    let a = asset_state(&w);
    assert_eq!((a.a_long, a.a_short), (percolator::ADL_ONE, percolator::ADL_ONE));
    assert!(equity(&w, 7) > 1_700_000 && equity(&w, 7) <= 1_800_000, "equity {}", equity(&w, 7));
    // A further fall takes it under the level again (at 0.75, 15 units hold 0.45 USDC against
    // 11.25, 4%), and the next liquidation again closes only what it takes: about 4.6 units stay.
    w.move_price(20, 750_000);
    w.close_out(7).unwrap();
    let left = position(&w, 7);
    assert!(left > 4 * UNIT as i128 && left < 5 * UNIT as i128, "left {left}");
    assert_eq!({ w.vault_state().inventory }, -left);
    expect(w.close_out(7), router_code(RouterError::NotCloseOnly));
    w.taker_trade(1, UNIT as i128).unwrap();
}

/// A trader's own request carries a deposit of 0.1% of its size in the chain's coin. It comes
/// back with a fill, and with an expiry whose price never arrived; it is kept when the request
/// expires after its price was the mark (the trader has seen the price by then, and letting
/// the request lapse must not be free).
#[test]
fn a_request_that_lapses_after_its_price_arrived_loses_its_deposit() {
    use percolator_router::{expiry_deposit, EXPIRY_DEPOSIT_BPS, EXPIRY_DEPOSIT_CAP, LAMPORTS_PER_ATOM};
    assert_eq!(expiry_deposit(-(500 * UNIT as i128), 2_000_000), 1_000_000_000 * EXPIRY_DEPOSIT_BPS as u64 / 10_000 * LAMPORTS_PER_ATOM);
    // A large order's deposit stops at the cap (about a dollar of the coin).
    assert_eq!(expiry_deposit(1_000_000 * UNIT as i128, 2_000_000), EXPIRY_DEPOSIT_CAP);
    let mut w = live();
    let t = w.trader(0);
    let kp = w.trader_kp(0);
    let size = 100 * UNIT as i128;
    let rent = w.env.svm.minimum_balance_for_rent_exemption(rstate::REQUEST_LEN);
    let deposit = expiry_deposit(size, 1_000_000);
    assert!(deposit > 0);
    let bal = |w: &World, k: &Pubkey| w.env.svm.get_balance(k).unwrap();

    // Filled: everything but the bond comes back.
    let start = bal(&w, &t.wallet);
    let id = w.request(0, size).unwrap();
    let (rk, _) = w.request_account(id);
    assert_eq!(bal(&w, &rk), rent + BOND_LAMPORTS + deposit);
    let queued = bal(&w, &t.wallet);
    assert!(start - queued >= rent + BOND_LAMPORTS + deposit);
    w.execute(0, id).unwrap();
    assert_eq!(bal(&w, &t.wallet), queued + rent + deposit);

    // Its price never arrives (no oracle, no executor): only the bond is lost.
    let id = w.request(0, size).unwrap();
    let queued = bal(&w, &t.wallet);
    let target = w.request_target(id);
    at(&mut w, target + GRACE_SECS + 1);
    let expire = rclient::expire(&w.payer.pubkey(), &w.vault, &t);
    w.send(vec![expire.clone()], &[]).unwrap();
    assert_eq!(bal(&w, &t.wallet), queued + rent + deposit);

    // Its price is the mark, nobody fills it, and it lapses: the deposit stays in the book.
    w.tick(1);
    let id = w.request(0, size).unwrap();
    let queued = bal(&w, &t.wallet);
    let target = w.request_target(id);
    at(&mut w, target + 1);
    let prev = w.pyth_time;
    w.pyth_time = target + 1;
    let u = w.pyth_update(w.price, target + 1, prev);
    w.advance_to(u).unwrap();
    let book = percolator_router::state::book_address(&percolator_router::id(), &w.vault).0;
    let (book_before, set) = (bal(&w, &book), w.clock_ts());
    at(&mut w, set + STALL_SECS + 1);
    let mut again = expire.clone();
    again.accounts[0] = AccountMeta::new_readonly(kp.pubkey(), true); // the trader itself lets it lapse
    w.send(vec![again], &[&kp]).unwrap();
    assert_eq!(bal(&w, &book) - book_before, BOND_LAMPORTS + deposit);
    assert!(bal(&w, &t.wallet) <= queued + rent, "only the rent came back");

    // What lapsed requests left in the book goes to the treasury, and nowhere else; the book
    // keeps its rent, and a second sweep finds nothing.
    let treasury = percolator_vault::processor::TREASURY;
    let book_rent = w.env.svm.minimum_balance_for_rent_exemption(rstate::BOOK_LEN);
    let spare = bal(&w, &book) - book_rent;
    assert!(spare >= 2 * BOND_LAMPORTS + deposit);
    let mut wrong = rclient::sweep(&w.vault);
    wrong.accounts[1] = AccountMeta::new(kp.pubkey(), false);
    assert!(w.send(vec![wrong], &[]).is_err(), "only the treasury");
    let had = w.env.svm.get_balance(&treasury).unwrap_or(0);
    w.send(vec![rclient::sweep(&w.vault)], &[]).unwrap();
    assert_eq!(w.env.svm.get_balance(&treasury).unwrap_or(0) - had, spare);
    assert_eq!(bal(&w, &book), book_rent);
    w.tick(1);
    assert!(w.send(vec![rclient::sweep(&w.vault)], &[]).is_err());
}

/// The deposit goes back when the request lapsed because the market was behind (an executor
/// down or catching up: nobody could fill it without first paying to bring the market current).
/// The same lapse on a market that was current keeps it, and a wrong vault or market is refused.
#[test]
fn a_request_that_lapses_on_a_market_that_was_behind_gets_its_deposit_back() {
    use percolator_router::{expiry_deposit, BEHIND_REFUND_SLOTS};
    let mut w = live();
    let t = w.trader(0);
    let size = 100 * UNIT as i128;
    let rent = w.env.svm.minimum_balance_for_rent_exemption(rstate::REQUEST_LEN);
    let deposit = expiry_deposit(size, 1_000_000);
    let bal = |w: &World, k: &Pubkey| w.env.svm.get_balance(k).unwrap();
    let market = w.env.market;
    let book = percolator_router::state::book_address(&percolator_router::id(), &w.vault).0;
    // Queues a request and makes its price the mark; returns the wallet's balance after queueing
    // and when the mark was set.
    let queue_at_mark = |w: &mut World| {
        w.tick(1);
        let id = w.request(0, size).unwrap();
        let queued = w.env.svm.get_balance(&t.wallet).unwrap();
        let target = w.request_target(id);
        at(w, target + 1);
        let prev = w.pyth_time;
        w.pyth_time = target + 1;
        let u = w.pyth_update(w.price, target + 1, prev);
        w.advance_to(u).unwrap();
        (queued, w.clock_ts())
    };

    // Current market: the deposit stays, as before, with the new accounts named too.
    let (queued, set) = queue_at_mark(&mut w);
    at(&mut w, set + STALL_SECS + 1);
    let before = bal(&w, &book);
    w.send(vec![rclient::expire_trade(&w.payer.pubkey(), &w.vault, &market, &t)], &[]).unwrap();
    assert_eq!(bal(&w, &book) - before, BOND_LAMPORTS + deposit);
    assert!(bal(&w, &t.wallet) <= queued + rent);

    // The market fell more than BEHIND_REFUND_SLOTS behind before the lapse: the deposit goes back.
    let (queued, set) = queue_at_mark(&mut w);
    let slot = w.env.current_slot() + BEHIND_REFUND_SLOTS + 1;
    w.env.set_clock(slot, set + STALL_SECS + 1);
    let mut wrong = rclient::expire_trade(&w.payer.pubkey(), &w.vault, &market, &t);
    wrong.accounts[6] = AccountMeta::new_readonly(w.payer.pubkey(), false);
    assert!(w.send(vec![wrong], &[]).is_err(), "not the vault's market");
    let before = bal(&w, &book);
    w.send(vec![rclient::expire_trade(&w.payer.pubkey(), &w.vault, &market, &t)], &[]).unwrap();
    assert_eq!(bal(&w, &book) - before, BOND_LAMPORTS, "only the bond is kept");
    assert_eq!(bal(&w, &t.wallet), queued + rent + deposit);
}

/// The router liquidates 1% above Percolator's own maintenance margin at least, and opens 1.5%
/// above that, whatever the asset's tier says: on this market (10% margins) that is 11% and 12.5%.
#[test]
fn the_router_liquidates_above_percolators_own_level() {
    let mut w = live();
    let market = w.env.svm.get_account(&w.env.market).unwrap().data;
    // (Without the tier record a position would open at the strictest tier's 20%.)
    assert_eq!(percolator_router::levels(&market, None, w.asset()).unwrap(), (2_000, 1_100, 1_000));
    leveraged_long(&mut w);
    // 20 long on 5 USDC. At 0.845 the account holds 1.9 against 16.9: 11.2%, and stays.
    w.move_price(20, 845_000);
    expect(w.close_out(7), router_code(RouterError::NotCloseOnly));
    // At 0.84: 1.8 against 16.8 is 10.7%, and it is closed against the vault (a quarter of it).
    w.move_price(20, 840_000);
    w.close_out(7).unwrap();
    assert_eq!(position(&w, 7), 15 * UNIT as i128);
    let a = asset_state(&w);
    assert_eq!((a.a_long, a.a_short), (percolator::ADL_ONE, percolator::ADL_ONE));
}

/// A market created with 5% and 2.5% margins: the default tier opens at 10x and is liquidated
/// below 6%; a major (BTC, ETH) opens at 20x and is liquidated below 3.5%. Without the tier
/// record a position opens at the default tier and is liquidated only at the major level.
#[test]
fn leverage_follows_the_assets_tier() {
    use percolator_router::{levels, tier_of_feed, MAJOR_FEEDS, TIER_DEFAULT, TIER_MAJOR};
    assert_eq!(tier_of_feed(&MAJOR_FEEDS[0]), TIER_MAJOR);
    assert_eq!(tier_of_feed(&MAJOR_FEEDS[1]), TIER_MAJOR);
    assert_eq!(tier_of_feed(&common::FEED), TIER_DEFAULT);
    let mut w = live_at(MarketConfig { maintenance_margin_bps: 250, initial_margin_bps: 500, max_price_move_bps_per_slot: 24, ..devnet_like_config() });
    let asset = w.asset();
    let market = w.env.market;
    let data = w.env.svm.get_account(&market).unwrap().data;
    assert_eq!(levels(&data, None, asset).unwrap(), (2_000, 350, 250), "no record: open as the strictest tier, liquidate as major");

    // SetTier writes the default tier for this vault's feed, with the asset's generation.
    let (tk, _) = rstate::tiers_address(&percolator_router::id(), &market);
    let set = rclient::set_tier(&w.payer.pubkey(), &w.vault, &market);
    w.send(vec![set.clone()], &[]).unwrap();
    let t: rstate::Tiers = bytemuck::pod_read_unaligned(&w.env.svm.get_account(&tk).unwrap().data);
    assert_eq!(t.tier[asset as usize], TIER_DEFAULT);
    assert_eq!(levels(&data, Some(&t), asset).unwrap(), (1_000, 600, 250));
    w.send(vec![set], &[]).unwrap(); // again: harmless

    // 10x on the default tier: 8x passes, 12x is refused (0.5 USDC of margin; the vault holds
    // 50 and takes at most 30 units, so the sizes stay small).
    let trader = |w: &mut World, i: usize, usdc: u64| {
        let u = w.new_user(100_000_000);
        let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
        let mint = w.env.mint;
        w.send(vec![rclient::open_account(&t, &mint), rclient::deposit(&t, &u.collateral, &w.env.vault, usdc)], &[&u.kp]).unwrap();
        w.traders.insert(i, (u, t));
    };
    trader(&mut w, 7, 500_000);
    expect(w.request(7, 6 * UNIT as i128), router_code(RouterError::InsufficientMargin));
    w.taker_trade(7, 4 * UNIT as i128).unwrap();

    // The same asset recorded as a major (as SetTier writes for BTC or ETH): 20x.
    let mut major = t;
    major.tier[asset as usize] = TIER_MAJOR;
    let mut acct = w.env.svm.get_account(&tk).unwrap();
    acct.data = bytemuck::bytes_of(&major).to_vec();
    w.env.svm.set_account(tk, acct).unwrap();
    assert_eq!(levels(&data, Some(&major), asset).unwrap(), (500, 350, 250));
    trader(&mut w, 8, 500_000);
    expect(w.request(8, 11 * UNIT as i128), router_code(RouterError::InsufficientMargin));
    w.taker_trade(8, 9 * UNIT as i128).unwrap();
    assert_eq!(position(&w, 8), 9 * UNIT as i128, "18x");
    // Without the record the 20x account cannot add (it would open at the default tier)...
    let t8 = w.trader(8);
    let kp8 = w.trader_kp(8);
    let mut bare = rclient::request(&t8, &w.vault, UNIT as i128);
    assert_eq!(bare.accounts.pop().unwrap().pubkey, tk, "the builders name the record last");
    expect(w.send(vec![bare], &[&kp8]), router_code(RouterError::InsufficientMargin));
    // ...and is liquidated below 3.5% either way. 9 long on 0.5: at 0.985 it holds 0.365 against
    // 8.87 (4.1%), not yet; at 0.98, 0.32 against 8.82 (3.6%), not yet; at 0.977, 0.293 against
    // 8.79 (3.3%), and it is liquidated: down to what 0.29 covers at 3.5% + 1.5% + 0.5% (about
    // 5.4 units of the 9). (Percolator's own 2.5% is not reached.)
    let close = rclient::request_close(&w.payer.pubkey(), &t8, &w.vault);
    let mut close_bare = close.clone();
    close_bare.accounts.pop();
    w.move_price(20, 985_000);
    expect(w.send(vec![close.clone()], &[]), router_code(RouterError::NotCloseOnly));
    w.move_price(20, 980_000);
    expect(w.send(vec![close.clone()], &[]), router_code(RouterError::NotCloseOnly));
    expect(w.send(vec![close_bare.clone()], &[]), router_code(RouterError::NotCloseOnly));
    w.move_price(20, 977_000);
    w.close_out(8).unwrap();
    let left = position(&w, 8);
    assert!(left > 5 * UNIT as i128 && left < 6 * UNIT as i128, "partly closed against the vault: {left}");
    let a = asset_state(&w);
    assert_eq!((a.a_long, a.a_short), (percolator::ADL_ONE, percolator::ADL_ONE), "before Percolator's own liquidation");
}

/// The mark's circuit breaker: a price further from the mark than a market moves in the time
/// between the two is refused, a real move that large is accepted once that time has passed.
#[test]
fn a_price_too_far_from_the_mark_for_the_time_passed_is_refused() {
    use percolator_router::{within_band, BAND_BASE_BPS, BAND_PER_SEC_BPS};
    assert_eq!((BAND_BASE_BPS, BAND_PER_SEC_BPS), (200, 50));
    assert!(within_band(0, 5, 0), "a book's first mark");
    assert!(within_band(1_000_000, 1_025_000, 1) && !within_band(1_000_000, 1_025_001, 1));
    assert!(within_band(1_000_000, 975_000, 1) && !within_band(1_000_000, 974_999, 1));
    assert!(!within_band(1_000_000, 500_000, 95) && within_band(1_000_000, 500_000, 96));

    let mut w = live();
    w.taker_trade(0, UNIT as i128).unwrap();
    let b = w.book();
    let (t0, p0) = (b.mark_publish_time, b.mark_price);
    at(&mut w, t0 + 10);
    // 30% away one second later: a broken feed, not a market.
    let wild = w.pyth_update(p0 * 13 / 10, t0 + 1, t0);
    expect(w.advance_to(wild), router_code(RouterError::PriceBand));
    assert_eq!({ w.book().mark_price }, p0);
    // 2.5% in that second is the most it takes.
    let edge = w.pyth_update(p0 * 1_025 / 1_000, t0 + 1, t0);
    w.advance_to(edge).unwrap();
    let p1 = { w.book().mark_price };
    // A real crash of 30% is taken a minute later (2% + 60 x 0.5% = 32%).
    at(&mut w, t0 + 70);
    let crash = w.pyth_update(p1 * 7 / 10, t0 + 61, t0 + 1);
    w.advance_to(crash).unwrap();
    assert_eq!({ w.book().mark_price }, p1 * 7 / 10);
}

/// A trader has one place in the queue, so while a request of its own waits nobody can queue its
/// liquidation. An account below the level could keep itself out of reach that way for as long
/// as it kept sending small requests (filling them itself returns the bond). So the fill of any
/// request of such an account closes its position instead.
#[test]
fn a_trader_below_the_liquidation_level_cannot_hide_behind_its_own_requests() {
    let mut w = live();
    leveraged_long(&mut w);
    w.move_price(20, 840_000);
    assert_eq!(position(&w, 7), 20 * UNIT as i128);
    // It asks to sell one unit of its twenty. While that waits, the liquidation cannot be queued.
    let id = w.request(7, -(UNIT as i128)).unwrap();
    let t = w.trader(7);
    let close = rclient::request_close(&w.payer.pubkey(), &t, &w.vault);
    expect(w.send(vec![close], &[]), router_code(RouterError::RequestPending));
    // Its own request fills: at that price the account is below the level, so the fill is a
    // liquidation (a quarter of the position) instead of the one unit asked for.
    w.execute(7, id).unwrap();
    assert_eq!(position(&w, 7), 15 * UNIT as i128);
    let a = asset_state(&w);
    assert_eq!((a.a_long, a.a_short), (percolator::ADL_ONE, percolator::ADL_ONE));
    // A healthy account's request is still just its request.
    w.taker_trade(1, 3 * UNIT as i128).unwrap();
    w.taker_trade(1, -(UNIT as i128)).unwrap();
    assert_eq!(position(&w, 1), 2 * UNIT as i128);
}

/// The last places in a vault's queue are kept for forced closes and settlements: trades cannot
/// fill the queue up and keep a liquidation out.
#[test]
fn trades_cannot_fill_the_queue_and_keep_a_liquidation_out() {
    let mut w = live();
    leveraged_long(&mut w);
    w.move_price(20, 840_000);
    let room = rstate::MAX_PENDING - percolator_router::RESERVED_PENDING;
    for i in 0..room {
        w.request(100 + i, UNIT as i128 / 100).unwrap();
    }
    assert_eq!({ w.book().len } as usize, room);
    expect(w.request(100 + room, UNIT as i128 / 100), router_code(RouterError::BookFull));
    let t = w.trader(7);
    let close = rclient::request_close(&w.payer.pubkey(), &t, &w.vault);
    w.send(vec![close], &[]).unwrap();
    assert_eq!({ w.book().len } as usize, room + 1);
}

#[test]
fn a_liquidation_does_nothing_if_the_trader_recovered_by_its_fill_price() {
    let mut w = live();
    leveraged_long(&mut w);
    w.move_price(20, 840_000);
    let t = w.trader(7);
    let id = w.book().next_id;
    let payer = w.payer.pubkey();
    w.send(vec![rclient::request_close(&payer, &t, &w.vault)], &[]).unwrap();
    // The first Pyth price after the target is back at 0.90: the account is above the level.
    w.price = 900_000;
    w.execute(7, id).unwrap();
    assert_eq!(position(&w, 7), 20 * UNIT as i128);
    assert_eq!(w.book().len, 0, "the request is gone either way");
}

/// If nobody liquidates through the router in time, Percolator's own liquidation is the backstop:
/// it reduces the position unilaterally, which deleverages the vault's side with it. The vault's
/// tracked position is then re-read from Percolator, and the market is closed out and reopens.
#[test]
fn percolators_own_liquidation_is_the_backstop() {
    let mut w = live();
    leveraged_long(&mut w);
    w.move_price(20, 760_000); // 0.2 USDC left against 15.2 of notional: far below 10%
    for _ in 0..3 {
        w.tick(1);
        w.settle(); // any crank on the account lets Percolator liquidate it
    }
    assert!(position(&w, 7) < 20 * UNIT as i128, "Percolator reduced the position");
    assert_ne!(asset_state(&w).a_short, percolator::ADL_ONE, "and deleveraged the vault's side");
    assert_eq!({ w.vault_state().inventory }, -20 * UNIT as i128, "which the matcher did not see");
    let sync = Instruction {
        program_id: pid(),
        accounts: vec![AccountMeta::new(w.vault, false), AccountMeta::new_readonly(w.env.market, false), AccountMeta::new_readonly(w.portfolio, false)],
        data: vec![percolator_vault::processor::TAG_SYNC_INVENTORY],
    };
    w.send(vec![sync], &[]).unwrap();
    assert_eq!({ w.vault_state().inventory }, -position(&w, 7));
    // Close-only now: close the trader out, settle, reset, and the market trades again.
    w.close_out(7).unwrap();
    w.settle();
    w.finalize_resets();
    let a = asset_state(&w);
    assert_eq!((a.oi_eff_long_q, a.a_long, a.a_short), (0, percolator::ADL_ONE, percolator::ADL_ONE));
    w.refresh_matcher(); // the approval lapsed while the price walked down
    w.taker_trade(1, UNIT as i128).unwrap();
}

/// Two people who send a request to the same market at the same moment both get in: a request
/// lives at its owner's address, not at one the whole market shares.
#[test]
fn two_traders_can_send_requests_at_the_same_moment() {
    let mut w = live();
    let (a, b) = (w.trader(0), w.trader(1));
    let (ka, kb) = (w.trader_kp(0), w.trader_kp(1));
    // Both transactions are built from the same view of the book.
    let first = w.book().next_id;
    let (ia, ib) = (rclient::request(&a, &w.vault, 2 * UNIT as i128), rclient::request(&b, &w.vault, -(UNIT as i128)));
    w.send(vec![ia], &[&ka]).unwrap();
    w.send(vec![ib], &[&kb]).unwrap();
    assert_eq!({ w.book().len }, 2);
    assert_eq!((w.request_account(first).1.wallet, w.request_account(first + 1).1.wallet), (a.wallet, b.wallet));
    // They fill in turn, each at the first price at or after its own target.
    w.execute(0, first).unwrap();
    if w.request_target(first + 1) <= w.book().mark_publish_time { w.fill(1, first + 1).unwrap() } else { w.execute(1, first + 1).unwrap() };
    assert_eq!((position(&w, 0), position(&w, 1)), (2 * UNIT as i128, -(UNIT as i128)));
    assert_eq!({ w.book().len }, 0);
}

/// A request the account can no longer afford at the price it fills at ends there, having traded
/// nothing, and the queue moves on. (It used to stay in the book, refused by Percolator on every
/// attempt, until it expired 90 seconds later, with every request behind it waiting.)
#[test]
fn a_request_the_account_cannot_afford_at_its_price_ends_without_trading() {
    let mut w = live();
    // 10 long on 5 USDC.
    let u = w.new_user(100_000_000);
    let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
    let mint = w.env.mint;
    w.send(vec![rclient::open_account(&t, &mint), rclient::deposit(&t, &u.collateral, &w.env.vault, 5_000_000)], &[&u.kp]).unwrap();
    w.traders.insert(7, (u, t));
    w.taker_trade(7, 10 * UNIT as i128).unwrap();
    // (Two minutes pass, so that the price band takes the fall below.)
    let now = w.clock_ts();
    at(&mut w, now + 120);
    let id = w.request(7, 12 * UNIT as i128).unwrap(); // twelve more, while it still can
    let behind = w.request(1, UNIT as i128).unwrap(); // someone else, queued behind it
    // Its price turns out to be 0.60: 1 USDC of equity is 16.7% of the 6 it holds (above the
    // liquidation level), but under the 10% Percolator asks for on 13.2 with the extra twelve.
    w.price = 600_000;
    let executor = w.payer.pubkey();
    let before = w.env.svm.get_balance(&executor).unwrap();
    w.execute(7, id).unwrap();
    assert_eq!(position(&w, 7), 10 * UNIT as i128, "nothing traded");
    assert!(w.env.svm.get_balance(&executor).unwrap() > before, "whoever ended it earned the bond");
    assert_eq!({ w.book().len }, 1);
    // The trader is free again, and the request behind fills.
    if w.request_target(behind) <= w.book().mark_publish_time { w.fill(1, behind).unwrap() } else { w.execute(1, behind).unwrap() };
    assert_eq!(position(&w, 1), UNIT as i128);
    w.taker_trade(7, -(UNIT as i128)).unwrap();
}

/// A request whose price the mark holds, and which nobody has filled `STALL_SECS` after the mark
/// was moved there, can be expired: a request that cannot fill does not hold the market up for
/// its whole grace period. Before its price has arrived, the grace period is the only way out.
#[test]
fn a_request_left_unfilled_at_its_price_can_be_expired_after_the_stall_time() {
    let mut w = live();
    let t = w.trader(0);
    let kp = w.trader_kp(0);
    let id = w.request(0, UNIT as i128).unwrap();
    let target = w.request_target(id);
    let expire = rclient::expire(&kp.pubkey(), &w.vault, &t);

    // Its price has not arrived: no early way out, however long it has waited.
    at(&mut w, target + STALL_SECS + 5);
    expect(w.send(vec![expire.clone()], &[&kp]), router_code(RouterError::TooEarly));

    // The mark moves to its price. Nobody fills it.
    let prev = w.pyth_time;
    w.pyth_time = target + 1;
    let u = w.pyth_update(w.price, target + 1, prev);
    w.advance_to(u).unwrap();
    let set = w.clock_ts();
    at(&mut w, set + STALL_SECS);
    expect(w.send(vec![expire.clone()], &[&kp]), router_code(RouterError::TooEarly));
    at(&mut w, set + STALL_SECS + 1);
    assert!(set + STALL_SECS + 1 < target + GRACE_SECS);
    w.send(vec![expire], &[&kp]).unwrap();
    assert_eq!({ w.book().len }, 0);
    // The mark is free to move on, and the trader to trade.
    w.taker_trade(0, UNIT as i128).unwrap();
}

/// Two requests waiting at the same price can be filled in one transaction (the executor sends
/// them together, a few at a time, so many liquidations in a crash do not wait one behind the other).
#[test]
fn two_requests_at_one_price_fill_in_one_transaction() {
    let mut w = live();
    let a = w.request(1, 2 * UNIT as i128).unwrap();
    let b = w.request(2, -(3 * UNIT as i128)).unwrap();
    let target = w.request_target(a).max(w.request_target(b));
    let slot = w.env.current_slot() + 1;
    w.env.set_clock(slot, target.max(w.clock_ts()));
    let prev = w.pyth_time;
    w.pyth_time = target;
    let u = w.pyth_update(w.price, target, prev);
    w.advance_to(u).unwrap();
    w.converge();
    let p = w.payer.pubkey();
    let ixs = vec![w.fill_ix(1, a, &p), w.fill_ix(2, b, &p)];
    w.send(ixs, &[]).unwrap();
    assert_eq!(position(&w, 1), 2 * UNIT as i128);
    assert_eq!(position(&w, 2), -3 * (UNIT as i128));
}

/// Two liquidations at one price, in one transaction.
#[test]
fn two_liquidations_at_one_price_fill_in_one_transaction() {
    let mut w = live();
    leveraged_long(&mut w);
    let mint = w.env.mint;
    let u = w.new_user(100_000_000);
    let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
    w.send(vec![rclient::open_account(&t, &mint), rclient::deposit(&t, &u.collateral, &w.env.vault, 5_000_000)], &[&u.kp]).unwrap();
    w.traders.insert(8, (u, t));
    w.taker_trade(8, 20 * UNIT as i128).unwrap();
    w.move_price(20, 840_000);
    let p = w.payer.pubkey();
    let (t7, t8) = (w.trader(7), w.trader(8));
    let a = w.book().next_id;
    w.send(vec![rclient::request_close(&p, &t7, &w.vault)], &[]).unwrap();
    let b = w.book().next_id;
    w.send(vec![rclient::request_close(&p, &t8, &w.vault)], &[]).unwrap();
    let target = w.request_target(a).max(w.request_target(b));
    let slot = w.env.current_slot() + 1;
    w.env.set_clock(slot, target.max(w.clock_ts()));
    let prev = w.pyth_time;
    w.pyth_time = target;
    let up = w.pyth_update(w.price, target, prev);
    w.advance_to(up).unwrap();
    w.converge();
    let ixs = vec![w.fill_ix(7, a, &p), w.fill_ix(8, b, &p)];
    w.send(ixs, &[]).unwrap();
    assert_eq!(position(&w, 7), 15 * UNIT as i128);
    assert_eq!(position(&w, 8), 15 * UNIT as i128);
}

/// Targets fall on the batch grid, never sooner than the delay, and requests sent within one
/// window share a target (and so a price).
#[test]
fn targets_are_rounded_up_to_the_batch_grid() {
    use percolator_router::target_time;
    for now in 1_000..1_010i64 {
        for mark in [0, now - 5, now, now + 3] {
            let t = target_time(now, mark, DELAY_SECS).unwrap();
            let earliest = now.max(mark) + DELAY_SECS;
            assert!(t >= earliest && t - earliest < BATCH_SECS && t % BATCH_SECS == 0, "now {now} mark {mark} -> {t}");
        }
    }
    // Sent one second apart, inside one window: the same target.
    let a = (1_000..).find(|n| (n + DELAY_SECS) % BATCH_SECS == 1).unwrap();
    assert_eq!(target_time(a, 0, DELAY_SECS), target_time(a + 1, 0, DELAY_SECS));
    assert_eq!(target_time(i64::MAX - 1, 0, DELAY_SECS), None);
}
