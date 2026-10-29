//! What traders owe the vault besides Percolator's trading fee: a holding fee for the crowded
//! side, an extra fee on trades that make the vault's position bigger, and a fee on liquidations.
//!
//! Why here and not in Percolator: Percolator's funding marks every position stale whenever its
//! rate moves, and then refuses trades (it was switched off for that, 2026-10-20); its trading
//! fee is one rate for the whole market; and the matcher's price only sizes that fee (positions
//! are booked at the oracle price). So the router keeps the account itself:
//!
//! - Each vault has a meter (`Carry`). While the vault holds more than `HOLD_FREE_BPS` of its
//!   position limit, the side it is against (traders' crowded side) owes a rate that rises in a
//!   straight line to `HOLD_MAX_E12` at the limit. The vault short means traders are net long,
//!   so longs owe; the other side owes nothing. The rate is set from the vault's position after
//!   every fill.
//! - Each trading account has a ledger (`Ledger`): per asset, what it owes and the meter reading
//!   its position was last settled at. Every fill on that asset settles the time held since.
//! - A fill that makes the vault's position bigger (not a trader's own close) adds `SIDE_FEE_BPS`
//!   of the part that grew it; a liquidation adds `LIQ_FEE_BPS` of what it closes.
//! - What is owed counts against the account's equity in the router's margin and liquidation
//!   checks, so a debt that grows reduces what the trader can hold, as funding would.
//! - It is paid into the vault (its buffer, where it adds to the depositors' value at the next
//!   roll) out of the trader's capital by `PayFees`, which anyone may send once the account holds
//!   no position (Percolator lets nothing leave an account with one open). A withdrawal is refused
//!   while anything is owed. A debt is never more than the account's equity after the fill that
//!   added to it, and what is left when the account is flat and empty is forgiven.
use super::*;

/// The holding fee's rate at the vault's whole limit: 0.01% of the position's value an hour
/// (e12 per second), about 88% a year. Half that at half the limit, and so on.
pub const HOLD_MAX_E12: u64 = 27_778;
/// Below this share (bps) of the vault's limit, nobody owes a holding fee.
pub const HOLD_FREE_BPS: u128 = 1_000;
/// Extra fee (bps) on the part of a new trade that makes the vault's position bigger.
pub const SIDE_FEE_BPS: u128 = 5;
/// Fee (bps) on what a liquidation closes.
pub const LIQ_FEE_BPS: u128 = 50;
const SCALE: u128 = 1_000_000_000_000_000_000; // POS_SCALE (1e6) x the rate's e12

/// The rate (signed: + longs owe, - shorts owe) for a vault holding `inventory` units against a
/// limit of `limit` units.
pub fn target_rate(inventory: i128, limit: u128) -> i64 {
    if inventory == 0 || limit == 0 {
        return 0;
    }
    let used = (inventory.unsigned_abs().saturating_mul(10_000) / limit).min(10_000);
    if used <= HOLD_FREE_BPS {
        return 0;
    }
    let rate = (HOLD_MAX_E12 as u128 * (used - HOLD_FREE_BPS) / (10_000 - HOLD_FREE_BPS)) as i64;
    // The vault short: traders are net long, and longs owe.
    if inventory < 0 { rate } else { -rate }
}

/// Brings the meter up to `now` at `price_e6`.
pub fn accrue(c: &mut Carry, price_e6: u64, now: i64) {
    let dt = now.saturating_sub(c.updated).max(0) as u128;
    let add = (price_e6 as u128).saturating_mul(c.rate_e12.unsigned_abs() as u128).saturating_mul(dt);
    if c.rate_e12 > 0 {
        c.index_long = c.index_long.saturating_add(add);
    } else if c.rate_e12 < 0 {
        c.index_short = c.index_short.saturating_add(add);
    }
    c.updated = c.updated.max(now);
}

/// The meter's sum for a position of sign `side` (0 has none).
pub fn index_for(c: &Carry, side: i128) -> u128 {
    if side > 0 { c.index_long } else if side < 0 { c.index_short } else { 0 }
}

