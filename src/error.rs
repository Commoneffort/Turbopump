use solana_program::program_error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum VaultError {
    InvalidInstruction = 0x5600,
    InvalidParams,
    BadAccount,
    BadPda,
    BadPercolatorAccount,
    NotSigner,
    NotWritable,
    AlreadyInitialized,
    NotActive,
    NotTerminal,
    ClaimFirst,
    NothingToClaim,
    EpochNotOver,
    EpochNotRolled,
    NotFlat,
    Overflow,
    ZeroAmount,
    UnknownAsset,
    UnauthorizedMatcherCaller,
    StillLive,
    WrongMode,
    NothingToHarvest,
    /// RetireMarket: the market still has liquidity providers, requests, a position, or has not
    /// been listed long enough.
    NotIdle,
    /// A Pyth account that is not a fully verified update for the vault's feed.
    BadOracle,
    /// Only the router's authority can move the mark or arm a fill.
    NotRouter,
    /// A fill that the router did not arm for this slot and size.
    NotArmed,
    /// A settlement with the vault's position open needs that position settled at the price.
    NotSettled,
    /// `RequireFlat`: the epoch's withdrawals fit in the vault's cash, so no flat roll is needed.
    CanSettleOpen,
    /// A deposit or withdrawal request while this epoch's settlement is queued: its price is
    /// already fixed. The request is accepted again once the epoch has rolled.
    SettlementQueued,
    /// `TopUpMargin`: the vault is flat, or its margin in Percolator is not thin.
    MarginNotThin,
    /// `CoverLoss`: already done for this roll.
    CoverNotDue,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
