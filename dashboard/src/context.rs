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
        path::PathBuf,
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

    /// Share of the cluster's stake this validator can currently see in gossip,
    /// from 0 to 1, while it is waiting for a supermajority.
    ///
    /// The one phase besides replay that can say how far along it is. `None`
    /// everywhere else, including on a validator that never waits — most do
    /// not, the wait being for a restart rather than an ordinary boot.
    pub stake_percent: Option<f64>,

    /// How long the validator has been in this phase, and how long each phase
    /// before it took.
    ///
    /// Most of the boot sequence can say nothing about how far through it is —
    /// there is no count of accounts left to index or archive left to unpack —
    /// so what is offered instead is how long it has been going. On a boot that
    /// has stopped somewhere, that is the figure an operator is actually after.
    ///
    /// Both are filled in by the dashboard, which watches the phase change. The
    /// validator reports which phase it is in and nothing about when it got
    /// there.
    pub phase_elapsed_nanos: u64,
    pub phases_taken: Vec<PhaseTiming>,
}

/// How long one phase of the boot sequence took.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PhaseTiming {
    pub phase: String,
    pub elapsed_nanos: u64,
}

/// Supplies the current startup phase on demand.
pub type StartupProgressFn = Arc<dyn Fn() -> StartupProgress + Send + Sync>;

/// The highest slot the cluster has finalized, as far as this node can tell.
///
/// A closure rather than a handle, so the dashboard needs neither the
/// certificate type nor the crate it lives in, and so the rule for what counts
/// as the cluster's tip stays with the validator that already decides it.
///
/// `None` before the node has seen anything to go on, which on a fresh start is
/// until the first certificate arrives.
pub type ClusterTipFn = Arc<dyn Fn() -> Option<Slot> + Send + Sync>;

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
    /// How far the cluster has got, which is the one figure here that does not
    /// move with this node's own replay.
    ///
    /// Everything else the dashboard measures is taken from this validator's
    /// view of the chain, and that view lags when replay lags, so every
    /// self-referential reading keeps agreeing with itself. A node hundreds of
    /// slots behind votes promptly on what it has replayed and reports perfect
    /// health by every other rule.
    pub cluster_tip: ClusterTipFn,
    /// Where the accounts database keeps its storage files.
    ///
    /// Several, commonly, because an operator striping accounts across disks
    /// passes `--accounts` more than once. The ledger path is not here: the
    /// blockstore above already knows it.
    pub account_paths: Vec<PathBuf>,
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
