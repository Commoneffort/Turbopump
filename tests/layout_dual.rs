//! The vault and router read Percolator market accounts in both engine layouts: the one before
//! engine c030aa4 (asset slot 1813 bytes) and the current one (1877), so they keep working
//! across the one-shot migration (Percolator tag 73).
//!
//! Fixtures: the six live testnet markets on 2026-11-20 (v1 layout) and 24 X1 portfolios with
//! open legs. Each market is migrated with Percolator's own migration code, and every reader
//! must return the same answer on the v1 bytes and on the migrated bytes.

use percolator_vault::percolator as perc;
use solana_sdk::{account_info::AccountInfo, pubkey::Pubkey};
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/layout_v1")
}

fn markets() -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<_> = std::fs::read_dir(dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().ends_with(".bin") && !p.to_string_lossy().contains("portfolios"))
        .map(|p| (p.file_stem().unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()))
        .collect();
    out.sort();
    assert_eq!(out.len(), 6);
    out
}

fn portfolios() -> Vec<Vec<u8>> {
    let all = std::fs::read(dir().join("x1_portfolios.bin")).unwrap();
    assert_eq!(all.len() % perc::PORTFOLIO_ACCOUNT_LEN, 0);
    all.chunks(perc::PORTFOLIO_ACCOUNT_LEN).map(|c| c.to_vec()).collect()
}

fn migrated(old: &[u8]) -> Vec<u8> {
    let (cap, _) = percolator_prog::state::layout_v1_market(old).expect("v1 market");
    let mut new = old.to_vec();
    new.resize(percolator_prog::state::market_account_len_for_capacity(cap).unwrap(), 0);
    percolator_prog::state::migrate_layout_v1_slots_in_place(&mut new, cap).expect("migrates");
    new
}

fn insurance(data: &[u8], asset: u16) -> (u64, u128) {
    let key = Pubkey::new_unique();
    let owner = perc::PERCOLATOR_PROGRAM_ID;
    let mut lamports = 1u64;
    let mut d = data.to_vec();
    let ai = AccountInfo::new(&key, false, false, &mut lamports, &mut d, &owner, false, 0);
    perc::asset_insurance(&ai, asset).unwrap()
}

#[test]
fn every_reader_agrees_across_the_migration() {
    let pfs = portfolios();
    let mut open_positions = 0;
    for (name, old) in markets() {
        let new = migrated(&old);
        assert_eq!(perc::market_slot_len(old.len()).unwrap(), perc::MARKET_ASSET_SLOT_LEN_V1, "{name}");
        assert_eq!(perc::market_slot_len(new.len()).unwrap(), perc::MARKET_ASSET_SLOT_LEN, "{name}");
        let cap = ((old.len() - perc::MARKET_SLOTS_OFF) / perc::MARKET_ASSET_SLOT_LEN_V1) as u16;
        assert_eq!(perc::policy_sequence(&old).unwrap(), perc::policy_sequence(&new).unwrap(), "{name}");
        for a in 0..cap {
            let price = perc::asset_price(&old, a).unwrap();
            assert_eq!(price, perc::asset_price(&new, a).unwrap(), "{name} asset {a}: price");
            assert_eq!(perc::asset_cohort(&old, a).unwrap(), perc::asset_cohort(&new, a).unwrap(), "{name} asset {a}: cohort");
            assert_eq!(perc::asset_close_only(&old, a).unwrap(), perc::asset_close_only(&new, a).unwrap(), "{name} asset {a}");
            assert_eq!(perc::asset_sequences(&old, a).unwrap(), perc::asset_sequences(&new, a).unwrap(), "{name} asset {a}");
            assert_eq!(perc::authority_funding(&old, a).unwrap(), perc::authority_funding(&new, a).unwrap(), "{name} asset {a}");
            assert_eq!(insurance(&old, a), insurance(&new, a), "{name} asset {a}: insurance");
            if price.1 != 0 {
                for p in &pfs {
                    assert_eq!(perc::crank_work(&old, p, a, price.2).unwrap(), perc::crank_work(&new, p, a, price.2).unwrap(), "{name} asset {a}");
                }
            }
        }
        for p in &pfs {
            let before = perc::positions(&old, p).unwrap();
            assert_eq!(before, perc::positions(&new, p).unwrap(), "{name}: positions");
            open_positions += before.iter().filter(|x| x.size != 0).count();
        }
        // A listing grows the account in its own layout.
        assert_eq!(perc::market_account_len_for_slots(old.len(), cap as usize + 1).unwrap(), old.len() + perc::MARKET_ASSET_SLOT_LEN_V1);
        assert_eq!(perc::market_account_len_for_slots(new.len(), cap as usize + 1).unwrap(), new.len() + perc::MARKET_ASSET_SLOT_LEN);
    }
    assert!(open_positions > 0, "the fixtures exercise open positions");
}

