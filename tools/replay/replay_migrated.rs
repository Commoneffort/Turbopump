//! Replays recorded live transactions (REPLAY_TXS_DIR, written by the scratch recorder: accounts.jsonl,
//! txs.jsonl, programs/*.so, meta.json) on two Percolator binaries (REPLAY_OLD, REPLAY_NEW) and
//! compares every transaction's result and every account's final bytes. Without REPLAY_TXS_DIR
//! the test does nothing. Local tool, not part of the suite.
//!
//! Migration mode (REPLAY_MIGRATE=1): before the NEW run, every v1-layout market account in the
//! snapshot is moved to the current layout with Percolator's own migration code (tag 73), and
//! REPLAY_NEW_PROGRAMS ("id=path,id=path") replaces other programs (the new vault and router).
//! Final market accounts of the OLD run are migrated the same way before they are compared.
use litesvm::LiteSVM;
use solana_sdk::{
    account::Account, clock::Clock, message::VersionedMessage, pubkey::Pubkey,
    signature::Signature, transaction::VersionedTransaction,
};
use std::collections::BTreeMap;
use std::str::FromStr;

const PERC: &str = "8o3uV87X2CvPYfPwM1sxeaYYE7sGWsTUiEy7SskEMM3P";
const UPGRADEABLE: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> u32 {
        match c { b'A'..=b'Z' => (c - b'A') as u32, b'a'..=b'z' => (c - b'a' + 26) as u32, b'0'..=b'9' => (c - b'0' + 52) as u32, b'+' => 62, b'/' => 63, _ => 0 }
    };
    let b = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(b.len() * 3 / 4);
    for ch in b.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in ch.iter().enumerate() { n |= val(c) << (18 - 6 * i); }
        out.push((n >> 16) as u8);
        if ch.len() > 2 { out.push((n >> 8) as u8); }
        if ch.len() > 3 { out.push(n as u8); }
    }
    out
}

struct Run {
    results: Vec<Result<u64, String>>,
    state: BTreeMap<Pubkey, Account>,
}

fn migrate_market(data: &[u8]) -> Option<Vec<u8>> {
    let (cap, _) = percolator_prog::state::layout_v1_market(data).ok()?;
    let mut new = data.to_vec();
    new.resize(percolator_prog::state::market_account_len_for_capacity(cap).ok()?, 0);
    percolator_prog::state::migrate_layout_v1_slots_in_place(&mut new, cap).ok()?;
    Some(new)
}

fn run(dir: &str, perc_so: &str) -> Run {
    run_with(dir, perc_so, &[], false)
}

