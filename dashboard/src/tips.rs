//! Jito tips, read as the movement of the tip payment accounts across a slot.
//!
//! Tips are ordinary lamport transfers into eight program accounts. They
//! accumulate across a leader's turn and are swept to the previous receiver
//! when the next jito leader cranks the receiver change. Reading the balances
//! from a frozen bank and differencing them against the same accounts on its
//! parent gives what a block paid, exactly: banks are committed snapshots, so
//! the difference between two of them captures every lamport any transaction
//! in that block moved, with no sampling window to miss.
//!
//! Firedancer measures the same thing inside its executor, per transaction,
//! which is strictly better and needs an executor of its own. This is the best
//! a reader outside the runtime can do, and it differs in one way worth
//! knowing: it is the net movement of those accounts, so anything else that
//! touches them in the same slot is counted as a tip.
//!
//! Nothing stored here is anyone's income. What a turn paid is a fact about the
//! slot; what a validator earned from it depends on how that validator is
//! configured. Only the measured figure is kept, and the two derived ones are
//! worked out where they are drawn, so that correcting a rate corrects the
//! whole history rather than only what arrives afterwards.

use {serde::Serialize, solana_pubkey::Pubkey, solana_runtime::bank::Bank};

/// The tip payment program's eight accounts, by their seeds.
///
/// Derived from the program id rather than written down as addresses, because
/// the id is a validator flag and differs between clusters. Firedancer compiles
/// the mainnet addresses in, which is cheaper and reports nothing on testnet.
const TIP_ACCOUNT_SEEDS: [&[u8]; 8] = [
    b"TIP_ACCOUNT_0",
    b"TIP_ACCOUNT_1",
    b"TIP_ACCOUNT_2",
    b"TIP_ACCOUNT_3",
    b"TIP_ACCOUNT_4",
    b"TIP_ACCOUNT_5",
    b"TIP_ACCOUNT_6",
    b"TIP_ACCOUNT_7",
];

/// How many of them there are, for the caller that reports the count.
pub const TIP_ACCOUNTS: usize = TIP_ACCOUNT_SEEDS.len();

/// What jito takes before anything reaches a distribution account, in basis
/// points.
///
/// Three per cent at the end of the block and three at distribution time. Held
/// as one figure because that is how it is applied: to every leader's turn,
/// including leaders whose arrangement cannot be seen from here. That is an
/// assumption, and the reason the column it feeds is labelled derived rather
/// than measured.
///
/// The live per-connection rate is available to a jito validator for its own
/// block engine and is deliberately not used. A number meaning one thing for
/// our turns and another for everybody else's would be worse than a single
/// stated approximation. Reconcile against a real distribution before trusting
/// this to more than a couple of significant figures.
pub const JITO_CUT_BPS: u16 = 600;

/// Basis points in the whole.
const BPS_WHOLE: u128 = 10_000;

/// `amount` scaled by `bps`, in `u128` so the multiply cannot saturate at any
/// lamport figure a `u64` can hold.
fn scale(amount: u64, bps: u16) -> u64 {
    let scaled = u128::from(amount)
        .saturating_mul(u128::from(bps))
        .checked_div(BPS_WHOLE)
        .unwrap_or(0);
    u64::try_from(scaled).unwrap_or(u64::MAX)
}

/// What reaches a distribution account, from what was paid into the tip
/// accounts.
///
/// The schedule page's column, for every leader. Still not anyone's income: it
/// is a validator's and its stakers' together, and which of them gets what
/// depends on a commission this cannot see.
pub fn jito_share(paid: u64) -> u64 {
    paid.saturating_sub(scale(paid, JITO_CUT_BPS))
}

/// A validator's own cut of what reached the distribution account.
///
/// Only for slots this validator led, and only where the commission is known.
/// It moves if the flag is changed mid-epoch, because the distribution account
/// is initialised once per epoch with whatever the commission was then, so this
/// is an estimate even for us.
pub fn our_share(paid: u64, commission_bps: u16) -> u64 {
    scale(jito_share(paid), commission_bps)
}

/// The rates a page needs to derive the two drawn figures from the measured
/// one.
///
/// Sent to the client rather than applied here, so that what is stored stays
/// what was measured. Correcting a rate then corrects a hundred thousand rows
/// of history instead of only the slots that arrive afterwards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TipRates {
    /// [`JITO_CUT_BPS`], carried rather than duplicated in the client.
    pub jito_cut_bps: u16,
    /// This validator's own commission, where it was configured. `None` leaves
    /// the page showing what a turn paid and claiming nothing about what it
    /// earned.
    pub commission_bps: Option<u16>,
}

/// Reads what each slot paid in tips, and keeps the little state that takes.
///
/// Two figures. A floor, because the accounts never empty and their resting
/// balance is not ours to guess at. And a running total of what has been
/// credited to the current receiver, which exists so the sweep can be checked
/// against it.
///
/// Order matters here where it does not for the rest of the collector: the
/// per-slot figure is a difference between a bank and its parent and would be
/// right in any order, but the checksum only means anything if slots are
/// measured as they come. The caller sorts.
pub struct TipMeter {
    accounts: [Pubkey; TIP_ACCOUNTS],
    /// The lowest total the accounts have been seen to hold.
    ///
    /// Learned rather than computed from rent exemption, which would be a
    /// second thing to keep right and would go stale if the parameters moved.
    /// It starts too high and converges down at the first crank, so the first
    /// turn after a restart reads low.
    floor: u64,
    /// Credited to the current receiver since the last sweep.
    attributed: u64,
    /// What the last sweep says was missed. See [`TipMeter::residual`].
    residual: Option<u64>,
}

