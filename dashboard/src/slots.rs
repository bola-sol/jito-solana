//! Rolling history of recent slots, backing the slot strip and the sidebar.

use {
    serde::Serialize,
    solana_clock::Slot,
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
    /// True when this validator was the scheduled leader.
    ///
    /// The leader itself is not here. It was three strings on every slot, and
    /// across a window of them the same key, name and icon repeated for all
    /// four slots of a turn: about a hundred bytes a slot, and a quarter of
    /// what a client was sent on connect. The key now comes from the epoch's
    /// turn array and the name and icon from the peer table, each holding one
    /// copy per leader instead of one per slot.
    ///
    /// `mine` stays because it cannot be worked out from those without the
    /// epoch arrays, which arrive on their own message and may not have yet.
    pub mine: bool,
    /// What replay found in the block. `None` until the slot freezes, and for
    /// a slot that was skipped or never replayed.
    pub block: Option<BlockDetail>,
    /// Wall-clock duration from the previous slot completing, in nanoseconds.
    ///
    /// Outside [`BlockDetail`] because it is measured from shred arrival rather
    /// than read off the bank, and so exists for slots that have no block.
    pub duration_nanos: Option<u64>,
}

/// What one block contained, read off its bank at the moment it froze.
///
/// Every field is per block. Some of the bank's counters accumulate along the
/// fork and some are reset for each bank, and which is which is not guessable
/// from the names, so the caller differences the inherited ones before they
/// reach here.
///
/// Grouped rather than spread across [`SlotEntry`] because they are all read at
/// the same instant from the same bank, and because a client is sent five
/// hundred of these at once: one absent object costs less on the wire than
/// eight absent fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BlockDetail {
    /// Transactions in this block. Differenced against the parent.
    pub transactions: u64,
    /// Of those, the ones that were not votes. Differenced against the parent.
    pub non_vote_transactions: u64,
    /// Transactions that landed but returned an error. The bank's own counter,
    /// reset for each bank, so this is already per block.
    pub failed_transactions: u64,
    /// Entries in the block. The bank's own counter.
    pub entries: u64,
    /// Compute units the block consumed, and the protocol limit it was measured
    /// against.
    pub block_cost: u64,
    pub block_cost_limit: u64,
    /// The most compute any one account may be charged in a block.
    ///
    /// Taken from the bank rather than held as a constant here, because it is a
    /// consensus limit that moves with feature activation. A block can be far
    /// short of the block limit and still be unable to take another transaction
    /// touching an account that has reached this one.
    pub account_cost_limit: u64,
    /// Fees this block collected, in lamports. Held per bank rather than
    /// accumulated along the fork, so neither is differenced.
    ///
    /// `total_fees` is base and priority together: the bank's
    /// `total_transaction_fee` adds the two despite its name, so taking it as
    /// the base fee alone would double-count the priority half.
    pub total_fees: u64,
    pub priority_fees: u64,
}

impl SlotEntry {
    fn new(slot: Slot) -> Self {
        Self {
            slot,
            level: SlotLevel::Incomplete,
            mine: false,
            block: None,
            duration_nanos: None,
        }
    }
}

/// This validator's own leader slots held back from pruning.
///
/// A validator leads roughly one slot in eight hundred, so a window sized for
/// the live strip holds none of its own. Held back, a client that reconnects
/// still receives them; pruned with everything else, the sidebar's own-slots
/// view would be empty on every reload.
///
/// Sixty-four of them, which is what that rail needs and no more. The schedule
/// page reaches our slots by searching the packed history instead, which goes
/// back a hundred thousand rather than the few hours this does, so the deep
/// view no longer comes from here.
///
/// They occupy the ring's capacity rather than extending it, so the oldest
/// ordinary slots make way for them. Matches the browser's own retention, so a
/// reload restores what was on screen rather than some other depth.
const OWN_SLOTS_KEPT: usize = 64;

