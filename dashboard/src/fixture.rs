//! A validator small enough to test against, gathered into one
//! `DashboardContext`. The node is its own staked leader so a leader schedule
//! exists.

use {
    crate::{
        collect::{Collector, CollectorShared, EpochInfo, Replies},
        context::{DashboardContext, StartProgress},
        history::{PACKED_SLOTS, SlotHistory},
        meters::Meters,
        metrics_tap::MetricsTap,
        proto::Publisher,
        validator_info::ValidatorInfoCache,
    },
    solana_account::AccountSharedData,
    solana_accounts_db::{
        accounts_db::AccountsDbConfig,
        accounts_index::{
            AccountIndex, AccountSecondaryIndexes, AccountSecondaryIndexesIncludeExclude,
        },
    },
    solana_clock::Slot,
    solana_core::validator::ValidatorStartProgress,
    solana_gossip::{cluster_info::ClusterInfo, contact_info::ContactInfo},
    solana_keypair::Keypair,
    solana_leader_schedule::SlotLeader,
    solana_ledger::{
        blockstore::Blockstore, get_tmp_ledger_path_auto_delete,
        leader_schedule_cache::LeaderScheduleCache,
    },
    solana_net_utils::SocketAddrSpace,
    solana_pubkey::Pubkey,
    solana_runtime::{
        bank::{Bank, BankTestConfig},
        bank_forks::BankForks,
        commitment::BlockCommitmentCache,
        genesis_utils::{GenesisConfigInfo, create_genesis_config_with_leader},
    },
    solana_signer::Signer,
    solana_system_transaction as system_transaction,
    std::{
        collections::HashSet,
        sync::{Arc, RwLock},
        time::SystemTime,
    },
    tempfile::TempDir,
};

/// A vote account with no stake is skipped by every count.
const VALIDATOR_STAKE: u64 = 1_000_000;

const MINT: u64 = 1_000_000_000;

pub struct Fixture {
    pub ctx: DashboardContext,
    pub publisher: Arc<Publisher>,
    pub bank_forks: Arc<RwLock<BankForks>>,
    pub identity: Pubkey,
    pub vote_account: Pubkey,
    mint: Keypair,
    pub history: Arc<RwLock<SlotHistory>>,
    pub epochs: Arc<RwLock<Vec<EpochInfo>>>,
    /// Held: dropping it deletes the directory the blockstore has open.
    _ledger: TempDir,
}

impl Fixture {
    /// Before Alpenglow the tip is the blockstore's latest optimistic slot.
    pub fn set_cluster_tip(&self, slot: Slot) {
        let hash = self.working_bank().last_blockhash();
        self.ctx
            .blockstore
            .insert_optimistic_slot(slot, &hash, 0)
            .unwrap();
    }

    pub fn working_bank(&self) -> Arc<Bank> {
        self.bank_forks.read().unwrap().working_bank()
    }

    pub fn advance_to(&self, slot: Slot) -> Arc<Bank> {
        self.advance_with(slot, &[])
    }

    /// Written before the freeze, since a bank asserts against stores afterwards.
    pub fn advance_with(&self, slot: Slot, accounts: &[(Pubkey, AccountSharedData)]) -> Arc<Bank> {
        let parent = self.working_bank();
        if !parent.is_frozen() {
            parent.freeze();
        }
        let bank = Bank::new_from_parent(
            parent,
            SlotLeader {
                id: self.identity,
                vote_address: self.vote_account,
            },
            slot,
        );
        for (pubkey, account) in accounts {
            bank.store_account(pubkey, account);
        }
        bank.freeze();
        self.bank_forks.write().unwrap().insert(bank);
        self.bank_forks.read().unwrap().get(slot).unwrap()
    }

    /// Transfers of more than the mint holds.
    pub fn advance_with_failures(&self, slot: Slot, failures: usize) -> Arc<Bank> {
        let parent = self.working_bank();
        if !parent.is_frozen() {
            parent.freeze();
        }
        let bank = Bank::new_from_parent(
            parent,
            SlotLeader {
                id: self.identity,
                vote_address: self.vote_account,
            },
            slot,
        );
        for _ in 0..failures {
            let transfer = system_transaction::transfer(
                &self.mint,
                &Pubkey::new_unique(),
                MINT.saturating_mul(2),
                bank.last_blockhash(),
            );
            assert!(bank.process_transaction(&transfer).is_err());
        }
        bank.freeze();
        self.bank_forks.write().unwrap().insert(bank);
        self.bank_forks.read().unwrap().get(slot).unwrap()
    }

    pub fn published(&self) -> Vec<String> {
        self.publisher
            .snapshot()
            .iter()
            .map(|message| message.to_string())
            .collect()
    }

