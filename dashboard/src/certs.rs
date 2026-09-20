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
    std::collections::HashMap,
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

/// A certificate paying fewer ranks than the lowest this percent of the
/// epoch's certificates is thin, once `THIN_MIN_CERTIFICATES` have been seen.
pub const THIN_PERCENTILE: u64 = 10;
pub const THIN_MIN_CERTIFICATES: u64 = 100;

/// How many of the leaders behind lost votes are named.
const LOST_LEADERS: usize = 3;

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
    /// The leaders whose certificates left the most lost votes out, most first.
    pub lost_leaders: Vec<LostLeader>,
}

/// Slots that paid others but not this validator, by where they fell. A slot
/// in more than one place counts in the first.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Misses {
    /// Within `BOUNDARY_SLOTS` of the epoch's first slot.
    pub boundary: u64,
    /// One of this validator's leader slots.
    pub leader: u64,
    /// While a snapshot archive was being written.
    pub snapshot: u64,
    /// The certificate paid fewer ranks than the lowest `THIN_PERCENTILE`
    /// percent of the epoch's certificates.
    pub thin: u64,
    /// This node finished replaying the slot after the certificate's writer
    /// had begun its own.
    pub late: u64,
    /// None of the above: the vote was in time and the certificate full.
    pub lost: u64,
}

/// A leader whose certificates left this validator's vote out, and how often.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LostLeader {
    pub identity: String,
    pub name: Option<String>,
    pub count: u64,
}

/// What the collector knows about an unpaid slot beyond where it fell.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MissDetail {
    /// The leader of the slot the certificate was written in.
    pub writer: Option<Pubkey>,
    pub late: bool,
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