/// A bounded, slot-keyed history. Slots more than `capacity` behind the highest
/// one seen are dropped, except for this validator's own.
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

    /// What a newly connected client is sent: the most recent `count` slots,
    /// preceded by this validator's own from further back.
    ///
    /// Without the second part a reload lost every leader slot on screen, since
    /// the recent window almost never contains one.
    ///
    /// One message. It was two while a slot carried its leader's key, name and
    /// icon, which put five hundred of ours and five hundred and twelve recent
    /// ones past the frame ceiling in the worst case. Those strings live once
    /// per leader elsewhere now, the worst case is a quarter of the ceiling,
    /// and the split and the key ordering it depended on are both gone.
    pub fn overview(&self, count: usize) -> Vec<SlotEntry> {
        let recent = self.recent(count);
        let floor = recent.first().map_or(Slot::MAX, |entry| entry.slot);
        let mut overview: Vec<SlotEntry> = self
            .entries
            .values()
            .filter(|entry| entry.mine && entry.slot < floor)
            .cloned()
            .collect();
        overview.extend(recent);
        overview
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
        if self.entries.len() <= self.capacity {
            return;
        }
        // Split by ownership rather than walked oldest-first and skipping ours,
        // which would delete newer slots to make room for the ones it skipped.
        // The map is ordered by slot, so both lists come out oldest first.
        let mut own = Vec::new();
        let mut rest = Vec::new();
        for (&slot, entry) in &self.entries {
            if entry.mine { &mut own } else { &mut rest }.push(slot);
        }
        // Our own slots take up the ring's capacity rather than sitting on top
        // of it. Kept on top, the map settled above the length the guard above
        // returns early at, so the guard never fired again: every update ran
        // this whole scan, removed nothing, and left the length where it was.
        //
        // The cost is that a validator holding its full allowance of leader
        // slots keeps that many fewer ordinary ones, which out of four thousand
        // is not a window anybody will miss.
        let drop_own = own.len().saturating_sub(OWN_SLOTS_KEPT);
        let kept_own = own.len().saturating_sub(drop_own);
        let drop_rest = rest
            .len()
            .saturating_sub(self.capacity.saturating_sub(kept_own));
        for slot in own
            .into_iter()
            .take(drop_own)
            .chain(rest.into_iter().take(drop_rest))
        {
            self.entries.remove(&slot);
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

    /// Records that this validator leads `slot`.
    ///
    /// The only thing about a leader a slot still carries. Everything else the
    /// page shows about them is one copy per leader elsewhere.
    pub fn set_mine(&mut self, slot: Slot, mine: bool) -> Option<SlotEntry> {
        self.update(slot, |entry| entry.mine = mine)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_a_slot_records_only_whether_it_is_ours() {
        let mut ring = SlotRing::new(16);
        let entry = ring.set_mine(7, true).expect("a change");
        assert!(entry.mine);
    }

    #[test]
    fn test_marking_the_same_slot_ours_twice_reports_no_change() {
        // The schedule is walked forwards on every tick, so a slot is labelled
        // repeatedly. Republishing each time would put the strip's whole window
        // on the wire five times a second.
        let mut ring = SlotRing::new(16);
        assert!(ring.set_mine(7, true).is_some());
        assert!(ring.set_mine(7, true).is_none());
    }

    /// The two slot snapshots are the largest messages the server sends, and
    /// the websocket ceiling is sized from them. If a field is added here, or
    /// either grows, this is what notices before a client is cut off
    /// mid-snapshot in production.
    ///
    /// Checked separately because they are sent separately. Added together
    /// they are over the ceiling, which is why they were split, and asserting
    /// on the sum would fail for a shape that ships perfectly well.
    #[test]
    fn test_the_largest_slot_snapshots_fit_the_message_ceiling() {
        // Worst case throughout: a full ring, every counter at its ceiling.
        // Far smaller than it was, the leader's key, name and icon having moved
        // off the slot; the check stays because what bounds the frame is still
        // this message and a field added here is what would grow it.
        //
        // The 512 mirrors `SLOT_OVERVIEW_LEN` in `collect`, which this module
        // cannot see.
        let worst = |count: usize| -> Vec<SlotEntry> {
            (0..count as u64)
                .map(|index| SlotEntry {
                    slot: 428_804_675 + index,
                    level: SlotLevel::OptimisticallyConfirmed,
                    mine: true,
                    block: Some(BlockDetail {
                        transactions: u64::MAX,
                        non_vote_transactions: u64::MAX,
                        failed_transactions: u64::MAX,
                        entries: u64::MAX,
                        block_cost: u64::MAX,
                        block_cost_limit: u64::MAX,
                        account_cost_limit: u64::MAX,
                        total_fees: u64::MAX,
                        priority_fees: u64::MAX,
                    }),
                    duration_nanos: Some(u64::MAX),
                })
                .collect()
        };

        let encoded = crate::proto::encode("slot", "overview", &worst(512 + OWN_SLOTS_KEPT));
        assert!(
            encoded.len() < crate::proto::MAX_MESSAGE,
            "worst-case overview is {} bytes against a {} byte ceiling",
            encoded.len(),
            crate::proto::MAX_MESSAGE
        );
    }

    /// Every slot this validator led, oldest first.
    fn ours(ring: &SlotRing) -> Vec<Slot> {
        ring.entries
            .values()
            .filter(|entry| entry.mine)
            .map(|entry| entry.slot)
            .collect()
    }

    #[test]
    fn test_our_own_slots_outlive_the_window() {
        // Without this a client that reconnects is sent a window that almost
        // never contains one of its own slots, and the sidebar's own-slots view
        // comes back empty on every reload.
        let mut ring = SlotRing::new(8);
        for slot in 1..=4 {
            ring.update(slot, |entry| entry.mine = true);
        }
        for slot in 5..=200 {
            ring.update(slot, |entry| entry.level = SlotLevel::Rooted);
        }
        assert_eq!(ours(&ring), vec![1, 2, 3, 4]);
    }

    #[test]
    fn test_own_retention_is_bounded() {
        // Saturating rather than bare `+`: the workspace denies
        // `arithmetic_side_effects`, and a cast of a constant is not a literal
        // as far as the lint is concerned.
        let led = (OWN_SLOTS_KEPT as Slot).saturating_add(100);
        let mut ring = SlotRing::new(8);
        for slot in 1..=led {
            ring.update(slot, |entry| entry.mine = true);
        }
        for slot in led.saturating_add(1)..=led.saturating_add(200) {
            ring.update(slot, |entry| entry.level = SlotLevel::Rooted);
        }
        let kept = ours(&ring);
        assert_eq!(kept.len(), OWN_SLOTS_KEPT);
        // The newest of ours, not the first we ever led.
        assert_eq!(kept.last(), Some(&led));
        assert_eq!(kept.first(), Some(&101));
    }

    #[test]
    fn test_keeping_our_own_costs_the_oldest_ordinary_slot() {
        let mut ring = SlotRing::new(8);
        ring.update(1, |entry| entry.mine = true);
        for slot in 2..=100 {
            ring.update(slot, |entry| entry.level = SlotLevel::Rooted);
        }
        // Seven ordinary slots and the one of ours, filling the capacity rather
        // than overflowing it. The newest are all still here: what the retained
        // slot costs is the oldest ordinary one, not a recent one.
        let recent: Vec<Slot> = ring.recent(8).iter().map(|entry| entry.slot).collect();
        assert_eq!(recent, vec![1, 94, 95, 96, 97, 98, 99, 100]);
    }

    #[test]
    fn test_pruning_settles_where_the_guard_will_leave_it_alone() {
        // `prune` returns early at `capacity`, so it has to prune to at most
        // that. When our own slots were kept on top of the capacity instead of
        // within it, the map settled above the threshold and the guard never
        // fired again: every update ran the whole scan, removed nothing, and
        // left the length where it was. Nothing failed, it just burned the
        // collector's tick.
        let mut ring = SlotRing::new(256);
        for slot in 1..=80 {
            ring.update(slot, |entry| entry.mine = true);
        }
        for slot in 81..=2_000 {
            ring.update(slot, |entry| entry.level = SlotLevel::Rooted);
        }

        let settled = ring.entries.len();
        assert!(
            settled <= ring.capacity,
            "settled at {settled}, above the {} the guard returns early at",
            ring.capacity
        );

        // The fixed point itself: pruning again has nothing left to do.
        ring.prune();
        assert_eq!(ring.entries.len(), settled);
    }

    #[test]
    fn test_the_overview_carries_our_own_slots_from_before_the_window() {
        let mut ring = SlotRing::new(512);
        for slot in [1, 2] {
            ring.update(slot, |entry| entry.mine = true);
        }
        for slot in 3..=100 {
            ring.update(slot, |entry| entry.level = SlotLevel::Rooted);
        }
        let slots: Vec<Slot> = ring.overview(10).iter().map(|entry| entry.slot).collect();

        assert_eq!(&slots[..2], &[1, 2]);
        assert_eq!(slots.last(), Some(&100));
        assert!(
            slots.windows(2).all(|pair| pair[0] < pair[1]),
            "the overview must stay ordered and hold nothing twice: {slots:?}"
        );
    }

    #[test]
    fn test_an_own_slot_inside_the_window_is_not_sent_twice() {
        let mut ring = SlotRing::new(512);
        for slot in 1..=20 {
            ring.update(slot, |entry| entry.level = SlotLevel::Rooted);
        }
        ring.update(18, |entry| entry.mine = true);

        let slots: Vec<Slot> = ring.overview(5).iter().map(|entry| entry.slot).collect();
        assert_eq!(slots, vec![16, 17, 18, 19, 20]);
    }

    #[test]
    fn test_level_never_regresses() {
        let mut ring = SlotRing::new(16);
        ring.update(10, |entry| entry.level = SlotLevel::Rooted);
        assert!(
            ring.update(10, |entry| entry.level = SlotLevel::Completed)
                .is_none()
        );
        assert_eq!(ring.get(10).unwrap().level, SlotLevel::Rooted);
    }

    #[test]
    fn test_update_reports_only_real_changes() {
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
    fn test_ring_is_bounded() {
        let mut ring = SlotRing::new(4);
        for slot in 0..10 {
            ring.update(slot, |entry| entry.level = SlotLevel::Completed);
        }
        assert_eq!(ring.entries.len(), 4);
        assert!(ring.get(0).is_none());
        assert!(ring.get(9).is_some());
    }

    #[test]
    fn test_promote_advances_replayed_slots_only() {
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
    fn test_promote_does_not_demote() {
        let mut ring = SlotRing::new(16);
        ring.update(1, |entry| entry.level = SlotLevel::Finalized);
        assert!(ring.promote(1, SlotLevel::Rooted).is_empty());
        assert_eq!(ring.get(1).unwrap().level, SlotLevel::Finalized);
    }

    #[test]
    fn test_marking_skipped_leaves_completed_slots_alone() {
        let mut ring = SlotRing::new(16);
        ring.update(1, |entry| entry.level = SlotLevel::Completed);
        ring.update(2, |_| {});
        let skipped = ring.mark_skipped_below(3);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].slot, 2);
        assert_eq!(ring.get(1).unwrap().level, SlotLevel::Completed);
    }
}
