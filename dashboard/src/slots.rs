//! Rolling history of recent slots, backing the slot strip and the sidebar.

use {
    serde::Serialize,
    solana_clock::Slot,
    solana_pubkey::Pubkey,
    std::collections::{BTreeMap, btree_map::Entry},
};

/// How far a slot has progressed through consensus, ordered from least to most
/// settled. The frontend colours slots by this value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotLevel {
    /// Not yet replayed, or still being received.
    Incomplete,
    /// Replayed and frozen by this validator.
    Completed,
    /// Frozen, and a supermajority of stake has voted for it.
    OptimisticallyConfirmed,
    /// This validator considers it final.
    Rooted,
    /// Rooted, and the cluster considers it final.
    Finalized,
    /// The leader did not produce a block, or it was not received in time.
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlotEntry {
    pub slot: Slot,
    pub level: SlotLevel,
    /// Base58 identity of the scheduled leader, when the schedule is known.
    pub leader: Option<String>,
    /// The leader's display name, carried here so the client needs no copy of
    /// the cluster's peer table just to label a row.
    pub leader_name: Option<String>,
    /// The leader's on-chain icon URL, when it published one.
    pub leader_icon: Option<String>,
    /// True when this validator was the scheduled leader.
    pub mine: bool,
    /// Transactions in the block, once replayed.
    pub transactions: Option<u64>,
    /// Non-vote transactions in the block, once replayed.
    pub non_vote_transactions: Option<u64>,
    /// Wall-clock duration from the previous slot completing, in nanoseconds.
    pub duration_nanos: Option<u64>,
}

impl SlotEntry {
    fn new(slot: Slot) -> Self {
        Self {
            slot,
            level: SlotLevel::Incomplete,
            leader: None,
            leader_name: None,
            leader_icon: None,
            mine: false,
            transactions: None,
            non_vote_transactions: None,
            duration_nanos: None,
        }
    }
}

/// A bounded, slot-keyed history. Slots more than `capacity` behind the highest
/// one seen are dropped.
pub struct SlotRing {
    entries: BTreeMap<Slot, SlotEntry>,
    capacity: usize,
    highest: Slot,
}

