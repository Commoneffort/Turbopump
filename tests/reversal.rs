//! What a price reversal does to a trader's account, depending on which accounts were settled
//! (cranked) at the turning point. Characterization only: it prints, and asserts conservation.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_prog::ix::Instruction as ProgIx;
use percolator_vault::percolator as perc;
use solana_sdk::{instruction::{AccountMeta, Instruction}, pubkey::Pubkey, signature::Signer};

const U: i128 = UNIT as i128;

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
fn account(w: &World, pf: &Pubkey) -> (i128, i128) {
    let d = w.env.svm.get_account(pf).unwrap().data;
    let (capital, pnl, _) = perc::portfolio_exposure(&d).unwrap();
    (capital as i128, pnl)
}
fn crank(w: &mut World, pf: Pubkey) {
    let asset = w.asset();
    let slot = w.env.current_slot();
    let ix = Instruction {
        program_id: perc::PERCOLATOR_PROGRAM_ID,
        accounts: vec![AccountMeta::new(w.payer.pubkey(), true), AccountMeta::new(w.env.market, false), AccountMeta::new(pf, false)],
        data: ProgIx::PermissionlessCrank { now_slot: slot, observations: vec![percolator_prog::ix::CrankObservationHint { asset_index: asset, oracle_accounts: 0 }] }.encode(),
    };
    let _ = w.send(vec![ix], &[]);
}
/// Moves the mark and Percolator's price to `price`, settling nobody.
fn move_unsettled(w: &mut World, price: u64) {
    w.tick(20);
    let secs = (w.clock_ts() - w.pyth_time).max(1);
    let u = w.next_pyth(secs, price);
    w.advance_to(u).expect("advance mark");
    let asset = w.asset();
    for _ in 0..400 {
        w.tick(1);
        let slot = w.env.current_slot();
        w.catch_up(asset, slot, &[]);
        if w.env.primary_market_state().1.assets[asset as usize].effective_price == w.book().mark_price { return; }
    }
    panic!("did not converge");
}

fn run(at_peak: &str) -> (i128, i128, i128) {
    let mut w = live();
    w.taker_trade(0, 10 * U).unwrap();
    let t = w.taker_portfolio(0);
    let lp = w.portfolio;
    let (c0, p0) = account(&w, &t);
    let (l0, lp0) = account(&w, &lp);
    move_unsettled(&mut w, 1_140_000);
    match at_peak {
        "trader only" => crank(&mut w, t),
        "vault only" => crank(&mut w, lp),
        "vault then trader" => { crank(&mut w, lp); crank(&mut w, t) }
        "trader then vault" => { crank(&mut w, t); crank(&mut w, lp) }
        _ => {}
    }
    let (c1, p1) = account(&w, &t);
    move_unsettled(&mut w, 855_000);
    crank(&mut w, t);
    crank(&mut w, lp);
    crank(&mut w, t);
    let (c2, p2) = account(&w, &t);
    let (l2, lp2) = account(&w, &lp);
    println!("settled at the peak: {at_peak:18} | trader {} -> peak {}+{} -> end {}+{} (change {}) | vault {}+{} -> {}+{} (change {})",
        c0 + p0, c1, p1, c2, p2, c2 + p2 - c0 - p0, l0, lp0, l2, lp2, l2 + lp2 - l0 - lp0);
    (c2 + p2 - c0 - p0, l2 + lp2 - l0 - lp0, c2 + p2)
}

#[test]
fn a_reversal_costs_the_trader_the_same_whoever_was_settled_at_the_peak() {
    println!("long 10 at 1.00, up to 1.14, down to 0.855: the position alone loses 1.45 (1450000)");
    let mut out = vec![];
    for k in ["nobody", "trader only", "vault only", "vault then trader", "trader then vault"] { out.push((k, run(k))); }
    for (k, (t, _, _)) in &out { println!("{k:18}: trader change {t}"); }
}

