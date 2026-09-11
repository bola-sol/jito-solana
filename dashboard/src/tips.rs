//! Jito tips, read as the movement of the eight tip payment accounts between
//! a frozen bank and its parent. Only the measured figure is kept; shares are
//! derived where drawn.

use {serde::Serialize, solana_pubkey::Pubkey, solana_runtime::bank::Bank};

/// The tip payment program's eight accounts, by seed. Derived from the program
/// id because it differs between clusters.
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
/// points. One stated approximation applied to every leader.
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

/// What reaches a distribution account from what was paid into the tip
/// accounts. A validator's and its stakers' together; the split depends on a
/// commission this cannot see.
pub fn jito_share(paid: u64) -> u64 {
    paid.saturating_sub(scale(paid, JITO_CUT_BPS))
}

/// A validator's own cut of what reached the distribution account, for its
/// own slots where the commission is known. An estimate.
pub fn our_share(paid: u64, commission_bps: u16) -> u64 {
    scale(jito_share(paid), commission_bps)
}

/// The rates a page derives the two drawn figures from. Sent rather than
/// applied so what is stored stays what was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TipRates {
    /// [`JITO_CUT_BPS`], carried rather than duplicated in the client.
    pub jito_cut_bps: u16,
    /// This validator's own commission, where configured. `None` leaves the page
    /// claiming nothing about what a turn earned.
    pub commission_bps: Option<u16>,
}

/// Reads what each slot paid in tips. Keeps a floor, since the accounts never
/// empty, and a running total the sweep is checked against. Slots must arrive
/// in order.
pub struct TipMeter {
    accounts: [Pubkey; TIP_ACCOUNTS],
    /// The lowest total the accounts have been seen to hold. Learned rather than
    /// computed from rent exemption; it starts high and converges at the first
    /// crank, so the first turn after a restart reads low.
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

    /// What the last sweep says was paid before the crank and counted nowhere.
    /// `None` until a sweep has been seen. Near nought means the readings were
    /// complete.
    pub fn residual(&self) -> Option<u64> {
        self.residual
    }

    /// What `bank` paid in tips, differenced against `before`, its parent's
    /// total. The caller keeps that, since the parent may be pruned by now.
    pub fn measure(&mut self, bank: &Bank, before: u64) -> u64 {
        let now = self.total(bank);
        self.floor = self.floor.min(now);

        if now >= before {
            let paid = now.saturating_sub(before);
            self.attributed = self.attributed.saturating_add(paid);
            return paid;
        }

        // The balance fell, so the receiver was cranked in this slot and what stands
        // above the floor arrived after it. What arrived before was swept, and cannot
        // be told apart from the rest of that turn here.
        let swept = before.saturating_sub(self.floor);
        let paid = now.saturating_sub(self.floor);
        self.residual = Some(swept.saturating_sub(self.attributed));
        self.attributed = paid;
        paid
    }

    /// What the tip accounts hold in `bank`.
    pub fn total(&self, bank: &Bank) -> u64 {
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
        // A tenth of what survives jito's cut, not of what was paid. The wrong one
        // overstates by six per cent, small enough to look right.
        assert_eq!(our_share(1_400_000_000, 1_000), 131_600_000);
        assert_eq!(our_share(1_400_000_000, 10_000), 1_316_000_000);
        assert_eq!(our_share(1_400_000_000, 0), 0);
    }

    #[test]
    fn test_the_shares_hold_where_a_u64_multiply_would_not() {
        // Overflows a u64 several times over; scaled through u128 it is exactly six
        // per cent.
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
