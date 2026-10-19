//! Spot swaps through xDEX, X1's exchange, with the platform's fee taken on chain.
//!
//! xDEX is a copy of Raydium's constant-product swap program (same accounts, same instruction,
//! same pool layout). `Swap` takes `SWAP_FEE_BPS` of what the wallet pays in, sends it to a
//! token account the treasury owns, and swaps the rest with xDEX's own `swap_base_input`. The
//! wallet signs for both; the router holds nothing and signs nothing. After the swap the router
//! checks what actually arrived in the wallet's output account (after any Token-2022 transfer
//! fee), so `min_out` is what the wallet receives, not what xDEX sent.

use super::*;

/// The platform's fee on a swap, in bps of what is paid in (20 = 0.2%), on top of the pool's own.
pub const SWAP_FEE_BPS: u64 = 20;

/// xDEX on the network this router is built for.
#[cfg(feature = "x1")]
pub const XDEX_PROGRAM: Pubkey = solana_program::pubkey!("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
#[cfg(not(feature = "x1"))]
pub const XDEX_PROGRAM: Pubkey = solana_program::pubkey!("9VBpPJ8GMyttp46TtoiKDaYjY3yPbJbW6c37R66fQgxD");
/// X1 mainnet's xDEX (not used by these test builds; here so the address is written down once).
pub const XDEX_PROGRAM_X1_MAINNET: Pubkey = solana_program::pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");

pub const TOKEN_2022: Pubkey = solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Anchor's name for `swap_base_input`: the first 8 bytes of sha256("global:swap_base_input").
pub const SWAP_BASE_INPUT: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];

/// The platform's cut of `amount_in`, rounded up (a swap of any size pays at least one atom).
pub fn swap_fee(amount_in: u64) -> u64 {
    ((amount_in as u128 * SWAP_FEE_BPS as u128 + 9_999) / 10_000) as u64
}

fn is_token_program(k: &Pubkey) -> bool {
    *k == spl_token::ID || *k == TOKEN_2022
}

/// A token account's (mint, owner, amount), for either token program. Both share the first 165
/// bytes; byte 108 is the state (1 = initialized).
fn token_account(ai: &AccountInfo) -> Result<(Pubkey, Pubkey, u64), RouterError> {
    if !is_token_program(ai.owner) {
        return Err(RouterError::BadAccount);
    }
    let d = ai.try_borrow_data().map_err(|_| RouterError::BadAccount)?;
    if d.len() < 165 || d[108] != 1 {
        return Err(RouterError::BadAccount);
    }
    let k = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
    Ok((k(0), k(32), u64::from_le_bytes(d[64..72].try_into().unwrap())))
}

/// Swaps `amount_in` of one token for at least `min_out` of the other on an xDEX pool, paying
/// `swap_fee(amount_in)` of it to the treasury first.
///
/// Accounts: 0 wallet [signer], 1 fee account [w] (a token account of the input mint owned by
/// `processor::TREASURY`), 2 xDEX program, then xDEX's `swap_base_input` accounts in its order:
/// 3 payer (= the wallet) [signer], 4 pool authority, 5 amm config, 6 pool [w], 7 input token
/// account [w], 8 output token account [w], 9 input vault [w], 10 output vault [w], 11 input
/// token program, 12 output token program, 13 input mint, 14 output mint, 15 observation [w].
/// Data: amount_in u64 (fee included), min_out u64 (received in account 8).
pub(crate) fn swap(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let amount_in = data.get(0..8).map(|b| u64::from_le_bytes(b.try_into().unwrap())).ok_or(RouterError::InvalidInstruction)?;
    let min_out = data.get(8..16).map(|b| u64::from_le_bytes(b.try_into().unwrap())).ok_or(RouterError::InvalidInstruction)?;
    let wallet = acc(accounts, 0)?;
    let fee_ai = acc(accounts, 1)?;
    let xdex = acc(accounts, 2)?;
    let payer = acc(accounts, 3)?;
    let input_ai = acc(accounts, 7)?;
    let output_ai = acc(accounts, 8)?;
    let input_program = acc(accounts, 11)?;
    let input_mint = acc(accounts, 13)?;
    acc(accounts, 15)?;
    signer(wallet)?;
    key_is(xdex, &XDEX_PROGRAM)?;
    key_is(payer, wallet.key)?;
    writable(fee_ai)?;
    if !is_token_program(input_program.key) || input_mint.owner != input_program.key || fee_ai.owner != input_program.key {
        return Err(RouterError::BadAccount.into());
    }
    let (fee_mint, fee_owner, _) = token_account(fee_ai)?;
    if fee_mint != *input_mint.key || fee_owner != percolator_vault::processor::TREASURY {
        return Err(RouterError::BadAccount.into());
    }
    let fee = swap_fee(amount_in);
    let rest = amount_in.checked_sub(fee).filter(|r| *r > 0).ok_or(RouterError::InvalidInstruction)?;
    let decimals = *input_mint.try_borrow_data()?.get(44).ok_or(RouterError::BadAccount)?;

    // The fee: TransferChecked (tag 12), the same instruction in both token programs.
    let mut fee_data = vec![12u8];
    fee_data.extend_from_slice(&fee.to_le_bytes());
    fee_data.push(decimals);
    invoke(
        &Instruction {
            program_id: *input_program.key,
            accounts: vec![
                AccountMeta::new(*input_ai.key, false),
                AccountMeta::new_readonly(*input_mint.key, false),
                AccountMeta::new(*fee_ai.key, false),
                AccountMeta::new_readonly(*wallet.key, true),
            ],
            data: fee_data,
        },
        &[input_ai.clone(), input_mint.clone(), fee_ai.clone(), wallet.clone(), input_program.clone()],
    )?;

    // The swap, with xDEX's own accounts passed through as the wallet gave them.
    let (_, _, before) = token_account(output_ai)?;
    let pass = &accounts[3..16];
    let mut swap_data = SWAP_BASE_INPUT.to_vec();
    swap_data.extend_from_slice(&rest.to_le_bytes());
    swap_data.extend_from_slice(&min_out.to_le_bytes());
    let metas = pass
        .iter()
        .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable })
        .collect();
    let mut infos = pass.to_vec();
    infos.push(xdex.clone());
    invoke(&Instruction { program_id: XDEX_PROGRAM, accounts: metas, data: swap_data }, &infos)?;
    let (_, _, after) = token_account(output_ai)?;
    if after.saturating_sub(before) < min_out {
        return Err(RouterError::Slippage.into());
    }
    msg!("swap: {} in, fee {}, {} out", amount_in, fee, after - before);
    Ok(())
}