fn run_with(dir: &str, perc_so: &str, overrides: &[(Pubkey, String)], migrate: bool) -> Run {
    let mut svm = LiteSVM::new().with_sigverify(false);
    // Programs: recorded bytes, Percolator from the binary under test.
    for e in std::fs::read_dir(format!("{dir}/programs")).unwrap() {
        let p = e.unwrap().path();
        let id = Pubkey::from_str(p.file_stem().unwrap().to_str().unwrap()).unwrap();
        let bytes = if id.to_string() == PERC {
            std::fs::read(perc_so).unwrap()
        } else if let Some((_, path)) = overrides.iter().find(|(k, _)| *k == id) {
            std::fs::read(path).unwrap()
        } else {
            std::fs::read(&p).unwrap()
        };
        svm.add_program(id, &bytes);
    }
    if !std::path::Path::new(&format!("{dir}/programs/{PERC}.so")).exists() {
        svm.add_program(Pubkey::from_str(PERC).unwrap(), &std::fs::read(perc_so).unwrap());
    }
    let mut tracked = Vec::new();
    for line in std::fs::read_to_string(format!("{dir}/accounts.jsonl")).unwrap().lines() {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        let owner = v["owner"].as_str().unwrap();
        if v["exec"].as_bool().unwrap_or(false) || owner == UPGRADEABLE {
            continue;
        }
        let k = Pubkey::from_str(v["k"].as_str().unwrap()).unwrap();
        let mut data = b64(v["data"].as_str().unwrap());
        let mut lamports = v["lamports"].as_u64().unwrap();
        if migrate && owner == PERC {
            if let Some(new) = migrate_market(&data) {
                lamports = lamports.max(solana_sdk::rent::Rent::default().minimum_balance(new.len()));
                data = new;
                println!("migrated market {k}");
            }
        }
        svm.set_account(
            k,
            Account {
                lamports,
                data,
                owner: Pubkey::from_str(owner).unwrap(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        tracked.push(k);
    }
    let mut results = Vec::new();
    for line in std::fs::read_to_string(format!("{dir}/txs.jsonl")).unwrap().lines() {
        let v: serde_json::Value = serde_json::from_str(line).unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.slot = v["slot"].as_u64().unwrap();
        clock.unix_timestamp = v["time"].as_i64().unwrap_or(clock.unix_timestamp);
        svm.set_sysvar(&clock);
        let msg: VersionedMessage = bincode::deserialize(&b64(v["tx"].as_str().unwrap())).unwrap();
        let sigs: Vec<Signature> = v["sigs"].as_array().unwrap().iter().map(|s| Signature::from_str(s.as_str().unwrap()).unwrap()).collect();
        let tx = VersionedTransaction { signatures: sigs, message: msg };
        let r = match svm.send_transaction(tx) {
            Ok(m) => Ok(m.compute_units_consumed),
            Err(e) => Err(format!("{:?}", e.err)),
        };
        results.push(r);
        svm.expire_blockhash();
    }
    let state = tracked.into_iter().filter_map(|k| svm.get_account(&k).map(|a| (k, a))).collect();
    Run { results, state }
}

#[test]
fn replay_txs() {
    let Ok(dir) = std::env::var("REPLAY_TXS_DIR") else { return };
    let old = std::env::var("REPLAY_OLD").unwrap();
    let new = std::env::var("REPLAY_NEW").unwrap();
    let live: Vec<bool> = std::fs::read_to_string(format!("{dir}/txs.jsonl")).unwrap().lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["err"].is_null()).collect();
    let migrate = std::env::var("REPLAY_MIGRATE").is_ok();
    let overrides: Vec<(Pubkey, String)> = std::env::var("REPLAY_NEW_PROGRAMS").unwrap_or_default().split(',').filter(|s| !s.is_empty())
        .map(|s| { let (k, p) = s.split_once('=').unwrap(); (Pubkey::from_str(k).unwrap(), p.to_string()) }).collect();
    let mut a = run(&dir, &old);
    let b = run_with(&dir, &new, &overrides, migrate);
    if migrate {
        for (k, acc) in a.state.iter_mut() {
            if acc.owner.to_string() == PERC {
                if let Some(m) = migrate_market(&acc.data) { acc.data = m; } else if percolator_prog::state::layout_v1_market(&acc.data).is_ok() { println!("old final market {k} no longer migrates"); }
            }
        }
    }
    let n = live.len();
    let ok = |r: &Vec<Result<u64, String>>| r.iter().filter(|x| x.is_ok()).count();
    let old_vs_live = (0..n).filter(|&i| a.results[i].is_ok() != live[i]).count();
    let mut diff_result = 0;
    let mut diff_cu = 0;
    let mut errs: BTreeMap<String, usize> = BTreeMap::new();
    for i in 0..n {
        match (&a.results[i], &b.results[i]) {
            (Ok(x), Ok(y)) => { if x != y { diff_cu += 1; } }
            (Err(x), Err(y)) => { if x != y { diff_result += 1; println!("tx {i}: old {x} new {y}"); } else { *errs.entry(x.clone()).or_default() += 1; } }
            (x, y) => { diff_result += 1; println!("tx {i}: old {x:?} new {y:?}"); }
        }
    }
    let mut diff_acc = 0;
    let mut perc_acc = 0;
    for (k, x) in &a.state {
        let y = b.state.get(k);
        if x.owner.to_string() == PERC { perc_acc += 1; }
        if y.map(|y| y.data != x.data || (!migrate && y.lamports != x.lamports)).unwrap_or(true) {
            diff_acc += 1;
            if diff_acc <= 20 { println!("account {k} (owner {}) differs", x.owner); }
        }
    }
    println!("REPLAY txs {n}: live ok {}, old ok {}, new ok {}; old!=live {old_vs_live}; result diffs {diff_result}; cu diffs {diff_cu}", live.iter().filter(|x| **x).count(), ok(&a.results), ok(&b.results));
    println!("REPLAY accounts {} (percolator {perc_acc}), differing {diff_acc}", a.state.len());
    println!("REPLAY same errors both: {errs:?}");
}
