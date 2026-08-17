//! The handles the dashboard reads validator state through.
//!
//! This crate does not depend on `solana-core`. The validator owns the
//! dashboard, not the other way around. Anything that only exists in
//! `solana-core`, such as startup progress, comes in behind a small interface
//! defined here. That keeps the wiring at the validator's post-init site down
//! to a handful of lines.

use {
    serde::Serialize,
    solana_clock::Slot,
    solana_cluster_type::ClusterType,
    solana_gossip::cluster_info::ClusterInfo,
    solana_ledger::{blockstore::Blockstore, leader_schedule_cache::LeaderScheduleCache},
    solana_pubkey::Pubkey,
    solana_runtime::{bank_forks::BankForks, commitment::BlockCommitmentCache},
    std::{
        sync::{Arc, RwLock},
        time::SystemTime,
    },
};

/// A coarse description of where the validator is in its boot sequence,
/// mirroring `solana_core::validator::ValidatorStartProgress` without depending
/// on it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StartupProgress {
    /// Machine-readable phase name, e.g. `"loading_ledger"`.
    pub phase: String,
    /// Human-readable detail for the phase, when there is any.
    pub detail: Option<String>,
    /// True once the validator is fully running.
    pub running: bool,
    /// How far ledger replay has got, from 0 to 1, once enough has been seen to
    /// measure it. Filled in by the dashboard rather than the validator, which
    /// reports absolute slots and does not record where replay began.
    pub fraction: Option<f64>,
    /// The absolute `(current, target)` replay slots `fraction` is derived
    /// from. Internal to the crate; the client is sent the fraction.
    #[serde(skip)]
    pub replay_slots: Option<(Slot, Slot)>,
}

/// Supplies the current startup phase on demand.
pub type StartupProgressFn = Arc<dyn Fn() -> StartupProgress + Send + Sync>;

#[derive(Clone)]
pub struct DashboardContext {
    pub cluster_info: Arc<ClusterInfo>,
    pub bank_forks: Arc<RwLock<BankForks>>,
    /// Where confirmed and finalized slot positions come from. Always present,
    /// unlike the optimistically-confirmed bank tracker, which only runs when
    /// RPC is enabled.
    pub block_commitment_cache: Arc<RwLock<BlockCommitmentCache>>,
    pub blockstore: Arc<Blockstore>,
    pub leader_schedule_cache: Arc<LeaderScheduleCache>,
    /// The vote account this validator votes with, if it is a voting validator.
    pub vote_account: Pubkey,
    pub cluster_type: ClusterType,
    /// When the validator process started, for the uptime readout.
    pub start_time: SystemTime,
}

impl DashboardContext {
    pub fn identity(&self) -> Pubkey {
        self.cluster_info.id()
    }

    /// The cluster name as the dashboard reports it. `ClusterType` is derived
    /// from genesis, so a custom cluster reports as `development`.
    pub fn cluster_name(&self) -> &'static str {
        match self.cluster_type {
            ClusterType::Testnet => "testnet",
            ClusterType::MainnetBeta => "mainnet-beta",
            ClusterType::Devnet => "devnet",
            ClusterType::Development => "development",
        }
    }
}

#[cfg(test)]
mod tests {
    use {super::*, crate::fixture::fixture};

    #[test]
    fn test_the_identity_is_the_one_gossip_announces() {
        // Read through cluster info rather than held as a field, because an
        // operator can swap a validator's identity while it runs and the page
        // has to follow.
        let harness = fixture();
        assert_eq!(harness.ctx.identity(), harness.identity);
    }

    #[test]
    fn test_every_cluster_reports_a_name() {
        // The header renders this directly, so an unnamed cluster would show a
        // blank badge. Genesis only ever yields `development` in a test, so the
        // rest are set here rather than left unexercised.
        let harness = fixture();
        for (cluster_type, name) in [
            (ClusterType::Testnet, "testnet"),
            (ClusterType::MainnetBeta, "mainnet-beta"),
            (ClusterType::Devnet, "devnet"),
            (ClusterType::Development, "development"),
        ] {
            let mut ctx = harness.ctx.clone();
            ctx.cluster_type = cluster_type;
            assert_eq!(ctx.cluster_name(), name);
        }
    }
}
