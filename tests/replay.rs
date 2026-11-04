//! Replays real trading from the X1 fill log (`tests/replay-data/`, extracted from
//! `deploy/logs/fills-x1.jsonl`) through the vault and the router, with the real sequence of
//! traders, sizes and prices, and checks after every fill that no money appears or disappears:
//! - Percolator's token account holds what its books say it holds, and that covers every
//!   account's capital, the insurance and the profit it has booked (`stray` >= 0);
//! - the vault's tracked position is what Percolator says it holds, and the traders' positions
//!   and the vault's add up to zero;
//! - at the end, after everyone closed, every token minted is still somewhere.

#![cfg(not(feature = "x1"))]

mod common;
use common::*;
use percolator_vault::percolator as perc;
use percolator_router::client as rclient;
use solana_sdk::signature::Signer;

struct Row {
    trader: usize,
    price_e6: u64,
    size: i128,
}

fn rows(name: &str) -> Vec<Row> {
    let text = std::fs::read_to_string(format!("{}/tests/replay-data/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    text.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| {
            let f: Vec<i128> = l.split(',').map(|x| x.trim().parse().unwrap()).collect();
            // Prices are relative to the first fill; sizes are dollars of notional at that price.
            // The test asset starts at 1.00, so a dollar of notional is one unit.
            let price_e6 = (INITIAL_PRICE as i128 * f[2] / 1_000_000) as u64;
            Row { trader: f[0] as usize, price_e6, size: f[3] }
        })
        .collect()
}

fn header(w: &World) -> (i128, i128) {
    let h = w.env.primary_market_state().1;
    (h.vault as i128, h.vault as i128 - h.c_tot as i128 - h.insurance as i128 - h.pnl_pos_tot as i128)
}

fn held(w: &World, portfolio: &solana_sdk::pubkey::Pubkey) -> i128 {
    let m = w.env.svm.get_account(&w.env.market).unwrap().data;
    let d = w.env.svm.get_account(portfolio).unwrap().data;
    perc::positions(&m, &d).unwrap().iter().map(|p| p.size).sum()
}

fn check(w: &World, step: usize, traders: &[usize]) {
    let (books, stray) = header(w);
    let tokens = w.tokens(w.env.vault) as i128;
    assert_eq!(tokens, books, "step {step}: Percolator's token account differs from its books");
    assert!(stray >= 0, "step {step}: Percolator owes {} more than it holds", -stray);
    let lp = held(w, &w.portfolio);
    let inv = { w.vault_state().inventory };
    assert_eq!(inv, lp, "step {step}: the vault's tracked position is not Percolator's");
    let sum: i128 = traders.iter().map(|t| held(w, &w.taker_portfolio(*t))).sum();
    assert_eq!(sum + lp, 0, "step {step}: positions do not add up");
}

#[test]
fn replay_x1_asset4_fills() {
    replay("x1-asset4.csv");
}

#[test]
fn replay_x1_asset5_fills() {
    replay("x1-asset5.csv");
}

#[test]
fn replay_x1_asset6_fills() {
    replay("x1-asset6.csv");
}

fn replay(name: &str) {
    let rows = rows(name);
    let mut w = World::with_config(devnet_like_config());
    w.env.set_clock(5, 1_000);
    w.operate();
    let alice = w.new_user(400_000_000_000);
    w.deposit(&alice, 200_000_000_000).unwrap(); // 200,000 USDC
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();

    // One funded router account per real wallet (20,000 USDC each: the largest real fill is
    // about $16k of notional).
    let mut traders: Vec<usize> = rows.iter().map(|r| r.trader).collect();
    traders.sort();
    traders.dedup();
    for &i in &traders {
        let u = w.new_user(40_000_000_000);
        let t = rclient::TraderKeys::new(w.env.market, u.kp.pubkey());
        let mint = w.env.mint;
        w.send(
            vec![rclient::open_account(&t, &mint), rclient::open_ledger(&t.wallet, &t), rclient::deposit(&t, &u.collateral, &w.env.vault, 20_000_000_000)],
            &[&u.kp],
        )
        .unwrap();
        w.traders.insert(i, (u, t));
    }
    let wallets: Vec<_> = traders.iter().map(|i| w.traders[i].0.collateral).collect();
    let everywhere = |w: &World| -> u128 {
        let mut keys = vec![w.env.vault, w.buffer, alice.collateral];
        keys.extend(wallets.iter().copied());
        keys.iter().map(|k| w.tokens(*k) as u128).sum()
    };
    let start = everywhere(&w);
    check(&w, 0, &traders);

    let (mut filled, mut refused, mut partial) = (0, 0, 0);
    for (step, r) in rows.iter().enumerate() {
        if r.price_e6 != w.price {
            w.move_price(20, r.price_e6);
        }
        // The keepers renew the vault's matcher approval as it nears its end (it lapses in
        // `matcher_ttl_slots`); hours of real trading outlast it.
        w.refresh_matcher();
        let before = held(&w, &w.taker_portfolio(r.trader));
        match w.taker_trade(r.trader, r.size) {
            Ok(_) => {
                let traded = held(&w, &w.taker_portfolio(r.trader)) - before;
                if traded == r.size { filled += 1 } else if traded == 0 { refused += 1 } else { partial += 1 }
            }
            Err(e) if e.contains(&format!("{:#x}", percolator_router::RouterError::InsufficientMargin as u32)) => refused += 1,
            Err(e) => panic!("step {step}: {e}"),
        }
        check(&w, step + 1, &traders);
    }
    println!("{name}: replayed {} fills: {filled} filled in full, {partial} partly, {refused} refused", rows.len());
    assert!(filled > rows.len() / 2, "most real fills should replay");

    // Everyone closes; then every token is still somewhere (Percolator, the vault, the wallets;
    // what traders hold in Percolator is in its token account).
    for &i in &traders {
        w.close_position(i).unwrap();
    }
    check(&w, rows.len() + 1, &traders);
    assert_eq!(held(&w, &w.portfolio), 0, "the vault is flat once everyone closed");
    assert_eq!(everywhere(&w), start, "tokens were created or lost");
    let _ = w.payer.pubkey();
}