/// A bigger vault (10,000) so traders can be at 4.5x, several of them, both sides.
fn big() -> World {
    let mut w = World::with_config(devnet_like_config());
    w.env.set_clock(5, 1_000);
    w.operate();
    let alice = w.new_user(20_000_000_000);
    w.deposit(&alice, 10_000_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();
    w
}
/// Long 4,500 at 1.00 on 1,000 of margin (trader 0), with or without two more traders (long
/// 2,000, short 1,500); the vault is the other side of all of them. Up 14%, `at_peak` says who
/// is settled there, then down 25% from the peak and everyone is settled. Returns what trader 0,
/// the other traders and the vault each gained, and what Percolator's collateral account holds
/// beyond every account's capital and profit.
fn run_big(at_peak: &str, others: bool) -> (i128, i128, i128) {
    let mut w = big();
    w.taker_trade(0, 4_500 * U).unwrap();
    if others { w.taker_trade(1, 2_000 * U).unwrap(); w.taker_trade(2, -1_500 * U).unwrap(); }
    let all: Vec<Pubkey> = (0..if others { 3 } else { 1 }).map(|i| w.taker_portfolio(i)).collect();
    let (t, lp) = (all[0], w.portfolio);
    let eq = |w: &World, k: &Pubkey| { let (c, p) = account(w, k); c + p };
    let start: Vec<i128> = all.iter().chain([&lp]).map(|k| eq(&w, k)).collect();
    move_unsettled(&mut w, 1_140_000);
    match at_peak {
        "the traders" => for a in &all { crank(&mut w, *a) },
        "everyone, losers first" => { crank(&mut w, lp); crank(&mut w, all[all.len() - 1]); for a in &all { crank(&mut w, *a) } }
        _ => {}
    }
    move_unsettled(&mut w, 855_000);
    crank(&mut w, t);
    crank(&mut w, lp);
    for a in &all { crank(&mut w, *a) }
    crank(&mut w, lp);
    let end: Vec<i128> = all.iter().chain([&lp]).map(|k| eq(&w, k)).collect();
    let change: Vec<i128> = end.iter().zip(&start).map(|(e, s)| e - s).collect();
    let n = change.len();
    let (trader, vault) = (change[0], change[n - 1]);
    let rest: i128 = change[1..n - 1].iter().sum();
    println!("others {others:5}, settled at the peak: {at_peak:22} | trader {trader:>12}  other traders {rest:>12}  vault {vault:>12}  all together {:>12}", trader + rest + vault);
    (trader, rest, vault)
}

/// What the position alone loses: 4,500 x (0.855 - 1.00).
const PLAIN: i128 = -652_500_000;

/// With every holder of the market settled at each price (losers before winners, which is what
/// our executor does), a reversal costs exactly what the position lost.
#[test]
fn settled_together_a_reversal_costs_what_the_position_lost() {
    for others in [false, true] {
        assert_eq!(run_big("everyone, losers first", others).0, PLAIN);
        assert_eq!(run_big("nobody", others).0, PLAIN);
    }
}

/// Percolator as it is today (engine v16.9.1): if the winners are settled at the peak and the
/// vault, which owes them, is not, the gain of each winner is backed only by the losses booked so
/// far (here the short trader's 210 against 910 of gains: 23%). When the price turns, the loss is
/// taken against the gain at that rate and the rest out of capital, for good. Trader 0 loses its
/// whole 1,000 and owes 137 more, where the position alone lost 652.5. Anyone can call a crank,
/// so anyone can bring this state about. This test pins the behaviour so that we notice when
/// the engine changes it.
#[test]
fn winners_settled_before_the_vault_lose_more_than_their_position_did() {
    let (trader, _, _) = run_big("the traders", true);
    assert!(trader < PLAIN - 400_000_000, "trader 0 lost {trader}, the position alone {PLAIN}");
    // Alone on the market there is no partial backing, and nothing is lost.
    assert_eq!(run_big("the traders", false).0, PLAIN);
}