/// The slot whose leader writes the certificate for `slot`.
pub fn writer_slot(slot: Slot) -> Slot {
    slot.saturating_add(NUM_SLOTS_FOR_REWARD)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Place {
    Boundary,
    Leader,
    Snapshot,
    Thin,
    Late,
    Lost,
}

/// One unpaid slot. A place settled when the slot was seen, else one decided
/// against the epoch's certificates when read.
#[derive(Debug, Clone, Copy)]
struct Miss {
    slot: Slot,
    fixed: Option<Place>,
    /// Ranks the certificate paid.
    paid_ranks: u32,
    writer: Option<Pubkey>,
    late: bool,
}

/// Paid slots per rank over one epoch's marks.
#[derive(Debug)]
pub struct Tally {
    epoch: Epoch,
    since_slot: Slot,
    epoch_start: Slot,
    slots_in_epoch: u64,
    /// Ascending. Empty where the schedule was not known when the tally began,
    /// when those misses fall under the later places.
    leader_slots: Vec<Slot>,
    paid: u64,
    rewarded: u64,
    per_rank: Vec<u64>,
    misses: Vec<Miss>,
    /// Certificates by how many ranks they paid, indexed by that count.
    paid_ranks: Vec<u32>,
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
            misses: Vec::new(),
            paid_ranks: Vec::new(),
        }
    }

    pub fn epoch(&self) -> Epoch {
        self.epoch
    }

    /// Counts a mark, placing an unpaid slot against `snapshots`, the writes
    /// seen so far, and `detail`. A slot with no certificate counts for nobody.
    pub fn add(&mut self, mark: &Mark, snapshots: &[Span], detail: Option<MissDetail>) {
        let paid_ranks = mark.paid.iter().filter(|paid| **paid).count();
        match mark.reward {
            Reward::Paid => self.paid = self.paid.saturating_add(1),
            Reward::Unpaid => self.miss(mark.slot, paid_ranks, snapshots, detail),
            Reward::NoCertificate => return,
        }
        self.rewarded = self.rewarded.saturating_add(1);
        if self.paid_ranks.len() <= paid_ranks {
            self.paid_ranks.resize(paid_ranks.saturating_add(1), 0);
        }
        if let Some(count) = self.paid_ranks.get_mut(paid_ranks) {
            *count = count.saturating_add(1);
        }
        if self.per_rank.len() < mark.paid.len() {
            self.per_rank.resize(mark.paid.len(), 0);
        }
        for (count, paid) in self.per_rank.iter_mut().zip(&mark.paid) {
            if *paid {
                *count = count.saturating_add(1);
            }
        }
    }

    fn miss(
        &mut self,
        slot: Slot,
        paid_ranks: usize,
        snapshots: &[Span],
        detail: Option<MissDetail>,
    ) {
        let fixed = if slot < self.epoch_start.saturating_add(BOUNDARY_SLOTS) {
            Some(Place::Boundary)
        } else if self.leader_slots.binary_search(&slot).is_ok() {
            Some(Place::Leader)
        } else if snapshots.iter().any(|span| span.covers(slot)) {
            Some(Place::Snapshot)
        } else {
            None
        };
        let detail = detail.unwrap_or_default();
        self.misses.push(Miss {
            slot,
            fixed,
            paid_ranks: u32::try_from(paid_ranks).unwrap_or(u32::MAX),
            writer: detail.writer,
            late: detail.late,
        });
    }

    /// The paid-rank count the lowest `THIN_PERCENTILE` percent of the epoch's
    /// certificates fall under. `None` until `THIN_MIN_CERTIFICATES` are in.
    fn thin_below(&self) -> Option<u32> {
        if self.rewarded < THIN_MIN_CERTIFICATES {
            return None;
        }
        let cutoff = self
            .rewarded
            .saturating_mul(THIN_PERCENTILE)
            .checked_div(100)?;
        let mut seen = 0u64;
        for (ranks, count) in self.paid_ranks.iter().enumerate() {
            seen = seen.saturating_add(u64::from(*count));
            if seen > cutoff {
                return u32::try_from(ranks).ok();
            }
        }
        None
    }

    fn bin_of(&self, slot: Slot) -> usize {
        let bin = slot
            .saturating_sub(self.epoch_start)
            .saturating_mul(MISS_BINS as u64)
            .checked_div(self.slots_in_epoch)
            .unwrap_or(0);
        usize::try_from(bin).unwrap_or(LAST_BIN).min(LAST_BIN)
    }

    /// The counts so far, the best rank's among them. `name` gives a lost
    /// vote's leader a display name.
    pub fn participation(&self, name: impl Fn(&Pubkey) -> Option<String>) -> Participation {
        let thin_below = self.thin_below();
        let mut misses = Misses::default();
        let mut miss_bins = vec![0u32; MISS_BINS];
        let mut by_writer: HashMap<Pubkey, u64> = HashMap::new();
        for miss in &self.misses {
            let decided = if thin_below.is_some_and(|below| miss.paid_ranks < below) {
                Place::Thin
            } else if miss.late {
                Place::Late
            } else {
                Place::Lost
            };
            let place = miss.fixed.unwrap_or(decided);
            let count = match place {
                Place::Boundary => &mut misses.boundary,
                Place::Leader => &mut misses.leader,
                Place::Snapshot => &mut misses.snapshot,
                Place::Thin => &mut misses.thin,
                Place::Late => &mut misses.late,
                Place::Lost => &mut misses.lost,
            };
            *count = count.saturating_add(1);
            if place == Place::Lost
                && let Some(writer) = miss.writer
            {
                let count = by_writer.entry(writer).or_default();
                *count = count.saturating_add(1);
            }
            if let Some(bin) = miss_bins.get_mut(self.bin_of(miss.slot)) {
                *bin = bin.saturating_add(1);
            }
        }
        let mut leaders: Vec<(Pubkey, u64)> = by_writer.into_iter().collect();
        leaders.sort_by(|(a_key, a_count), (b_key, b_count)| {
            b_count.cmp(a_count).then(a_key.cmp(b_key))
        });
        leaders.truncate(LOST_LEADERS);
        Participation {
            epoch: self.epoch,
            since_slot: self.since_slot,
            paid: self.paid,
            rewarded: self.rewarded,
            cluster_max: self.per_rank.iter().copied().max().unwrap_or(0),
            misses,
            miss_bins,
            lost_leaders: leaders
                .into_iter()
                .map(|(identity, count)| LostLeader {
                    name: name(&identity),
                    identity: identity.to_string(),
                    count,
                })
                .collect(),
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

    fn read(tally: &Tally) -> Participation {
        tally.participation(|_| None)
    }

    fn misses(tally: &Tally) -> Misses {
        read(tally).misses
    }

    fn detail(writer: Option<Pubkey>, late: bool) -> Option<MissDetail> {
        Some(MissDetail { writer, late })
    }

    /// Enough certificates that a thin one can be told: seventy paying all
    /// four ranks and thirty paying three, this node among them either way.
    fn fill(tally: &mut Tally, from: Slot) {
        for (index, slot) in (from..from.saturating_add(THIN_MIN_CERTIFICATES)).enumerate() {
            let ranks: &[usize] = if index < 70 {
                &[0, 1, 2, 3]
            } else {
                &[0, 1, 2]
            };
            tally.add(&mark(slot, Reward::Paid, ranks), &[], None);
        }
    }

    #[test]
    fn test_the_tally_counts_paid_slots_for_us_and_the_best_rank() {
        let mut tally = tally();
        tally.add(&mark(100, Reward::Paid, &[0, 1, 2]), &[], None);
        tally.add(&mark(101, Reward::Unpaid, &[1, 2]), &[], None);
        tally.add(&mark(102, Reward::NoCertificate, &[]), &[], None);
        tally.add(&mark(103, Reward::Paid, &[0, 1]), &[], None);
        let participation = read(&tally);
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
        assert_eq!(read(&tally()).cluster_max, 0);
    }

    #[test]
    fn test_a_miss_is_placed_by_where_it_fell() {
        let mut tally = tally();
        let written = [Span {
            from: 3_000,
            to: Some(3_010),
        }];
        tally.add(&mark(999, Reward::Unpaid, &[1]), &written, None);
        tally.add(&mark(2_001, Reward::Unpaid, &[1]), &written, None);
        tally.add(&mark(3_005, Reward::Unpaid, &[1]), &written, None);
        tally.add(
            &mark(3_011, Reward::Unpaid, &[1]),
            &written,
            detail(None, true),
        );
        tally.add(&mark(3_012, Reward::Unpaid, &[1]), &written, None);
        assert_eq!(
            misses(&tally),
            Misses {
                boundary: 1,
                leader: 1,
                snapshot: 1,
                thin: 0,
                late: 1,
                lost: 1,
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
        tally.add(&mark(3_999, Reward::Unpaid, &[1]), &writing, None);
        tally.add(&mark(2_999, Reward::Unpaid, &[1]), &writing, None);
        assert_eq!(misses(&tally).snapshot, 1);
        assert_eq!(misses(&tally).lost, 1);
    }

    #[test]
    fn test_the_boundary_takes_a_leader_slot_within_it() {
        let mut tally = Tally::new(7, 0, 0, 4_000, vec![500]);
        tally.add(&mark(500, Reward::Unpaid, &[1]), &[], None);
        assert_eq!(misses(&tally).boundary, 1);
        assert_eq!(misses(&tally).leader, 0);
    }

    #[test]
    fn test_a_certificate_paying_fewer_than_the_lowest_tenth_is_thin() {
        let mut tally = tally();
        fill(&mut tally, 1_000);
        // The lowest tenth of the hundred ends at three ranks: two is under it.
        tally.add(&mark(3_000, Reward::Unpaid, &[1, 2]), &[], None);
        tally.add(
            &mark(3_001, Reward::Unpaid, &[1, 2, 3]),
            &[],
            detail(None, true),
        );
        let misses = misses(&tally);
        assert_eq!((misses.thin, misses.late, misses.lost), (1, 1, 0));
    }

    #[test]
    fn test_nothing_is_thin_before_enough_certificates() {
        let mut tally = tally();
        tally.add(&mark(3_000, Reward::Unpaid, &[1]), &[], None);
        assert_eq!(misses(&tally).thin, 0);
        assert_eq!(misses(&tally).lost, 1);
    }

    #[test]
    fn test_thin_is_read_against_the_certificates_seen_so_far() {
        // Lost when seen, thin once the epoch's certificates show it was.
        let mut tally = tally();
        tally.add(&mark(1_500, Reward::Unpaid, &[1]), &[], None);
        assert_eq!(misses(&tally).lost, 1);
        fill(&mut tally, 2_100);
        assert_eq!(misses(&tally).thin, 1);
    }

    #[test]
    fn test_lost_votes_are_counted_by_the_leader_who_wrote_them_out() {
        let mut tally = tally();
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        for slot in [3_000, 3_001, 3_002] {
            tally.add(
                &mark(slot, Reward::Unpaid, &[1]),
                &[],
                detail(Some(a), false),
            );
        }
        tally.add(
            &mark(3_003, Reward::Unpaid, &[1]),
            &[],
            detail(Some(b), false),
        );
        // A late vote is not lost, so its writer is not counted.
        tally.add(
            &mark(3_004, Reward::Unpaid, &[1]),
            &[],
            detail(Some(b), true),
        );
        let named = |key: &Pubkey| (*key == a).then(|| "Alpha".to_string());
        let leaders = tally.participation(named).lost_leaders;
        assert_eq!(
            leaders,
            vec![
                LostLeader {
                    identity: a.to_string(),
                    name: Some("Alpha".to_string()),
                    count: 3,
                },
                LostLeader {
                    identity: b.to_string(),
                    name: None,
                    count: 1,
                },
            ]
        );
    }

    #[test]
    fn test_misses_fall_in_the_bin_for_their_place_in_the_epoch() {
        let mut tally = tally();
        tally.add(&mark(0, Reward::Unpaid, &[1]), &[], None);
        tally.add(&mark(2_000, Reward::Unpaid, &[1]), &[], None);
        tally.add(&mark(2_001, Reward::Unpaid, &[1]), &[], None);
        tally.add(&mark(3_999, Reward::Unpaid, &[1]), &[], None);
        let bins = read(&tally).miss_bins;
        assert_eq!(bins.len(), MISS_BINS);
        assert_eq!((bins[0], bins[200], bins[MISS_BINS - 1]), (1, 2, 1));
    }

    #[test]
    fn test_a_slot_past_the_epoch_lands_in_the_last_bin() {
        let mut tally = tally();
        tally.add(&mark(9_000, Reward::Unpaid, &[1]), &[], None);
        assert_eq!(read(&tally).miss_bins[MISS_BINS - 1], 1);
    }
}
