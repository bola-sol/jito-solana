//! This node's skip rate for the epoch: of its leader slots the root has passed, how many have no
//! block in the chain.

use {
    solana_clock::{Epoch, Slot},
    solana_pubkey::Pubkey,
    solana_slot_history::Check,
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

    /// Whether a leader slot the root has passed is still to be counted.
    pub(super) fn due(&self, root: Slot) -> bool {
        self.leader_slots
            .get(self.next_index)
            .is_some_and(|slot| *slot <= root)
    }

    /// Only slots the root has passed are settled. `check` answers from the root bank's slot
    /// history, which a restart does not lose; a slot too old for it is passed but not counted.
    pub(super) fn advance(&mut self, root: Slot, check: impl Fn(Slot) -> Check) {
        while let Some(slot) = self.leader_slots.get(self.next_index).copied() {
            if slot > root {
                break;
            }
            let made = match check(slot) {
                // The history has not reached the root yet; asked again next time.
                Check::Future => break,
                Check::TooOld => None,
                Check::Found => Some(true),
                Check::NotFound => Some(false),
            };
            self.next_index = self.next_index.saturating_add(1);
            let Some(made) = made else {
                continue;
            };
            if made {
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

    /// A chain holding every slot from `oldest` to `newest` except those in `missing`.
    fn chain(oldest: Slot, newest: Slot, missing: &'static [Slot]) -> impl Fn(Slot) -> Check {
        move |slot| {
            if slot > newest {
                Check::Future
            } else if slot < oldest {
                Check::TooOld
            } else if missing.contains(&slot) {
                Check::NotFound
            } else {
                Check::Found
            }
        }
    }

    #[test]
    fn test_only_slots_the_root_has_passed_are_counted() {
        let mut walk = SkipRateWalk::new(3, Pubkey::new_unique(), vec![10, 11, 12, 13]);
        walk.advance(11, chain(0, 11, &[11]));
        assert_eq!(walk.rate(), Some(0.5));
        assert!(!walk.due(11));
        assert!(walk.due(12));
        walk.advance(13, chain(0, 13, &[11]));
        assert_eq!(walk.rate(), Some(0.25));
    }

    #[test]
    fn test_a_slot_older_than_the_history_is_passed_but_not_counted() {
        let mut walk = SkipRateWalk::new(3, Pubkey::new_unique(), vec![10, 11, 20, 21]);
        walk.advance(21, chain(20, 21, &[21]));
        assert_eq!(walk.next_index, 4);
        assert_eq!(walk.rate(), Some(0.5));
    }

    #[test]
    fn test_a_history_behind_the_root_is_asked_again_later() {
        let mut walk = SkipRateWalk::new(3, Pubkey::new_unique(), vec![10, 11]);
        walk.advance(11, chain(0, 10, &[]));
        assert_eq!(walk.next_index, 1);
        walk.advance(11, chain(0, 11, &[11]));
        assert_eq!(walk.rate(), Some(0.5));
    }

    #[test]
    fn test_no_rate_before_a_leader_slot_has_passed() {
        let mut walk = SkipRateWalk::new(3, Pubkey::new_unique(), vec![10]);
        walk.advance(9, chain(0, 9, &[]));
        assert_eq!(walk.rate(), None);
        assert_eq!(SkipRateWalk::default().rate(), None);
    }
}
