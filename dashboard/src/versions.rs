//! Message versions in our own blocks, tallied over the non-vote
//! transactions.

use {
    serde::Serialize,
    solana_sdk_ids::vote,
    solana_transaction::versioned::{TransactionVersion, VersionedTransaction},
};

/// Non-vote transactions in one block, by message version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct TxVersions {
    pub legacy: u64,
    pub v0: u64,
    pub v1: u64,
}

/// Tallies `transactions` by version, simple votes left out.
pub fn tally<'a>(transactions: impl IntoIterator<Item = &'a VersionedTransaction>) -> TxVersions {
    let mut versions = TxVersions::default();
    for transaction in transactions {
        let slot = match transaction.version() {
            TransactionVersion::Legacy(_) if is_simple_vote(transaction) => continue,
            TransactionVersion::Legacy(_) => &mut versions.legacy,
            TransactionVersion::Number(0) => &mut versions.v0,
            TransactionVersion::Number(1) => &mut versions.v1,
            TransactionVersion::Number(_) => continue,
        };
        *slot = slot.saturating_add(1);
    }
    versions
}

/// The runtime's rule: one or two signatures, one instruction, to the vote
/// program.
fn is_simple_vote(transaction: &VersionedTransaction) -> bool {
    let message = &transaction.message;
    let [instruction] = message.instructions() else {
        return false;
    };
    let program = message
        .static_account_keys()
        .get(usize::from(instruction.program_id_index));
    (1..=2).contains(&transaction.signatures.len()) && program == Some(&vote::id())
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        solana_message::{
            VersionedMessage, compiled_instruction::CompiledInstruction, legacy, v0, v1,
        },
        solana_pubkey::Pubkey,
        solana_signature::Signature,
    };

    fn legacy_tx(program: Pubkey, signatures: usize) -> VersionedTransaction {
        let message = legacy::Message {
            account_keys: vec![Pubkey::new_unique(), program],
            instructions: vec![CompiledInstruction::new_from_raw_parts(1, vec![], vec![])],
            ..Default::default()
        };
        VersionedTransaction {
            signatures: vec![Signature::default(); signatures],
            message: VersionedMessage::Legacy(message),
        }
    }

    fn versioned(message: VersionedMessage) -> VersionedTransaction {
        VersionedTransaction {
            signatures: vec![Signature::default()],
            message,
        }
    }

    #[test]
    fn test_each_version_lands_in_its_own_count() {
        let block = [
            legacy_tx(Pubkey::new_unique(), 1),
            legacy_tx(Pubkey::new_unique(), 1),
            versioned(VersionedMessage::V0(v0::Message::default())),
            versioned(VersionedMessage::V1(v1::Message::default())),
        ];
        assert_eq!(
            tally(&block),
            TxVersions {
                legacy: 2,
                v0: 1,
                v1: 1,
            }
        );
    }

    #[test]
    fn test_a_simple_vote_is_not_counted() {
        let block = [legacy_tx(vote::id(), 1), legacy_tx(vote::id(), 2)];
        assert_eq!(tally(&block), TxVersions::default());
    }

    #[test]
    fn test_a_vote_instruction_with_three_signers_is_not_a_simple_vote() {
        let block = [legacy_tx(vote::id(), 3)];
        assert_eq!(tally(&block).legacy, 1);
    }

    #[test]
    fn test_an_empty_block_tallies_to_nought() {
        let block: [VersionedTransaction; 0] = [];
        assert_eq!(tally(&block), TxVersions::default());
    }
}
