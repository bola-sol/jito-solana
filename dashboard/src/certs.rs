//! Whether this node's vote made each slot's certificates, read from the
//! footers alpenglow leaders write into their blocks.

use {
    agave_votor_messages::reward_certificate::NUM_SLOTS_FOR_REWARD,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cert {
    /// Embedded by a later leader, for the slot it finalizes.
    Finalization,
    /// Embedded by the leader eight slots on, for the slot it pays.
    Reward,
}

/// One certificate's verdict on this node's vote for a slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
    pub slot: Slot,
    pub cert: Cert,
    pub with_vote: bool,
}

enum Block {
    Footer(Box<BlockFooterV1>),
    /// At or below the root with no block, so its reward certificate was
    /// never written and nobody was paid for the slot it would have covered.
    Missing,
    /// Above the root and not full yet.
    Pending,
    /// Full, but the footer could not be read.
    Opaque,
}

/// This node's rank in the epoch stakes that cover `slot`, and how many ranks
/// there are. `None` where it holds no stake there.
type RankOf<'a> = dyn Fn(Slot) -> Option<(usize, usize)> + 'a;

/// Reads the footers of `from..=to` and returns what they say about this
/// node's vote, with the last slot read. Stops at the first slot still
/// filling.
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
        match read_block(blockstore, slot, root) {
            Block::Footer(footer) => marks.extend(footer_marks(*footer, slot, &my_rank)),
            Block::Missing => {
                if let Some(reward_slot) = slot.checked_sub(NUM_SLOTS_FOR_REWARD)
                    && my_rank(reward_slot).is_some()
                {
                    marks.push(Mark {
                        slot: reward_slot,
                        cert: Cert::Reward,
                        with_vote: false,
                    });
                }
            }
            Block::Pending => break,
            Block::Opaque => {}
        }
        read_to = Some(slot);
    }
    (read_to, marks)
}

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

/// What the footer of `slot` says. The finalization certificate names its own
/// slot; the reward certificates name theirs, or cover the slot eight back
/// when the leader had no votes to write.
fn footer_marks(footer: BlockFooterV1, slot: Slot, rank_of: &RankOf) -> Vec<Mark> {
    let mut marks = Vec::with_capacity(2);
    if let Some(cert) = footer.block_final_cert
        && let Some((rank, len)) = rank_of(cert.slot)
    {
        let in_final = includes(&cert.final_aggregate.into_bitmap(), rank, len);
        let in_notar = cert.notar_aggregate.map_or(Some(false), |aggregate| {
            includes(&aggregate.into_bitmap(), rank, len)
        });
        if let Some(with_vote) = either(in_final, in_notar) {
            marks.push(Mark {
                slot: cert.slot,
                cert: Cert::Finalization,
                with_vote,
            });
        }
    }

    let reward_slot = footer
        .notar_reward_cert
        .as_ref()
        .map(|cert| cert.slot)
        .or_else(|| footer.skip_reward_cert.as_ref().map(|cert| cert.slot))
        .or_else(|| slot.checked_sub(NUM_SLOTS_FOR_REWARD));
    if let Some(reward_slot) = reward_slot
        && let Some((rank, len)) = rank_of(reward_slot)
    {
        let in_notar = footer
            .notar_reward_cert
            .map_or(Some(false), |cert| includes(cert.bitmap(), rank, len));
        let in_skip = footer
            .skip_reward_cert
            .map_or(Some(false), |cert| includes(cert.to_bitmap(), rank, len));
        if let Some(with_vote) = either(in_notar, in_skip) {
            marks.push(Mark {
                slot: reward_slot,
                cert: Cert::Reward,
                with_vote,
            });
        }
    }
    marks
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

/// Set in either bitmap, where both could be read. One unreadable bitmap
/// still answers if the other has the vote.
fn either(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
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
    fn test_either_answers_from_one_readable_bitmap() {
        assert_eq!(either(Some(true), None), Some(true));
        assert_eq!(either(None, Some(true)), Some(true));
        assert_eq!(either(Some(false), None), None);
        assert_eq!(either(Some(false), Some(false)), Some(false));
    }
}
