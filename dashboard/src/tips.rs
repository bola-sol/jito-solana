//! Jito tips, read as the movement of the eight tip payment accounts between
//! a frozen bank and its parent. Only the measured figure is kept; shares are
//! derived where drawn.

use {serde::Serialize, solana_pubkey::Pubkey, solana_runtime::bank::Bank};

/// Derived from the program id, which differs between clusters.
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

pub const TIP_ACCOUNTS: usize = TIP_ACCOUNT_SEEDS.len();

/// In basis points; one approximation applied to every leader.
pub const JITO_CUT_BPS: u16 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TipRates {
    pub jito_cut_bps: u16,
    pub commission_bps: Option<u16>,
}

pub struct TipMeter {
    accounts: [Pubkey; TIP_ACCOUNTS],
    /// Starts high and converges at the first crank, so the first turn after a restart reads low.
    floor: u64,
    attributed: u64,
    residual: Option<u64>,
}

impl TipMeter {
    pub fn new(program_id: &Pubkey) -> Self {
        Self {
            accounts: TIP_ACCOUNT_SEEDS
                .map(|seed| Pubkey::find_program_address(&[seed], program_id).0),
            floor: u64::MAX,
            attributed: 0,
            residual: None,
        }
    }

    pub fn accounts(&self) -> &[Pubkey] {
        &self.accounts
    }

    pub fn residual(&self) -> Option<u64> {
        self.residual
    }

    /// The caller keeps the parent's total, since the parent may be pruned by now.
    pub fn measure(&mut self, bank: &Bank, before: u64) -> u64 {
        let now = self.total(bank);
        self.floor = self.floor.min(now);

        if now >= before {
            let paid = now.saturating_sub(before);
            self.attributed = self.attributed.saturating_add(paid);
            return paid;
        }

        // The balance fell, so the receiver was cranked in this slot and only what stands above the
        // floor arrived after it.
        let swept = before.saturating_sub(self.floor);
        let paid = now.saturating_sub(self.floor);
        self.residual = Some(swept.saturating_sub(self.attributed));
        self.attributed = paid;
        paid
    }

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
        let one = TipMeter::new(&Pubkey::new_unique());
        let other = TipMeter::new(&Pubkey::new_unique());
        assert_ne!(one.accounts(), other.accounts());
    }
}
