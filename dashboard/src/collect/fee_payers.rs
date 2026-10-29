//! Fee payers whose transactions fail in our blocks, against the same payers in other leaders'
//! blocks, for this epoch and the last.

use {
    crate::versions::is_simple_vote,
    agave_feature_set::FeatureSet,
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_compute_budget_instruction::instructions_processor::process_compute_budget_instructions,
    solana_entry::entry::Entry,
    solana_ledger::blockstore::Blockstore,
    solana_message::VersionedMessage,
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    solana_svm_transaction::instruction::SVMInstruction,
    solana_transaction::versioned::VersionedTransaction,
    std::{
        cmp::Reverse,
        collections::{BTreeMap, HashMap},
        sync::Arc,
    },
};

/// Flagged from this many transactions in our blocks in an epoch.
const MIN_TRANSACTIONS: u64 = 100;
const MIN_FAILED_PERCENT: u64 = 10;
/// 0.05 SOL of priority fees on failed transactions.
const MIN_PRIORITY_FAILED: u64 = 50_000_000;
/// Escalated above this many times its rate in other leaders' blocks.
const ESCALATE_RATIO: u128 = 3;
/// The rate elsewhere counts from this many transactions there.
const MIN_AWAY_TRANSACTIONS: u64 = 100;

/// Payers followed per epoch; past this, new payers count only in the epoch's totals.
const MAX_PAYERS: usize = 100_000;
/// A frozen bank is held until its block is whole in the blockstore, at most this many at once.
const MAX_WAITING: usize = 64;
/// Read blocks wait for their root; under TowerBFT that is thirty two slots behind.
const MAX_UNSETTLED: usize = 1_024;
/// A block not whole this far under the root is given up.
const WAIT_SLOTS: u64 = 64;

const TOP_PAYERS: usize = 10;
const MAX_ALERTS: usize = 20;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Tally {
    transactions: u64,
    failed: u64,
    /// Lamports.
    priority_failed: u64,
}

impl Tally {
    fn add(&mut self, other: &Tally) {
        self.transactions = self.transactions.saturating_add(other.transactions);
        self.failed = self.failed.saturating_add(other.failed);
        self.priority_failed = self.priority_failed.saturating_add(other.priority_failed);
    }

    fn note(&mut self, failed: bool, priority_fee: u64) {
        self.transactions = self.transactions.saturating_add(1);
        if failed {
            self.failed = self.failed.saturating_add(1);
            self.priority_failed = self.priority_failed.saturating_add(priority_fee);
        }
    }
}

#[derive(Debug, Default)]
struct BlockTally {
    epoch: Epoch,
    ours: bool,
    /// Every non-vote transaction of ours whose result was found.
    total: Tally,
    payers: HashMap<Pubkey, Tally>,
}

#[derive(Debug, Default)]
struct Payer {
    ours: Tally,
    away: Tally,
    flagged_slot: Option<Slot>,
}

