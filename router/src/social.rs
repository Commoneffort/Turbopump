//! Track records, profiles, following and copy trading.
//!
//! None of this can move a trader's money anywhere but through the queue every trade goes
//! through. A copy is an instruction the follower signs once ("keep my positions in line with
//! this trader's"); carrying it out only queues an ordinary request for the follower's own
//! account, which fills at the first oracle price published after its target time like any
//! trade. The size is not the caller's to choose: it is what brings the follower to the leader's
//! leverage on that market, as the chain shows both accounts at that moment.

use super::*;

/// Smallest copy trade (collateral atoms of notional), unless it closes the position.
pub const MIN_COPY_NOTIONAL: u128 = 1_000_000;
/// A follower is brought in line once its position is this far (bps of the target) from it, when
/// the leader opens, closes or turns a position, or when the follower holds one the leader does
/// not. Smaller differences (both accounts' equity drifts with every price) are left alone, so a
/// follower does not pay a fee on every tick.
pub const COPY_BAND_BPS: u128 = 1_000;
/// A caller who brings a follower in line with less than the whole difference must trade at least
/// one part in this many of it, or the follower's whole equity in notional (one step of 1x
/// leverage) if that is less. The follower has one place in the queue: with no lower limit,
/// anyone could keep it taken with one-atom copies (filling them oneself returns the bond), and
/// the follower could then neither trade nor withdraw. With it, a few steps bring the follower
/// in line or to the end of its margin, and then there is nothing left to queue.
pub const MIN_COPY_PART: u128 = 4;

/// The smallest part of `delta` a copy may trade (see `MIN_COPY_PART`). An account with nothing
/// left is only ever brought in line whole: what it does then is close, which needs no margin.
pub fn min_copy_part(delta: i128, follower_equity: i128, price: u64) -> u128 {
    let whole = delta.unsigned_abs();
    if follower_equity <= 0 || price == 0 {
        return whole;
    }
    (whole / MIN_COPY_PART).min((follower_equity as u128).saturating_mul(POS_SCALE) / price as u128)
}
/// Largest share of the leader's leverage a follower can ask for (3x).
pub const MAX_COPY_RATIO_BPS: u32 = 30_000;

