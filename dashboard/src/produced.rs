//! Detail for the blocks this validator produced, captured while the block's
//! bank is still in bank forks: the cost tracker and collected fees go with
//! the bank when it is dropped after rooting.

use {
    crate::{metrics_tap::StageTimes, versions::TxVersions},
    serde::Serialize,
    solana_clock::Slot,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Bundles {
    pub sanitized: u64,
    pub executed: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Execution {
    /// Thread time, not wall time.
    pub non_vote: StageTimes,
    pub workers: u64,
    pub longest_batch: u64,
    pub votes: Option<StageTimes>,
    pub window_millis: u64,
}

/// `transactions` and `non_vote_transactions` are differences against the parent; the rest are the
/// bank's own.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProducedBlock {
    pub slot: Slot,
    pub slot_time_millis: Option<u64>,
    pub blockhash: String,
    pub duration_nanos: Option<u64>,

    pub transactions: u64,
    pub non_vote_transactions: u64,
    pub failed_transactions: u64,
    pub entries: u64,

    pub block_cost: u64,
    pub block_cost_limit: u64,
    pub account_cost_limit: u64,

    /// Base and priority together: `total_transaction_fee` adds the two despite its name.
    pub total_fees: u64,
    pub priority_fees: u64,
    pub tips: Option<u64>,
    /// Absent on a stock validator or under BAM.
    pub bundles: Option<Bundles>,
    pub versions: Option<TxVersions>,
    pub execution: Option<Execution>,
    pub certificate: Option<BlockCertificate>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BlockCertificate {
    pub rewards: Slot,
    pub leader: Option<String>,
    pub leader_name: Option<String>,
    /// No fewer notarize votes than skip votes.
    pub notarized: bool,
    pub paid: u32,
    pub ranks: u32,
    pub stake_paid: f64,
    pub notar: u32,
    pub skip: u32,
    pub ours_in: bool,
    pub usual: Option<u32>,
    pub left_out: Vec<CertificateValidator>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CertificateValidator {
    pub identity: String,
    pub name: Option<String>,
    pub ip: Option<String>,
}

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

    /// Returns false for a slot already held: only the first sighting has the block's figures.
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

    pub fn fill_bundles(&mut self, landed: impl Fn(Slot) -> Option<Bundles>) -> bool {
        let mut changed = false;
        for block in &mut self.blocks {
            if block.bundles.is_none()
                && let Some(bundles) = landed(block.slot)
            {
                block.bundles = Some(bundles);
                changed = true;
            }
        }
        changed
    }

    fn block_mut(&mut self, slot: Slot) -> Option<&mut ProducedBlock> {
        self.blocks.iter_mut().find(|block| block.slot == slot)
    }

    pub fn set_versions(&mut self, slot: Slot, versions: TxVersions) -> bool {
        match self.block_mut(slot) {
            Some(block) if block.versions.is_none() => {
                block.versions = Some(versions);
                true
            }
            _ => false,
        }
    }

    pub fn set_certificate(&mut self, slot: Slot, certificate: BlockCertificate) -> bool {
        match self.block_mut(slot) {
            Some(block) if block.certificate.is_none() => {
                block.certificate = Some(certificate);
                true
            }
            _ => false,
        }
    }

    pub fn set_execution(&mut self, slot: Slot, execution: Execution) -> bool {
        match self.block_mut(slot) {
            Some(block) if block.execution.is_none() => {
                block.execution = Some(execution);
                true
            }
            _ => false,
        }
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
            account_cost_limit: 0,
            total_fees: 0,
            priority_fees: 0,
            tips: None,
            bundles: None,
            versions: None,
            execution: None,
            certificate: None,
        }
    }

    fn certificate(rewards: Slot) -> BlockCertificate {
        BlockCertificate {
            rewards,
            leader: None,
            leader_name: None,
            notarized: true,
            paid: 103,
            ranks: 112,
            stake_paid: 0.986,
            notar: 101,
            skip: 2,
            ours_in: true,
            usual: Some(103),
            left_out: Vec::new(),
        }
    }

    #[test]
    fn test_a_certificate_is_recorded_once() {
        let mut ring = ProducedRing::new(4);
        ring.insert(block(10));
        assert!(ring.set_certificate(10, certificate(2)));
        assert!(!ring.set_certificate(10, certificate(2)));
        assert!(!ring.set_certificate(11, certificate(3)));
        assert_eq!(
            ring.blocks()[0].certificate.as_ref().map(|c| c.rewards),
            Some(2)
        );
    }

    #[test]
    fn test_bundles_are_filled_in_once_the_stage_reports() {
        let mut ring = ProducedRing::new(4);
        ring.insert(block(10));
        ring.insert(block(11));
        let landed = |slot: Slot| {
            (slot == 11).then_some(Bundles {
                sanitized: 17,
                executed: 14,
            })
        };
        assert!(ring.fill_bundles(landed));
        assert_eq!(ring.blocks()[0].bundles, None);
        assert_eq!(
            ring.blocks()[1].bundles,
            Some(Bundles {
                sanitized: 17,
                executed: 14,
            })
        );
        assert!(!ring.fill_bundles(landed), "nothing left to fill");
    }

    #[test]
    fn test_versions_are_set_once_and_only_on_a_held_block() {
        let mut ring = ProducedRing::new(4);
        ring.insert(block(10));
        let tally = TxVersions {
            legacy: 312,
            v0: 41,
            v1: 0,
        };
        assert!(!ring.set_versions(11, tally), "not a block we hold");
        assert!(ring.set_versions(10, tally));
        assert_eq!(ring.blocks()[0].versions, Some(tally));
        assert!(
            !ring.set_versions(10, TxVersions::default()),
            "already read"
        );
        assert_eq!(ring.blocks()[0].versions, Some(tally));
    }

    #[test]
    fn test_execution_is_set_once_and_only_on_a_held_block() {
        let mut ring = ProducedRing::new(4);
        ring.insert(block(10));
        let execution = Execution {
            non_vote: StageTimes {
                load_execute: 512_000,
                ..StageTimes::default()
            },
            workers: 4,
            longest_batch: 14_800,
            votes: None,
            window_millis: 402,
        };
        assert!(!ring.set_execution(11, execution), "not a block we hold");
        assert!(ring.set_execution(10, execution));
        assert_eq!(ring.blocks()[0].execution, Some(execution));
        assert!(!ring.set_execution(10, execution), "already set");
    }

    #[test]
    fn test_slot_is_recorded_once() {
        let mut ring = ProducedRing::new(4);
        assert!(ring.insert(block(10)));
        // Only the first sighting of a frozen bank holds the block's own figures.
        assert!(!ring.insert(block(10)));
        assert_eq!(ring.blocks().len(), 1);
    }

    #[test]
    fn test_blocks_are_held_oldest_first_however_they_arrive() {
        let mut ring = ProducedRing::new(8);
        for slot in [12, 10, 13, 11] {
            ring.insert(block(slot));
        }
        let slots: Vec<Slot> = ring.blocks().iter().map(|block| block.slot).collect();
        assert_eq!(slots, vec![10, 11, 12, 13]);
    }

    #[test]
    fn test_oldest_go_first_when_it_is_full() {
        let mut ring = ProducedRing::new(3);
        for slot in 1..=6 {
            ring.insert(block(slot));
        }
        let slots: Vec<Slot> = ring.blocks().iter().map(|block| block.slot).collect();
        assert_eq!(slots, vec![4, 5, 6]);
    }

    #[test]
    fn test_out_of_order_arrival_still_evicts_the_oldest() {
        let mut ring = ProducedRing::new(2);
        ring.insert(block(5));
        ring.insert(block(9));
        ring.insert(block(7));
        let slots: Vec<Slot> = ring.blocks().iter().map(|block| block.slot).collect();
        assert_eq!(slots, vec![7, 9]);
    }
}