/// What `size` units held from meter reading `snap` to `now_index` owe, in atoms.
pub fn owed_between(size: i128, snap: u128, now_index: u128) -> u64 {
    let d = now_index.saturating_sub(snap);
    let q = size.unsigned_abs();
    let atoms = match q.checked_mul(d) {
        Some(p) => p / SCALE,
        None => (d / SCALE).saturating_mul(q).saturating_add((d % SCALE).saturating_mul(q) / SCALE),
    };
    u64::try_from(atoms).unwrap_or(u64::MAX)
}

/// `bps` of the value of `units` at `price_e6`, in atoms.
pub fn fee_on(units: u128, price_e6: u64, bps: u128) -> u64 {
    let notional = units.saturating_mul(price_e6 as u128) / POS_SCALE;
    u64::try_from(notional.saturating_mul(bps) / 10_000).unwrap_or(u64::MAX)
}

// The ledger is edited in place in its account: copied whole it would not fit in a program's
// 4 KB stack frame next to a fill's own state.
const ENTRIES: usize = 48; // after magic, trader, bump, padding
const ENTRY: usize = core::mem::size_of::<LedgerEntry>();
const _: () = assert!(ENTRIES + LEDGER_SLOTS * ENTRY == LEDGER_LEN && ENTRY == 32);

/// A ledger's bytes, read and written field by field.
pub struct Entries<'r, 'd>(pub core::cell::RefMut<'r, &'d mut [u8]>);

fn rd<const N: usize>(d: &[u8], at: usize) -> [u8; N] {
    d[at..at + N].try_into().unwrap()
}

impl Entries<'_, '_> {
    pub fn asset(&self, i: usize) -> u16 { u16::from_le_bytes(rd(&self.0, ENTRIES + i * ENTRY)) }
    pub fn generation(&self, i: usize) -> u64 {
        let g: [u8; 6] = rd(&self.0, ENTRIES + i * ENTRY + 2);
        let mut b = [0u8; 8];
        b[..6].copy_from_slice(&g);
        u64::from_le_bytes(b)
    }
    pub fn owed(&self, i: usize) -> u64 { u64::from_le_bytes(rd(&self.0, ENTRIES + i * ENTRY + 8)) }
    pub fn snap(&self, i: usize) -> u128 { u128::from_le_bytes(rd(&self.0, ENTRIES + i * ENTRY + 16)) }
    pub fn set(&mut self, i: usize, asset: u16, generation: u64, owed: u64, snap: u128) {
        let at = ENTRIES + i * ENTRY;
        self.0[at..at + 2].copy_from_slice(&asset.to_le_bytes());
        self.0[at + 2..at + 8].copy_from_slice(&gen48(generation).to_le_bytes()[..6]);
        self.0[at + 8..at + 16].copy_from_slice(&owed.to_le_bytes());
        self.0[at + 16..at + 32].copy_from_slice(&snap.to_le_bytes());
    }
    pub fn total(&self) -> u64 {
        (0..LEDGER_SLOTS).filter(|&i| self.asset(i) != LEDGER_FREE).fold(0u64, |a, i| a.saturating_add(self.owed(i)))
    }
    /// The entry for `asset` in `generation` (an entry from before generations were recorded,
    /// 0, counts as the current one).
    pub fn find(&self, asset: u16, generation: u64) -> Option<usize> {
        (0..LEDGER_SLOTS).find(|&i| self.asset(i) == asset && (self.generation(i) == gen48(generation) || self.generation(i) == 0))
    }
    /// Whether `asset` has an entry or a free slot for one.
    pub fn has_room(&self, asset: u16, generation: u64) -> bool {
        self.find(asset, generation).is_some() || (0..LEDGER_SLOTS).any(|i| self.asset(i) == LEDGER_FREE)
    }
    /// The entry for `asset`, taking a free one if it has none (None when all are in use).
    pub fn slot(&mut self, asset: u16, generation: u64) -> Option<usize> {
        if let Some(i) = self.find(asset, generation) {
            return Some(i);
        }
        let i = (0..LEDGER_SLOTS).find(|&i| self.asset(i) == LEDGER_FREE)?;
        self.set(i, asset, generation, 0, 0);
        Some(i)
    }
}

