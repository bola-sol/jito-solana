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
}

/// Paid slots per rank over one epoch's marks.
#[derive(Debug)]
pub struct Tally {
    epoch: Epoch,
    since_slot: Slot,
    paid: u64,
    rewarded: u64,
    per_rank: Vec<u64>,
}

impl Tally {
    pub fn new(epoch: Epoch, since_slot: Slot) -> Self {
        Self {
            epoch,
            since_slot,
            paid: 0,
            rewarded: 0,
            per_rank: Vec::new(),
        }
    }

    pub fn epoch(&self) -> Epoch {
        self.epoch
    }

    /// Counts a mark. A slot with no certificate counts for nobody.
    pub fn add(&mut self, mark: &Mark) {
        match mark.reward {
            Reward::Paid => self.paid = self.paid.saturating_add(1),
            Reward::Unpaid => {}
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

    /// The counts so far, the best rank's among them.
    pub fn participation(&self) -> Participation {
        Participation {
            epoch: self.epoch,
            since_slot: self.since_slot,
            paid: self.paid,
            rewarded: self.rewarded,
            cluster_max: self.per_rank.iter().copied().max().unwrap_or(0),
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

    #[test]
    fn test_the_tally_counts_paid_slots_for_us_and_the_best_rank() {
        let mut tally = Tally::new(7, 100);
        tally.add(&mark(100, Reward::Paid, &[0, 1, 2]));
        tally.add(&mark(101, Reward::Unpaid, &[1, 2]));
        tally.add(&mark(102, Reward::NoCertificate, &[]));
        tally.add(&mark(103, Reward::Paid, &[0, 1]));
        assert_eq!(
            tally.participation(),
            Participation {
                epoch: 7,
                since_slot: 100,
                paid: 2,
                rewarded: 3,
                cluster_max: 3,
            }
        );
    }

    #[test]
    fn test_an_empty_tally_has_no_best() {
        assert_eq!(Tally::new(7, 100).participation().cluster_max, 0);
    }
}
