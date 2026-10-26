//! Funding is off (`CANON_MAX_FUNDING_E9` = 0): `SetFundingCap` switches it off on a market where
//! it was on, after which fills push no rate and trading goes on as time passes.
mod common;

use common::*;
use percolator_router::funding::FUNDING_MAX_E9;
use percolator_vault::{client, error::VaultError, percolator as perc, processor};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    signature::{Keypair, Signer},
};

/// A funded vault (50 USDC at 1.00, the test feed's major limits: 150 units), its market handed
/// to the program's governor.
fn governed() -> World {
    let mut w = World::with_config(devnet_like_config());
    w.env.set_clock(5, 1_000);
    w.operate();
    let alice = w.new_user(100_000_000);
    w.deposit(&alice, 50_000_000).unwrap();
    w.advance(EPOCH_LEN, INITIAL_PRICE);
    w.roll().unwrap();
    w.claim(&alice, 0).unwrap();
    w.env.update_market_authority_from_admin(4).unwrap();
    let admin = w.env.actors[4].signer.insecure_clone();
    let epoch0 = w.env.primary_control_sequences(0).authority_epoch;
    w.send(vec![client::accept_governance(&pid(), &admin.pubkey(), &w.env.market, epoch0)], &[&admin]).unwrap();
    w
}

fn market(w: &World) -> Vec<u8> {
    w.env.market_data(false)
}
fn cap(w: &World) -> u64 {
    perc::max_abs_funding_e9(&market(w)).unwrap()
}
fn rate(w: &World) -> i64 {
    perc::authority_funding(&market(w), w.asset()).unwrap().0
}
/// The market as the live ones were after funding was switched on: its cap at 40.
fn with_cap_40(w: &mut World) {
    let mut a = w.env.svm.get_account(&w.env.market).unwrap();
    let at = perc::MARKET_CONFIG_OFF + perc::CONFIG_MAX_ABS_FUNDING_E9;
    a.data[at..at + 8].copy_from_slice(&40u64.to_le_bytes());
    w.env.svm.set_account(w.env.market, a).unwrap();
    assert_eq!(cap(w), 40);
}
/// Lets `slots` pass with the asset kept up to date (a keeper's cranks, 100 slots at a time).
fn pass(w: &mut World, slots: u64) {
    let asset = w.asset();
    let mut left = slots;
    while left > 0 {
        let step = left.min(100);
        w.tick(step);
        let slot = w.env.current_slot();
        w.catch_up(asset, slot, &[]);
        left -= step;
    }
    w.refresh_matcher(); // the test build's matcher approval is short, and lapses meanwhile
}

#[test]
fn funding_is_off_and_set_funding_cap_switches_it_off() {
    let mut w = governed();
    assert_eq!(processor::CANON_MAX_FUNDING_E9, 0);
    assert_eq!(cap(&w), 0, "a market starts without funding");
    assert!(w.send(vec![client::set_funding_cap(&pid(), &w.env.market)], &[]).is_err(), "nothing to change on a market without funding");

    // A market whose funding was switched on: anyone switches it off, and only off.
    with_cap_40(&mut w);
    w.send(vec![client::set_funding_cap(&pid(), &w.env.market)], &[]).unwrap();
    assert_eq!(cap(&w), 0);
    assert!(w.send(vec![client::set_funding_cap(&pid(), &w.env.market)], &[]).is_err(), "nothing left to change");

    // Traders crowd the long side (the vault short 100 of its 150): no rate is pushed, and trades
    // keep filling as time passes.
    w.taker_trade(1, 50 * UNIT as i128).unwrap();
    w.taker_trade(2, 50 * UNIT as i128).unwrap();
    assert_eq!(rate(&w), 0, "no cap, no funding");
    for i in 0..5 {
        pass(&mut w, 300);
        w.taker_trade(3, if i % 2 == 0 { UNIT as i128 } else { -(UNIT as i128) }).unwrap();
        assert_eq!(rate(&w), 0);
    }
}

#[test]
fn only_the_router_pushes_a_rate() {
    let mut w = governed();
    let anyone = Keypair::new();
    w.env.svm.airdrop(&anyone.pubkey(), 1_000_000_000).unwrap();
    let mut data = vec![processor::TAG_PUSH_FUNDING];
    data.extend_from_slice(&(FUNDING_MAX_E9).to_le_bytes());
    let ix = Instruction {
        program_id: pid(),
        accounts: vec![
            AccountMeta::new_readonly(anyone.pubkey(), true),
            AccountMeta::new_readonly(w.vault, false),
            AccountMeta::new(w.env.market, false),
            AccountMeta::new_readonly(perc::PERCOLATOR_PROGRAM_ID, false),
        ],
        data,
    };
    let err = w.send(vec![ix], &[&anyone]).unwrap_err();
    assert!(err.contains(&format!("{:#x}", VaultError::NotRouter as u32)), "{err}");
    // The router's own refresh does nothing on a market without funding, and fails nothing.
    w.taker_trade(1, 60 * UNIT as i128).unwrap();
    w.tick(50);
    let refresh = Instruction {
        program_id: percolator_router::id(),
        accounts: vec![
            AccountMeta::new_readonly(w.vault, false),
            AccountMeta::new(w.env.market, false),
            AccountMeta::new_readonly(percolator_router::state::authority_address(&percolator_router::id()).0, false),
            AccountMeta::new_readonly(pid(), false),
            AccountMeta::new_readonly(perc::PERCOLATOR_PROGRAM_ID, false),
        ],
        data: vec![percolator_router::TAG_REFRESH_FUNDING],
    };
    w.send(vec![refresh], &[]).unwrap();
    assert_eq!(rate(&w), 0);
}
