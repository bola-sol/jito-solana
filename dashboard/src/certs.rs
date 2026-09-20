//! Whether this node's vote was paid for each slot, and how many slots each
//! validator's was, read from the reward certificates alpenglow leaders write
//! into their block footers.

use {
    agave_votor_messages::reward_certificate::{
        NUM_SLOTS_FOR_REWARD, NotarRewardCertificate, SkipRewardCertificate,
    },
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_entry::block_component::{
        BlockComponent, BlockFooterV1, VersionedBlockFooter, VersionedBlockMarker,
    },
    solana_ledger::{blockstore::Blockstore, shred::DATA_SHREDS_PER_FEC_BLOCK},
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    solana_signer_store::{Decoded, decode},
};

/// The footer sits in the second to last FEC set; the last one closes the
/// block. Reading from there costs two sets of shreds whatever the block holds.
const FOOTER_SPAN: u64 = 2 * DATA_SHREDS_PER_FEC_BLOCK as u64;

/// Slots from the epoch's first over which the cluster pays out stake
/// rewards, when every validator misses votes.
pub const BOUNDARY_SLOTS: Slot = 1_000;

/// How finely unpaid slots are placed along the epoch for the marks on the
/// epoch meter.
pub const MISS_BINS: usize = 400;
const LAST_BIN: usize = MISS_BINS - 1;

/// What the reward certificate for a slot said about this node's vote. The
/// certificate for slot N can only be written by the leader of slot N+8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reward {
    Paid,
    Unpaid,
    /// The leader of slot N+8 produced no block, so nobody was paid for N.
    NoCertificate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub slot: Slot,
    pub reward: Reward,
    /// Each rank's bit in the notar and skip certificates together. Empty
    /// where there was no certificate.
    pub paid: Vec<bool>,
}

/// Slots this validator's vote was paid for in an epoch, against the most any
/// validator's was, counted from `since_slot` where the walk began.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Participation {
    pub epoch: Epoch,
    pub since_slot: Slot,
    pub paid: u64,
    /// Slots whose certificate paid anybody.
    pub rewarded: u64,
    pub cluster_max: u64,
    pub misses: Misses,
    /// Unpaid slots per `MISS_BINS`th of the epoch.
    pub miss_bins: Vec<u32>,
}

/// Slots that paid others but not this validator, by where they fell. A slot
/// in more than one place counts in the first: the boundary is the cluster's
/// doing, a leader slot ours.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Misses {
    /// Within `BOUNDARY_SLOTS` of the epoch's first slot.
    pub boundary: u64,
    /// One of this validator's leader slots.
    pub leader: u64,
    /// While a snapshot archive was being written.
    pub snapshot: u64,
    pub elsewhere: u64,
}

/// The slots a snapshot write spanned. Open where it is still being written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub from: Slot,
    pub to: Option<Slot>,
}

impl Span {
    fn covers(&self, slot: Slot) -> bool {
        slot >= self.from && self.to.is_none_or(|to| slot <= to)
    }
}

/// Paid slots per rank over one epoch's marks.
#[derive(Debug)]
pub struct Tally {
    epoch: Epoch,
    since_slot: Slot,
    epoch_start: Slot,
    slots_in_epoch: u64,
    /// Ascending. Empty where the schedule was not known when the tally began,
    /// when those misses fall under `elsewhere`.
    leader_slots: Vec<Slot>,
    paid: u64,
    rewarded: u64,
    per_rank: Vec<u64>,
    misses: Misses,
    miss_bins: Vec<u32>,
}

impl Tally {
    pub fn new(
        epoch: Epoch,
        since_slot: Slot,
        epoch_start: Slot,
        slots_in_epoch: u64,
        leader_slots: Vec<Slot>,
    ) -> Self {
        Self {
            epoch,
            since_slot,
            epoch_start,
            slots_in_epoch,
            leader_slots,
            paid: 0,
            rewarded: 0,
            per_rank: Vec::new(),
            misses: Misses::default(),
            miss_bins: vec![0; MISS_BINS],
        }
    }

    pub fn epoch(&self) -> Epoch {
        self.epoch
    }