#[test]
fn v1_offsets_read_the_live_values() {
    // Spot checks of v1 offsets against values decoded from the same live accounts with the
    // pre-c030aa4 engine on 2026-11-20 (X1 main market 281YHBA8, asset 4: A = ADL_ONE both sides).
    let (_, old) = markets().into_iter().find(|(n, _)| n.contains("281YHBA8")).unwrap();
    assert!(!perc::asset_close_only(&old, 4).unwrap());
    let new = migrated(&old);
    assert!(!perc::asset_close_only(&new, 4).unwrap());
    // Bytes that are not a market in either layout are refused.
    assert!(perc::market_slot_len(perc::MARKET_SLOTS_OFF + 1000).is_err());
}

/// The vault's `MigrateMarketLayout` (tag 46): anyone moves a governed live market to the
/// current layout; the market's governor signs Percolator's tag 73 and the payer adds the rent.
#[test]
fn vault_migrates_each_governed_live_market_once() {
    use litesvm::LiteSVM;
    use solana_sdk::{
        account::Account,
        instruction::{AccountMeta, Instruction},
        rent::Rent,
        signature::{Keypair, Signer},
        transaction::Transaction,
    };
    use std::str::FromStr;
    let root = env!("CARGO_MANIFEST_DIR");
    let vault_so = format!("{root}/target/deploy/percolator_vault.so");
    let perc_so = format!("{root}/../percolator-prog/target/deploy/percolator_prog.so");
    for (name, old) in markets() {
        let key = Pubkey::from_str(name.split('_').nth(1).unwrap()).unwrap();
        let mut svm = LiteSVM::new();
        svm.add_program(perc::PERCOLATOR_PROGRAM_ID, &std::fs::read(&perc_so).unwrap());
        svm.add_program(percolator_vault::id(), &std::fs::read(&vault_so).unwrap());
        let old_rent = Rent::default().minimum_balance(old.len());
        svm.set_account(key, Account { lamports: old_rent, data: old.clone(), owner: perc::PERCOLATOR_PROGRAM_ID, executable: false, rent_epoch: 0 }).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        let ix = |governor: Pubkey| Instruction {
            program_id: percolator_vault::id(),
            accounts: vec![
                AccountMeta::new_readonly(governor, false),
                AccountMeta::new(key, false),
                AccountMeta::new_readonly(perc::PERCOLATOR_PROGRAM_ID, false),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            ],
            data: vec![percolator_vault::processor::TAG_MIGRATE_MARKET_LAYOUT],
        };
        let mut send = |svm: &mut LiteSVM, governor: Pubkey| {
            svm.expire_blockhash();
            let tx = Transaction::new_signed_with_payer(&[ix(governor)], Some(&payer.pubkey()), &[&payer], svm.latest_blockhash());
            svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err))
        };
        let governor = Pubkey::find_program_address(&[b"governor", key.as_ref()], &percolator_vault::id()).0;
        assert_eq!(&old[16..48], governor.as_ref(), "{name}: governed by the vault program");
        assert!(send(&mut svm, Pubkey::new_unique()).is_err(), "{name}: another governor refused");
        assert_eq!(svm.get_account(&key).unwrap().data, old, "{name}: unchanged");
        send(&mut svm, governor).unwrap_or_else(|e| panic!("{name}: {e}"));
        let after = svm.get_account(&key).unwrap();
        assert_eq!(after.data, migrated(&old), "{name}: exactly Percolator's migration");
        assert!(after.lamports >= Rent::default().minimum_balance(after.data.len()), "{name}: rent paid");
        assert!(send(&mut svm, governor).is_err(), "{name}: only once");
        assert_eq!(svm.get_account(&key).unwrap().data, after.data);
    }
}
