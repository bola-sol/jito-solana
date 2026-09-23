//! The handles the dashboard reads validator state through.

use {
    agave_snapshots::snapshot_config::SnapshotConfig,
    solana_clock::Slot,
    solana_cluster_type::ClusterType,
    solana_core::validator::ValidatorStartProgress,
    solana_gossip::cluster_info::ClusterInfo,
    solana_ledger::{blockstore::Blockstore, leader_schedule_cache::LeaderScheduleCache},
    solana_pubkey::Pubkey,
    solana_runtime::{
        bank_forks::BankForks, commitment::BlockCommitmentCache,
        validated_block_finalization::ValidatedBlockFinalizationCert,
    },
    std::{
        path::PathBuf,
        sync::{Arc, RwLock},
    },
};

/// The validator's boot phase, shared with the binary that advances it.
pub type StartProgress = Arc<RwLock<ValidatorStartProgress>>;

#[derive(Clone)]
pub struct DashboardContext {
    pub cluster_info: Arc<ClusterInfo>,
    pub bank_forks: Arc<RwLock<BankForks>>,
    pub block_commitment_cache: Arc<RwLock<BlockCommitmentCache>>,
    pub blockstore: Arc<Blockstore>,
    pub leader_schedule_cache: Arc<LeaderScheduleCache>,
    pub vote_account: Pubkey,
    /// The last finalization certificate votor validated. Empty until
    /// Alpenglow consensus is live.
    pub highest_finalized: Arc<RwLock<Option<ValidatedBlockFinalizationCert>>>,
    /// Where the accounts database keeps its storage files, for the host panel.
    pub account_paths: Vec<PathBuf>,
    /// Where snapshot archives are written and how often. `None` in tests.
    pub snapshot_config: Option<SnapshotConfig>,
}

impl DashboardContext {
    pub fn identity(&self) -> Pubkey {
        self.cluster_info.id()
    }

    pub fn cluster_name(&self) -> &'static str {
        cluster_name(self.bank_forks.read().unwrap().root_bank().cluster_type())
    }

    /// The highest slot the cluster has finalized as far as this node can tell: votor's last
    /// certificate under Alpenglow, the blockstore's latest optimistic slot before it.
    pub fn cluster_tip(&self) -> Option<Slot> {
        let migration_status = self.bank_forks.read().unwrap().migration_status();
        if migration_status.is_alpenglow_enabled() {
            self.highest_finalized
                .read()
                .ok()?
                .as_ref()
                .map(|cert| cert.block().slot)
        } else {
            // After a restart the confirmed slot predates the snapshot. The
            // highest slot with shreds is the floor.
            let confirmed = self
                .blockstore
                .get_latest_optimistic_slots(1)
                .ok()
                .and_then(|mut slots| slots.pop())
                .map(|(slot, _, _)| slot);
            let shredded = self.blockstore.highest_slot().ok().flatten();
            confirmed.into_iter().chain(shredded).max()
        }
    }
}

fn cluster_name(cluster_type: ClusterType) -> &'static str {
    match cluster_type {
        ClusterType::Testnet => "testnet",
        ClusterType::MainnetBeta => "mainnet-beta",
        ClusterType::Devnet => "devnet",
        ClusterType::Development => "development",
    }
}

#[cfg(test)]
mod tests {
    use {super::*, crate::fixture::fixture};

    #[test]
    fn test_the_identity_is_the_one_gossip_announces() {
        // Read through cluster info rather than held as a field, because an
        // operator can swap a validator's identity while it runs.
        let harness = fixture();
        assert_eq!(harness.ctx.identity(), harness.identity);
    }

    #[test]
    fn test_every_cluster_reports_a_name() {
        for (cluster_type, name) in [
            (ClusterType::Testnet, "testnet"),
            (ClusterType::MainnetBeta, "mainnet-beta"),
            (ClusterType::Devnet, "devnet"),
            (ClusterType::Development, "development"),
        ] {
            assert_eq!(cluster_name(cluster_type), name);
        }
    }
}
