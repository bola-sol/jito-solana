//! This node's skip rate for the epoch: of its leader slots the root has passed, how many made
//! no block.

use {
    solana_clock::{Epoch, Slot},
    solana_pubkey::Pubkey,
};

#[derive(Debug, Default)]
pub(super) struct SkipRateWalk {
    /// The epoch and identity the walk is for; a swapped identity starts it again.
    pub(super) epoch: Option<(Epoch, Pubkey)>,
    leader_slots: Vec<Slot>,
    pub(super) next_index: usize,
    produced: usize,
    elapsed: usize,
}

impl SkipRateWalk {
    pub(super) fn new(epoch: Epoch, identity: Pubkey, leader_slots: Vec<Slot>) -> Self {
        Self {
            epoch: Some((epoch, identity)),
            leader_slots,
            ..Self::default()
        }
    }

    /// Only slots the root has passed are settled, and only those at or above `floor` count:
    /// after a restart from a snapshot the ledger begins partway through the epoch.
    pub(super) fn advance(&mut self, root: Slot, floor: Slot, is_full: impl Fn(Slot) -> bool) {
        while let Some(slot) = self.leader_slots.get(self.next_index).copied() {
            if slot > root {
                break;
            }
            self.next_index = self.next_index.saturating_add(1);
            if slot < floor {
                continue;
            }
            if is_full(slot) {
                self.produced = self.produced.saturating_add(1);
            }
            self.elapsed = self.elapsed.saturating_add(1);
        }
    }

    pub(super) fn rate(&self) -> Option<f64> {
        (self.elapsed > 0)
            .then(|| self.elapsed.saturating_sub(self.produced) as f64 / self.elapsed as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_only_slots_the_root_has_passed_are_counted() {
        let mut walk = SkipRateWalk::new(3, Pubkey::new_unique(), vec![10, 11, 12, 13]);
        walk.advance(11, 0, |slot| slot != 11);
        assert_eq!(walk.rate(), Some(0.5));
        walk.advance(13, 0, |slot| slot != 11);
        assert_eq!(walk.rate(), Some(0.25));
    }

    #[test]
    fn test_slots_below_the_ledger_floor_are_passed_but_not_counted() {
        let mut walk = SkipRateWalk::new(3, Pubkey::new_unique(), vec![10, 11, 20, 21]);
        walk.advance(21, 20, |_| false);
        assert_eq!(walk.next_index, 4);
        assert_eq!(walk.rate(), Some(1.0));
    }

    #[test]
    fn test_no_rate_before_a_leader_slot_has_passed() {
        let mut walk = SkipRateWalk::new(3, Pubkey::new_unique(), vec![10]);
        walk.advance(9, 0, |_| true);
        assert_eq!(walk.rate(), None);
        assert_eq!(SkipRateWalk::default().rate(), None);
    }
}