    pub fn published_key(&self, topic: &str, key: &str) -> Option<String> {
        let needle = format!(r#""topic":"{topic}","key":"{key}""#);
        self.published()
            .into_iter()
            .find(|message| message.contains(&needle))
    }

    pub fn collector(&self) -> Collector {
        self.collector_with_startup(Arc::new(std::sync::Mutex::new(
            crate::startup::StartupPublisher::default(),
        )))
    }

    pub fn collector_with_startup(
        &self,
        startup: Arc<std::sync::Mutex<crate::startup::StartupPublisher>>,
    ) -> Collector {
        let shared = CollectorShared {
            publisher: self.publisher.clone(),
            info_cache: Arc::new(RwLock::new(ValidatorInfoCache::default())),
            history: self.history.clone(),
            epochs: self.epochs.clone(),
            replies: Arc::new(Replies::default()),
            startup_progress: running(),
            startup,
            metrics_tap: Arc::new(MetricsTap::default()),
        };
        Collector::new(self.ctx.clone(), shared, None, None, None)
    }

    pub fn meters(&self) -> Meters {
        // A tap of its own rather than the process-wide one, which would carry
        // whatever the rest of the suite measured.
        Meters::new(
            self.ctx.clone(),
            self.publisher.clone(),
            running(),
            SystemTime::now(),
            Arc::new(MetricsTap::default()),
        )
    }
}

fn running() -> StartProgress {
    Arc::new(RwLock::new(ValidatorStartProgress::Running))
}

pub fn fixture() -> Fixture {
    let keypair = Arc::new(Keypair::new());
    let identity = keypair.pubkey();

    let GenesisConfigInfo {
        genesis_config,
        mint_keypair,
        voting_keypair,
        ..
    } = create_genesis_config_with_leader(MINT, &identity, VALIDATOR_STAKE);
    let vote_account = voting_keypair.pubkey();

    // With the config program in the account index, which `validator_info::scan_all` requires.
    let bank = Bank::new_with_paths_for_tests(
        &genesis_config,
        Some(BankTestConfig {
            accounts_db_config: AccountsDbConfig {
                account_indexes: Some(AccountSecondaryIndexes {
                    indexes: HashSet::from([AccountIndex::ProgramId]),
                    keys: Some(AccountSecondaryIndexesIncludeExclude {
                        exclude: false,
                        keys: HashSet::from([solana_sdk_ids::config::id()]),
                    }),
                }),
                ..BankTestConfig::default().accounts_db_config
            },
        }),
        Vec::new(),
        None,
    );
    // Taken before the bank moves into bank forks, and from the same bank, so
    // the schedule the collector resolves against is the one it is reading.
    let leader_schedule_cache = Arc::new(LeaderScheduleCache::new_from_bank(&bank));
    bank.freeze();
    let bank_forks = BankForks::new_rw_arc(bank);

    let ledger = get_tmp_ledger_path_auto_delete!();
    let blockstore = Arc::new(Blockstore::open(ledger.path()).unwrap());

    // Localhost contact info: the ingest panel matches advertised ports, and a
    // node advertising nothing produces no rows.
    let cluster_info = Arc::new(ClusterInfo::new(
        ContactInfo::new_localhost(&identity, 0),
        keypair,
        SocketAddrSpace::Unspecified,
    ));

    Fixture {
        ctx: DashboardContext {
            cluster_info,
            bank_forks: bank_forks.clone(),
            block_commitment_cache: Arc::new(RwLock::new(BlockCommitmentCache::default())),
            blockstore,
            leader_schedule_cache,
            vote_account,
            highest_finalized: Arc::new(RwLock::new(None)),
            account_paths: Vec::new(),
            snapshot_config: None,
        },
        publisher: Arc::new(Publisher::new()),
        bank_forks,
        identity,
        vote_account,
        mint: mint_keypair,
        history: Arc::new(RwLock::new(SlotHistory::new(PACKED_SLOTS))),
        epochs: Arc::new(RwLock::new(Vec::new())),
        _ledger: ledger,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_the_fixture_builds_a_validator_with_stake() {
        let harness = fixture();
        let bank = harness.working_bank();
        assert_eq!(bank.slot(), 0);
        assert!(
            bank.vote_accounts().values().any(|(stake, _)| *stake > 0),
            "the fixture's validator must hold stake or the counts test nothing"
        );
    }

    #[test]
    fn test_advancing_gives_a_frozen_child() {
        let harness = fixture();
        let bank = harness.advance_to(1);
        assert_eq!(bank.slot(), 1);
        assert!(bank.is_frozen(), "the collector only reads frozen banks");
        assert_eq!(
            harness.bank_forks.read().unwrap().frozen_banks().count(),
            2,
            "genesis and its child"
        );
    }

    #[test]
    fn test_a_tick_publishes_what_a_client_needs_to_render() {
        let harness = fixture();
        harness.advance_to(1);

        let mut collector = harness.collector();
        collector.publish_static();
        collector.tick();

        for key in [
            "version",
            "cluster",
            "shred_version",
            "identity_key",
            "vote_key",
            "root_slot",
            "completed_slot",
            "estimated_slot",
            "block_height",
            "identity_balance",
            "startup_progress",
        ] {
            assert!(
                harness.published_key("summary", key).is_some(),
                "summary.{key} was not published"
            );
        }
        assert!(
            harness.published_key("epoch", "new").is_some(),
            "the epoch panel would have nothing to show"
        );
    }

    #[test]
    fn test_the_cluster_wide_tier_waits_for_a_viewer() {
        // Easy to break by moving a collector into the wrong tier, and invisible if it is.
        let harness = fixture();
        harness.advance_to(1);
        let mut collector = harness.collector();

        collector.tick();
        assert!(
            harness
                .published_key("summary", "validator_counts")
                .is_none(),
            "the cluster walk ran with nobody watching"
        );

        let _viewer = harness.publisher.subscribe();
        collector.tick();
        assert!(
            harness
                .published_key("summary", "validator_counts")
                .is_some(),
            "a viewer attached and the cluster walk still did not run"
        );
    }

    #[test]
    fn test_the_node_leads_its_own_schedule() {
        // Without this the leader schedule is empty, no slot gets labelled, and
        // collect_leaders has nothing to resolve.
        let harness = fixture();
        let bank = harness.working_bank();
        assert_eq!(
            harness
                .ctx
                .leader_schedule_cache
                .slot_leader_at(0, Some(&bank))
                .map(|leader| leader.id),
            Some(harness.identity),
        );
    }
}