    /// Counts a mark, placing an unpaid slot against `snapshots`, the writes
    /// seen so far. A slot with no certificate counts for nobody.
    pub fn add(&mut self, mark: &Mark, snapshots: &[Span]) {
        match mark.reward {
            Reward::Paid => self.paid = self.paid.saturating_add(1),
            Reward::Unpaid => self.miss(mark.slot, snapshots),
            Reward::NoCertificate => return,
        }
        self.rewarded = self.rewarded.saturating_add(1);
        if self.per_rank.len() < mark.paid.len() {
            self.per_rank.resize(mark.paid.len(), 0);
        }
        for (count, paid) in self.per_rank.iter_mut().zip(&mark.paid) {
            if *paid {
                *count = count.saturating_add(1);
            }
        }
    }

    fn miss(&mut self, slot: Slot, snapshots: &[Span]) {
        let count = if slot < self.epoch_start.saturating_add(BOUNDARY_SLOTS) {
            &mut self.misses.boundary
        } else if self.leader_slots.binary_search(&slot).is_ok() {
            &mut self.misses.leader
        } else if snapshots.iter().any(|span| span.covers(slot)) {
            &mut self.misses.snapshot
        } else {
            &mut self.misses.elsewhere
        };
        *count = count.saturating_add(1);
        let bin = slot
            .saturating_sub(self.epoch_start)
            .saturating_mul(MISS_BINS as u64)
            .checked_div(self.slots_in_epoch)
            .unwrap_or(0);
        let bin = usize::try_from(bin).unwrap_or(LAST_BIN).min(LAST_BIN);
        if let Some(count) = self.miss_bins.get_mut(bin) {
            *count = count.saturating_add(1);
        }
    }

    /// The counts so far, the best rank's among them.
    pub fn participation(&self) -> Participation {
        Participation {
            epoch: self.epoch,
            since_slot: self.since_slot,
            paid: self.paid,
            rewarded: self.rewarded,
            cluster_max: self.per_rank.iter().copied().max().unwrap_or(0),
            misses: self.misses,
            miss_bins: self.miss_bins.clone(),
        }
    }
}

enum Block {
    Footer(Box<BlockFooterV1>),
    /// At or below the root with no block.
    Missing,
    /// Above the root and not full yet.
    Pending,
    /// Full, but the footer could not be read.
    Opaque,
}

/// Reads the footers of `from..=to` for the reward certificates they carry,
/// returning a mark per certificate and the last slot read. Stops at the
/// first slot still filling.
pub fn walk(
    blockstore: &Blockstore,
    bank: &Bank,
    vote_account: &Pubkey,
    from: Slot,
    to: Slot,
) -> (Option<Slot>, Vec<Mark>) {
    let my_rank = |slot| rank_of(bank, vote_account, slot);
    let root = bank.slot();
    let mut marks = Vec::new();
    let mut read_to = None;
    for slot in from..=to {
        let Some(reward_slot) = slot.checked_sub(NUM_SLOTS_FOR_REWARD) else {
            read_to = Some(slot);
            continue;
        };
        let Some((rank, len)) = my_rank(reward_slot) else {
            read_to = Some(slot);
            continue;
        };
        match read_block(blockstore, slot, root) {
            Block::Footer(footer) => {
                let (notar, skip) = (
                    footer.notar_reward_cert.as_ref(),
                    footer.skip_reward_cert.as_ref(),
                );
                if let Some(mark) = mark_of(notar, skip, reward_slot, rank, len) {
                    marks.push(mark);
                }
            }
            Block::Missing => marks.push(Mark {
                slot: reward_slot,
                reward: Reward::NoCertificate,
                paid: Vec::new(),
            }),
            Block::Pending => break,
            Block::Opaque => {}
        }
        read_to = Some(slot);
    }
    (read_to, marks)
}

/// This node's rank in the epoch stakes that cover `slot`, and how many ranks
/// there are. `None` where it holds no stake there.
fn rank_of(bank: &Bank, vote_account: &Pubkey, slot: Slot) -> Option<(usize, usize)> {
    let map = bank.get_rank_map(slot)?;
    let rank = map.get_rank_for_vote_pubkey(vote_account)?;
    Some((usize::from(*rank), map.len()))
}

