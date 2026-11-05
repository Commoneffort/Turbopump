//! The risk dial: how much tighter than normal a fill that adds risk is held, from 1 (normal) to
//! `percolator_vault::math::MAX_DIAL`. At dial `d` the vault gives a fill that grows its position
//! `d` times less room, and a trader needs `d` times the usual margin to open (so at most a
//! `d`-th of the usual leverage). Closing a position, liquidations included, is never dialled.
//!
//! Two things raise it, and the higher one counts:
//! - **Price sources disagree.** Pyth's confidence interval, or on X1 the gap between the
//!   reported price and the witness's, measured each time the mark moves (`price_dial`). A wide
//!   one means the market is moving fast or thin, which is when a gap is most likely.
//! - **A stock market is about to close, or is closed** (`hours_dial`, stock tier only). A stock's
//!   price cannot move while its exchange is shut and jumps at the next open, past whatever
//!   margin was thin: the dial is 2 outside US regular hours and 3 over the weekend.
//!   US exchange holidays are not known here; they count as an ordinary weekday.

use percolator_vault::feeds::TIER_STOCK;
use percolator_vault::math::MAX_DIAL;

/// Disagreement (bps of the price) at which the price dial reaches 2, 3 and 4.
pub const PRICE_STEPS_BPS: [u64; 3] = [20, 40, 70];

/// The dial from how far the price sources disagree, in bps of the price.
pub fn price_dial(disagreement_bps: u64) -> u8 {
    1 + PRICE_STEPS_BPS.iter().filter(|s| disagreement_bps >= **s).count() as u8
}

/// Slot time (X1): how fast the price moved between two marks, in bps per `SPEED_SLOTS` slots
/// (about a second), over at least that many slots so that one quick tick is not blown up. It
/// counts like a disagreement between sources (`PRICE_STEPS_BPS`): the dial reaches 2 when the
/// price moves 0.2% in about a second. In calm markets X1's majors move 1 to 4 bps a second.
pub const SPEED_SLOTS: i64 = 3;
pub fn speed_bps(last: u64, price: u64, slots: i64) -> u64 {
    if last == 0 {
        return 0;
    }
    let moved = (price as u128).abs_diff(last as u128).saturating_mul(10_000) / last as u128;
    let per = moved.saturating_mul(SPEED_SLOTS as u128) / slots.max(SPEED_SLOTS) as u128;
    per.min(10_000) as u64
}

/// US regular hours in UTC seconds of the day, taken wide enough for both summer and winter
/// time: the dial is normal from 13:30 (the summer open) to 19:00 (an hour before the summer
/// close, two before the winter one).
pub const OPEN_UTC: i64 = 13 * 3600 + 1800;
pub const CALM_UNTIL_UTC: i64 = 19 * 3600;

/// The dial from the time (unix seconds) for a feed of `tier`: 1 off the stock tier and in US
/// regular hours, 3 from Friday 19:00 to Monday 13:30 UTC, 2 at every other time.
pub fn hours_dial(tier: u8, now: i64) -> u8 {
    if tier != TIER_STOCK {
        return 1;
    }
    let day = now.div_euclid(86_400);
    let secs = now.rem_euclid(86_400);
    // 1970-01-01 was a Thursday: weekday 0 = Monday.
    let weekday = (day + 3).rem_euclid(7);
    let weekend = match weekday {
        4 => secs >= CALM_UNTIL_UTC,
        5 | 6 => true,
        0 => secs < OPEN_UTC,
        _ => false,
    };
    if weekend {
        3
    } else if (OPEN_UTC..CALM_UNTIL_UTC).contains(&secs) {
        1
    } else {
        2
    }
}

/// The dial a fill uses: the higher of the one stored with the mark and the hours one, at most
/// `MAX_DIAL`; 0 (a book written before the dial existed) counts as 1.
pub fn dial(stored: u8, tier: u8, now: i64) -> u8 {
    stored.max(hours_dial(tier, now)).clamp(1, MAX_DIAL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use percolator_vault::feeds::{TIER_DEFAULT, TIER_MAJOR};

    // 2026-11-02 was a Monday.
    const MON: i64 = 1_793_577_600;
    const H: i64 = 3600;

    #[test]
    fn monday_is_a_monday() {
        assert_eq!((MON / 86_400 + 3) % 7, 0);
    }

    #[test]
    fn price_steps() {
        assert_eq!(price_dial(0), 1);
        assert_eq!(price_dial(19), 1);
        assert_eq!(price_dial(20), 2);
        assert_eq!(price_dial(40), 3);
        assert_eq!(price_dial(70), 4);
        assert_eq!(price_dial(10_000), 4);
    }

    #[test]
    fn speed() {
        assert_eq!(speed_bps(0, 5, 3), 0);
        assert_eq!(speed_bps(1_000_000, 1_000_000, 3), 0);
        // 0.3% in 3 slots, and in 1 slot (counted over 3): 30 bps a second.
        assert_eq!(speed_bps(1_000_000, 1_003_000, 3), 30);
        assert_eq!(speed_bps(1_000_000, 997_000, 1), 30);
        // The same move over 30 slots: 3 bps a second.
        assert_eq!(speed_bps(1_000_000, 1_003_000, 30), 3);
        assert_eq!(price_dial(speed_bps(1_000_000, 1_002_000, 3)), 2);
        assert_eq!(speed_bps(1, u64::MAX, 3), 10_000);
    }

    #[test]
    fn hours_only_for_stocks() {
        for t in [MON, MON + 5 * 86_400, MON + 2 * H] {
            assert_eq!(hours_dial(TIER_MAJOR, t), 1);
            assert_eq!(hours_dial(TIER_DEFAULT, t), 1);
        }
    }

    #[test]
    fn stock_hours() {
        assert_eq!(hours_dial(TIER_STOCK, MON + 13 * H), 3); // Monday before the open
        assert_eq!(hours_dial(TIER_STOCK, MON + 14 * H), 1);
        assert_eq!(hours_dial(TIER_STOCK, MON + 19 * H), 2); // the last hours of the day
        assert_eq!(hours_dial(TIER_STOCK, MON + 86_400 + 3 * H), 2); // Tuesday night
        assert_eq!(hours_dial(TIER_STOCK, MON + 4 * 86_400 + 15 * H), 1); // Friday afternoon
        assert_eq!(hours_dial(TIER_STOCK, MON + 4 * 86_400 + 19 * H), 3); // Friday close
        assert_eq!(hours_dial(TIER_STOCK, MON + 5 * 86_400 + 12 * H), 3); // Saturday
        assert_eq!(hours_dial(TIER_STOCK, MON + 6 * 86_400 + 23 * H), 3); // Sunday night
    }

    #[test]
    fn combined() {
        assert_eq!(dial(0, TIER_MAJOR, MON + 14 * H), 1);
        assert_eq!(dial(3, TIER_MAJOR, MON + 14 * H), 3);
        assert_eq!(dial(2, TIER_STOCK, MON + 5 * 86_400), 3);
        assert_eq!(dial(9, TIER_MAJOR, MON), MAX_DIAL);
    }
}