fn equity(portfolio: &AccountInfo) -> Result<i128, ProgramError> {
    let (capital, pnl, _) = perc::portfolio_exposure(&portfolio.try_borrow_data()?)?;
    Ok((capital as i128).checked_add(pnl).ok_or(RouterError::Overflow)?)
}
fn clamp_i64(x: i128) -> i64 {
    x.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

// ---- track record ----

/// Opens a trading account's track record, starting from its equity now. Anyone may (and pays
/// its rent); from then on the account's deposits and withdrawals must name it.
///
/// Accounts: 0 payer [s, w], 1 trader [w], 2 trader wallet, 3 stats [w], 4 market, 5 trader
/// portfolio, 6 system program.
#[inline(never)]
pub(crate) fn open_stats(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let payer = acc(accounts, 0)?;
    let trader_ai = acc(accounts, 1)?;
    let wallet = acc(accounts, 2)?;
    let stats_ai = acc(accounts, 3)?;
    let market = acc(accounts, 4)?;
    let portfolio = acc(accounts, 5)?;
    let system = acc(accounts, 6)?;
    signer(payer)?;
    for w in [payer, trader_ai, stats_ai] {
        writable(w)?;
    }
    key_is(system, &system_program::ID)?;
    let mut t = load_trader(program_id, trader_ai, wallet.key)?;
    key_is(market, &t.market)?;
    key_is(portfolio, &t.portfolio)?;
    let (sk, bump) = stats_address(program_id, &t.market, wallet.key);
    key_is(stats_ai, &sk)?;
    create_pda(payer, stats_ai, system, program_id, STATS_LEN, 0, &[SEED_STATS, t.market.as_ref(), wallet.key.as_ref(), &[bump]])?;
    let mut s = Stats::zeroed();
    s.magic = STATS_MAGIC;
    s.wallet = *wallet.key;
    s.market = t.market;
    s.bump = bump;
    s.start_time = Clock::get()?.unix_timestamp;
    s.start_equity = clamp_i64(equity(portfolio)?);
    store(stats_ai, &s)?;
    t.has_stats = 1;
    store(trader_ai, &t)
}

/// Books a deposit or a withdrawal in the trader's track record (the account after the
/// instruction's own). Nothing to do for a trading account without one.
pub(crate) fn book_flow(program_id: &Pubkey, t: &TraderState, stats_ai: Result<&AccountInfo, RouterError>, paid_in: u64, paid_out: u64) -> ProgramResult {
    if t.has_stats == 0 {
        return Ok(());
    }
    let stats_ai = stats_ai?;
    writable(stats_ai)?;
    key_is(stats_ai, &stats_address(program_id, &t.market, &t.wallet).0)?;
    let mut s: Stats = load(stats_ai, program_id, STATS_MAGIC)?;
    s.deposited = s.deposited.saturating_add(paid_in);
    s.withdrawn = s.withdrawn.saturating_add(paid_out);
    store(stats_ai, &s)
}

/// Books a fill in the trader's track record, if `stats_ai` is it (the last account of a `Fill`;
/// a fill without it is still a fill). It never fails the fill.
pub(crate) fn record_fill(program_id: &Pubkey, stats_ai: &AccountInfo, t: &TraderState, portfolio: &AccountInfo, asset: u16, traded: i128, price: u64) {
    if t.has_stats == 0 || !stats_ai.is_writable || *stats_ai.key != stats_address(program_id, &t.market, &t.wallet).0 {
        return;
    }
    let Ok(mut s) = load::<Stats>(stats_ai, program_id, STATS_MAGIC) else { return };
    let (Ok(eq), Ok(clock)) = (equity(portfolio), Clock::get()) else { return };
    let now = clock.unix_timestamp;
    let pnl = clamp_i64(eq - s.start_equity as i128 - s.deposited as i128 + s.withdrawn as i128);
    let today = (now / 86_400).max(0) as u32;
    let mut days = s.days;
    let mut at = s.day_at as usize % STATS_DAYS;
    let newest = days[at];
    if newest.day != today {
        if newest.day != 0 {
            // The day before is over: count it.
            let d = newest.pnl;
            if d > 0 {
                s.days_up = s.days_up.saturating_add(1);
            } else if d < 0 {
                s.days_down = s.days_down.saturating_add(1);
            }
            s.best_day = s.best_day.max(d);
            s.worst_day = s.worst_day.min(d);
            at = (at + 1) % STATS_DAYS;
        }
        s.day_open_pnl = s.last_pnl;
        days[at] = DayRec { day: today, _pad: 0, pnl: 0 };
        s.day_at = at as u8;
    }
    days[at].pnl = pnl.saturating_sub(s.day_open_pnl);
    s.days = days;
    s.last_pnl = pnl;
    s.last_time = now;
    s.peak_pnl = s.peak_pnl.max(pnl);
    s.max_drawdown = s.max_drawdown.max((s.peak_pnl as i128 - pnl as i128).max(0) as u64);
    if traded != 0 {
        s.trades = s.trades.saturating_add(1);
        s.volume = s.volume.saturating_add(traded.unsigned_abs().saturating_mul(price as u128) / POS_SCALE);
        let mut fills = s.fills;
        let f = (s.fill_at as usize + if s.trades > 1 { 1 } else { 0 }) % STATS_FILLS;
        fills[f] = FillRec { time: now, price, size: clamp_i64(traded), asset, _pad: [0; 6] };
        s.fills = fills;
        s.fill_at = f as u8;
    }
    let _ = store(stats_ai, &s);
}

// ---- profiles ----

fn valid_name(name: &[u8]) -> bool {
    (NAME_MIN..=NAME_MAX).contains(&name.len()) && name.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// Sets the wallet's name and badge. A name is 3 to 16 letters, digits or underscores, and no
/// two wallets hold the same one (compared without case): the name's own account records who
/// has it. Changing the name frees the old one. Taking a name, and changing it to another,
/// costs `NAME_FEE_LAMPORTS`, paid to the platform's treasury; a new badge or colour, or the
/// same name in other capitals, costs nothing.
///
/// Accounts: 0 wallet [s, w], 1 profile [w], 2 the new name's account [w], 3 the old name's
/// account [w] (any account when the name does not change), 4 system program, 5 treasury [w]
/// (read only when a name is taken).
/// Data: name length (u8), name (16 bytes, zero padded), badge (u8), colour (u8).
#[inline(never)]
pub(crate) fn set_profile(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let profile_ai = acc(accounts, 1)?;
    let name_ai = acc(accounts, 2)?;
    let old_ai = acc(accounts, 3)?;
    let system = acc(accounts, 4)?;
    signer(wallet)?;
    for w in [wallet, profile_ai, name_ai] {
        writable(w)?;
    }
    key_is(system, &system_program::ID)?;
    let d = data.get(..NAME_MAX + 3).ok_or(RouterError::InvalidInstruction)?;
    let len = d[0] as usize;
    if len > NAME_MAX || !valid_name(&d[1..1 + len]) || d[1 + len..1 + NAME_MAX].iter().any(|c| *c != 0) {
        return Err(RouterError::BadName.into());
    }
    let mut name = [0u8; NAME_MAX];
    name[..len].copy_from_slice(&d[1..1 + len]);
    let lower = name.map(|c| c.to_ascii_lowercase());
    let (badge, color) = (d[1 + NAME_MAX], d[2 + NAME_MAX]);
    let (pk, pbump) = profile_address(program_id, wallet.key);
    key_is(profile_ai, &pk)?;
    let (nk, nbump) = name_address(program_id, &lower[..len]);
    key_is(name_ai, &nk)?;

    let mut freed = false;
    let mut p = if profile_ai.owner == program_id {
        let p: Profile = load(profile_ai, program_id, PROFILE_MAGIC)?;
        if p.wallet != *wallet.key {
            return Err(RouterError::BadAccount.into());
        }
        // A different name: the old one is free again (closed at the end).
        let old_len = p.name_len as usize;
        let old_lower = p.name.map(|c| c.to_ascii_lowercase());
        if old_lower[..old_len] != lower[..len] {
            writable(old_ai)?;
            key_is(old_ai, &name_address(program_id, &old_lower[..old_len]).0)?;
            let o: NameRec = load(old_ai, program_id, NAME_MAGIC)?;
            if o.wallet != *wallet.key {
                return Err(RouterError::BadAccount.into());
            }
            freed = true;
        }
        p
    } else {
        create_pda(wallet, profile_ai, system, program_id, PROFILE_LEN, 0, &[SEED_PROFILE, wallet.key.as_ref(), &[pbump]])?;
        let mut p = Profile::zeroed();
        p.magic = PROFILE_MAGIC;
        p.wallet = *wallet.key;
        p.bump = pbump;
        p.created = Clock::get()?.unix_timestamp;
        p
    };
    if name_ai.owner == program_id {
        let n: NameRec = load(name_ai, program_id, NAME_MAGIC)?;
        if n.wallet != *wallet.key {
            return Err(RouterError::NameTaken.into());
        }
    } else {
        // A name this wallet did not hold: its first, or a different one.
        pay_treasury(wallet, acc(accounts, 5)?, system, NAME_FEE_LAMPORTS)?;
        create_pda(wallet, name_ai, system, program_id, NAME_LEN, 0, &[SEED_NAME, &lower[..len], &[nbump]])?;
        store(name_ai, &NameRec { magic: NAME_MAGIC, wallet: *wallet.key, bump: nbump, _pad: [0; 7] })?;
    }
    p.name = name;
    p.name_len = len as u8;
    p.badge = badge;
    p.color = color;
    store(profile_ai, &p)?;
    // Last, after every transfer the system program makes for this instruction.
    if freed {
        close(old_ai, 0, wallet, wallet)?;
    }
    Ok(())
}

// ---- following ----

/// The wallet follows `leader`. Accounts: 0 wallet [s, w], 1 follow [w], 2 leader, 3 system program.
#[inline(never)]
pub(crate) fn follow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let follow_ai = acc(accounts, 1)?;
    let leader = acc(accounts, 2)?;
    let system = acc(accounts, 3)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(follow_ai)?;
    key_is(system, &system_program::ID)?;
    if leader.key == wallet.key {
        return Err(RouterError::BadAccount.into());
    }
    let (fk, bump) = follow_address(program_id, wallet.key, leader.key);
    key_is(follow_ai, &fk)?;
    create_pda(wallet, follow_ai, system, program_id, FOLLOW_LEN, 0, &[SEED_FOLLOW, wallet.key.as_ref(), leader.key.as_ref(), &[bump]])?;
    store(follow_ai, &Follow { magic: FOLLOW_MAGIC, follower: *wallet.key, leader: *leader.key, since: Clock::get()?.unix_timestamp, bump, _pad: [0; 7] })
}

/// The wallet stops following (its rent comes back). Accounts: 0 wallet [s, w], 1 follow [w].
#[inline(never)]
pub(crate) fn unfollow(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let follow_ai = acc(accounts, 1)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(follow_ai)?;
    let f: Follow = load(follow_ai, program_id, FOLLOW_MAGIC)?;
    if f.follower != *wallet.key {
        return Err(RouterError::BadAccount.into());
    }
    close(follow_ai, 0, wallet, wallet)
}

// ---- referrals ----

/// Records who referred the wallet. Once: the account already existing is an error, and nothing
/// closes it. A wallet cannot name itself.
/// Accounts: 0 wallet [s, w], 1 referral [w], 2 referrer, 3 system program.
#[inline(never)]
pub(crate) fn set_referrer(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let referral_ai = acc(accounts, 1)?;
    let referrer = acc(accounts, 2)?;
    let system = acc(accounts, 3)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(referral_ai)?;
    key_is(system, &system_program::ID)?;
    if referrer.key == wallet.key || referral_ai.data_len() != 0 {
        return Err(RouterError::BadAccount.into());
    }
    let (rk, bump) = referral_address(program_id, wallet.key);
    key_is(referral_ai, &rk)?;
    create_pda(wallet, referral_ai, system, program_id, REFERRAL_LEN, 0, &[SEED_REFERRAL, wallet.key.as_ref(), &[bump]])?;
    store(referral_ai, &Referral { magic: REFERRAL_MAGIC, wallet: *wallet.key, referrer: *referrer.key, since: Clock::get()?.unix_timestamp, bump, _pad: [0; 23] })
}

// ---- copying ----

/// Starts copying `leader`, or changes the terms (one leader at a time per trading account).
/// Starting to copy a trader (the first time, again after stopping, or a different one) costs
/// `COPY_FEE_LAMPORTS`, paid to the platform's treasury, plus `COPY_LEADER_FEE_LAMPORTS`, paid to
/// the leader's wallet; changing the terms costs nothing.
///
/// Accounts: 0 wallet [s, w], 1 copy [w], 2 the wallet's trader account, 3 leader wallet [w],
/// 4 leader's trader account, 5 system program, 6 treasury [w].
/// Data: ratio (u32, bps of the leader's leverage), most notional on one market (u64, 0 = no limit).
#[inline(never)]
pub(crate) fn set_copy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let copy_ai = acc(accounts, 1)?;
    let trader_ai = acc(accounts, 2)?;
    let leader = acc(accounts, 3)?;
    let leader_trader = acc(accounts, 4)?;
    let system = acc(accounts, 5)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(copy_ai)?;
    key_is(system, &system_program::ID)?;
    let d = data.get(..12).ok_or(RouterError::InvalidInstruction)?;
    let ratio_bps = u32::from_le_bytes(d[..4].try_into().unwrap());
    let max_notional = u64::from_le_bytes(d[4..12].try_into().unwrap());
    if ratio_bps == 0 || ratio_bps > MAX_COPY_RATIO_BPS || leader.key == wallet.key {
        return Err(RouterError::InvalidInstruction.into());
    }
    let t = load_trader(program_id, trader_ai, wallet.key)?;
    let lt = load_trader(program_id, leader_trader, leader.key)?;
    if lt.market != t.market {
        return Err(RouterError::BadAccount.into());
    }
    let (ck, bump) = copy_address(program_id, &t.market, wallet.key);
    key_is(copy_ai, &ck)?;
    let now = Clock::get()?.unix_timestamp;
    let mut c = if copy_ai.owner == program_id {
        let c: Copy = load(copy_ai, program_id, COPY_MAGIC)?;
        if c.follower != *wallet.key {
            return Err(RouterError::BadAccount.into());
        }
        c
    } else {
        create_pda(wallet, copy_ai, system, program_id, COPY_LEN, 0, &[SEED_COPY, t.market.as_ref(), wallet.key.as_ref(), &[bump]])?;
        let mut c = Copy::zeroed();
        c.magic = COPY_MAGIC;
        c.market = t.market;
        c.follower = *wallet.key;
        c.bump = bump;
        c
    };
    if c.leader != *leader.key {
        pay_treasury(wallet, acc(accounts, 6)?, system, COPY_FEE_LAMPORTS)?;
        writable(leader)?;
        invoke(&system_instruction::transfer(wallet.key, leader.key, COPY_LEADER_FEE_LAMPORTS), &[wallet.clone(), leader.clone(), system.clone()])?;
        c.leader = *leader.key;
        c.since = now;
        c.triggers = 0;
    }
    c.ratio_bps = ratio_bps;
    c.max_notional = max_notional;
    store(copy_ai, &c)
}