impl SlotRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: BTreeMap::new(),
            capacity: capacity.max(1),
            highest: 0,
        }
    }

    pub fn get(&self, slot: Slot) -> Option<&SlotEntry> {
        self.entries.get(&slot)
    }

    /// The most recent `count` slots, oldest first.
    pub fn recent(&self, count: usize) -> Vec<SlotEntry> {
        let skip = self.entries.len().saturating_sub(count);
        self.entries.values().skip(skip).cloned().collect()
    }

    /// Applies `update` to the entry for `slot`, creating it if needed, and
    /// returns the entry if anything actually changed. Callers publish only on
    /// a `Some` so that idle polling produces no traffic.
    pub fn update(&mut self, slot: Slot, update: impl FnOnce(&mut SlotEntry)) -> Option<SlotEntry> {
        let before = self.entries.get(&slot).cloned();
        let entry = match self.entries.entry(slot) {
            Entry::Occupied(occupied) => occupied.into_mut(),
            Entry::Vacant(vacant) => vacant.insert(SlotEntry::new(slot)),
        };
        update(entry);

        // A level never moves backwards. Replay and the commitment cache are
        // sampled independently, so without this a slot can appear to regress
        // from rooted to completed between polls.
        if let Some(before) = &before
            && entry.level < before.level
        {
            entry.level = before.level;
        }

        let changed = before.as_ref() != Some(&*entry);
        let result = changed.then(|| entry.clone());

        self.highest = self.highest.max(slot);
        self.prune();
        result
    }

    fn prune(&mut self) {
        while self.entries.len() > self.capacity {
            let Some((&oldest, _)) = self.entries.iter().next() else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }

    /// Raises every replayed slot at or below `up_to` to `level`.
    ///
    /// Bank forks drops banks once they fall below the root, so a slot's level
    /// would otherwise freeze at whatever it was when it left the fork tree and
    /// never reach rooted or finalized.
    pub fn promote(&mut self, up_to: Slot, level: SlotLevel) -> Vec<SlotEntry> {
        let candidates: Vec<Slot> = self
            .entries
            .iter()
            .filter(|(slot, entry)| {
                **slot <= up_to
                    && entry.level < level
                    // A slot that was never produced does not become rooted.
                    && entry.level != SlotLevel::Incomplete
            })
            .map(|(&slot, _)| slot)
            .collect();
        candidates
            .into_iter()
            .filter_map(|slot| self.update(slot, |entry| entry.level = level))
            .collect()
    }

    /// Marks every unstarted slot below `up_to` as skipped. Called once replay
    /// has moved past them, since a slot the leader never produced is otherwise
    /// indistinguishable from one that has not arrived yet.
    pub fn mark_skipped_below(&mut self, up_to: Slot) -> Vec<SlotEntry> {
        let stale: Vec<Slot> = self
            .entries
            .iter()
            .filter(|(slot, entry)| **slot < up_to && entry.level == SlotLevel::Incomplete)
            .map(|(&slot, _)| slot)
            .collect();
        stale
            .into_iter()
            .filter_map(|slot| self.update(slot, |entry| entry.level = SlotLevel::Skipped))
            .collect()
    }

    /// Slots that know their leader but have no name for it yet, as
    /// `(slot, leader)` pairs.
    pub fn leaders_without_names(&self) -> Vec<(Slot, String)> {
        self.entries
            .values()
            .filter(|entry| entry.leader_name.is_none())
            .filter_map(|entry| entry.leader.clone().map(|leader| (entry.slot, leader)))
            .collect()
    }

    pub fn set_leader_display(
        &mut self,
        slot: Slot,
        name: Option<String>,
        icon: Option<String>,
    ) -> Option<SlotEntry> {
        self.update(slot, |entry| {
            entry.leader_name = name;
            entry.leader_icon = icon;
        })
    }

    pub fn set_leader(
        &mut self,
        slot: Slot,
        leader: &Pubkey,
        name: Option<String>,
        icon: Option<String>,
        mine: bool,
    ) -> Option<SlotEntry> {
        let leader = leader.to_string();
        self.update(slot, |entry| {
            entry.leader = Some(leader);
            entry.leader_name = name;
            entry.leader_icon = icon;
            entry.mine = mine;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_never_regresses() {
        let mut ring = SlotRing::new(16);
        ring.update(10, |entry| entry.level = SlotLevel::Rooted);
        assert!(
            ring.update(10, |entry| entry.level = SlotLevel::Completed)
                .is_none()
        );
        assert_eq!(ring.get(10).unwrap().level, SlotLevel::Rooted);
    }

    #[test]
    fn update_reports_only_real_changes() {
        let mut ring = SlotRing::new(16);
        assert!(
            ring.update(1, |entry| entry.level = SlotLevel::Completed)
                .is_some()
        );
        assert!(
            ring.update(1, |entry| entry.level = SlotLevel::Completed)
                .is_none()
        );
    }

    #[test]
    fn ring_is_bounded() {
        let mut ring = SlotRing::new(4);
        for slot in 0..10 {
            ring.update(slot, |entry| entry.level = SlotLevel::Completed);
        }
        assert_eq!(ring.entries.len(), 4);
        assert!(ring.get(0).is_none());
        assert!(ring.get(9).is_some());
    }

    #[test]
    fn promote_advances_replayed_slots_only() {
        let mut ring = SlotRing::new(16);
        ring.update(1, |entry| entry.level = SlotLevel::Completed);
        ring.update(2, |_| {}); // never replayed
        ring.update(3, |entry| entry.level = SlotLevel::Completed);

        let promoted = ring.promote(2, SlotLevel::Rooted);
        assert_eq!(promoted.len(), 1);
        assert_eq!(promoted[0].slot, 1);
        assert_eq!(ring.get(2).unwrap().level, SlotLevel::Incomplete);
        assert_eq!(ring.get(3).unwrap().level, SlotLevel::Completed);
    }

    #[test]
    fn promote_does_not_demote() {
        let mut ring = SlotRing::new(16);
        ring.update(1, |entry| entry.level = SlotLevel::Finalized);
        assert!(ring.promote(1, SlotLevel::Rooted).is_empty());
        assert_eq!(ring.get(1).unwrap().level, SlotLevel::Finalized);
    }

    #[test]
    fn marking_skipped_leaves_completed_slots_alone() {
        let mut ring = SlotRing::new(16);
        ring.update(1, |entry| entry.level = SlotLevel::Completed);
        ring.update(2, |_| {});
        let skipped = ring.mark_skipped_below(3);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].slot, 2);
        assert_eq!(ring.get(1).unwrap().level, SlotLevel::Completed);
    }
}