fn gen48(generation: u64) -> u64 {
    generation & 0xFFFF_FFFF_FFFF
}

/// A ledger's entries, writable (the account must be the ledger: see `ledger_in`).
pub fn entries<'r, 'd>(ai: &'r AccountInfo<'d>) -> Result<Entries<'r, 'd>, ProgramError> {
    let d = ai.try_borrow_mut_data()?;
    if d.len() != LEDGER_LEN {
        return Err(RouterError::BadAccount.into());
    }
    Ok(Entries(d))
}

/// What a ledger account says is owed in all (0 when it is not one).
pub fn total_owed(ai: &AccountInfo) -> u64 {
    entries(ai).map_or(0, |e| e.total())
}

/// The vault's meter among `accounts` (found by owner, size, magic and vault).
pub fn carry_in<'a, 'b>(program_id: &Pubkey, accounts: &'a [AccountInfo<'b>], vault: &Pubkey) -> Option<(&'a AccountInfo<'b>, Carry)> {
    accounts.iter().find_map(|a| {
        if a.owner != program_id || a.data_len() != CARRY_LEN {
            return None;
        }
        let c: Carry = bytemuck::pod_read_unaligned(&a.try_borrow_data().ok()?[..CARRY_LEN]);
        (c.magic == CARRY_MAGIC && c.vault == *vault).then_some((a, c))
    })
}

/// The trading account's ledger among `accounts` (found by owner, size, magic and trader).
pub fn ledger_in<'a, 'b>(program_id: &Pubkey, accounts: &'a [AccountInfo<'b>], trader: &Pubkey) -> Option<&'a AccountInfo<'b>> {
    accounts.iter().find(|a| {
        a.owner == program_id
            && a.data_len() == LEDGER_LEN
            && a.try_borrow_data().is_ok_and(|d| d[..8] == LEDGER_MAGIC.to_le_bytes() && d[8..40] == trader.to_bytes())
    })
}

/// A fill's bookkeeping (see the module's notes): the vault's meter and the trader's ledger,
/// each when it has one.
pub struct Fees<'a, 'b> {
    pub carry: Option<(&'a AccountInfo<'b>, Carry)>,
    pub ledger: Option<&'a AccountInfo<'b>>,
}

