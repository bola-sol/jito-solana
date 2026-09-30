//! Detail for the blocks this validator produced, captured while the block's
//! bank is still in bank forks: the cost tracker and collected fees go with
//! the bank when it is dropped after rooting.

use {
    crate::{metrics_tap::StageTimes, turns::LeaderTurn, versions::TxVersions},
    serde::Serialize,
    solana_clock::Slot,
    std::collections::{BTreeMap, BTreeSet},
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

/// The previous epoch's blocks stay until this share of the new one has passed, so the page is not
/// empty just after a boundary.
pub const PREVIOUS_EPOCH_KEPT_PERCENT: u64 = 20;

/// Well past 1.2 epochs of the largest stake's slots; a guard for a floor never set.
const MAX_HELD_BLOCKS: usize = 32_768;

/// The bundle stage reports within a few slots, and the tap keeps its reports about this long.
const BUNDLE_REACH: usize = 512;

/// The oldest slot kept, given the epoch's first slot, the previous epoch's, and how far in the
/// newest root is.
pub fn held_from(first: Slot, previous_first: Slot, index: u64, slots_in_epoch: u64) -> Slot {
    let passed = index.saturating_mul(100);
    if first == previous_first
        || passed >= slots_in_epoch.saturating_mul(PREVIOUS_EPOCH_KEPT_PERCENT)
    {
        first
    } else {
        previous_first
    }
}

/// Our blocks and leader turns for the current epoch, and the previous one for a while after the
/// boundary; see [`held_from`].
#[derive(Debug, Default)]
pub struct ProducedStore {
    blocks: BTreeMap<Slot, ProducedBlock>,
    /// By first slot.
    turns: BTreeMap<Slot, LeaderTurn>,
    /// Blocks added or filled in since `take_changed`.
    changed: BTreeSet<Slot>,
    floor: Slot,
}

impl ProducedStore {
    pub fn contains(&self, slot: Slot) -> bool {
        self.blocks.contains_key(&slot)
    }

    pub fn len(&self) -> usize {
        self.blocks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    pub fn floor(&self) -> Slot {
        self.floor
    }

    /// The newest `count`, oldest first.
    pub fn recent(&self, count: usize) -> Vec<ProducedBlock> {
        let mut recent: Vec<ProducedBlock> =
            self.blocks.values().rev().take(count).cloned().collect();
        recent.reverse();
        recent
    }

    /// The blocks added or filled in since the last call, oldest first; one since dropped is left out.
    pub fn take_changed(&mut self) -> Vec<ProducedBlock> {
        std::mem::take(&mut self.changed)
            .into_iter()
            .filter_map(|slot| self.blocks.get(&slot).cloned())
            .collect()
    }

    /// Returns false for a slot already held or below the floor: only the first sighting has the
    /// block's figures.
    pub fn insert(&mut self, block: ProducedBlock) -> bool {
        if block.slot < self.floor || self.contains(block.slot) {
            return false;
        }
        self.changed.insert(block.slot);
        self.blocks.insert(block.slot, block);
        while self.blocks.len() > MAX_HELD_BLOCKS {
            self.blocks.pop_first();
        }
        true
    }

    /// Drops what is older than `floor`, and refuses it from then on.
    pub fn hold_from(&mut self, floor: Slot) {
        if floor == self.floor {
            return;
        }
        self.floor = floor;
        self.blocks = self.blocks.split_off(&floor);
        self.turns = self.turns.split_off(&floor);
        self.changed = self.changed.split_off(&floor);
    }

    pub fn fill_bundles(&mut self, landed: impl Fn(Slot) -> Option<Bundles>) -> bool {
        let mut changed = false;
        for block in self.blocks.values_mut().rev().take(BUNDLE_REACH) {
            if block.bundles.is_none()
                && let Some(bundles) = landed(block.slot)
            {
                block.bundles = Some(bundles);
                self.changed.insert(block.slot);
                changed = true;
            }
        }
        changed
    }

    /// The blocks still waiting on their reward certificate.
    pub fn without_certificate(&self) -> Vec<Slot> {
        self.blocks
            .values()
            .filter(|block| block.certificate.is_none())
            .map(|block| block.slot)
            .collect()
    }

    pub fn set_versions(&mut self, slot: Slot, versions: TxVersions) -> bool {
        let set = match self.blocks.get_mut(&slot) {
            Some(block) if block.versions.is_none() => {
                block.versions = Some(versions);
                true
            }
            _ => false,
        };
        self.note_changed(slot, set)
    }

    pub fn set_certificate(&mut self, slot: Slot, certificate: BlockCertificate) -> bool {
        let set = match self.blocks.get_mut(&slot) {
            Some(block) if block.certificate.is_none() => {
                block.certificate = Some(certificate);
                true
            }
            _ => false,
        };
        self.note_changed(slot, set)
    }

    pub fn set_execution(&mut self, slot: Slot, execution: Execution) -> bool {
        let set = match self.blocks.get_mut(&slot) {
            Some(block) if block.execution.is_none() => {
                block.execution = Some(execution);
                true
            }
            _ => false,
        };
        self.note_changed(slot, set)
    }

    fn note_changed(&mut self, slot: Slot, set: bool) -> bool {
        if set {
            self.changed.insert(slot);
        }
        set
    }

    /// How many of `first..=last` produced a block.
    pub fn produced_in(&self, first: Slot, last: Slot) -> u64 {
        self.blocks.range(first..=last).count() as u64
    }

    pub fn add_turn(&mut self, turn: LeaderTurn) {
        if turn.first >= self.floor {
            self.turns.insert(turn.first, turn);
        }
    }

    /// The newest `count`, oldest first.
    pub fn recent_turns(&self, count: usize) -> Vec<LeaderTurn> {
        let mut recent: Vec<LeaderTurn> = self.turns.values().rev().take(count).cloned().collect();
        recent.reverse();
        recent
    }
}

/// A block with nought everywhere, for tests elsewhere too.
#[cfg(test)]
pub(crate) fn sample_block(slot: Slot) -> ProducedBlock {
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

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{
            meters::QuicPort,
            metrics_tap::{ExecutedTotals, QuicLevels, QuicTotals, VerifyTotals},
        },
    };

    fn block(slot: Slot) -> ProducedBlock {
        sample_block(slot)
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

    fn execution() -> Execution {
        Execution {
            non_vote: StageTimes {
                load_execute: 512_000,
                ..StageTimes::default()
            },
            workers: 4,
            longest_batch: 14_800,
            votes: None,
            window_millis: 402,
        }
    }

    fn turn(first: Slot, last: Slot) -> LeaderTurn {
        LeaderTurn {
            first,
            last,
            produced: 0,
            drained_millis: 0,
            since_millis: None,
            quic: QuicPort {
                name: "tpu",
                counts: QuicTotals::default(),
                levels: QuicLevels::default(),
                kernel_drops: None,
            },
            verify: VerifyTotals::default(),
            executed: ExecutedTotals::default(),
        }
    }

    fn slots(blocks: &[ProducedBlock]) -> Vec<Slot> {
        blocks.iter().map(|block| block.slot).collect()
    }

    #[test]
    fn test_each_block_added_or_filled_in_is_taken_once() {
        let mut ring = ProducedStore::default();
        ring.insert(block(11));
        ring.insert(block(10));
        assert_eq!(slots(&ring.take_changed()), [10, 11]);
        assert!(ring.take_changed().is_empty());

        ring.set_versions(11, TxVersions::default());
        ring.set_certificate(11, certificate(3));
        ring.set_execution(12, execution());
        assert_eq!(slots(&ring.take_changed()), [11]);
        assert!(ring.recent(usize::MAX)[1].certificate.is_some());
    }

    #[test]
    fn test_a_certificate_is_recorded_once() {
        let mut ring = ProducedStore::default();
        ring.insert(block(10));
        assert!(ring.set_certificate(10, certificate(2)));
        assert!(!ring.set_certificate(10, certificate(2)));
        assert!(!ring.set_certificate(11, certificate(3)));
        assert_eq!(
            ring.recent(usize::MAX)[0]
                .certificate
                .as_ref()
                .map(|c| c.rewards),
            Some(2)
        );
    }

    #[test]
    fn test_bundles_are_filled_in_once_the_stage_reports() {
        let mut ring = ProducedStore::default();
        ring.insert(block(10));
        ring.insert(block(11));
        let landed = |slot: Slot| {
            (slot == 11).then_some(Bundles {
                sanitized: 17,
                executed: 14,
            })
        };
        assert!(ring.fill_bundles(landed));
        assert_eq!(ring.recent(usize::MAX)[0].bundles, None);
        assert_eq!(
            ring.recent(usize::MAX)[1].bundles,
            Some(Bundles {
                sanitized: 17,
                executed: 14,
            })
        );
        assert!(!ring.fill_bundles(landed), "nothing left to fill");
    }

    #[test]
    fn test_versions_are_set_once_and_only_on_a_held_block() {
        let mut ring = ProducedStore::default();
        ring.insert(block(10));
        let tally = TxVersions {
            legacy: 312,
            v0: 41,
            v1: 0,
        };
        assert!(!ring.set_versions(11, tally), "not a block we hold");
        assert!(ring.set_versions(10, tally));
        assert_eq!(ring.recent(usize::MAX)[0].versions, Some(tally));
        assert!(
            !ring.set_versions(10, TxVersions::default()),
            "already read"
        );
        assert_eq!(ring.recent(usize::MAX)[0].versions, Some(tally));
    }

    #[test]
    fn test_execution_is_set_once_and_only_on_a_held_block() {
        let mut ring = ProducedStore::default();
        ring.insert(block(10));
        let execution = execution();
        assert!(!ring.set_execution(11, execution), "not a block we hold");
        assert!(ring.set_execution(10, execution));
        assert_eq!(ring.recent(usize::MAX)[0].execution, Some(execution));
        assert!(!ring.set_execution(10, execution), "already set");
    }

    #[test]
    fn test_slot_is_recorded_once() {
        let mut ring = ProducedStore::default();
        assert!(ring.insert(block(10)));
        // Only the first sighting of a frozen bank holds the block's own figures.
        assert!(!ring.insert(block(10)));
        assert_eq!(ring.recent(usize::MAX).len(), 1);
    }

    #[test]
    fn test_blocks_are_held_oldest_first_however_they_arrive() {
        let mut ring = ProducedStore::default();
        for slot in [12, 10, 13, 11] {
            ring.insert(block(slot));
        }
        let slots: Vec<Slot> = ring
            .recent(usize::MAX)
            .iter()
            .map(|block| block.slot)
            .collect();
        assert_eq!(slots, vec![10, 11, 12, 13]);
    }

    #[test]
    fn test_the_previous_epoch_is_kept_for_a_fifth_of_the_next() {
        assert_eq!(held_from(1_000, 0, 199, 1_000), 0);
        assert_eq!(held_from(1_000, 0, 200, 1_000), 1_000);
        assert_eq!(
            held_from(0, 0, 5, 1_000),
            0,
            "the first epoch has none before it"
        );
    }

    #[test]
    fn test_a_floor_drops_older_blocks_and_turns_and_refuses_them() {
        let mut ring = ProducedStore::default();
        for slot in [8, 9, 12, 13] {
            ring.insert(block(slot));
        }
        ring.add_turn(turn(8, 9));
        ring.add_turn(turn(12, 13));
        ring.take_changed();
        ring.set_versions(9, TxVersions::default());
        ring.hold_from(12);
        assert_eq!(slots(&ring.recent(usize::MAX)), [12, 13]);
        assert!(
            ring.take_changed().is_empty(),
            "the change to 9 went with it"
        );
        assert_eq!(ring.recent_turns(8).len(), 1);
        assert!(!ring.insert(block(10)), "below the floor");
        ring.add_turn(turn(10, 11));
        assert_eq!(ring.recent_turns(8).len(), 1);
    }

    #[test]
    fn test_bundles_reach_only_the_newest_blocks() {
        let mut ring = ProducedStore::default();
        for slot in 0..(BUNDLE_REACH as u64 + 1) {
            ring.insert(block(slot));
        }
        let landed = |_slot: Slot| {
            Some(Bundles {
                sanitized: 1,
                executed: 1,
            })
        };
        ring.fill_bundles(landed);
        let held = ring.recent(usize::MAX);
        assert_eq!(held[0].bundles, None);
        assert!(held[1].bundles.is_some());
    }
}
