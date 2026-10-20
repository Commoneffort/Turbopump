//! Prices posted on chain by a reporter key, for when verified Pyth prices are not available.
//!
//! The router keeps one account per feed that only the reporter can write (`PostPrice`). Unlike
//! a Pyth update nothing on chain can check such a price: whoever holds the reporter key is
//! trusted for the price and for the publish times it reports. It is therefore used narrowly.
//! On Solana it is a fallback: the router accepts it only for a queued request that Pyth has
//! failed to serve for `FALLBACK_SECS`. In an X1 build (`x1` feature), where there is no Pyth, it
//! is the price source.

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use crate::{error::VaultError, pyth::PriceUpdate, ROUTER_PROGRAM_ID};

/// The key allowed to post prices. Deployments (the `devnet` feature, which also compiles in the
/// deployed Percolator id; an X1 deployment is `devnet,x1`) use the operator's reporter key.
/// Test builds, with or without `x1`, use a fixed test key (the ed25519 key of seed `[42; 32]`);
/// they talk to the test harness's Percolator id and cannot run on a real chain.
#[cfg(feature = "devnet")]
pub const REPORTER: Pubkey = solana_program::pubkey!("9KhhASTNPmDGy1M2TeLRhEEbFUzy8wgTz9g4cijViXuk");
#[cfg(not(feature = "devnet"))]
pub const REPORTER: Pubkey = solana_program::pubkey!("2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ");
/// The witness: a second key, run apart from the reporter with its own price source, that posts
/// its own price for each feed. In an X1 build a reported price only moves a mark when the
/// witness's price for that feed is recent (`WITNESS_SECS`) and agrees (`WITNESS_BPS`), so
/// neither one key nor one price source can move a market alone. Test builds use the key of seed
/// `[43; 32]`.
#[cfg(feature = "devnet")]
pub const WITNESS: Pubkey = solana_program::pubkey!("DQA2FE6ZSPHCRxLVgi4G4fb5X61D9s2phbF589TDdvvZ");
#[cfg(not(feature = "devnet"))]
pub const WITNESS: Pubkey = solana_program::pubkey!("5eUm8K9YiCqAxtyZgmmN1NGhmD3D2C9Azp2Za7nxwhiN");
/// Most seconds between the witness's publish time and the reported price's.
pub const WITNESS_SECS: i64 = 30;
/// Most the two prices may differ, in bps of the reported one.
pub const WITNESS_BPS: u64 = 150;
pub const SEED_WITNESS: &[u8] = b"witness";

/// The witness's price account for a feed (same layout as the reporter's).
pub fn witness_address(feed: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_WITNESS, feed], &ROUTER_PROGRAM_ID)
}

/// Reads the witness's price for `feed`.
pub fn read_witness(ai: &AccountInfo, feed: &[u8; 32]) -> Result<PriceUpdate, VaultError> {
    if *ai.owner != ROUTER_PROGRAM_ID || *ai.key != witness_address(feed).0 {
        return Err(VaultError::BadOracle);
    }
    let u = decode(&ai.try_borrow_data().map_err(|_| VaultError::BadOracle)?)?;
    if u.feed_id != *feed {
        return Err(VaultError::BadOracle);
    }
    Ok(u)
}

/// True when the witness's price `w` confirms the reported price `u`.
pub fn witness_agrees(u: &PriceUpdate, w: &PriceUpdate) -> bool {
    if (u.publish_time - w.publish_time).abs() > WITNESS_SECS || u.price <= 0 || w.price <= 0 {
        return false;
    }
    let (a, b) = (u.price as u128, w.price as u128);
    a.abs_diff(b) * 10_000 <= a * WITNESS_BPS as u128
}

/// How long a queued request's target must have passed without a Pyth price before a reported
/// price may serve it (Solana builds).
pub const FALLBACK_SECS: i64 = 20;

pub const REPORT_MAGIC: u64 = 0x5052_4943_4552_5054; // "PRICERPT"
pub const SEED_REPORT: &[u8] = b"report";
/// magic u64, feed [32], price_e6 u64, publish_time i64, prev_publish_time i64, bump u8, pad 7.
pub const REPORT_LEN: usize = 8 + 32 + 8 + 8 + 8 + 8;
pub const REPORT_FEED_OFF: usize = 8;
pub const REPORT_PRICE_OFF: usize = 40;
pub const REPORT_PUBLISH_OFF: usize = 48;
pub const REPORT_PREV_OFF: usize = 56;
pub const REPORT_BUMP_OFF: usize = 64;

/// The router's price account for a feed.
pub fn report_address(feed: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SEED_REPORT, feed], &ROUTER_PROGRAM_ID)
}

pub fn decode(data: &[u8]) -> Result<PriceUpdate, VaultError> {
    if data.len() != REPORT_LEN || data[..8] != REPORT_MAGIC.to_le_bytes() {
        return Err(VaultError::BadOracle);
    }
    let rd8 = |o: usize| <[u8; 8]>::try_from(&data[o..o + 8]).unwrap();
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(&data[REPORT_FEED_OFF..REPORT_FEED_OFF + 32]);
    let price = i64::try_from(u64::from_le_bytes(rd8(REPORT_PRICE_OFF))).map_err(|_| VaultError::BadOracle)?;
    Ok(PriceUpdate {
        feed_id,
        price,
        conf: 0,
        exponent: -6,
        publish_time: i64::from_le_bytes(rd8(REPORT_PUBLISH_OFF)),
        prev_publish_time: i64::from_le_bytes(rd8(REPORT_PREV_OFF)),
    })
}

/// Reads the reported price for `feed` from the router's account for it.
pub fn read(ai: &AccountInfo, feed: &[u8; 32]) -> Result<PriceUpdate, VaultError> {
    if *ai.owner != ROUTER_PROGRAM_ID || *ai.key != report_address(feed).0 {
        return Err(VaultError::BadOracle);
    }
    let u = decode(&ai.try_borrow_data().map_err(|_| VaultError::BadOracle)?)?;
    if u.feed_id != *feed {
        return Err(VaultError::BadOracle);
    }
    Ok(u)
}

/// True when `ai` is a reported-price account rather than a Pyth update.
pub fn is_report(ai: &AccountInfo) -> bool {
    *ai.owner == ROUTER_PROGRAM_ID
}
