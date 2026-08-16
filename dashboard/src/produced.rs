//! Detail for the blocks this validator produced.
//!
//! Captured while the block's bank is still in bank forks. The cost tracker and
//! the collected fees live on the bank and go with it when it is dropped after
//! rooting, so anything read from them has to be taken at the moment the slot
//! freezes or not at all.
//!
//! Only this validator's own leader slots are kept, which on a small validator
//! is about four slots in every eight hundred.

use {serde::Serialize, solana_clock::Slot};

/// What one produced block looked like.
///
/// Some of the bank's counters accumulate along the fork and some are reset for
/// each bank. Which is which is not guessable from the names, so it is recorded
/// here per field rather than left to the reader: `transactions` and
/// `non_vote_transactions` are differences against the parent, the rest are the
/// bank's own.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProducedBlock {
    pub slot: Slot,
    /// When the blockstore recorded the first shred of this slot, in
    /// milliseconds. For a block this validator produced that is its own
    /// first shred, so it is when the block started rather than when anything
    /// observed it. `None` for a slot the blockstore holds no timing for.
    pub slot_time_millis: Option<u64>,
    pub blockhash: String,
    /// Time from the previous slot, when the blockstore recorded one.
    pub duration_nanos: Option<u64>,

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

    /// Fees this block collected, in lamports. Held per bank rather than
    /// accumulated along the fork, so neither is differenced.
    ///
    /// `total_fees` is base and priority together: the bank's
    /// `total_transaction_fee` adds the two despite its name, so taking it as
    /// the base fee alone would double-count the priority half.
    pub total_fees: u64,
    pub priority_fees: u64,
}

/// The most recent produced blocks, oldest first.
#[derive(Debug)]
pub struct ProducedRing {
    capacity: usize,
    blocks: Vec<ProducedBlock>,
}

impl ProducedRing {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            blocks: Vec::new(),
        }
    }

    pub fn contains(&self, slot: Slot) -> bool {
        self.blocks.iter().any(|block| block.slot == slot)
    }

    pub fn blocks(&self) -> &[ProducedBlock] {
        &self.blocks
    }

    /// Records a block, keeping the newest `capacity` of them.
    ///
    /// Returns false for a slot already held. A bank stays frozen in bank forks
    /// for many ticks before it is rooted, so the collector sees each of these
    /// repeatedly and only the first sighting carries the block's own figures.
    ///
    /// Sorted on insert rather than assumed ordered: bank forks is walked as a
    /// map, so two blocks frozen between one tick and the next can arrive in
    /// either order.
    pub fn insert(&mut self, block: ProducedBlock) -> bool {
        if self.contains(block.slot) {
            return false;
        }
        self.blocks.push(block);
        self.blocks.sort_by_key(|block| block.slot);
        if self.blocks.len() > self.capacity {
            let excess = self.blocks.len().saturating_sub(self.capacity);
            self.blocks.drain(..excess);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(slot: Slot) -> ProducedBlock {
        ProducedBlock {
            slot,
            slot_time_millis: None,
            blockhash: format!("hash{slot}"),
            duration_nanos: None,
            transactions: 0,
            non_vote_transactions: 0,
            failed_transactions: 0,
            entries: 0,
            block_cost: 0,
            block_cost_limit: 0,
            total_fees: 0,
            priority_fees: 0,
        }
    }

    #[test]
    fn a_slot_is_recorded_once() {
        let mut ring = ProducedRing::new(4);
        assert!(ring.insert(block(10)));
        // The same bank is seen frozen on every tick until it is rooted. Only
        // the first sighting holds the block's own figures.
        assert!(!ring.insert(block(10)));
        assert_eq!(ring.blocks().len(), 1);
    }

    #[test]
    fn blocks_are_held_oldest_first_however_they_arrive() {
        let mut ring = ProducedRing::new(8);
        for slot in [12, 10, 13, 11] {
            ring.insert(block(slot));
        }
        let slots: Vec<Slot> = ring.blocks().iter().map(|block| block.slot).collect();
        assert_eq!(slots, vec![10, 11, 12, 13]);
    }

    #[test]
    fn the_oldest_go_first_when_it_is_full() {
        let mut ring = ProducedRing::new(3);
        for slot in 1..=6 {
            ring.insert(block(slot));
        }
        let slots: Vec<Slot> = ring.blocks().iter().map(|block| block.slot).collect();
        assert_eq!(slots, vec![4, 5, 6]);
    }

    #[test]
    fn an_out_of_order_arrival_still_evicts_the_oldest() {
        let mut ring = ProducedRing::new(2);
        ring.insert(block(5));
        ring.insert(block(9));
        // Arrives late and is older than both, so it is the one dropped.
        ring.insert(block(7));
        let slots: Vec<Slot> = ring.blocks().iter().map(|block| block.slot).collect();
        assert_eq!(slots, vec![7, 9]);
    }
}