#[derive(Debug, Default)]
struct EpochPayers {
    blocks: u64,
    ours: Tally,
    /// The followed payers' transactions in other leaders' blocks.
    away: Tally,
    payers: HashMap<Pubkey, Payer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Alert {
    Flagged,
    Escalated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EpochFigures {
    pub epoch: Epoch,
    pub blocks: u64,
    pub transactions: u64,
    pub failed: u64,
    pub priority_failed: u64,
    pub away_transactions: u64,
    pub away_failed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PayerRow {
    pub epoch: Epoch,
    pub payer: String,
    pub transactions: u64,
    pub failed: u64,
    pub priority_failed: u64,
    pub away_transactions: u64,
    pub away_failed: u64,
    pub alert: Option<Alert>,
    /// Our slot in which it first met the flag.
    pub flagged_slot: Option<Slot>,
}

/// Newest epoch first; the payers are the newest epoch's, by priority fees on failed transactions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FeePayerSummary {
    pub epochs: Vec<EpochFigures>,
    pub payers: Vec<PayerRow>,
    pub alerts: Vec<PayerRow>,
}

#[derive(Debug, Default)]
pub(super) struct FeePayers {
    waiting: BTreeMap<Slot, (Arc<Bank>, bool)>,
    unsettled: BTreeMap<Slot, BlockTally>,
    epochs: BTreeMap<Epoch, EpochPayers>,
    /// The root last settled to; read from bank forks, the same banks come back every tick.
    settled_root: Option<Slot>,
}

impl FeePayers {
    pub(super) fn note_frozen(&mut self, bank: &Arc<Bank>, ours: bool) {
        let slot = bank.slot();
        if self.settled_root.is_some_and(|root| slot <= root)
            || self.waiting.contains_key(&slot)
            || self.unsettled.contains_key(&slot)
        {
            return;
        }
        self.waiting.insert(slot, (bank.clone(), ours));
        while self.waiting.len() > MAX_WAITING {
            self.waiting.pop_first();
        }
    }

    /// Reads each held block once the blockstore has all of it, and lets its bank go.
    pub(super) fn read(&mut self, blockstore: &Blockstore) {
        let full: Vec<Slot> = self
            .waiting
            .keys()
            .copied()
            .filter(|slot| blockstore.is_full(*slot))
            .collect();
        for slot in full {
            let Some((bank, ours)) = self.waiting.remove(&slot) else {
                continue;
            };
            let Ok(entries) = blockstore.get_slot_entries(slot, 0) else {
                continue;
            };
            let followed = self.epochs.get(&bank.epoch());
            let tally = tally_block(&bank, &entries, ours, |payer| {
                followed.is_some_and(|epoch| epoch.payers.contains_key(payer))
            });
            self.unsettled.insert(slot, tally);
        }
        while self.unsettled.len() > MAX_UNSETTLED {
            self.unsettled.pop_first();
        }
    }

    /// Counts the read blocks at or under the root that were rooted, and drops the rest, which
    /// were on abandoned forks.
    pub(super) fn settle(&mut self, root: Slot, root_epoch: Epoch, is_root: impl Fn(Slot) -> bool) {
        let later = self.unsettled.split_off(&root.saturating_add(1));
        for (slot, tally) in std::mem::replace(&mut self.unsettled, later) {
            if is_root(slot) {
                self.count(slot, tally);
            }
        }
        self.waiting = self.waiting.split_off(&root.saturating_sub(WAIT_SLOTS));
        self.epochs = self.epochs.split_off(&root_epoch.saturating_sub(1));
        self.settled_root = Some(root);
    }

    fn count(&mut self, slot: Slot, tally: BlockTally) {
        let epoch = self.epochs.entry(tally.epoch).or_default();
        if tally.ours {
            epoch.blocks = epoch.blocks.saturating_add(1);
            epoch.ours.add(&tally.total);
            for (key, block) in &tally.payers {
                if epoch.payers.len() >= MAX_PAYERS && !epoch.payers.contains_key(key) {
                    continue;
                }
                let payer = epoch.payers.entry(*key).or_default();
                payer.ours.add(block);
                if payer.flagged_slot.is_none() && is_flagged(&payer.ours) {
                    payer.flagged_slot = Some(slot);
                }
            }
        } else {
            for (key, block) in &tally.payers {
                if let Some(payer) = epoch.payers.get_mut(key) {
                    payer.away.add(block);
                    epoch.away.add(block);
                }
            }
        }
    }

    pub(super) fn summary(&self) -> Option<FeePayerSummary> {
        let (newest, _) = self.epochs.last_key_value()?;
        let epochs = self
            .epochs
            .iter()
            .rev()
            .map(|(epoch, held)| EpochFigures {
                epoch: *epoch,
                blocks: held.blocks,
                transactions: held.ours.transactions,
                failed: held.ours.failed,
                priority_failed: held.ours.priority_failed,
                away_transactions: held.away.transactions,
                away_failed: held.away.failed,
            })
            .collect();

        // Ranked before any row is built, since an epoch can hold many thousands of payers.
        let mut ranked: Vec<(&Pubkey, &Payer)> = self
            .epochs
            .get(newest)
            .into_iter()
            .flat_map(|held| held.payers.iter())
            .filter(|(_, payer)| payer.ours.failed > 0)
            .collect();
        ranked.sort_unstable_by_key(|(_, payer)| {
            Reverse((payer.ours.priority_failed, payer.ours.failed))
        });
        let payers = ranked
            .into_iter()
            .take(TOP_PAYERS)
            .map(|(key, payer)| row(*newest, key, payer))
            .collect();

        let mut alerts: Vec<PayerRow> = self
            .epochs
            .iter()
            .flat_map(|(epoch, held)| {
                held.payers
                    .iter()
                    .filter(|(_, payer)| is_flagged(&payer.ours))
                    .map(|(key, payer)| row(*epoch, key, payer))
            })
            .collect();
        alerts.sort_by_key(|row| {
            Reverse((
                row.epoch,
                row.alert == Some(Alert::Escalated),
                row.priority_failed,
            ))
        });
        alerts.truncate(MAX_ALERTS);

        Some(FeePayerSummary {
            epochs,
            payers,
            alerts,
        })
    }
}

fn row(epoch: Epoch, key: &Pubkey, payer: &Payer) -> PayerRow {
    PayerRow {
        epoch,
        payer: key.to_string(),
        transactions: payer.ours.transactions,
        failed: payer.ours.failed,
        priority_failed: payer.ours.priority_failed,
        away_transactions: payer.away.transactions,
        away_failed: payer.away.failed,
        alert: alert(&payer.ours, &payer.away),
        flagged_slot: payer.flagged_slot,
    }
}

fn is_flagged(ours: &Tally) -> bool {
    ours.transactions >= MIN_TRANSACTIONS
        && ours.failed.saturating_mul(100) >= ours.transactions.saturating_mul(MIN_FAILED_PERCENT)
        && ours.priority_failed >= MIN_PRIORITY_FAILED
}

fn alert(ours: &Tally, away: &Tally) -> Option<Alert> {
    if !is_flagged(ours) {
        return None;
    }
    // Our rate over three times theirs, cross multiplied.
    let here = u128::from(ours.failed).saturating_mul(u128::from(away.transactions));
    let there = u128::from(away.failed)
        .saturating_mul(u128::from(ours.transactions))
        .saturating_mul(ESCALATE_RATIO);
    if away.transactions >= MIN_AWAY_TRANSACTIONS && here > there {
        Some(Alert::Escalated)
    } else {
        Some(Alert::Flagged)
    }
}

/// Every non-vote transaction of our block, or only the followed payers' in another's. A result
/// not found in the status cache leaves the transaction out.
fn tally_block(
    bank: &Bank,
    entries: &[Entry],
    ours: bool,
    followed: impl Fn(&Pubkey) -> bool,
) -> BlockTally {
    let mut tally = BlockTally {
        epoch: bank.epoch(),
        ours,
        ..BlockTally::default()
    };
    for transaction in entries.iter().flat_map(|entry| &entry.transactions) {
        if is_simple_vote(transaction) {
            continue;
        }
        let Some(payer) = transaction.message.static_account_keys().first() else {
            continue;
        };
        if !ours && !followed(payer) {
            continue;
        }
        let Some(failed) = failed_in(bank, transaction) else {
            continue;
        };
        let fee = if ours && failed {
            priority_fee(transaction, &bank.feature_set)
        } else {
            0
        };
        tally.payers.entry(*payer).or_default().note(failed, fee);
        if ours {
            tally.total.note(failed, fee);
        }
    }
    tally
}

/// By message hash, which the cache holds for all but durable nonce transactions; those are found
/// by signature where the node keeps signatures.
fn failed_in(bank: &Bank, transaction: &VersionedTransaction) -> Option<bool> {
    let message = &transaction.message;
    let by_hash = bank.status_cache.read().unwrap().get_status(
        message.hash(),
        message.recent_blockhash(),
        &bank.ancestors,
    );
    let (slot, status) = match by_hash {
        Some(found) => found,
        None => bank.get_signature_status_slot(transaction.signatures.first()?)?,
    };
    (slot == bank.slot()).then(|| status.is_err())
}

/// What the fee charged beyond the signatures: a v1 message states it, earlier ones set a price
/// per compute unit.
fn priority_fee(transaction: &VersionedTransaction, feature_set: &FeatureSet) -> u64 {
    let message = &transaction.message;
    if let VersionedMessage::V1(v1) = message {
        return v1.config.priority_fee.unwrap_or(0);
    }
    let keys = message.static_account_keys();
    let instructions = message.instructions().iter().filter_map(|instruction| {
        let program = keys.get(usize::from(instruction.program_id_index))?;
        Some((program, SVMInstruction::from(instruction)))
    });
    process_compute_budget_instructions(instructions, feature_set)
        .map_or(0, |limits| limits.get_prioritization_fee())
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        solana_compute_budget_interface::ComputeBudgetInstruction,
        solana_keypair::Keypair,
        solana_runtime::genesis_utils::{GenesisConfigInfo, create_genesis_config},
        solana_signer::Signer,
        solana_system_interface::instruction::transfer,
        solana_transaction::Transaction,
    };

    fn tally(transactions: u64, failed: u64, priority_failed: u64) -> Tally {
        Tally {
            transactions,
            failed,
            priority_failed,
        }
    }

    fn block(epoch: Epoch, ours: bool, payers: &[(Pubkey, Tally)]) -> BlockTally {
        let mut total = Tally::default();
        for (_, payer) in payers {
            total.add(payer);
        }
        BlockTally {
            epoch,
            ours,
            total,
            payers: payers.iter().copied().collect(),
        }
    }

    #[test]
    fn flags_at_each_threshold() {
        assert!(is_flagged(&tally(100, 10, MIN_PRIORITY_FAILED)));
        assert!(!is_flagged(&tally(99, 99, MIN_PRIORITY_FAILED)));
        assert!(!is_flagged(&tally(100, 9, MIN_PRIORITY_FAILED)));
        assert!(!is_flagged(&tally(
            100,
            100,
            MIN_PRIORITY_FAILED.saturating_sub(1)
        )));
    }

    #[test]
    fn escalates_over_three_times_the_rate_elsewhere() {
        let ours = tally(100, 40, MIN_PRIORITY_FAILED);
        // 40% against 13% is over three times, against 14% not.
        assert_eq!(alert(&ours, &tally(100, 13, 0)), Some(Alert::Escalated));
        assert_eq!(alert(&ours, &tally(100, 14, 0)), Some(Alert::Flagged));
        assert_eq!(alert(&ours, &tally(100, 0, 0)), Some(Alert::Escalated));
        // Too few elsewhere to judge.
        assert_eq!(alert(&ours, &tally(99, 0, 0)), Some(Alert::Flagged));
        assert_eq!(alert(&tally(100, 5, 0), &tally(100, 0, 0)), None);
    }

    #[test]
    fn counts_rooted_blocks_and_follows_our_payers_elsewhere() {
        let (spammer, other) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut payers = FeePayers::default();
        payers.unsettled.insert(
            10,
            block(5, true, &[(spammer, tally(120, 60, MIN_PRIORITY_FAILED))]),
        );
        // Another leader's block, and one on a fork that was abandoned.
        payers.unsettled.insert(
            11,
            block(
                5,
                false,
                &[(spammer, tally(200, 10, 0)), (other, tally(50, 50, 0))],
            ),
        );
        payers
            .unsettled
            .insert(12, block(5, true, &[(other, tally(500, 500, u64::MAX))]));
        payers.unsettled.insert(13, block(5, true, &[]));
        payers.settle(12, 5, |slot| slot != 12);

        assert_eq!(payers.unsettled.keys().copied().collect::<Vec<_>>(), [13]);
        let summary = payers.summary().unwrap();
        assert_eq!(
            summary.epochs,
            [EpochFigures {
                epoch: 5,
                blocks: 1,
                transactions: 120,
                failed: 60,
                priority_failed: MIN_PRIORITY_FAILED,
                away_transactions: 200,
                away_failed: 10,
            }]
        );
        assert_eq!(summary.payers.len(), 1);
        let row = &summary.alerts[0];
        assert_eq!(row.payer, spammer.to_string());
        assert_eq!(row.alert, Some(Alert::Escalated));
        assert_eq!(row.flagged_slot, Some(10));
    }

    #[test]
    fn keeps_this_epoch_and_the_last() {
        let payer = Pubkey::new_unique();
        let mut payers = FeePayers::default();
        for (slot, epoch) in [(1, 3), (2, 4), (3, 5)] {
            payers
                .unsettled
                .insert(slot, block(epoch, true, &[(payer, tally(1, 1, 1))]));
        }
        payers.settle(3, 5, |_| true);
        let summary = payers.summary().unwrap();
        let epochs: Vec<Epoch> = summary.epochs.iter().map(|figures| figures.epoch).collect();
        assert_eq!(epochs, [5, 4]);
        assert!(summary.payers.iter().all(|row| row.epoch == 5));
    }

    #[test]
    fn orders_alerts_newest_epoch_and_escalated_first() {
        let (a, b, c) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        let flagged = tally(100, 100, MIN_PRIORITY_FAILED);
        let mut payers = FeePayers::default();
        payers.unsettled.insert(1, block(4, true, &[(a, flagged)]));
        payers
            .unsettled
            .insert(2, block(5, true, &[(b, flagged), (c, flagged)]));
        payers
            .unsettled
            .insert(3, block(5, false, &[(c, tally(100, 1, 0))]));
        payers.settle(3, 5, |_| true);
        let alerts: Vec<(String, Option<Alert>)> = payers
            .summary()
            .unwrap()
            .alerts
            .into_iter()
            .map(|row| (row.payer, row.alert))
            .collect();
        assert_eq!(
            alerts,
            [
                (c.to_string(), Some(Alert::Escalated)),
                (b.to_string(), Some(Alert::Flagged)),
                (a.to_string(), Some(Alert::Flagged)),
            ]
        );
    }

    #[test]
    fn reads_results_and_priority_fees_from_the_bank() {
        let GenesisConfigInfo {
            genesis_config,
            mint_keypair,
            ..
        } = create_genesis_config(1_000_000_000);
        let (bank, _forks) = Bank::new_with_bank_forks_for_tests(&genesis_config);
        let blockhash = bank.last_blockhash();
        let to = Pubkey::new_unique();
        let paid = |lamports: u64| {
            Transaction::new_signed_with_payer(
                &[
                    ComputeBudgetInstruction::set_compute_unit_limit(10_000),
                    ComputeBudgetInstruction::set_compute_unit_price(2_000_000),
                    transfer(&mint_keypair.pubkey(), &to, lamports),
                ],
                Some(&mint_keypair.pubkey()),
                &[&mint_keypair],
                blockhash,
            )
        };
        let landed = paid(1_000);
        let failed = paid(10_000_000_000);
        bank.process_transaction(&landed).unwrap();
        assert!(bank.process_transaction(&failed).is_err());
        let unprocessed = solana_system_transaction::transfer(&Keypair::new(), &to, 1, blockhash);
        let entries = [Entry {
            num_hashes: 1,
            hash: blockhash,
            transactions: [landed, failed, unprocessed]
                .into_iter()
                .map(VersionedTransaction::from)
                .collect(),
        }];

        let ours = tally_block(&bank, &entries, true, |_| false);
        // 2,000,000 micro-lamports per unit over a 10,000 unit limit.
        assert_eq!(ours.total, tally(2, 1, 20_000));
        assert_eq!(ours.payers[&mint_keypair.pubkey()], tally(2, 1, 20_000));

        let away = tally_block(&bank, &entries, false, |payer| {
            *payer == mint_keypair.pubkey()
        });
        assert_eq!(away.total, Tally::default());
        assert_eq!(away.payers[&mint_keypair.pubkey()], tally(2, 1, 0));
        assert!(
            tally_block(&bank, &entries, false, |_| false)
                .payers
                .is_empty()
        );
    }
}