impl<'a, 'b> Fees<'a, 'b> {
    /// Finds the accounts a fill must name: the meter when the book says the vault has one, the
    /// ledger when the trading account has one. Refuses a fill that leaves out either.
    pub fn load(program_id: &Pubkey, accounts: &'a [AccountInfo<'b>], b: &Book, t: &TraderState, vault: &Pubkey, trader: &Pubkey) -> Result<Self, ProgramError> {
        let carry = if b.has_carry != 0 { Some(carry_in(program_id, accounts, vault).ok_or(RouterError::BadAccount)?) } else { None };
        let ledger = if t.has_ledger != 0 { Some(ledger_in(program_id, accounts, trader).ok_or(RouterError::BadAccount)?) } else { None };
        if let Some((ai, _)) = carry {
            writable(ai)?;
        }
        if let Some(ai) = ledger {
            writable(ai)?;
        }
        Ok(Self { carry, ledger })
    }

    /// Before the trade: brings the meter up to `now` at `price` and settles the time `before`
    /// units were held on `asset` into what is owed. Returns the account's total debt after it.
    #[inline(never)]
    pub fn settle(&mut self, asset: u16, generation: u64, before: i128, price: u64, now: i64) -> Result<u64, ProgramError> {
        if let Some((_, c)) = self.carry.as_mut() {
            accrue(c, price, now);
        }
        let Some(ai) = self.ledger else { return Ok(0) };
        let mut l = entries(ai)?;
        if let (Some((_, c)), Some(i)) = (self.carry.as_ref(), l.find(asset, generation)) {
            let mut owed = l.owed(i);
            if before != 0 {
                owed = owed.saturating_add(owed_between(before, l.snap(i), index_for(c, before)));
            }
            l.set(i, asset, generation, owed, index_for(c, before));
        }
        Ok(l.total())
    }

    /// Whether this fill's fees can be booked: a ledger with an entry for the asset, or room for
    /// one (32 assets at once). Without it the account may only reduce, like one with no ledger.
    pub fn can_book(&self, asset: u16, generation: u64) -> Result<bool, ProgramError> {
        match self.ledger {
            None => Ok(false),
            Some(ai) => Ok(entries(ai)?.has_room(asset, generation)),
        }
    }

    /// After the trade: books the side and liquidation fees (`extra`), records the meter reading
    /// for the position now held, caps the debt at the account's equity, sets the meter's rate
    /// from the vault's new position, and writes the meter back. Returns what is owed in all.
    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    pub fn finish(self, asset: u16, generation: u64, after: i128, extra: u64, equity: i128, inventory: i128, limit: u128) -> Result<u64, ProgramError> {
        let carry = self.carry.map(|(ai, mut c)| {
            c.rate_e12 = target_rate(inventory, limit);
            (ai, c)
        });
        let mut total = 0;
        if let Some(ai) = self.ledger {
            let mut l = entries(ai)?;
            let index = carry.as_ref().map_or(0, |(_, c)| index_for(c, after));
            let need = after != 0 || extra > 0 || l.find(asset, generation).is_some_and(|i| l.owed(i) > 0);
            // (With every slot in use, 32 assets at once, the fill could only have reduced the
            // position: `can_book`.)
            if let Some(i) = if need { l.slot(asset, generation) } else { None } {
                let mut owed = l.owed(i).saturating_add(extra);
                l.set(i, asset, generation, owed, index);
                // Never more than the account is worth: what it cannot pay is forgiven.
                let cap = u64::try_from(equity.max(0)).unwrap_or(u64::MAX);
                let total = l.total();
                if total > cap {
                    owed = owed.saturating_sub(total - cap);
                    l.set(i, asset, generation, owed, index);
                }
            }
            // A closed position that owes nothing frees its slot.
            if let Some(i) = l.find(asset, generation) {
                if after == 0 && l.owed(i) == 0 {
                    l.set(i, LEDGER_FREE, 0, 0, 0);
                }
            }
            total = l.total();
        }
        if let Some((ai, c)) = carry {
            store(ai, &c)?;
        }
        Ok(total)
    }
}

/// `OpenCarry` (tag 32, anyone, the payer pays the rent): starts a vault's holding-fee meter.
/// From then on every fill on the vault must name it. Does nothing when it has one.
///
/// Accounts: 0 payer [s, w], 1 meter [w], 2 vault, 3 book [w], 4 system program.
#[inline(never)]
pub fn open_carry(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (payer, carry_ai, vault_ai, book_ai, system) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?, acc(accounts, 3)?, acc(accounts, 4)?);
    signer(payer)?;
    writable(carry_ai)?;
    writable(book_ai)?;
    key_is(system, &system_program::ID)?;
    load_vault(vault_ai)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    let (ck, bump) = carry_address(program_id, vault_ai.key);
    key_is(carry_ai, &ck)?;
    if b.has_carry != 0 {
        return Ok(()); // already started (by whoever got there first)
    }
    create_pda(payer, carry_ai, system, program_id, CARRY_LEN, 0, &[SEED_CARRY, vault_ai.key.as_ref(), &[bump]])?;
    let mut c = Carry::zeroed();
    c.magic = CARRY_MAGIC;
    c.vault = *vault_ai.key;
    c.bump = bump;
    c.updated = Clock::get()?.unix_timestamp;
    store(carry_ai, &c)?;
    b.has_carry = 1;
    store(book_ai, &b)
}