/// Stops copying. Positions stay as they are: closing them is the wallet's own decision.
/// Accounts: 0 wallet [s, w], 1 copy [w].
#[inline(never)]
pub(crate) fn stop_copy(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let copy_ai = acc(accounts, 1)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(copy_ai)?;
    let c: Copy = load(copy_ai, program_id, COPY_MAGIC)?;
    if c.follower != *wallet.key {
        return Err(RouterError::BadAccount.into());
    }
    close(copy_ai, 0, wallet, wallet)
}

/// The position on `asset` that puts the follower at the leader's leverage there, times the
/// copy's ratio and within its limit.
pub fn copy_target(leader_pos: i128, leader_equity: i128, follower_equity: i128, ratio_bps: u32, max_notional: u64, price: u64) -> Result<i128, ProgramError> {
    if leader_pos == 0 || leader_equity <= 0 || follower_equity <= 0 || price == 0 {
        return Ok(0);
    }
    let mut q = leader_pos
        .unsigned_abs()
        .checked_mul(follower_equity as u128)
        .and_then(|x| x.checked_mul(ratio_bps as u128))
        .ok_or(RouterError::Overflow)?
        / (leader_equity as u128)
        / 10_000;
    if max_notional != 0 {
        q = q.min((max_notional as u128).saturating_mul(POS_SCALE) / price as u128);
    }
    let q = i128::try_from(q).map_err(|_| RouterError::Overflow)?;
    Ok(if leader_pos > 0 { q } else { -q })
}

