//! Can a market that has been traded on be retired once it is empty again? Characterization:
//! it prints what happens right after everyone left, and after time has passed.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_vault::processor;
use solana_sdk::signature::Signer;

const U: i128 = UNIT as i128;

fn world() -> (World, User) {
    let mut cfg = devnet_like_config();
    // RETIRE_HMAX: the longest time (slots) a gain waits before it can become capital.
    if let Some(h) = std::env::var("RETIRE_HMAX").ok().and_then(|v| v.parse().ok()) { cfg.h_max = h; }
    let mut w = World::with_config(cfg);
    w.env.set_clock(5, 1_000);
    w.operate();
    w.env.update_market_authority_from_admin(4).unwrap();
    let admin = w.env.actors[4].signer.insecure_clone();
    let epoch0 = w.env.primary_control_sequences(0).authority_epoch;
    let ix = percolator_vault::client::accept_governance(&pid(), &admin.pubkey(), &w.env.market, epoch0);
    w.send(vec![ix], &[&admin]).unwrap();
    let alice = w.new_user(20_000_000_000);
    w.deposit(&alice, 10_000_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();
    (w, alice)
}
fn retire(w: &mut World) -> Result<u64, String> {
    let v = w.vault_state();
    let asset_epoch = w.env.primary_control_sequences(v.asset_index as usize).authority_epoch;
    let market_epoch = w.env.primary_control_sequences(0).authority_epoch;
    let ix = percolator_vault::client::retire_market(&w.keys.unwrap(), asset_epoch, market_epoch);
    w.send(vec![ix], &[])
}
/// Everyone out: takers flat, the depositor's shares withdrawn and claimed.
fn empty_out(w: &mut World, alice: &User, takers: &[usize]) {
    for &t in takers { w.refresh_matcher(); let _ = w.close_position(t); }
    let shares = w.tokens(alice.shares);
    w.withdraw(alice, shares).unwrap();
    w.advance(EPOCH_LEN, w.price);
    w.roll().unwrap();
    let epoch = { w.vault_state().epoch } - 1;
    w.claim(alice, epoch).unwrap();
}
fn code(r: &Result<u64, String>) -> String {
    match r { Ok(_) => "ok".into(), Err(e) => e.lines().next().unwrap_or("").to_string() }
}

fn try_retire(name: &str, trade: impl Fn(&mut World)) {
    let (mut w, alice) = world();
    trade(&mut w);
    empty_out(&mut w, &alice, &[0, 1]);
    w.advance(EPOCH_LEN * processor::RETIRE_IDLE_EPOCHS + 1, w.price);
    let first = retire(&mut w);
    println!("{name}: right after everyone left: {}", code(&first));
    if first.is_err() {
        let g = w.env.primary_market_state().1;
        let a = &g.assets[w.asset() as usize];
        println!("   market: profit booked {} | claims {} | insurance credit reserved {} | vault-capital-insurance {}", g.pnl_pos_tot, g.source_claim_bound_total_num, g.source_insurance_credit_reserved_total_atoms, g.vault as i128 - g.c_tot as i128 - g.insurance as i128);
        println!("   asset: {}", format!("{a:?}").split(", ").filter(|f| !f.ends_with(": 0") && !f.ends_with(": 0 }")).collect::<Vec<_>>().join(", "));
        for i in 0..2 { let d = w.env.svm.get_account(&w.taker_portfolio(i.min(w.traders.len() - 1))).unwrap().data; let (c, p, _) = percolator_vault::percolator::portfolio_exposure(&d).unwrap(); println!("   taker {i}: capital {c} pnl {p}"); }
    }
    if first.is_ok() { return; }
    // The vault's own booked profit can be turned into capital by anyone (`ConvertPnl`).
    let ix = percolator_vault::client::convert_pnl(w.keys.as_ref().unwrap());
    println!("{name}: vault ConvertPnl: {}", code(&w.send(vec![ix], &[])));
    // A trader's can too, through the router.
    for i in 0..w.traders.len() { let t = w.trader(i); let _ = w.send(vec![percolator_router::client::convert_pnl(&t)], &[]); }
    let r = retire(&mut w);
    println!("{name}: after converting everyone's profit: {}", code(&r));
    if r.is_ok() { return; }
    for epochs in [1u64, 5, 20] {
        for _ in 0..epochs { let p = w.price; w.advance(EPOCH_LEN, p); w.refresh_matcher(); }
        let r = retire(&mut w);
        println!("{name}: {epochs} epochs later: {}", code(&r));
        if r.is_ok() { return; }
    }
}

#[test]
fn retiring_a_market_that_was_traded_on() {
    try_retire("never traded", |_| {});
    try_retire("traded, no price move", |w| { w.taker_trade(0, 500 * U).unwrap(); });
    try_retire("one trader won", |w| { w.taker_trade(0, 500 * U).unwrap(); w.advance(40, 1_030_000); });
    try_retire("one trader lost", |w| { w.taker_trade(0, 500 * U).unwrap(); w.advance(40, 970_000); });
    // The case that leaves money in no account (tests/leak.rs): A wins, gives part back while B gains, then B loses.
    try_retire("win, give back, reversal", |w| {
        w.taker_trade(0, -802 * U).unwrap();
        w.advance(40, 992_001);
        w.taker_trade(1, 1_153 * U).unwrap();
        w.advance(40, 995_473);
        w.advance(40, 990_694);
    });
}

fn expect_err(r: Result<u64, String>, e: percolator_router::RouterError) {
    let msg = r.expect_err("expected the attempt to fail");
    assert!(msg.contains(&format!("custom program error: {:#x}", e as u32)), "expected {e:?}, got:\n{msg}");
}

/// Can a trader who won and closed take the winnings out? The gain is booked as profit, not as
/// capital, and a withdrawal pays out capital.
#[test]
fn a_winner_can_withdraw_what_it_won() {
    use percolator_router::client as rclient;
    let (mut w, _alice) = world();
    w.taker_trade(0, 500 * U).unwrap();
    w.advance(40, 1_030_000);
    w.refresh_matcher();
    w.close_position(0).unwrap();
    let t = w.trader(0);
    let (kp, dest) = (w.trader_kp(0), w.traders[&0].0.collateral);
    let vault = w.env.vault;
    let read = |w: &World| { let d = w.env.svm.get_account(&w.taker_portfolio(0)).unwrap().data; let (c, p, _) = percolator_vault::percolator::portfolio_exposure(&d).unwrap(); (c, p) };
    println!("after closing: capital {} profit {}", read(&w).0, read(&w).1);
    // The margin paid in comes out; the 15 won on top of it is asked for as well.
    let all = w.send(vec![rclient::withdraw(&t, &dest, &vault, 1_015_000_000)], &[&kp]);
    println!("withdraw 1,015 (margin + winnings) at once: {}", code(&all));
    for epochs in [1u64, 5] {
        for _ in 0..epochs { let p = w.price; w.advance(EPOCH_LEN, p); w.refresh_matcher(); }
        let r = w.send(vec![rclient::withdraw(&t, &dest, &vault, 1_015_000_000)], &[&kp]);
        println!("{epochs} more epoch(s) later: capital {} profit {} | withdraw 1,015: {}", read(&w).0, read(&w).1, code(&r));
        if r.is_ok() { return; }
    }
    // With the router's ConvertPnl (anyone may send it): how much of the 15 becomes capital, and when.
    for epochs in [0u64, 1, 5, 20] {
        for _ in 0..epochs { let p = w.price; w.advance(EPOCH_LEN, p); w.refresh_matcher(); }
        let c = w.send(vec![rclient::convert_pnl(&t)], &[]);
        println!("ConvertPnl after {epochs} more epoch(s): {} | capital {} profit {}", code(&c), read(&w).0, read(&w).1);
    }
    // Once converted, the winnings are capital like the rest.
    assert_eq!(read(&w), (1_015_000_000, 0));
    // What it owes the vault comes first: 5 bps on the 500 its opening trade added to the
    // vault's position (0.25). Anyone may pay it in, from the trader's capital to the vault.
    expect_err(w.send(vec![rclient::withdraw(&t, &dest, &vault, 1_000_000)], &[&kp]), percolator_router::RouterError::FeesOwed);
    let k = w.keys.clone().unwrap();
    let buffer = w.tokens(k.buffer);
    w.send(vec![rclient::pay_fees(&k, &t)], &[]).expect("fees paid");
    assert_eq!(w.tokens(k.buffer) - buffer, 250_000);
    // Then all the rest comes out.
    let before = w.tokens(dest);
    w.send(vec![rclient::withdraw(&t, &dest, &vault, 1_014_750_000)], &[&kp]).expect("margin and winnings withdrawn");
    assert_eq!(w.tokens(dest) - before, 1_014_750_000);
    assert_eq!(read(&w), (0, 0));
}