/// `OpenLedger` (tag 33, anyone, the payer pays the rent): starts a trading account's fee
/// ledger. A fill that adds to a position needs one; from then on every fill and withdrawal of
/// the account must name it. Does nothing when it has one.
///
/// Accounts: 0 payer [s, w], 1 trader [w], 2 ledger [w], 3 system program.
#[inline(never)]
pub fn open_ledger(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let (payer, trader_ai, ledger_ai, system) = (acc(accounts, 0)?, acc(accounts, 1)?, acc(accounts, 2)?, acc(accounts, 3)?);
    signer(payer)?;
    writable(trader_ai)?;
    writable(ledger_ai)?;
    key_is(system, &system_program::ID)?;
    let mut t: TraderState = load(trader_ai, program_id, TRADER_MAGIC)?;
    let (lk, bump) = ledger_address(program_id, trader_ai.key);
    key_is(ledger_ai, &lk)?;
    if t.has_ledger != 0 {
        return Ok(()); // already open (the page and the executor may both send it)
    }
    create_pda(payer, ledger_ai, system, program_id, LEDGER_LEN, 0, &[SEED_LEDGER, trader_ai.key.as_ref(), &[bump]])?;
    {
        let mut d = ledger_ai.try_borrow_mut_data()?;
        d[..8].copy_from_slice(&LEDGER_MAGIC.to_le_bytes());
        d[8..40].copy_from_slice(trader_ai.key.as_ref());
        d[40] = bump;
    }
    let mut l = entries(ledger_ai)?;
    for i in 0..LEDGER_SLOTS {
        l.set(i, LEDGER_FREE, 0, 0, 0);
    }
    drop(l);
    t.has_ledger = 1;
    store(trader_ai, &t)
}