/// Whether a follower holding `held` with target `target` is to be brought in line.
pub fn copy_due(held: i128, target: i128, price: u64) -> bool {
    let delta = target - held;
    if delta == 0 {
        return false;
    }
    if target == 0 {
        return true; // the leader is out: so is the follower, whatever the size
    }
    if delta.unsigned_abs().saturating_mul(price as u128) / POS_SCALE < MIN_COPY_NOTIONAL {
        return false;
    }
    held == 0 || (held > 0) != (target > 0) || delta.unsigned_abs().saturating_mul(10_000) >= target.unsigned_abs().saturating_mul(COPY_BAND_BPS)
}

/// Brings a follower's position on a vault's market in line with its leader's. Anyone may call
/// it (paying the request's bond and rent, which come back when it fills). It queues a trade of
/// the difference, or of `size` when that is given: the same direction and no larger, for when
/// the follower's margin or the vault's room does not take the whole difference at once.
///
/// Accounts: 0 payer [s, w], 1 copy [w], 2 follower's trader account [w], 3 follower wallet,
/// 4 vault, 5 book [w], 6 request [w], 7 market, 8 follower portfolio, 9 leader's trader
/// account, 10 leader portfolio, 11 system program. Data: size (i128, 0 = the whole difference).
#[inline(never)]
pub(crate) fn trigger_copy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let payer = acc(accounts, 0)?;
    let copy_ai = acc(accounts, 1)?;
    let trader_ai = acc(accounts, 2)?;
    let wallet = acc(accounts, 3)?;
    let vault_ai = acc(accounts, 4)?;
    let book_ai = acc(accounts, 5)?;
    let request_ai = acc(accounts, 6)?;
    let market = acc(accounts, 7)?;
    let portfolio = acc(accounts, 8)?;
    let leader_trader = acc(accounts, 9)?;
    let leader_portfolio = acc(accounts, 10)?;
    let system = acc(accounts, 11)?;
    signer(payer)?;
    for w in [payer, copy_ai, trader_ai, book_ai, request_ai] {
        writable(w)?;
    }
    key_is(system, &system_program::ID)?;
    let asked = i128::from_le_bytes(data.get(..16).ok_or(RouterError::InvalidInstruction)?.try_into().unwrap());
    let mut c: Copy = load(copy_ai, program_id, COPY_MAGIC)?;
    key_is(wallet, &c.follower)?;
    let mut t = load_trader(program_id, trader_ai, wallet.key)?;
    let lt = load_trader(program_id, leader_trader, &c.leader)?;
    let v = load_vault(vault_ai)?;
    let mut b: Book = load(book_ai, program_id, BOOK_MAGIC)?;
    key_is(market, &v.market)?;
    key_is(market, &t.market)?;
    key_is(market, &lt.market)?;
    key_is(market, &c.market)?;
    key_is(portfolio, &t.portfolio)?;
    key_is(leader_portfolio, &lt.portfolio)?;
    if b.vault != *vault_ai.key {
        return Err(RouterError::BadAccount.into());
    }
    if t.has_pending != 0 {
        return Err(RouterError::RequestPending.into());
    }
    if b.len as usize >= MAX_PENDING - RESERVED_PENDING {
        return Err(RouterError::BookFull.into());
    }
    perc::expect_market(market)?;
    let (_, price, _) = perc::asset_price(&market.try_borrow_data()?, v.asset_index)?;
    let held = position_on(market, portfolio, v.asset_index)?;
    let leader_pos = position_on(market, leader_portfolio, v.asset_index)?;
    let target = copy_target(leader_pos, equity(leader_portfolio)?, equity(portfolio)?, c.ratio_bps, c.max_notional, price)?;
    if !copy_due(held, target, price) {
        return Err(RouterError::InLine.into());
    }
    let delta = target - held;
    let size = if asked == 0 {
        delta
    } else if (asked > 0) == (delta > 0) && asked.unsigned_abs() <= delta.unsigned_abs() && asked.unsigned_abs() >= min_copy_part(delta, equity(portfolio)?, price) {
        asked
    } else {
        return Err(RouterError::InvalidInstruction.into());
    };
    if perc::asset_close_only(&market.try_borrow_data()?, v.asset_index)? {
        return Err(RouterError::CloseOnly.into());
    }
    if !margin_covers(&market.try_borrow_data()?, &portfolio.try_borrow_data()?, &v, size, tiers_in(program_id, accounts, market.key).as_ref())? {
        return Err(RouterError::InsufficientMargin.into());
    }
    c.triggers = c.triggers.saturating_add(1);
    store(copy_ai, &c)?;
    msg!("copy {} {}", c.leader, size);
    enqueue(program_id, payer, wallet.key, Some((trader_ai, &mut t)), vault_ai, book_ai, &mut b, request_ai, system, size, None, 0)?;
    // Queued by someone else than the trader: the request's rent goes back to them.
    let mut r: Request = load(request_ai, program_id, REQUEST_MAGIC)?;
    r.kind = KIND_COPY;
    store(request_ai, &r)
}

