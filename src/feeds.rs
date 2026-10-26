//! Which price feeds a market may be opened on, and the risk tier of each.
//!
//! Opening a market is permissionless, but only on the feeds listed here: a thin market whose
//! price someone can push is not one the vault should quote at all. Each feed has a tier, and the
//! tier sets how much the vault may hold (`position_nav_bps`), how much one fill may add
//! (`fill_nav_bps`), how much insurance it keeps (`insurance_nav_bps`) and, in the router, the
//! leverage traders get. Majors are the deepest markets; stocks only have a price while their
//! exchanges are open, so their price can jump at the open.

/// Everything not listed below: up to 10x for traders, the vault holds at most 1x its value.
pub const TIER_DEFAULT: u8 = 0;
/// BTC and ETH (the same ids on Pyth and on X1's reported prices): 20x, the vault up to 3x.
pub const TIER_MAJOR: u8 = 1;
/// Stocks and the ETF (X1 only): a price only while their exchanges are open.
pub const TIER_STOCK: u8 = 2;

const fn hex_digit(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("hex"),
    }
}
pub const fn hex32(h: &str) -> [u8; 32] {
    let b = h.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = hex_digit(b[2 * i]) * 16 + hex_digit(b[2 * i + 1]);
        i += 1;
    }
    out
}

/// The majors.
pub const MAJOR_FEEDS: [[u8; 32]; 2] = [
    hex32("e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"), // BTC/USD
    hex32("ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace"), // ETH/USD
];

/// X1's stock and ETF markets (feed id = sha256("x1:" + symbol)).
pub const STOCK_FEEDS: [[u8; 32]; 11] = [
    hex32("6d1cb9acc057a81bbf43ce459ce7bdfc3db1a040b25718158bf6d9936025838f"), // TSLA
    hex32("d0316d5ef0f1e4bbcf08c8ec72444bf005412a87c5368e130feac8afd862d6c8"), // NVDA
    hex32("2a4b5bcc3a1a7b6633350fb2f75cc514c57a19071277b992cf4eef17bc20b69e"), // MSTR
    hex32("c98e089b103f2766952e1490d902cb3a811c700e0064d4cee7c2ba6abef37ce6"), // AAPL
    hex32("55fe35fea9478cdac31cff1c57883213faab338a84d1dca3d3b9ca8b91fe7e70"), // GOOGL
    hex32("fb1093c2bfb0c40661d0d6b7731d08cab10bf111a77103e05ff3567ad18d969a"), // META
    hex32("665db1539de0d2082e2c2aa72f62317b6f9a2e3d72fe7f9b041b93e31d7ac2f4"), // AMD
    hex32("7e2e57832cf14dd0ac3bc79fd2560cfe86f388ade5d9a4d00d1528b75456abec"), // COIN
    hex32("66020da42582157facbf93cc3d944e51c4f15c8a4effec7edf4a18b72c846a71"), // PLTR
    hex32("38853158dfc20e282627dbc05fc728756ba7e9d5f1d483a8aeccf0123e072372"), // SPCX
    hex32("2f9cfc1fca7825bbffe689fcbadd465aecbf42be88e090f0acd23ed427d57dfd"), // SPY
];

