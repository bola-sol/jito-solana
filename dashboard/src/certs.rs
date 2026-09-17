//! Whether this node's vote was paid for each slot, read from the reward
//! certificates alpenglow leaders write into their block footers.

use {
    agave_votor_messages::reward_certificate::{
        NUM_SLOTS_FOR_REWARD, NotarRewardCertificate, SkipRewardCertificate,
    },
    serde::Serialize,
    solana_clock::Slot,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
    pub slot: Slot,
    pub reward: Reward,
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
                if let Some(reward) = reward_of(notar, skip, rank, len) {
                    marks.push(Mark {
                        slot: reward_slot,
                        reward,
                    });
                }
            }
            Block::Missing => marks.push(Mark {
                slot: reward_slot,
                reward: Reward::NoCertificate,
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

/// What a footer's reward certificates say about `rank`. Neither certificate
/// means nobody was paid. `None` where a bitmap could not be read.
fn reward_of(
    notar: Option<&NotarRewardCertificate>,
    skip: Option<&SkipRewardCertificate>,
    rank: usize,
    len: usize,
) -> Option<Reward> {
    let in_notar = notar.map_or(Some(false), |cert| includes(cert.bitmap(), rank, len));
    let in_skip = skip.map_or(Some(false), |cert| includes(cert.to_bitmap(), rank, len));
    match (in_notar, in_skip) {
        (Some(true), _) | (_, Some(true)) => Some(Reward::Paid),
        (Some(false), Some(false)) if notar.is_none() && skip.is_none() => {
            Some(Reward::NoCertificate)
        }
        (Some(false), Some(false)) => Some(Reward::Unpaid),
        _ => None,
    }
}

/// Whether `rank` is set in a certificate's signer bitmap. `None` where the
/// bitmap does not decode, or uses the two-vector form no certificate here
/// should carry.
fn includes(bitmap: &[u8], rank: usize, len: usize) -> Option<bool> {
    match decode(bitmap, len) {
        Ok(Decoded::Base2(bits)) => Some(bits.get(rank).is_some_and(|bit| *bit)),
        Ok(Decoded::Base3(..)) | Err(_) => None,
    }
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

    #[test]
    fn test_a_set_rank_is_in_the_bitmap() {
        let map = bitmap(10, &[3, 9]);
        assert_eq!(includes(&map, 3, 10), Some(true));
        assert_eq!(includes(&map, 9, 10), Some(true));
        assert_eq!(includes(&map, 4, 10), Some(false));
    }

    #[test]
    fn test_a_rank_past_the_bitmap_is_not_in_it() {
        assert_eq!(includes(&bitmap(10, &[3]), 12, 10), Some(false));
    }

    #[test]
    fn test_garbage_does_not_decode() {
        assert_eq!(includes(&[0, 1], 0, 10), None);
        assert_eq!(includes(&[7, 10, 0, 0, 0], 0, 10), None);
    }

    #[test]
    fn test_a_footer_with_no_reward_certificate_paid_nobody() {
        assert_eq!(reward_of(None, None, 0, 10), Some(Reward::NoCertificate));
    }
}
