//! Liquidation tape (2026-11-07): each vault keeps its last `TAPE_LEN` liquidations (when, how much,
//! which side), written by the router itself at every fill that liquidates, so that a standing
//! order can trigger on liquidations (`ORDER_LIQ`: "buy once $50,000 of longs were liquidated in
//! the last minute"). A fill never fails over it: without the tape account it records nothing.
use bytemuck::{Pod, Zeroable};
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey, system_program};

use crate::state::*;
use crate::*;

pub const TAPE_MAGIC: u64 = u64::from_le_bytes(*b"PRLQTAPE");
pub const SEED_TAPE: &[u8] = b"liqtape";
pub const TAPE_LEN: usize = 32;

#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct TapeEntry {
    /// Unix seconds.
    pub time: i64,
    /// Collateral atoms of notional closed.
    pub notional: u64,
    /// +1: a long was liquidated (sold), -1: a short (bought).
    pub side: i8,
    pub _pad: [u8; 7],
}

#[derive(Clone, Copy, Pod, Zeroable, Debug)]
#[repr(C, packed)]
pub struct Tape {
    pub magic: u64,
    pub vault: Pubkey,
    /// Where the next entry goes.
    pub head: u8,
    pub bump: u8,
    pub _pad: [u8; 6],
    pub entries: [TapeEntry; TAPE_LEN],
}
pub const TAPE_ACCOUNT_LEN: usize = core::mem::size_of::<Tape>();

pub fn tape_address(program_id: &Pubkey, vault: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_TAPE, vault.as_ref()], program_id)
}

/// `OpenLiqTape` (anyone, the payer pays the rent): starts a vault's tape. Does nothing if it is
/// open already. Accounts: 0 payer [s, w], 1 vault, 2 tape [w], 3 system program.
pub fn open_tape(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (payer, vault_ai, tape_ai, system) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?, acc(accounts, 3)?);
    signer(payer)?;
    writable(tape_ai)?;
    key_is(system, &system_program::ID)?;
    load_vault(vault_ai)?;
    let (tk, bump) = tape_address(program_id, vault_ai.key);
    key_is(tape_ai, &tk)?;
    if tape_ai.owner == program_id {
        return Ok(());
    }
    create_pda(payer, tape_ai, system, program_id, TAPE_ACCOUNT_LEN, 0, &[SEED_TAPE, vault_ai.key.as_ref(), &[bump]])?;
    let mut t = Tape::zeroed();
    t.magic = TAPE_MAGIC;
    t.vault = *vault_ai.key;
    t.bump = bump;
    store(tape_ai, &t)
}

/// The vault's tape among `accounts`, when passed writable (found by its address).
fn find<'a, 'b>(program_id: &Pubkey, accounts: &'b [AccountInfo<'a>], vault: &Pubkey) -> Option<&'b AccountInfo<'a>> {
    let tk = tape_address(program_id, vault).0;
    accounts.iter().find(|a| *a.key == tk && a.owner == program_id && a.data_len() == TAPE_ACCOUNT_LEN)
}

/// Records a liquidation that traded `traded` (asset atoms, signed) at `price` (e6), if the tape
/// was passed. Never fails the fill.
#[inline(never)]
pub(crate) fn record(program_id: &Pubkey, accounts: &[AccountInfo], vault: &Pubkey, now: i64, traded: i128, price: u64) {
    let Some(ai) = find(program_id, accounts, vault) else { return };
    if !ai.is_writable || traded == 0 {
        return;
    }
    let Ok(mut t) = load::<Tape>(ai, program_id, TAPE_MAGIC) else { return };
    let notional = (traded.unsigned_abs().saturating_mul(price as u128) / POS_SCALE).min(u64::MAX as u128) as u64;
    let i = t.head as usize % TAPE_LEN;
    // A long liquidated is sold (traded < 0).
    t.entries[i] = TapeEntry { time: now, notional, side: if traded < 0 { 1 } else { -1 }, _pad: [0; 7] };
    t.head = ((i + 1) % TAPE_LEN) as u8;
    let _ = store(ai, &t);
}

/// What was liquidated on `side` (+1 longs, -1 shorts) since `since` (unix seconds), in collateral
/// atoms of notional, from the vault's tape among `accounts` (None without it).
#[inline(never)]
pub(crate) fn liquidated_since(program_id: &Pubkey, accounts: &[AccountInfo], vault: &Pubkey, side: i8, since: i64) -> Option<u128> {
    let ai = find(program_id, accounts, vault)?;
    let t: Tape = load(ai, program_id, TAPE_MAGIC).ok()?;
    let entries = t.entries;
    Some(entries.iter().filter(|e| e.time >= since && e.time != 0 && e.side == side).map(|e| e.notional as u128).sum())
}