/// The feeds a market may be opened on in this build.
#[cfg(not(feature = "x1"))]
pub const LISTABLE: &[[u8; 32]] = &[
    hex32("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"), // SOL
    MAJOR_FEEDS[0],
    MAJOR_FEEDS[1],
    hex32("0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff"), // PYTH
    hex32("dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c"), // DOGE
    hex32("4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b"), // HYPE
    hex32("765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2"), // XAU
    hex32("a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b"), // EUR
];
#[cfg(feature = "x1")]
pub const LISTABLE: &[[u8; 32]] = &[
    hex32("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"), // SOL
    MAJOR_FEEDS[0],
    MAJOR_FEEDS[1],
    hex32("4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b"), // HYPE
    hex32("765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2"), // XAU
    hex32("e8ecabe1b6c5da82b3a4d5139699da03fb89342705688370b5ac124d91124bb7"), // XAG
    hex32("18ef2a004058135517c775c4e45e8c6ae6b6583336c70902329127f87a6d7d81"), // ZEC
    hex32("c7263494c2cf4f1f14575d26864d06f9d9718ebc7c1af2fc28506ef19415b392"), // FARTCOIN
    STOCK_FEEDS[0], STOCK_FEEDS[1], STOCK_FEEDS[2], STOCK_FEEDS[3], STOCK_FEEDS[4], STOCK_FEEDS[5],
    STOCK_FEEDS[6], STOCK_FEEDS[7], STOCK_FEEDS[8], STOCK_FEEDS[9], STOCK_FEEDS[10],
];

/// The test harness's feed, listable only in test builds (they are built without `devnet`).
#[cfg(not(feature = "devnet"))]
pub const TEST_FEED: [u8; 32] = [7; 32];

/// True when a market may be opened on `feed` in this build.
pub fn listable(feed: &[u8; 32]) -> bool {
    #[cfg(not(feature = "devnet"))]
    if *feed == TEST_FEED {
        return true;
    }
    LISTABLE.iter().any(|f| f == feed)
}

/// The tier of a feed (compiled in: nobody chooses it).
pub fn tier_of_feed(feed: &[u8; 32]) -> u8 {
    if MAJOR_FEEDS.iter().any(|f| f == feed) {
        TIER_MAJOR
    } else if STOCK_FEEDS.iter().any(|f| f == feed) {
        TIER_STOCK
    } else {
        TIER_DEFAULT
    }
}

/// The tier whose limits the vault applies to a feed: `tier_of_feed`, except that test builds give
/// the harness's feed a major's limits, so the integration tests keep the vault's widest limits
/// (the other tiers' limits are covered by unit tests of `math::fill_caps`). The router's leverage
/// always follows `tier_of_feed`.
pub fn cap_tier(feed: &[u8; 32]) -> u8 {
    #[cfg(not(feature = "devnet"))]
    if *feed == TEST_FEED {
        return TIER_MAJOR;
    }
    tier_of_feed(feed)
}

/// The most the vault may hold on a feed, as basis points of its value in notional.
pub fn position_nav_bps(tier: u8) -> u16 {
    if tier == TIER_MAJOR { 30_000 } else { 10_000 }
}
/// The most one fill may add to the vault's position, as basis points of its value in notional.
pub fn fill_nav_bps(tier: u8) -> u16 {
    if tier == TIER_MAJOR { 7_500 } else { 2_500 }
}
/// The share of the vault's value its asset's insurance keeps (deployed builds; the test build
/// keeps only the floor, see `processor::INSURANCE_NAV_BPS`).
pub fn insurance_nav_bps(tier: u8) -> u64 {
    if tier == TIER_MAJOR { 300 } else { 800 }
}

/// Ordinary trades may use this share (bps) of the vault's position limit; the rest is kept for
/// trades that close a trader's position, liquidations among them, so that a liquidation is never
/// refused because the vault is full.
pub const TRADE_ROOM_BPS: u128 = 8_000;
/// A fill that adds to the vault's position may add at most this share of what one fill could add
/// when the vault is flat, scaled down in line with the room left (never below `MIN_FILL_BPS`):
/// the more one-sided the vault already is, the less each further trade on the crowded side gets.
pub const MIN_FILL_BPS: u128 = 1_000;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tiers() {
        assert_eq!(tier_of_feed(&MAJOR_FEEDS[0]), TIER_MAJOR);
        assert_eq!(tier_of_feed(&STOCK_FEEDS[0]), TIER_STOCK);
        assert_eq!(tier_of_feed(&LISTABLE[0]), TIER_DEFAULT);
        assert!(listable(&MAJOR_FEEDS[1]));
        assert!(!listable(&[9; 32]));
    }
}
