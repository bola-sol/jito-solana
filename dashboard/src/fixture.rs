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
    crate::{context::DashboardContext, proto::Publisher},
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
        bank::Bank,
        bank_forks::BankForks,
        commitment::BlockCommitmentCache,
        genesis_utils::{GenesisConfigInfo, create_genesis_config_with_leader},
    },
    solana_signer::Signer,
    std::{
        sync::{Arc, RwLock},
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
    /// Held, not used. Dropping it deletes the directory the blockstore has
    /// open, and the failures that follow look like blockstore bugs.
    _ledger: TempDir,
}

impl Fixture {
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
}

pub fn fixture() -> Fixture {
    let keypair = Arc::new(Keypair::new());
    let identity = keypair.pubkey();

    let GenesisConfigInfo {
        genesis_config,
        voting_keypair,
        ..
    } = create_genesis_config_with_leader(MINT, &identity, VALIDATOR_STAKE);
    let vote_account = voting_keypair.pubkey();

    let bank = Bank::new_for_tests(&genesis_config);
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
        },
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
