//! A validator small enough to test against.
//!
//! The collectors read through eight handles, and every one of them has a test
//! constructor somewhere in the workspace — they are just scattered. This
//! gathers them into one `DashboardContext` so that a test can call `tick` and
//! look at what came out, rather than testing the arithmetic around the edges.
//!
//! The node is its own staked leader. That is what makes the fixture useful
//! rather than merely constructible: a genesis with no stake produces no
//! leader schedule, so nothing labels a slot, nothing counts a validator, and
//! the collectors all take their empty paths.

use {
    crate::{
        collect::Collector,
        context::{DashboardContext, StartupProgress, StartupProgressFn},
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
    std::{
        collections::HashSet,
        sync::{Arc, Mutex, RwLock},
        time::SystemTime,
    },
    tempfile::TempDir,
};

/// Lamports staked to the fixture's validator. Any non-zero amount will do —
/// `create_genesis_config` proper stakes nothing, and a vote account with no
/// stake is skipped by every count the dashboard makes.
const VALIDATOR_STAKE: u64 = 1_000_000;

const MINT: u64 = 1_000_000_000;

pub struct Fixture {
    pub ctx: DashboardContext,
    pub publisher: Arc<Publisher>,
    pub bank_forks: Arc<RwLock<BankForks>>,
    /// This validator's identity, which is also the staked leader.
    pub identity: Pubkey,
    pub vote_account: Pubkey,
    /// The cluster's tip as the context's closure will report it. Shared with
    /// that closure so a test can move the cluster on without rebuilding the
    /// fixture.
    cluster_tip: Arc<Mutex<Option<Slot>>>,
    /// Held, not used. Dropping it deletes the directory the blockstore has
    /// open, and the failures that follow look like blockstore bugs.
    _ledger: TempDir,
}

impl Fixture {
    /// Puts the cluster ahead of this validator, as a node that has fallen
    /// behind would see it.
    pub fn set_cluster_tip(&self, slot: Option<Slot>) {
        *self.cluster_tip.lock().unwrap() = slot;
    }

    /// The bank at the tip.
    pub fn working_bank(&self) -> Arc<Bank> {
        self.bank_forks.read().unwrap().working_bank()
    }

    /// Freezes the tip and builds a frozen child at `slot`, led by this
    /// validator.
    ///
    /// Slot zero on its own exercises almost nothing: consensus levels,
    /// durations and the skip rate all need slots to have passed. Both banks
    /// are frozen because the collector only looks at frozen ones.
    pub fn advance_to(&self, slot: Slot) -> Arc<Bank> {
        self.advance_with(slot, &[])
    }

    /// As [`Self::advance_to`], with `accounts` written in the new slot.
    ///
    /// Written before the child freezes: a bank asserts against stores once
    /// freezing has started, so there is no adding to it afterwards.
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

    /// Every retained message a client connecting now would receive, as JSON
    /// text. Tests assert against this rather than reaching into the collector.
    pub fn published(&self) -> Vec<String> {
        self.publisher
            .snapshot()
            .iter()
            .map(|message| message.to_string())
            .collect()
    }

    /// The retained message for one key, if it has been published.
    pub fn published_key(&self, topic: &str, key: &str) -> Option<String> {
        let needle = format!(r#""topic":"{topic}","key":"{key}""#);
        self.published()
            .into_iter()
            .find(|message| message.contains(&needle))
    }

    /// A collector over this fixture, ready to tick.
    pub fn collector(&self) -> Collector {
        Collector::new(
            self.ctx.clone(),
            self.publisher.clone(),
            Arc::new(RwLock::new(ValidatorInfoCache::default())),
            running(),
        )
    }

    /// The once-a-second readings over this fixture, ready to tick.
    pub fn meters(&self) -> Meters {
        // A tap of its own rather than the process-wide one: the observer is
        // installed once per process and the tests share a process, so an
        // installed tap would carry whatever the rest of the suite measured.
        Meters::new(
            self.ctx.clone(),
            self.publisher.clone(),
            running(),
            Arc::new(MetricsTap::default()),
        )
    }
}

/// Startup progress for a validator that has finished starting, which is what
/// both threads report against for all but the boot sequence itself.
fn running() -> StartupProgressFn {
    Arc::new(|| StartupProgress {
        phase: "running".to_string(),
        detail: None,
        running: true,
        fraction: None,
        replay_slots: None,
        stake_percent: None,
        phase_elapsed_nanos: 0,
        phases_taken: Vec::new(),
    })
}

pub fn fixture() -> Fixture {
    let keypair = Arc::new(Keypair::new());
    let identity = keypair.pubkey();
    let cluster_tip: Arc<Mutex<Option<Slot>>> = Arc::new(Mutex::new(None));

    let GenesisConfigInfo {
        genesis_config,
        voting_keypair,
        ..
    } = create_genesis_config_with_leader(MINT, &identity, VALIDATOR_STAKE);
    let vote_account = voting_keypair.pubkey();

    // Built with the config program in the account index, which is what the
    // README tells an operator to switch on and what `validator_info::scan_all`
    // requires. Without it the name lookup is skipped and the tests covering it
    // would pass against a code path nobody runs.
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
    let cluster_type = genesis_config.cluster_type;
    bank.freeze();
    let bank_forks = BankForks::new_rw_arc(bank);

    let ledger = get_tmp_ledger_path_auto_delete!();
    let blockstore = Arc::new(Blockstore::open(ledger.path()).unwrap());

    // Localhost contact info: the ingest panel matches gossip-advertised ports
    // against what the kernel reports, and a node advertising nothing produces
    // no rows at all.
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
            cluster_type,
            start_time: SystemTime::now(),
            // The tests drive this through `Fixture::set_cluster_tip` where
            // they care; a fixture with no cluster to speak of reports none,
            // which is what a validator that has seen no certificate does.
            cluster_tip: {
                let tip = cluster_tip.clone();
                Arc::new(move || *tip.lock().unwrap())
            },
        },
        cluster_tip,
        publisher: Arc::new(Publisher::new()),
        bank_forks,
        identity,
        vote_account,
        _ledger: ledger,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_the_fixture_builds_a_validator_with_stake() {
        // A smoke test, and the one worth having: it proves the dependency and
        // feature wiring before any real test leans on it. A genesis with no
        // stake compiles and then quietly makes every collector take its empty
        // path.
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
        // The end-to-end shape: sample a real validator once and look at the
        // snapshot a browser connecting afterwards would be sent. Asserts the
        // keys are present rather than their values, which move; what this
        // catches is a collector wired to publish nothing, which every unit
        // test around the edges would miss.
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
        // The expensive sampling is skipped while nobody is connected, which is
        // the whole reason an idle validator costs nothing. Easy to break by
        // moving a collector into the wrong tier, and invisible if it is.
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

        // Holding a receiver is what counts as a viewer.
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