fn read_block(blockstore: &Blockstore, slot: Slot, root: Slot) -> Block {
    let meta = match blockstore.meta(slot) {
        Ok(Some(meta)) if meta.is_full() => meta,
        Ok(_) if slot <= root => return Block::Missing,
        Ok(_) => return Block::Pending,
        Err(_) => return Block::Opaque,
    };
    let Some(last) = meta.last_index else {
        return Block::Opaque;
    };
    let start = last.saturating_add(1).saturating_sub(FOOTER_SPAN);
    let Ok((components, _, _)) = blockstore.get_slot_components_with_shred_info(slot, start, true)
    else {
        return Block::Opaque;
    };
    components
        .into_iter()
        .rev()
        .find_map(|component| match component {
            BlockComponent::BlockMarker(VersionedBlockMarker::V1(marker)) => marker
                .as_block_footer()
                .map(|VersionedBlockFooter::V1(footer)| footer.clone()),
            BlockComponent::EntryBatch(_) => None,
        })
        .map_or(Block::Opaque, |footer| Block::Footer(Box::new(footer)))
}

/// What a footer's reward certificates say about `rank`, with every rank's
/// bit. Neither certificate means nobody was paid. `None` where a bitmap
/// could not be read.
fn mark_of(
    notar: Option<&NotarRewardCertificate>,
    skip: Option<&SkipRewardCertificate>,
    slot: Slot,
    rank: usize,
    len: usize,
) -> Option<Mark> {
    if notar.is_none() && skip.is_none() {
        return Some(Mark {
            slot,
            reward: Reward::NoCertificate,
            paid: Vec::new(),
        });
    }
    let bitmaps = notar
        .map(|cert| cert.bitmap())
        .into_iter()
        .chain(skip.map(|cert| cert.to_bitmap()));
    let paid = union(bitmaps, len)?;
    let reward = if paid.get(rank).is_some_and(|flag| *flag) {
        Reward::Paid
    } else {
        Reward::Unpaid
    };
    Some(Mark { slot, reward, paid })
}