// ---- fees and badge pictures ----

/// `lamports` from `wallet` to the platform's treasury, by the system program.
fn pay_treasury<'a>(wallet: &AccountInfo<'a>, treasury: &AccountInfo<'a>, system: &AccountInfo<'a>, lamports: u64) -> ProgramResult {
    writable(treasury)?;
    key_is(treasury, &percolator_vault::processor::TREASURY)?;
    invoke(&system_instruction::transfer(wallet.key, treasury.key, lamports), &[wallet.clone(), treasury.clone(), system.clone()])
}

/// Starts a new badge picture for the wallet (its first, or one that replaces the one it has)
/// and writes the picture's first bytes. Costs `BADGE_IMAGE_FEE_LAMPORTS`, paid to the
/// platform's treasury, every time. The picture is a JPEG file of at most `BADGE_MAX_BYTES`;
/// the rest of it follows with `WriteBadgeImage`, and it counts once every byte is there.
///
/// Only the wallet itself can write its picture, the account has one fixed size, and nothing
/// the router does depends on what the bytes are.
///
/// Accounts: 0 wallet [s, w], 1 badge [w], 2 treasury [w], 3 system program.
/// Data: format (u8, 1 = JPEG), length of the whole picture (u16), then its first bytes.
#[inline(never)]
pub(crate) fn set_badge_image(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let badge_ai = acc(accounts, 1)?;
    let treasury = acc(accounts, 2)?;
    let system = acc(accounts, 3)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(badge_ai)?;
    key_is(system, &system_program::ID)?;
    let head = data.get(..3).ok_or(RouterError::InvalidInstruction)?;
    let (format, len) = (head[0], u16::from_le_bytes([head[1], head[2]]) as usize);
    let first = &data[3..];
    if format != BADGE_FORMAT_JPEG || len < JPEG_START.len() || len > BADGE_MAX_BYTES || first.len() > len || !first.starts_with(&JPEG_START) {
        return Err(RouterError::BadImage.into());
    }
    let (bk, bump) = badge_address(program_id, wallet.key);
    key_is(badge_ai, &bk)?;
    if badge_ai.owner == program_id {
        let b: BadgeImage = load_head(badge_ai, program_id)?;
        if b.wallet != *wallet.key {
            return Err(RouterError::BadAccount.into());
        }
    } else {
        create_pda(wallet, badge_ai, system, program_id, BADGE_LEN, 0, &[SEED_BADGE, wallet.key.as_ref(), &[bump]])?;
    }
    pay_treasury(wallet, treasury, system, BADGE_IMAGE_FEE_LAMPORTS)?;
    let b = BadgeImage { magic: BADGE_MAGIC, wallet: *wallet.key, len: len as u16, written: first.len() as u16, format, bump, _pad: [0; 2], created: Clock::get()?.unix_timestamp };
    let mut d = badge_ai.try_borrow_mut_data()?;
    d[..BADGE_HEAD].copy_from_slice(bytemuck::bytes_of(&b));
    // Nothing of an earlier picture stays behind.
    d[BADGE_HEAD..].fill(0);
    d[BADGE_HEAD..BADGE_HEAD + first.len()].copy_from_slice(first);
    Ok(())
}

