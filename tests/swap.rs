//! Spot swaps through xDEX (router `Swap`), against the real xDEX program and a copy of a real
//! pool from the network the router is built for (devnet, or X1 testnet with `--features x1`).
//! Both pools pair a classic SPL token (wrapped SOL / XNT) with a Token-2022 token, so both token
//! programs are exercised as input and as output.

use litesvm::LiteSVM;
use percolator_router::{
    client::{self as rclient, XdexPool},
    swap::{swap_fee, SWAP_FEE_BPS, TOKEN_2022},
    RouterError,
};
use percolator_vault::processor::TREASURY;
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program,
    sysvar::clock::Clock,
    transaction::Transaction,
};
use std::str::FromStr;

// (The router library in a test build is the default one, so the program is named here.)
#[cfg(not(feature = "x1"))]
const XDEX_PROGRAM: Pubkey = solana_sdk::pubkey!("9VBpPJ8GMyttp46TtoiKDaYjY3yPbJbW6c37R66fQgxD");
#[cfg(feature = "x1")]
const XDEX_PROGRAM: Pubkey = solana_sdk::pubkey!("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
#[cfg(not(feature = "x1"))]
const XDEX_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/xdex/xdex_devnet.so");
#[cfg(not(feature = "x1"))]
const POOL_JSON: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/xdex/devnet_pool.json");
#[cfg(not(feature = "x1"))]
const ROUTER_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy/percolator_router.so");
#[cfg(feature = "x1")]
const XDEX_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/xdex/xdex_x1.so");
#[cfg(feature = "x1")]
const POOL_JSON: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/xdex/x1_pool.json");
#[cfg(feature = "x1")]
const ROUTER_SO: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy-x1-test/percolator_router.so");

const ATA_PROGRAM: Pubkey = solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

fn code(e: RouterError) -> String {
    format!("custom program error: {:#x}", e as u32)
}

fn ata(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), program.as_ref(), mint.as_ref()], &ATA_PROGRAM).0
}
fn create_ata(payer: &Pubkey, owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Instruction {
    Instruction {
        program_id: ATA_PROGRAM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(ata(owner, mint, program), false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(*program, false),
        ],
        data: vec![1],
    }
}

struct Env {
    svm: LiteSVM,
    user: Keypair,
    pool: XdexPool,
    /// What the pool charges, out of 1,000,000 (its amm config).
    pool_fee_rate: u64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(percolator_router::id(), &std::fs::read(ROUTER_SO).expect("build the router with cargo build-sbf first"));
        svm.add_program(XDEX_PROGRAM, &std::fs::read(XDEX_SO).unwrap());
        let j: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(POOL_JSON).unwrap()).unwrap();
        for (k, a) in j["accounts"].as_object().unwrap() {
            let data = hex_decode(a["hex"].as_str().unwrap());
            svm.set_account(
                Pubkey::from_str(k).unwrap(),
                Account {
                    lamports: a["lamports"].as_u64().unwrap(),
                    data,
                    owner: Pubkey::from_str(a["owner"].as_str().unwrap()).unwrap(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        }
        let pk = Pubkey::from_str(j["keys"]["pool"].as_str().unwrap()).unwrap();
        let pool = XdexPool::from_data(XDEX_PROGRAM, pk, &svm.get_account(&pk).unwrap().data);
        let cfg = svm.get_account(&pool.amm_config).unwrap().data;
        let pool_fee_rate = u64::from_le_bytes(cfg[12..20].try_into().unwrap());
        // Now, so the pool is open and its price observations move forward.
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = 1_792_000_000;
        svm.set_sysvar(&clock);
        let user = Keypair::new();
        svm.airdrop(&user.pubkey(), 100_000_000_000).unwrap();
        let mut e = Env { svm, user, pool, pool_fee_rate };
        // The user's accounts of both tokens and the treasury's, the way the page makes them.
        let u = e.user.pubkey();
        let p = e.pool;
        let ixs = vec![
            create_ata(&u, &u, &p.mint0, &p.program0),
            create_ata(&u, &u, &p.mint1, &p.program1),
            create_ata(&u, &TREASURY, &p.mint0, &p.program0),
            create_ata(&u, &TREASURY, &p.mint1, &p.program1),
        ];
        e.send(ixs, &[]).unwrap();
        e
    }

    fn send(&mut self, ixs: Vec<Instruction>, extra: &[&Keypair]) -> Result<u64, String> {
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(400_000)];
        all.extend(ixs);
        let mut s = vec![&self.user];
        s.extend_from_slice(extra);
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(&all, Some(&self.user.pubkey()), &s, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|m| m.compute_units_consumed)
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    fn amount(&self, k: &Pubkey) -> u64 {
        let d = self.svm.get_account(k).map(|a| a.data).unwrap_or_default();
        if d.len() < 72 { 0 } else { u64::from_le_bytes(d[64..72].try_into().unwrap()) }
    }

    fn mine(&self, zero: bool) -> Pubkey {
        let p = self.pool;
        if zero { ata(&self.user.pubkey(), &p.mint0, &p.program0) } else { ata(&self.user.pubkey(), &p.mint1, &p.program1) }
    }
    fn treasury(&self, zero: bool) -> Pubkey {
        let p = self.pool;
        if zero { ata(&TREASURY, &p.mint0, &p.program0) } else { ata(&TREASURY, &p.mint1, &p.program1) }
    }

    /// Wraps `lamports` of the chain's coin into the user's token-0 account (wrapped SOL / XNT).
    fn wrap(&mut self, lamports: u64) {
        let a = self.mine(true);
        let ixs = vec![
            system_instruction::transfer(&self.user.pubkey(), &a, lamports),
            Instruction { program_id: spl_token::ID, accounts: vec![AccountMeta::new(a, false)], data: vec![17] },
        ];
        self.send(ixs, &[]).unwrap();
    }

    /// What the pool pays for `amount` after the platform's fee (the page's quote): the pool's
    /// constant-product price on its reserves net of the fees it holds for others.
    fn quote(&self, zero_for_one: bool, amount_in: u64) -> u64 {
        let d = self.svm.get_account(&self.pool.pool).unwrap().data;
        let q = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) as u128;
        let r0 = self.amount(&self.pool.vault0) as u128 - q(341) - q(357);
        let r1 = self.amount(&self.pool.vault1) as u128 - q(349) - q(365);
        let (rin, rout) = if zero_for_one { (r0, r1) } else { (r1, r0) };
        let x = (amount_in - swap_fee(amount_in)) as u128;
        let pool_fee = (x * self.pool_fee_rate as u128 + 999_999) / 1_000_000;
        let x = x - pool_fee;
        (x * rout / (rin + x)) as u64
    }

    fn swap_ix(&self, zero_for_one: bool, amount_in: u64, min_out: u64) -> Instruction {
        rclient::swap(&self.user.pubkey(), &self.treasury(zero_for_one), &self.pool, zero_for_one, &self.mine(zero_for_one), &self.mine(!zero_for_one), amount_in, min_out)
    }
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn swap_pays_the_platform_fee_and_delivers_the_quote_both_ways() {
    let mut e = Env::new();
    assert_eq!(e.pool.program0, spl_token::ID);
    assert_eq!(e.pool.program1, TOKEN_2022);
    e.wrap(2_000_000_000);

    // Coin -> Token-2022 token.
    let amount = 1_000_000_000;
    let want = e.quote(true, amount);
    assert!(want > 0);
    let (in0, out0, fee0) = (e.amount(&e.mine(true)), e.amount(&e.mine(false)), e.amount(&e.treasury(true)));
    let ix = e.swap_ix(true, amount, want);
    let cu = e.send(vec![ix], &[]).unwrap();
    assert_eq!(e.amount(&e.mine(true)), in0 - amount, "the wallet pays exactly amount_in");
    assert_eq!(e.amount(&e.treasury(true)) - fee0, swap_fee(amount), "the treasury gets the platform fee");
    assert_eq!(swap_fee(amount), amount * SWAP_FEE_BPS / 10_000);
    assert_eq!(e.amount(&e.mine(false)) - out0, want, "the wallet gets the page's quote exactly");
    println!("swap 0->1: {cu} CU");

    // And back: a Token-2022 input pays its fee through Token-2022.
    let back = (e.amount(&e.mine(false)) - out0) / 2;
    let want = e.quote(false, back);
    let (in1, out1, fee1) = (e.amount(&e.mine(false)), e.amount(&e.mine(true)), e.amount(&e.treasury(false)));
    let ix = e.swap_ix(false, back, want);
    e.send(vec![ix], &[]).unwrap();
    assert_eq!(e.amount(&e.mine(false)), in1 - back);
    assert_eq!(e.amount(&e.treasury(false)) - fee1, swap_fee(back));
    assert_eq!(e.amount(&e.mine(true)) - out1, want);
}

#[test]
fn a_swap_that_would_deliver_less_than_min_out_fails_and_charges_nothing() {
    let mut e = Env::new();
    e.wrap(1_000_000_000);
    let amount = 500_000_000;
    let want = e.quote(true, amount);
    let (in0, fee0) = (e.amount(&e.mine(true)), e.amount(&e.treasury(true)));
    let ix = e.swap_ix(true, amount, want + 1);
    let r = e.send(vec![ix], &[]).unwrap_err();
    // xDEX refuses first (its own ExceededSlippage, 6005 = 0x1775), before the router's check.
    assert!(r.contains("custom program error: 0x1775"), "{r}");
    assert_eq!(e.amount(&e.mine(true)), in0);
    assert_eq!(e.amount(&e.treasury(true)), fee0);
}

#[test]
fn the_fee_must_go_to_the_treasury_in_the_input_token() {
    let mut e = Env::new();
    e.wrap(1_000_000_000);
    let amount = 100_000_000;
    // A fee account the swapper owns.
    let u = e.user.pubkey();
    let mut ix = e.swap_ix(true, amount, 0);
    ix.accounts[1].pubkey = e.mine(true);
    let r = e.send(vec![ix], &[]).unwrap_err();
    assert!(r.contains(&code(RouterError::BadAccount)), "{r}");
    // The treasury's account of the other token.
    let mut ix = e.swap_ix(true, amount, 0);
    ix.accounts[1].pubkey = e.treasury(false);
    let r = e.send(vec![ix], &[]).unwrap_err();
    assert!(r.contains(&code(RouterError::BadAccount)), "{r}");
    // Someone else's account of the input token.
    let other = Keypair::new();
    let ixs = vec![create_ata(&u, &other.pubkey(), &e.pool.mint0, &e.pool.program0)];
    e.send(ixs, &[]).unwrap();
    let mut ix = e.swap_ix(true, amount, 0);
    ix.accounts[1].pubkey = ata(&other.pubkey(), &e.pool.mint0, &e.pool.program0);
    let r = e.send(vec![ix], &[]).unwrap_err();
    assert!(r.contains(&code(RouterError::BadAccount)), "{r}");
}

#[test]
fn only_xdex_and_only_for_the_signing_wallet() {
    let mut e = Env::new();
    e.wrap(1_000_000_000);
    // Another program in xDEX's place (here: the token program).
    let mut ix = e.swap_ix(true, 100_000_000, 0);
    ix.accounts[2].pubkey = spl_token::ID;
    let r = e.send(vec![ix], &[]).unwrap_err();
    assert!(r.contains(&code(RouterError::BadAccount)), "{r}");
    // xDEX's payer is not the wallet that signed the router instruction.
    let other = Keypair::new();
    e.svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
    let mut ix = e.swap_ix(true, 100_000_000, 0);
    ix.accounts[3] = AccountMeta::new(other.pubkey(), true);
    let r = e.send(vec![ix], &[&other]).unwrap_err();
    assert!(r.contains(&code(RouterError::BadAccount)), "{r}");
    // Nothing to swap after the fee.
    let ix = e.swap_ix(true, 1, 0);
    let r = e.send(vec![ix], &[]).unwrap_err();
    assert!(r.contains(&code(RouterError::InvalidInstruction)), "{r}");
}
