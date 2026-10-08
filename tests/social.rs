//! Track records, profiles, following and copy trading (router `social`).
//!
//! A track record is written by the router itself, so nobody can claim a result they did not
//! have. A copy is an instruction the follower signs once; anyone may then bring the follower in
//! line with the leader, but only by queuing an ordinary request, and only for the size the two
//! accounts' own state gives.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_router::{
    client::{self as rclient},
    social::{copy_due, copy_target},
    state::{self as rstate, Copy, Follow, Profile, Stats, COPY_LEN, FOLLOW_LEN, NAME_LEN, PROFILE_LEN, STATS_LEN},
    RouterError,
};
use percolator_vault::percolator as perc;
use solana_sdk::{pubkey::Pubkey, signature::Signer};

const U: i128 = UNIT as i128;
const RID: fn() -> Pubkey = percolator_router::id;

fn code(e: RouterError) -> String {
    format!("custom program error: {:#x}", e as u32)
}
fn expect(r: Result<u64, String>, e: RouterError) {
    let msg = r.expect_err("expected the attempt to fail");
    assert!(msg.contains(&code(e)), "expected {e:?}, got:\n{msg}");
}

/// A vault with 10,000 of liquidity on the devnet-like market, rolled live.
fn live() -> World {
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
fn position(w: &World, taker: usize) -> i128 {
    let m = w.env.svm.get_account(&w.env.market).unwrap().data;
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    perc::positions(&m, &d).unwrap().iter().map(|p| p.size).sum()
}
fn equity(w: &World, taker: usize) -> i128 {
    let d = w.env.svm.get_account(&w.taker_portfolio(taker)).unwrap().data;
    let (c, p, _) = perc::portfolio_exposure(&d).unwrap();
    c as i128 + p
}
fn read<T: bytemuck::Pod>(w: &World, k: &Pubkey) -> Option<T> {
    w.env.svm.get_account(k).filter(|a| !a.data.is_empty() && a.owner == RID()).map(|a| bytemuck::pod_read_unaligned(&a.data))
}
fn stats(w: &World, taker: usize) -> Stats {
    let t = w.traders[&taker].1;
    read(w, &rstate::stats_address(&RID(), &t.market, &t.wallet).0).expect("track record")
}
fn open_stats(w: &mut World, taker: usize) {
    let t = w.trader(taker);
    let ix = rclient::open_stats(&w.payer.pubkey(), &t);
    w.send(vec![ix], &[]).expect("open track record");
}
fn copy(w: &World, taker: usize) -> Option<Copy> {
    let t = w.traders[&taker].1;
    read(w, &rstate::copy_address(&RID(), &t.market, &t.wallet).0)
}
fn set_copy(w: &mut World, follower: usize, leader: usize, ratio_bps: u32, max_notional: u64) -> Result<u64, String> {
    let (t, l) = (w.trader(follower), w.trader(leader));
    let kp = w.trader_kp(follower);
    w.send(vec![rclient::set_copy(&t, &l.wallet, ratio_bps, max_notional)], &[&kp])
}
/// Anyone (the harness payer) brings the follower in line; returns the id of the queued request.
fn trigger(w: &mut World, follower: usize, leader: usize, size: i128) -> Result<u64, String> {
    let (t, l) = (w.trader(follower), w.trader(leader));
    let id = w.book().next_id;
    let ix = rclient::trigger_copy(&w.payer.pubkey(), &t, &l.wallet, &w.vault, size);
    w.send(vec![ix], &[]).map(|_| id)
}
fn sync(w: &mut World, follower: usize, leader: usize) -> Result<u64, String> {
    let id = trigger(w, follower, leader, 0)?;
    w.execute(follower, id)
}

// ---------------------------------------------------------------- layouts the page reads

/// The page decodes these accounts by offset (app/src/social.ts): pin every offset it uses.
#[test]
fn layouts_are_what_the_page_reads() {
    use core::mem::offset_of;
    assert_eq!((STATS_LEN, PROFILE_LEN, NAME_LEN, FOLLOW_LEN, COPY_LEN), (1184, 72, 48, 88, 136));
    assert_eq!(
        (offset_of!(Stats, wallet), offset_of!(Stats, day_at), offset_of!(Stats, fill_at), offset_of!(Stats, start_time), offset_of!(Stats, start_equity), offset_of!(Stats, deposited), offset_of!(Stats, withdrawn)),
        (8, 73, 74, 80, 88, 96, 104)
    );
    assert_eq!(
        (offset_of!(Stats, volume), offset_of!(Stats, trades), offset_of!(Stats, days_up), offset_of!(Stats, days_down), offset_of!(Stats, last_time), offset_of!(Stats, last_pnl), offset_of!(Stats, day_open_pnl)),
        (112, 128, 132, 134, 136, 144, 152)
    );
    assert_eq!(
        (offset_of!(Stats, peak_pnl), offset_of!(Stats, max_drawdown), offset_of!(Stats, best_day), offset_of!(Stats, worst_day), offset_of!(Stats, days), offset_of!(Stats, fills)),
        (160, 168, 176, 184, 192, 672)
    );
    assert_eq!((offset_of!(Profile, wallet), offset_of!(Profile, name), offset_of!(Profile, name_len), offset_of!(Profile, badge), offset_of!(Profile, color), offset_of!(Profile, created)), (8, 40, 56, 57, 58, 64));
    assert_eq!((offset_of!(Follow, follower), offset_of!(Follow, leader), offset_of!(Follow, since)), (8, 40, 72));
    assert_eq!((offset_of!(Copy, market), offset_of!(Copy, follower), offset_of!(Copy, leader), offset_of!(Copy, ratio_bps), offset_of!(Copy, max_notional), offset_of!(Copy, since), offset_of!(Copy, triggers)), (8, 40, 72, 104, 112, 120, 128));
    assert_eq!(offset_of!(rstate::TraderState, has_stats), 138);
}

// ---------------------------------------------------------------- track record

#[test]
fn a_track_record_is_profit_after_what_was_paid_in_and_out() {
    let mut w = live();
    let t = w.trader(0); // opened with 1,000 of margin
    open_stats(&mut w, 0);
    let s = stats(&w, 0);
    assert_eq!(({ s.start_equity }, { s.deposited }, { s.withdrawn }, { s.trades }), (1_000_000_000, 0, 0, 0));

    // A deposit is not profit.
    let (kp, source) = (w.trader_kp(0), w.traders[&0].0.collateral);
    let vault = w.env.vault;
    w.send(vec![rclient::deposit(&t, &source, &vault, 500_000_000)], &[&kp]).unwrap();
    assert_eq!({ stats(&w, 0).deposited }, 500_000_000);

    // Long 2,000 at 1.00, the price goes to 1.05, close: +100, less fees where the market charges them.
    w.taker_trade(0, 2_000 * U).unwrap();
    w.advance(40, 1_050_000);
    w.taker_trade(0, -2_000 * U).unwrap();
    let s = stats(&w, 0);
    let profit = equity(&w, 0) - 1_000_000_000 - 500_000_000;
    assert_eq!({ s.last_pnl } as i128, profit);
    assert!((95_000_000..=100_000_000).contains(&profit), "profit {profit}");
    assert_eq!({ s.trades }, 2);
    assert_eq!({ s.volume }, 2_000_000_000 + 2_100_000_000);
    // The newest fill, and the one before it.
    let fills = s.fills;
    let (last, first) = (fills[s.fill_at as usize], fills[0]);
    assert_eq!(({ first.size }, { first.price }, { last.size }, { last.price }), (2_000_000_000, 1_000_000, -2_000_000_000, 1_050_000));
    // One trading day so far, in profit.
    let today = s.days[s.day_at as usize];
    assert_eq!({ today.pnl }, { s.last_pnl });
    assert_eq!({ s.max_drawdown }, 0);

    // A withdrawal is not a loss.
    let dest = w.traders[&0].0.collateral;
    w.send(vec![rclient::withdraw(&t, &dest, &vault, 300_000_000)], &[&kp]).unwrap();
    let s = stats(&w, 0);
    assert_eq!({ s.withdrawn }, 300_000_000);
    assert_eq!(equity(&w, 0) - 1_000_000_000 - 500_000_000 + 300_000_000, profit);
}

#[test]
fn money_cannot_move_past_a_track_record() {
    let mut w = live();
    let t = w.trader(0);
    let (kp, source) = (w.trader_kp(0), w.traders[&0].0.collateral);
    let vault = w.env.vault;
    // Without a record the old form of a deposit (no record named) still works.
    let mut bare = rclient::deposit(&t, &source, &vault, 1_000_000);
    bare.accounts.pop();
    w.send(vec![bare.clone()], &[&kp]).unwrap();
    open_stats(&mut w, 0);
    // With one, a deposit or withdrawal that does not name it is refused, and so is another account.
    w.tick(1);
    expect(w.send(vec![bare], &[&kp]), RouterError::BadAccount);
    let mut other = rclient::deposit(&t, &source, &vault, 1_000_000);
    other.accounts[9].pubkey = rstate::stats_address(&RID(), &t.market, &w.payer.pubkey()).0;
    expect(w.send(vec![other], &[&kp]), RouterError::BadAccount);
    let mut out = rclient::withdraw(&t, &source, &vault, 1_000_000);
    out.accounts.pop();
    expect(w.send(vec![out], &[&kp]), RouterError::BadAccount);
    // A second record for the same account cannot be opened (it would reset the first).
    let again = rclient::open_stats(&w.payer.pubkey(), &t);
    w.tick(1);
    expect(w.send(vec![again], &[]), RouterError::AlreadyInitialized);
}

#[test]
fn days_are_counted_as_they_end() {
    let mut w = live();
    w.trader(0);
    open_stats(&mut w, 0);
    let day = |w: &mut World| { let slot = w.env.current_slot() + 10; let ts = w.clock_ts() + 86_400; w.env.set_clock(slot, ts); w.pyth_time = ts - 1; };
    // (The harness clock starts in 1970; a day number of 0 marks an empty entry.)
    for _ in 0..3 { day(&mut w); }
    // Day 1: long 2,000, the price rises 2%.
    w.taker_trade(0, 2_000 * U).unwrap();
    w.advance(40, 1_020_000);
    w.taker_trade(0, -1_000 * U).unwrap();
    let d1 = { stats(&w, 0).last_pnl };
    assert!(d1 > 0);
    // Day 2: the price falls 5% on the 1,000 still held.
    day(&mut w);
    w.advance(40, 969_000);
    w.taker_trade(0, -500 * U).unwrap();
    let s = stats(&w, 0);
    assert_eq!(({ s.days_up }, { s.days_down }), (1, 0), "day 1 is over and was up");
    let today = s.days[s.day_at as usize];
    assert_eq!({ today.pnl }, { s.last_pnl } - d1, "day 2 holds what was lost since day 1's last fill");
    assert!({ today.pnl } < 0);
    assert_eq!({ s.max_drawdown } as i64, { s.peak_pnl } - { s.last_pnl });
    // Day 3: one more fill closes day 2 as a losing day.
    day(&mut w);
    w.advance(40, 969_000);
    w.taker_trade(0, -500 * U).unwrap();
    let s = stats(&w, 0);
    assert_eq!(({ s.days_up }, { s.days_down }), (1, 1));
    assert!({ s.worst_day } < 0 && { s.best_day } == d1);
}

// ---------------------------------------------------------------- profiles

#[test]
fn a_name_belongs_to_one_wallet() {
    let mut w = live();
    let (a, b) = (w.new_user(0), w.new_user(0));
    let profile = |w: &World, k: &Pubkey| read::<Profile>(w, &rstate::profile_address(&RID(), k).0);
    w.send(vec![rclient::set_profile(&a.kp.pubkey(), "Satoshi_1", None, 3, 2)], &[&a.kp]).unwrap();
    let p = profile(&w, &a.kp.pubkey()).unwrap();
    assert_eq!((&p.name[..p.name_len as usize], p.badge, p.color), (&b"Satoshi_1"[..], 3, 2));
    // Nobody else gets it, in any case of letters.
    expect(w.send(vec![rclient::set_profile(&b.kp.pubkey(), "SATOSHI_1", None, 0, 0)], &[&b.kp]), RouterError::NameTaken);
    // Names are 3 to 16 letters, digits or underscores.
    for bad in ["ab", "has space", "seventeen_letters", "emoji\u{1F600}"] {
        expect(w.send(vec![rclient::set_profile(&b.kp.pubkey(), bad, None, 0, 0)], &[&b.kp]), RouterError::BadName);
    }
    // The holder can change badge and letter case, and take another name, which frees the first.
    w.send(vec![rclient::set_profile(&a.kp.pubkey(), "satoshi_1", Some("Satoshi_1"), 5, 1)], &[&a.kp]).unwrap();
    assert_eq!(profile(&w, &a.kp.pubkey()).unwrap().badge, 5);
    w.send(vec![rclient::set_profile(&a.kp.pubkey(), "nakamoto", Some("satoshi_1"), 5, 1)], &[&a.kp]).unwrap();
    w.send(vec![rclient::set_profile(&b.kp.pubkey(), "Satoshi_1", None, 1, 1)], &[&b.kp]).unwrap();
    assert_eq!(&profile(&w, &b.kp.pubkey()).unwrap().name[..9], b"Satoshi_1");
    // Renaming must free the name the profile actually holds.
    let mut cheat = rclient::set_profile(&a.kp.pubkey(), "another", Some("nakamoto"), 0, 0);
    cheat.accounts[3].pubkey = rstate::name_address(&RID(), b"satoshi_1").0;
    expect(w.send(vec![cheat], &[&a.kp]), RouterError::BadAccount);
}

#[test]
fn following_is_a_list_and_nothing_else() {
    let mut w = live();
    let (a, b) = (w.new_user(0), w.new_user(0));
    let key = rstate::follow_address(&RID(), &a.kp.pubkey(), &b.kp.pubkey()).0;
    w.send(vec![rclient::follow(&a.kp.pubkey(), &b.kp.pubkey())], &[&a.kp]).unwrap();
    let f: Follow = read(&w, &key).unwrap();
    assert_eq!((f.follower, f.leader), (a.kp.pubkey(), b.kp.pubkey()));
    expect(w.send(vec![rclient::follow(&a.kp.pubkey(), &a.kp.pubkey())], &[&a.kp]), RouterError::BadAccount);
    // Only the follower can end it.
    let mut theirs = rclient::unfollow(&b.kp.pubkey(), &b.kp.pubkey());
    theirs.accounts[1].pubkey = key;
    expect(w.send(vec![theirs], &[&b.kp]), RouterError::BadAccount);
    w.send(vec![rclient::unfollow(&a.kp.pubkey(), &b.kp.pubkey())], &[&a.kp]).unwrap();
    assert!(read::<Follow>(&w, &key).is_none());
}

// ---------------------------------------------------------------- copying

#[test]
fn the_size_of_a_copy_is_the_leaders_leverage_on_the_followers_equity() {
    // Leader long 2,000 on 1,000 of equity; a follower with 250 copies at 100%: 500.
    assert_eq!(copy_target(2_000 * U, 1_000_000_000, 250_000_000, 10_000, 0, 1_000_000).unwrap(), 500 * U);
    // At half the leader's leverage, short, and limited to 100 of notional at a price of 2.00.
    assert_eq!(copy_target(-2_000 * U, 1_000_000_000, 250_000_000, 5_000, 0, 1_000_000).unwrap(), -250 * U);
    assert_eq!(copy_target(2_000 * U, 1_000_000_000, 250_000_000, 10_000, 100_000_000, 2_000_000).unwrap(), 50 * U);
    // A leader with nothing left, or a follower with nothing left: flat.
    assert_eq!(copy_target(2_000 * U, 0, 250_000_000, 10_000, 0, 1_000_000).unwrap(), 0);
    assert_eq!(copy_target(2_000 * U, 1_000_000_000, -5, 10_000, 0, 1_000_000).unwrap(), 0);
    // Due: opening, closing, turning, or more than 10% away. Not due: small drift, or dust.
    assert!(copy_due(0, 500 * U, 1_000_000) && copy_due(500 * U, 0, 1_000_000) && copy_due(500 * U, -500 * U, 1_000_000));
    assert!(copy_due(440 * U, 500 * U, 1_000_000) && !copy_due(460 * U, 500 * U, 1_000_000));
    assert!(!copy_due(0, U / 2, 1_000_000) && copy_due(1, 0, 1_000_000) && !copy_due(500 * U, 500 * U, 1_000_000));
}

#[test]
fn a_follower_is_brought_in_line_with_its_leader_by_anyone() {
    let mut w = live();
    w.trader(0); // the leader, 1,000
    let f = w.trader(1); // the follower: 1,000, of which 750 is withdrawn again
    let (kp, dest) = (w.trader_kp(1), w.traders[&1].0.collateral);
    let vault = w.env.vault;
    w.send(vec![rclient::withdraw(&f, &dest, &vault, 750_000_000)], &[&kp]).unwrap();
    // Nothing to copy yet, and nobody is copying.
    assert!(trigger(&mut w, 1, 0, 0).is_err());
    set_copy(&mut w, 1, 0, 10_000, 0).unwrap();
    let c = copy(&w, 1).unwrap();
    assert_eq!((c.leader, { c.ratio_bps }), (w.traders[&0].1.wallet, 10_000));
    expect(trigger(&mut w, 1, 0, 0), RouterError::InLine);

    // The leader goes long 2,000 (2x). The follower's 250 at 2x is 500.
    w.taker_trade(0, 2_000 * U).unwrap();
    // The caller does not choose the size: not more, not the other way.
    expect(trigger(&mut w, 1, 0, 600 * U), RouterError::InvalidInstruction);
    w.tick(1);
    expect(trigger(&mut w, 1, 0, -100 * U), RouterError::InvalidInstruction);
    // Nor a sliver of it: the follower's one place in the queue is not anyone's to keep taken.
    w.tick(1);
    expect(trigger(&mut w, 1, 0, 100 * U), RouterError::InvalidInstruction);
    assert_eq!(percolator_router::social::MIN_COPY_PART, 4);
    let payer_before = w.env.svm.get_balance(&w.payer.pubkey()).unwrap();
    let wallet_before = w.env.svm.get_balance(&f.wallet).unwrap();
    w.tick(1);
    sync(&mut w, 1, 0).unwrap();
    let got = position(&w, 1);
    // (The fill before it cost the leader a fee, so its equity is a little under 1,000.)
    assert!((500 * U..502 * U).contains(&got), "follower holds {got}");
    assert_eq!({ copy(&w, 1).unwrap().triggers }, 1);
    // The bond and the request's rent went back to whoever queued it, not to the follower.
    assert_eq!(w.env.svm.get_balance(&f.wallet).unwrap(), wallet_before);
    assert!(payer_before - w.env.svm.get_balance(&w.payer.pubkey()).unwrap() < 200_000, "the caller only paid transaction fees");
    w.tick(1);
    expect(trigger(&mut w, 1, 0, 0), RouterError::InLine);

    // The leader halves: 1,000. The follower follows to about 250.
    w.taker_trade(0, -1_000 * U).unwrap();
    sync(&mut w, 1, 0).unwrap();
    assert!((249 * U..252 * U).contains(&position(&w, 1)), "follower holds {}", position(&w, 1));
    // The leader turns short 1,000: the follower turns with it, in one trade.
    w.taker_trade(0, -2_000 * U).unwrap();
    sync(&mut w, 1, 0).unwrap();
    assert!((-252 * U..-248 * U).contains(&position(&w, 1)), "follower holds {}", position(&w, 1));
    // The leader is out: so is the follower.
    w.taker_trade(0, 1_000 * U).unwrap();
    sync(&mut w, 1, 0).unwrap();
    assert_eq!(position(&w, 1), 0);
}

#[test]
fn a_copy_is_the_followers_to_set_and_to_end() {
    let mut w = live();
    w.trader(0);
    let f = w.trader(1);
    w.trader(2);
    // Limits: a ratio of 0 or above 3x, or copying oneself, makes no copy.
    expect(set_copy(&mut w, 1, 0, 0, 0), RouterError::InvalidInstruction);
    expect(set_copy(&mut w, 1, 0, 30_001, 0), RouterError::InvalidInstruction);
    expect(set_copy(&mut w, 1, 1, 10_000, 0), RouterError::InvalidInstruction);
    // Half the leader's leverage, at most 100 on a market.
    set_copy(&mut w, 1, 0, 5_000, 100_000_000).unwrap();
    w.taker_trade(0, 2_000 * U).unwrap();
    sync(&mut w, 1, 0).unwrap();
    assert_eq!(position(&w, 1), 100 * U, "limited to 100 of notional at 1.00");
    // Nobody else can stop it or change its terms.
    let other = w.trader_kp(2);
    let mut stop = rclient::stop_copy(&w.traders[&2].1);
    stop.accounts[1].pubkey = rstate::copy_address(&RID(), &f.market, &f.wallet).0;
    expect(w.send(vec![stop], &[&other]), RouterError::BadAccount);
    // Another leader: one at a time, and the count starts again.
    set_copy(&mut w, 1, 2, 10_000, 0).unwrap();
    let c = copy(&w, 1).unwrap();
    assert_eq!((c.leader, { c.triggers }), (w.traders[&2].1.wallet, 0));
    // Trader 2 holds nothing: the follower is brought to nothing.
    sync(&mut w, 1, 2).unwrap();
    assert_eq!(position(&w, 1), 0);
    // The old leader's account no longer moves the follower.
    w.tick(1);
    expect(trigger(&mut w, 1, 0, 0), RouterError::BadAccount);
    // Stopped: the position stays, and nobody can move it.
    let kp = w.trader_kp(1);
    w.send(vec![rclient::stop_copy(&f)], &[&kp]).unwrap();
    assert!(copy(&w, 1).is_none());
    assert!(trigger(&mut w, 1, 2, 0).is_err());
}

#[test]
fn a_copy_trade_is_an_ordinary_request() {
    let mut w = live();
    w.trader(0);
    w.trader(1);
    set_copy(&mut w, 1, 0, 30_000, 0).unwrap();
    // One request at a time, like any trader.
    w.taker_trade(0, 1_000 * U).unwrap();
    let id = w.request(1, 10 * U).unwrap();
    expect(trigger(&mut w, 1, 0, 0), RouterError::RequestPending);
    w.execute(1, id).unwrap();
    // The margin check is the same: 3x of a leader at 4x is more than the follower's margin takes.
    w.taker_trade(0, 3_000 * U).unwrap();
    expect(trigger(&mut w, 1, 0, 0), RouterError::InsufficientMargin);
    // A smaller step in the same direction is accepted, and fills at the price that arrives
    // after it was queued, like any trade.
    w.tick(1);
    let id = trigger(&mut w, 1, 0, 2_000 * U).unwrap();
    let (_, r) = w.request_account(id);
    assert_eq!(({ r.size }, r.kind), (2_000 * U, rstate::KIND_COPY));
    w.execute(1, id).unwrap();
    assert_eq!(position(&w, 1), 2_010 * U);
}

/// Prints every new instruction as the Rust builders make it, for fixed keys, so that the page's
/// builders (app/src/social.ts, app/src/chain.ts) can be compared with them byte for byte:
/// `cargo test --test social builders -- --nocapture` against `npx tsx scripts/social-check.ts`.
#[test]
fn builders_print_what_the_page_must_send() {
    use std::str::FromStr;
    let market = Pubkey::from_str(&std::env::var("CHECK_MARKET").unwrap_or("8ZMjDzhAgcV7zidvkRXM257Dp2HmzeNz7jpbTFvRE1Ls".into())).unwrap();
    let k = |n: u8| Pubkey::new_from_array([n; 32]);
    let (wallet, leader, payer, vault, token, pv) = (k(1), k(2), k(3), k(4), k(5), k(6));
    let t = rclient::TraderKeys::new(market, wallet);
    let show = |name: &str, ix: solana_sdk::instruction::Instruction| {
        let keys: Vec<String> = ix.accounts.iter().map(|a| format!("{}:{}{}", a.pubkey, if a.is_signer { "s" } else { "" }, if a.is_writable { "w" } else { "" })).collect();
        println!("IX {name} {} {}", ix.data.iter().map(|b| format!("{b:02x}")).collect::<String>(), keys.join(","));
    };
    show("open_stats", rclient::open_stats(&payer, &t));
    show("set_profile", rclient::set_profile(&wallet, "Satoshi_1", None, 3, 2));
    show("rename", rclient::set_profile(&wallet, "nakamoto", Some("Satoshi_1"), 11, 1));
    show("follow", rclient::follow(&wallet, &leader));
    show("unfollow", rclient::unfollow(&wallet, &leader));
    show("set_copy", rclient::set_copy(&t, &leader, 20_000, 250_000_000));
    show("stop_copy", rclient::stop_copy(&t));
    show("trigger_copy", rclient::trigger_copy(&payer, &t, &leader, &vault, -1_500_000));
    show("deposit", rclient::deposit(&t, &token, &pv, 7));
    show("withdraw", rclient::withdraw(&t, &token, &pv, 9));
}