/// The next bytes of the wallet's badge picture, in order.
/// Accounts: 0 wallet [s], 1 badge [w]. Data: where these bytes start (u16), then the bytes.
#[inline(never)]
pub(crate) fn write_badge_image(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let badge_ai = acc(accounts, 1)?;
    signer(wallet)?;
    writable(badge_ai)?;
    key_is(badge_ai, &badge_address(program_id, wallet.key).0)?;
    let mut b: BadgeImage = load_head(badge_ai, program_id)?;
    if b.wallet != *wallet.key {
        return Err(RouterError::BadAccount.into());
    }
    let head = data.get(..2).ok_or(RouterError::InvalidInstruction)?;
    let (offset, bytes) = (u16::from_le_bytes([head[0], head[1]]) as usize, &data[2..]);
    let end = offset.checked_add(bytes.len()).ok_or(RouterError::Overflow)?;
    if bytes.is_empty() || offset != b.written as usize || end > b.len as usize {
        return Err(RouterError::BadImage.into());
    }
    b.written = end as u16;
    let mut d = badge_ai.try_borrow_mut_data()?;
    d[..BADGE_HEAD].copy_from_slice(bytemuck::bytes_of(&b));
    d[BADGE_HEAD + offset..BADGE_HEAD + end].copy_from_slice(bytes);
    Ok(())
}