impl TipMeter {
    /// Derives the eight accounts from the tip payment program.
    pub fn new(program_id: &Pubkey) -> Self {
        Self {
            accounts: TIP_ACCOUNT_SEEDS
                .map(|seed| Pubkey::find_program_address(&[seed], program_id).0),
            floor: u64::MAX,
            attributed: 0,
            residual: None,
        }
    }

    /// The addresses being watched, for logging them once at startup so an
    /// operator can check them against an explorer.
    pub fn accounts(&self) -> &[Pubkey] {
        &self.accounts
    }

    /// What the last observed sweep says was paid before the crank landed, and
    /// so counted nowhere. `None` until a sweep has been seen.
    ///
    /// The sweep is the only check this measurement gets. The amount drained is
    /// knowable, and so is what was credited to that receiver across their
    /// whole turn; the difference is what was missed. Near nought means the
    /// turn's readings were complete. Large means they were not, and says which
    /// turn.
    ///
    /// It audits the arithmetic and does not repair the display: those lamports
    /// belong to the previous receiver and arrived in the new leader's slot,
    /// and no balance reading can honestly assign them to one turn or the
    /// other.
    pub fn residual(&self) -> Option<u64> {
        self.residual
    }

    /// What `bank` paid in tips, differenced against its parent.
    ///
    /// The caller supplies the parent rather than a previous slot number: a
    /// slot number is not a chain position, and differencing across a fork or a
    /// skipped slot would produce a figure with no meaning rather than an
    /// error. Where the parent has been pruned there is nothing to difference
    /// against and the caller records nothing, which is not the same as
    /// recording nought.
    pub fn measure(&mut self, bank: &Bank, parent: &Bank) -> u64 {
        let now = self.total(bank);
        let before = self.total(parent);
        self.floor = self.floor.min(now);

        if now >= before {
            let paid = now.saturating_sub(before);
            self.attributed = self.attributed.saturating_add(paid);
            return paid;
        }

        // The balance fell, so the receiver was cranked in this slot and what
        // stands above the floor is what arrived after it. Whatever arrived
        // before was swept to the previous receiver, correctly, and cannot be
        // told apart from the rest of their turn by any reading taken here.
        let swept = before.saturating_sub(self.floor);
        let paid = now.saturating_sub(self.floor);
        self.residual = Some(swept.saturating_sub(self.attributed));
        self.attributed = paid;
        paid
    }

    fn total(&self, bank: &Bank) -> u64 {
        self.accounts
            .iter()
            .map(|account| bank.get_balance(account))
            .fold(0, u64::saturating_add)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_the_eight_accounts_are_derived_and_distinct() {
        let meter = TipMeter::new(&Pubkey::new_unique());
        let accounts = meter.accounts();
        assert_eq!(accounts.len(), TIP_ACCOUNTS);
        for (index, account) in accounts.iter().enumerate() {
            assert!(
                !accounts[..index].contains(account),
                "account {index} repeats an earlier one"
            );
        }
    }

    #[test]
    fn test_a_different_cluster_derives_different_accounts() {
        // The program id is a flag and differs between clusters, which is why
        // these are derived rather than written down as Firedancer's are.
        let one = TipMeter::new(&Pubkey::new_unique());
        let other = TipMeter::new(&Pubkey::new_unique());
        assert_ne!(one.accounts(), other.accounts());
    }

    #[test]
    fn test_jito_takes_six_per_cent_before_anyone_else_is_paid() {
        assert_eq!(jito_share(1_400_000_000), 1_316_000_000);
        // Nought in, nought out, rather than a division guarded at every call
        // site.
        assert_eq!(jito_share(0), 0);
    }

    #[test]
    fn test_our_share_is_the_commission_of_what_reached_the_account() {
        // A tenth of the 1.316 SOL that survives jito's cut, not a tenth of the
        // 1.4 that was paid. Taking it of the wrong one overstates by six per
        // cent, which is small enough to look right.
        assert_eq!(our_share(1_400_000_000, 1_000), 131_600_000);
        assert_eq!(our_share(1_400_000_000, 10_000), 1_316_000_000);
        assert_eq!(our_share(1_400_000_000, 0), 0);
    }

    #[test]
    fn test_the_shares_hold_where_a_u64_multiply_would_not() {
        // Ten quintillion lamports times six hundred overflows a u64 several
        // times over, so a same-width multiply would saturate and return the
        // whole amount as the cut. Scaled through u128 it is exactly six per
        // cent. Far more lamports than exist, but the arithmetic should not be
        // what decides that.
        assert_eq!(
            jito_share(10_000_000_000_000_000_000),
            9_400_000_000_000_000_000
        );
        assert_eq!(
            our_share(10_000_000_000_000_000_000, 10_000),
            9_400_000_000_000_000_000
        );
    }
}