/// `PayFees` (tag 34, anyone): pays what a trading account owes one vault, out of its capital,
/// into the vault's buffer. Only possible while the account holds no position (Percolator lets
/// nothing leave an account with one). What the capital cannot cover is forgiven once the account
/// is empty (no capital, no profit waiting to be released).
///
/// Accounts: 0 trader, 1 ledger [w], 2 market [w], 3 portfolio [w], 4 collateral [w],
/// 5 Percolator collateral vault [w], 6 Percolator vault authority, 7 vault, 8 vault buffer [w],
/// 9 token program, 10 Percolator program.
#[inline(never)]
pub fn pay_fees(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let trader_ai = acc(accounts, 0)?;
    let ledger_ai = acc(accounts, 1)?;
    let market = acc(accounts, 2)?;
    let portfolio = acc(accounts, 3)?;
    let collateral = acc(accounts, 4)?;
    let perc_vault = acc(accounts, 5)?;
    let perc_vault_auth = acc(accounts, 6)?;
    let vault_ai = acc(accounts, 7)?;
    let buffer = acc(accounts, 8)?;
    let token = acc(accounts, 9)?;
    let percolator = acc(accounts, 10)?;
    for w in [ledger_ai, market, portfolio, collateral, perc_vault, buffer] {
        writable(w)?;
    }
    key_is(token, &spl_token::ID)?;
    key_is(percolator, &PERCOLATOR_PROGRAM_ID)?;
    let t: TraderState = load(trader_ai, program_id, TRADER_MAGIC)?;
    key_is(market, &t.market)?;
    key_is(portfolio, &t.portfolio)?;
    key_is(collateral, &t.collateral)?;
    if ledger_in(program_id, core::slice::from_ref(ledger_ai), trader_ai.key).is_none() {
        return Err(RouterError::BadAccount.into());
    }
    // What is owed on an asset is paid to the vault that operated it in the generation it was
    // booked in (active or retired since): never to a vault opened later on a reused slot. (An
    // entry from before generations were recorded is paid to the asset's active vault.)
    let v = vstate::load_vault(vault_ai, &percolator_vault::id())?;
    key_is(market, &v.market)?;
    key_is(buffer, &v.buffer)?;
    if v.mode != MODE_OPERATE {
        return Err(RouterError::BadAccount.into());
    }
    let asset = v.asset_index;
    let (i, owed) = {
        let l = entries(ledger_ai)?;
        let i = (0..LEDGER_SLOTS)
            .find(|&i| l.asset(i) == asset && (l.generation(i) == gen48(v.asset_market_id) || (l.generation(i) == 0 && v.status == STATUS_ACTIVE)))
            .ok_or(RouterError::BadAccount)?;
        (i, l.owed(i))
    };
    let (capital, _, _) = perc::portfolio_exposure(&portfolio.try_borrow_data()?)?;
    let amount = (owed as u128).min(capital);
    let mut paid = 0u64;
    if amount > 0 {
        let view = perc::read_portfolio(portfolio, market.key, trader_ai.key)?;
        let before = token_amount(collateral)?;
        invoke_signed(
            &perc::withdraw(trader_ai.key, market.key, portfolio.key, collateral.key, perc_vault.key, perc_vault_auth.key, view.portfolio_id, view.sequence, amount),
            &[trader_ai.clone(), market.clone(), portfolio.clone(), collateral.clone(), perc_vault.clone(), perc_vault_auth.clone(), token.clone(), percolator.clone()],
            &[&[SEED_TRADER, t.market.as_ref(), t.wallet.as_ref(), &[t.bump]]],
        )?;
        paid = token_amount(collateral)?.checked_sub(before).ok_or(RouterError::Overflow)?;
        invoke_signed(
            &spl_token::instruction::transfer(&spl_token::ID, collateral.key, buffer.key, trader_ai.key, &[], paid)?,
            &[collateral.clone(), buffer.clone(), trader_ai.clone(), token.clone()],
            &[&[SEED_TRADER, t.market.as_ref(), t.wallet.as_ref(), &[t.bump]]],
        )?;
    } else if !perc::positions(&market.try_borrow_data()?, &portfolio.try_borrow_data()?)?.is_empty() {
        // Nothing can leave an account with a position: not the time to settle (or forgive).
        return Err(RouterError::BadAccount.into());
    }
    let (capital, pnl, _) = perc::portfolio_exposure(&portfolio.try_borrow_data()?)?;
    let mut l = entries(ledger_ai)?;
    let mut left = owed.saturating_sub(paid);
    if left > 0 && capital == 0 && pnl <= 0 {
        left = 0; // flat and empty: nothing left to pay it from
    }
    msg!("fees paid {} {} left {}", asset, paid, left);
    if left == 0 {
        l.set(i, LEDGER_FREE, 0, 0, 0);
    } else {
        let (generation, snap) = (l.generation(i), l.snap(i));
        l.set(i, asset, generation, left, snap);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_crowded_side_owes_more_the_fuller_the_vault() {
        assert_eq!(target_rate(10, 100), 0);
        // Vault short 55 of 100: traders net long, longs owe half the maximum.
        assert_eq!(target_rate(-55, 100), HOLD_MAX_E12 as i64 / 2);
        assert_eq!(target_rate(55, 100), -(HOLD_MAX_E12 as i64) / 2);
        assert_eq!(target_rate(-500, 100), HOLD_MAX_E12 as i64);
        assert_eq!(target_rate(5, 0), 0);
    }
    #[test]
    fn a_long_held_a_day_at_the_limit_owes_a_quarter_percent() {
        // 1 BTC (1e6 units) at $80,000, a day at the full rate: 0.01%/h x 24 = 0.24%, $192.
        let mut c = Carry::zeroed();
        c.rate_e12 = HOLD_MAX_E12 as i64;
        accrue(&mut c, 80_000_000_000, 86_400);
        let owed = owed_between(1_000_000, 0, c.index_long);
        assert!((191_000_000..=193_000_000).contains(&owed), "{owed}");
        assert_eq!({ c.index_short }, 0, "shorts owe nothing");
        assert_eq!(fee_on(1_000_000, 80_000_000_000, SIDE_FEE_BPS), 40_000_000);
    }
    #[test]
    fn huge_products_do_not_overflow() {
        assert!(owed_between(i128::MAX / 2, 0, u128::MAX / 4) > 0);
    }
}
