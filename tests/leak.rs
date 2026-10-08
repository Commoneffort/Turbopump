//! Does collateral end in no account when traders trade at random against the vault, and does it
//! depend on who is settled (cranked) when? Characterization: prints one line per settlement
//! policy. Percolator's own totals are read from the market: what its collateral account holds
//! beyond accounts' capital, insurance and booked profit belongs to nobody.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_prog::ix::Instruction as ProgIx;
use percolator_vault::percolator as perc;
use solana_sdk::{instruction::{AccountMeta, Instruction}, pubkey::Pubkey, signature::Signer};

const U: i128 = UNIT as i128;
const TAKERS: usize = 6;

fn big() -> World {
    let mut cfg = devnet_like_config();
    if let Some(h) = std::env::var("LEAK_HMAX").ok().and_then(|v| v.parse().ok()) { cfg.h_max = h; }
    let mut w = World::with_config(cfg);
    w.env.set_clock(5, 1_000);
    w.operate();
    let alice = w.new_user(20_000_000_000);
    w.deposit(&alice, 10_000_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();
    w
}
fn equity(w: &World, pf: &Pubkey) -> i128 {
    let d = w.env.svm.get_account(pf).unwrap().data;
    let (capital, pnl, _) = perc::portfolio_exposure(&d).unwrap();
    capital as i128 + pnl
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
/// Collateral held that is in no account: vault - capital - insurance - booked profit.
fn stray(w: &World) -> i128 {
    let h = w.env.primary_market_state().1;
    h.vault as i128 - h.c_tot as i128 - h.insurance as i128 - h.pnl_pos_tot as i128
}
/// Moves the mark and Percolator's price to `price`, settling nobody.
fn move_unsettled(w: &mut World, price: u64) {
    w.tick(20);
    let secs = w.band_secs(price);
    let u = w.next_pyth(secs, price);
    w.advance_to(u).expect("advance mark");
    walk(w);
}
fn walk(w: &mut World) {
    let asset = w.asset();
    for _ in 0..400 {
        w.tick(1);
        let slot = w.env.current_slot();
        w.catch_up(asset, slot, &[]);
        if w.env.primary_market_state().1.assets[asset as usize].effective_price == w.book().mark_price { return; }
    }
    panic!("did not converge");
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Policy {
    /// Every holder and the vault at every price, accounts with a loss first.
    EveryoneLosersFirst,
    /// Every holder and the vault at every price, accounts with a gain first.
    EveryoneWinnersFirst,
    /// The vault alone at every price (a keeper that cranks only the vault's account); everyone,
    /// losers first, right before each fill.
    VaultAloneBetweenFills,
    /// Nobody between fills; before a fill only the trader and the vault. Percolator refuses
    /// the fill (LockActive) while any holder is out of date, so this cannot happen live.
    #[allow(dead_code)]
    OnlyTheTwoParties,
}

struct Sim { w: World, pos: [i128; TAKERS], last: Vec<u64>, price: u64 }
impl Sim {
    fn keys(&self) -> Vec<Pubkey> { let mut k: Vec<Pubkey> = (0..TAKERS).map(|i| self.w.taker_portfolio(i)).collect(); k.push(self.w.portfolio); k }
    fn position(&self, i: usize) -> i128 { if i < TAKERS { self.pos[i] } else { -self.pos.iter().sum::<i128>() } }
    /// Cranks the accounts in `who`, ordered by whether settling books a loss.
    fn settle(&mut self, who: &[usize], losers_first: bool) {
        let keys = self.keys();
        let mut order: Vec<usize> = who.to_vec();
        let losing = |s: &Sim, i: usize| s.position(i) * (s.price as i128 - s.last[i] as i128) < 0;
        order.sort_by_key(|&i| if losing(self, i) == losers_first { 0 } else { 1 });
        for i in order { crank(&mut self.w, keys[i]); self.last[i] = self.price; }
        // LEAK_CONVERT=1: the vault's booked profit is turned into capital at once (anyone may ask).
        if std::env::var("LEAK_CONVERT").is_ok() { let ix = percolator_vault::client::convert_pnl(self.w.keys.as_ref().unwrap()); let _ = self.w.send(vec![ix], &[]); }
    }
}

fn run(policy: Policy, seed: u64, steps: usize) -> (i128, i128, i128, usize) {
    let mut w = big();
    for i in 0..TAKERS { w.trader(i); }
    let mut s = Sim { w, pos: [0; TAKERS], last: vec![INITIAL_PRICE; TAKERS + 1], price: INITIAL_PRICE };
    let keys = s.keys();
    let start: Vec<i128> = keys.iter().map(|k| equity(&s.w, k)).collect();
    let stray0 = stray(&s.w);
    let mut x = seed;
    let mut rnd = move |n: u64| { x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (x >> 33) % n };
    let all: Vec<usize> = (0..=TAKERS).collect();
    let mut fills = 0;
    let trace = std::env::var("LEAK_TRACE").is_ok();
    for step in 0..steps + TAKERS {
        // A price move of up to 0.8% either way, kept within 15% of the start.
        let bps = rnd(161) as i64 - 80;
        let p = ((s.price as i64) * (10_000 + bps) / 10_000).clamp(850_000, 1_150_000) as u64;
        let s_a = stray(&s.w);
        move_unsettled(&mut s.w, p);
        s.price = p;
        s.w.price = p;
        let s_b = stray(&s.w);
        match policy {
            Policy::EveryoneLosersFirst => s.settle(&all, true),
            Policy::EveryoneWinnersFirst => s.settle(&all, false),
            Policy::VaultAloneBetweenFills => s.settle(&[TAKERS], true),
            Policy::OnlyTheTwoParties => {}
        }
        let s_c = stray(&s.w);
        if trace { println!("  step {step}: price {p} | move {} settle {}", s_b - s_a, s_c - s_b); }
        // One trade: a random taker moves to a random position up to 2x; the last passes close.
        let t = if step < steps { rnd(TAKERS as u64) as usize } else { step - steps };
        let want = if step < steps { (rnd(4001) as i128 - 2000) * U } else { 0 };
        let size = want - s.pos[t];
        if size == 0 { continue; }
        let Ok(id) = s.w.request(t, size) else { continue };
        let target = s.w.request_target(id);
        let slot = s.w.env.current_slot() + 1;
        s.w.env.set_clock(slot, target.max(s.w.clock_ts()));
        let prev = s.w.pyth_time;
        s.w.pyth_time = target;
        let u = s.w.pyth_update(s.price, target, prev);
        s.w.advance_to(u).expect("mark at target");
        walk(&mut s.w);
        s.w.refresh_matcher(); // the vault's approval as matcher is time-limited; keepers renew it
        match policy {
            Policy::OnlyTheTwoParties => s.settle(&[t, TAKERS], true),
            Policy::EveryoneWinnersFirst => s.settle(&all, false),
            _ => s.settle(&all, true),
        }
        s.w.refresh_matcher();
        match s.w.fill(t, id) { Ok(_) => { s.pos[t] = want; fills += 1; } Err(e) => panic!("step {step}: fill of {size} for taker {t} (position {}) failed: {}", s.pos[t], e.lines().next().unwrap_or("")) }
        s.w.finalize_resets();
        if trace { let h = s.w.env.primary_market_state().1; println!("     fill taker {t} {} -> {}: stray since step start {} | insurance {} pnl_pos {} c_tot {}", (want - size) / U, want / U, stray(&s.w) - s_c, h.insurance, h.pnl_pos_tot, h.c_tot); }
    }
    s.settle(&all, true);
    s.settle(&all, true);
    let end: Vec<i128> = keys.iter().map(|k| equity(&s.w, k)).collect();
    let traders: i128 = (0..TAKERS).map(|i| end[i] - start[i]).sum();
    let vault = end[TAKERS] - start[TAKERS];
    let open: i128 = s.pos.iter().map(|p| p.abs()).sum();
    println!("{policy:?} seed {seed}: {fills} fills, open at the end {open} | traders {:.2}  vault {:.2}  together {:.2} | in no account {:.2}",
        traders as f64 / 1e6, vault as f64 / 1e6, (traders + vault) as f64 / 1e6, (stray(&s.w) - stray0) as f64 / 1e6);
    (traders, vault, stray(&s.w) - stray0, fills)
}

#[test]
fn where_the_money_goes_under_each_settlement_policy() {
    let steps: usize = std::env::var("LEAK_STEPS").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
    for seed in [1u64, 2].into_iter().take(if std::env::var("LEAK_TRACE").is_ok() { 1 } else { 2 }) {
        for p in [Policy::EveryoneLosersFirst, Policy::EveryoneWinnersFirst, Policy::VaultAloneBetweenFills] {
            run(p, seed, steps);
        }
    }
}

/// One scripted trade: request, mark at its target, everyone settled, fill.
fn trade(s: &mut Sim, t: usize, want: i128) {
    let all: Vec<usize> = (0..=TAKERS).collect();
    let size = want - s.pos[t];
    let id = s.w.request(t, size).expect("request");
    let target = s.w.request_target(id);
    let slot = s.w.env.current_slot() + 1;
    s.w.env.set_clock(slot, target.max(s.w.clock_ts()));
    let prev = s.w.pyth_time;
    s.w.pyth_time = target;
    let u = s.w.pyth_update(s.price, target, prev);
    s.w.advance_to(u).expect("mark at target");
    walk(&mut s.w);
    s.w.refresh_matcher();
    s.settle(&all, true);
    s.w.fill(t, id).expect("fill");
    s.pos[t] = want;
    s.w.finalize_resets();
}
fn to(s: &mut Sim, price: u64) {
    let all: Vec<usize> = (0..=TAKERS).collect();
    move_unsettled(&mut s.w, price);
    s.price = price;
    s.w.price = price;
    s.settle(&all, true);
    s.settle(&all, true);
}

/// The smallest case found: every account is settled at every price, losers first, and money
/// still ends in no account. A (short) wins, then gives part back while B (long, opened after
/// A's win) gains; when the price turns again B loses its position's loss plus exactly what A
/// gave back, and that amount is in no account. Settlement order and the warm-up period
/// (`LEAK_HMAX`) make no difference. `with_third` adds a second long.
fn scripted(with_third: bool) -> i128 {
    let mut w = big();
    for i in 0..TAKERS { w.trader(i); }
    let mut s = Sim { w, pos: [0; TAKERS], last: vec![INITIAL_PRICE; TAKERS + 1], price: INITIAL_PRICE };
    let keys = s.keys();
    let start: Vec<i128> = keys.iter().map(|k| equity(&s.w, k)).collect();
    let s0 = stray(&s.w);
    let show = |s: &Sim, what: &str| {
        let e: Vec<String> = [0usize, 1, 2, TAKERS].iter().map(|&i| format!("{:.6}", (equity(&s.w, &keys[i]) - start[i]) as f64 / 1e6)).collect();
        println!("  {what:34} A {} B {} C {} vault {} | in no account {:.6}", e[0], e[1], e[2], e[3], (stray(&s.w) - s0) as f64 / 1e6);
    };
    trade(&mut s, 0, -802 * U); show(&s, "A short 802 at 1.000000");
    to(&mut s, 992_001); show(&s, "price 0.992001 (A wins)");
    trade(&mut s, 1, 1_153 * U); show(&s, "B long 1,153");
    to(&mut s, 995_473); show(&s, "price 0.995473 (A gives back)");
    if with_third { trade(&mut s, 2, 1_378 * U); show(&s, "C long 1,378"); }
    to(&mut s, 990_694); show(&s, "price 0.990694 (B, C lose)");
    for t in 0..3 { if s.pos[t] != 0 { trade(&mut s, t, 0); } }
    to(&mut s, 990_694); show(&s, "all closed");
    stray(&s.w) - s0
}

#[test]
fn everyone_settled_at_every_price_and_money_still_strays() {
    println!("two takers:"); let two = scripted(false);
    println!("three takers:"); let three = scripted(true);
    println!("in no account: {two} (two takers), {three} (three takers)");
    // Pinned (engine 6de466b), so that we notice when the engine changes it: A's give-back of
    // 802 x (0.995473 - 0.992001) is paid out of A's own booked gain and is not counted as
    // backing for B's gain, so B's gain is cut by that much when the price turns again.
    assert_eq!((two, three), (2_784_542, 2_784_542));
}