/// The ranks set in any of the signer bitmaps, one flag per rank. `None`
/// where a bitmap does not decode, or uses the two-vector form no certificate
/// here should carry.
fn union<'a>(bitmaps: impl Iterator<Item = &'a [u8]>, len: usize) -> Option<Vec<bool>> {
    let mut paid = vec![false; len];
    for bitmap in bitmaps {
        let Ok(Decoded::Base2(bits)) = decode(bitmap, len) else {
            return None;
        };
        for (flag, bit) in paid.iter_mut().zip(bits.iter().by_vals()) {
            *flag |= bit;
        }
    }
    Some(paid)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Base2 bitmap: version, bit count as little-endian `u16`, then the bits.
    fn bitmap(len: u16, set: &[usize]) -> Vec<u8> {
        let mut bits = vec![0u8; usize::from(len).div_ceil(8)];
        for &rank in set {
            let bit = u32::try_from(rank.checked_rem(8).unwrap()).unwrap();
            bits[rank.checked_div(8).unwrap()] |= 1u8.checked_shl(bit).unwrap();
        }
        let mut bytes = vec![0u8];
        bytes.extend_from_slice(&len.to_le_bytes());
        bytes.extend(bits);
        bytes
    }

    fn flags(len: usize, set: &[usize]) -> Vec<bool> {
        (0..len).map(|rank| set.contains(&rank)).collect()
    }

    fn mark(slot: Slot, reward: Reward, paid: &[usize]) -> Mark {
        Mark {
            slot,
            reward,
            paid: flags(4, paid),
        }
    }

    #[test]
    fn test_the_union_has_every_rank_set_in_either_bitmap() {
        let bitmaps = [bitmap(10, &[3, 9]), bitmap(10, &[4])];
        let paid = union(bitmaps.iter().map(Vec::as_slice), 10).unwrap();
        assert_eq!(paid, flags(10, &[3, 4, 9]));
    }

    #[test]
    fn test_a_short_bitmap_leaves_the_ranks_past_it_unpaid() {
        let paid = union([bitmap(4, &[3])].iter().map(Vec::as_slice), 10).unwrap();
        assert_eq!(paid, flags(10, &[3]));
    }

    #[test]
    fn test_garbage_does_not_decode() {
        assert_eq!(union([&[0u8, 1][..]].into_iter(), 10), None);
        assert_eq!(union([&[7u8, 10, 0, 0, 0][..]].into_iter(), 10), None);
    }

    #[test]
    fn test_a_footer_with_no_reward_certificate_paid_nobody() {
        let mark = mark_of(None, None, 5, 0, 10).unwrap();
        assert_eq!(mark.reward, Reward::NoCertificate);
        assert!(mark.paid.is_empty());
    }

    /// An epoch of 4,000 slots from slot 0, with leader slots at 2,000 to 2,003.
    fn tally() -> Tally {
        Tally::new(7, 100, 0, 4_000, vec![2_000, 2_001, 2_002, 2_003])
    }

    fn misses(tally: &Tally) -> Misses {
        tally.participation().misses
    }

    #[test]
    fn test_the_tally_counts_paid_slots_for_us_and_the_best_rank() {
        let mut tally = tally();
        tally.add(&mark(100, Reward::Paid, &[0, 1, 2]), &[]);
        tally.add(&mark(101, Reward::Unpaid, &[1, 2]), &[]);
        tally.add(&mark(102, Reward::NoCertificate, &[]), &[]);
        tally.add(&mark(103, Reward::Paid, &[0, 1]), &[]);
        let participation = tally.participation();
        assert_eq!(
            (
                participation.epoch,
                participation.since_slot,
                participation.paid,
                participation.rewarded,
                participation.cluster_max,
            ),
            (7, 100, 2, 3, 3)
        );
        assert_eq!(participation.misses.boundary, 1);
        assert_eq!(participation.miss_bins.iter().sum::<u32>(), 1);
    }

    #[test]
    fn test_an_empty_tally_has_no_best() {
        assert_eq!(tally().participation().cluster_max, 0);
    }

    #[test]
    fn test_a_miss_is_placed_by_where_it_fell() {
        let mut tally = tally();
        let written = [Span {
            from: 3_000,
            to: Some(3_010),
        }];
        tally.add(&mark(999, Reward::Unpaid, &[1]), &written);
        tally.add(&mark(2_001, Reward::Unpaid, &[1]), &written);
        tally.add(&mark(3_005, Reward::Unpaid, &[1]), &written);
        tally.add(&mark(3_011, Reward::Unpaid, &[1]), &written);
        assert_eq!(
            misses(&tally),
            Misses {
                boundary: 1,
                leader: 1,
                snapshot: 1,
                elsewhere: 1,
            }
        );
    }

    #[test]
    fn test_a_write_still_going_covers_every_slot_since_it_began() {
        let mut tally = tally();
        let writing = [Span {
            from: 3_000,
            to: None,
        }];
        tally.add(&mark(3_999, Reward::Unpaid, &[1]), &writing);
        tally.add(&mark(2_999, Reward::Unpaid, &[1]), &writing);
        assert_eq!(misses(&tally).snapshot, 1);
        assert_eq!(misses(&tally).elsewhere, 1);
    }

    #[test]
    fn test_the_boundary_takes_a_leader_slot_within_it() {
        let mut tally = Tally::new(7, 0, 0, 4_000, vec![500]);
        tally.add(&mark(500, Reward::Unpaid, &[1]), &[]);
        assert_eq!(misses(&tally).boundary, 1);
        assert_eq!(misses(&tally).leader, 0);
    }

    #[test]
    fn test_misses_fall_in_the_bin_for_their_place_in_the_epoch() {
        let mut tally = tally();
        tally.add(&mark(0, Reward::Unpaid, &[1]), &[]);
        tally.add(&mark(2_000, Reward::Unpaid, &[1]), &[]);
        tally.add(&mark(2_001, Reward::Unpaid, &[1]), &[]);
        tally.add(&mark(3_999, Reward::Unpaid, &[1]), &[]);
        let bins = tally.participation().miss_bins;
        assert_eq!(bins.len(), MISS_BINS);
        assert_eq!((bins[0], bins[200], bins[MISS_BINS - 1]), (1, 2, 1));
    }

    #[test]
    fn test_a_slot_past_the_epoch_lands_in_the_last_bin() {
        let mut tally = tally();
        tally.add(&mark(9_000, Reward::Unpaid, &[1]), &[]);
        assert_eq!(tally.participation().miss_bins[MISS_BINS - 1], 1);
    }
}