/// Takes the wallet's badge picture away (its rent comes back; the fee does not).
/// Accounts: 0 wallet [s, w], 1 badge [w].
#[inline(never)]
pub(crate) fn remove_badge_image(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let badge_ai = acc(accounts, 1)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(badge_ai)?;
    let b: BadgeImage = load_head(badge_ai, program_id)?;
    if b.wallet != *wallet.key {
        return Err(RouterError::BadAccount.into());
    }
    close(badge_ai, 0, wallet, wallet)
}

/// The header of a badge picture's account (the account is longer than the header).
fn load_head(ai: &AccountInfo, program_id: &Pubkey) -> Result<BadgeImage, ProgramError> {
    if ai.owner != program_id || ai.data_len() != BADGE_LEN {
        return Err(RouterError::BadAccount.into());
    }
    let b: BadgeImage = bytemuck::pod_read_unaligned(&ai.try_borrow_data()?[..BADGE_HEAD]);
    if b.magic != BADGE_MAGIC {
        return Err(RouterError::BadAccount.into());
    }
    Ok(b)
}

/// One more day in the leaderboard's featured row for the wallet (`FEATURE_SECS`), for
/// `FEATURE_FEE_LAMPORTS` paid to the platform's treasury. Paid again while a day is running,
/// it adds a day at the end; at most `FEATURE_MAX_AHEAD_SECS` ahead. Being featured changes
/// nothing but where the page shows the wallet: its record is the router's as before.
///
/// Accounts: 0 wallet [s, w], 1 the wallet's profile [w] (it needs a name first), 2 treasury [w],
/// 3 system program.
#[inline(never)]
pub(crate) fn feature(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let wallet = acc(accounts, 0)?;
    let profile_ai = acc(accounts, 1)?;
    let treasury = acc(accounts, 2)?;
    let system = acc(accounts, 3)?;
    signer(wallet)?;
    writable(wallet)?;
    writable(profile_ai)?;
    key_is(system, &system_program::ID)?;
    key_is(profile_ai, &profile_address(program_id, wallet.key).0)?;
    let mut p: Profile = load(profile_ai, program_id, PROFILE_MAGIC)?;
    if p.wallet != *wallet.key {
        return Err(RouterError::BadAccount.into());
    }
    let now = Clock::get()?.unix_timestamp;
    let until = (p.featured_until as i64).max(now).saturating_add(FEATURE_SECS);
    if until > now.saturating_add(FEATURE_MAX_AHEAD_SECS) {
        return Err(RouterError::FeaturedEnough.into());
    }
    pay_treasury(wallet, treasury, system, FEATURE_FEE_LAMPORTS)?;
    p.featured_until = u32::try_from(until).map_err(|_| RouterError::Overflow)?;
    store(profile_ai, &p)
}
