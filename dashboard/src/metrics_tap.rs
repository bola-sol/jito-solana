//! Counters lifted from the metrics points the validator submits about itself.
//! The observer runs on the submitting thread: a name match, then an atomic add for a single
//! counter or one short lock for a set of them, the per-slot points included.
//! Points carry deltas, accumulated into totals. A few fields are levels,
//! replaced by the latest reading and never summed.

use {
    crate::certs::VoteSent,
    serde::Serialize,
    solana_clock::Slot,
    solana_metrics::datapoint::DataPoint,
    solana_time_utils::timestamp,
    std::{
        collections::{BTreeMap, BTreeSet, VecDeque},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        },
    },
};

const ACCOUNTS_DB_TIMINGS: &str = "accounts_db_store_timings";

const SHREDS_TURBINE: &str = "shred_fetch_receiver";
const SHREDS_REPAIR: &str = "shred_fetch_repair_receiver";

/// The receivers on the other two UDP ports the socket panel lists; the QUIC ports count
/// transactions, and serve repair's receiver never reports.
const GOSSIP_RECEIVER: &str = "gossip_receiver";

/// Turbine goes out over XDP and reports shreds only.
const GOSSIP_SENDER: &str = "Gossip";
const REPAIR_SENDER: &str = "Repair";
const SENT_BYTES: &str = "streamer-send-bytes_total";
const SENT_MILLIS: &str = "streamer-send-sample_duration_ms";
const TPU_VOTE_RECEIVER: &str = "tpu_vote_receiver";

const PACKETS_COUNT: &str = "packets_count";

/// Reported once a second and reset; submitted directly, so it arrives at any log level.
const SCHEDULER_COUNTS: &str = "banking_stage_scheduler_counts";
/// Same worker, tick and `id` as the counts point, so both read into one set of counters.
const WORKER_ERROR_METRICS: &str = "banking_stage_worker_error_metrics";

const ACCOUNTS_LOADS: &str = "accounts_db_load_accounts";
const ACCOUNTS_STORES: &str = "accounts_db-stores";
const ACCOUNTS_FLUSH: &str = "accounts_db-flush_accounts_cache";

/// The program cache's counters, reported and reset once per bank, so each point is one slot's
/// work.
const PROGRAM_CACHE: &str = "loaded-programs-cache-stats";

const QUIC_TPU: &str = "quic_streamer_tpu";
const QUIC_TPU_FORWARDS: &str = "quic_streamer_tpu_forwards";
const QUIC_TPU_VOTE: &str = "quic_streamer_tpu_vote";

/// `tpu-vote-verifier` is left alone: votes never reach the scheduler.
const TPU_VERIFIER: &str = "tpu-verifier";

const BUNDLE_STAGE: &str = "bundle_stage-loop_stats";

const BUNDLE_SLOT_STATS: &str = "bundle_stage-stats";

/// Every twenty milliseconds while it has work, with no slot on it.
const WORKER_TIMING: &str = "banking_stage_worker_timing";

const VOTE_SLOT_TIMING: &str = "banking_stage-leader_slot_vote_execute_and_commit_timings";

const WORKER_ID: &str = "id";

/// The worker threads, one point each, summed. Submitted at trace level, which the observer sees
/// anyway since it runs before the level check.
const WORKER_COUNTS: &str = "banking_stage_worker_counts";

const SCHEDULER_SLOT_COUNTS: &str = "banking_stage_scheduler_slot_counts";

/// Submitted only where an XDP config was given, so its absence says XDP is off.
const XDP_NETWORK_CONFIG: &str = "xdp-network-config";

const RETRANSMIT_STAGE: &str = "retransmit-stage";

const RETRANSMIT_SLOT_STATS: &str = "retransmit-stage-slot-stats";

/// Sent with `datapoint_info!`, so absent below `solana=info`.
const REPLAY_SLOT_STATS: &str = "replay-slot-stats";

const SHRED_FULL: &str = "shred_insert_is_full";

/// Reported for every slot, tagged with whether it was ours; only ours are kept.
const COST_TRACKER: &str = "cost_tracker_stats";

const WFSM_GOSSIP: &str = "wfsm_gossip";

/// Gossip reports itself every two seconds across these points, clearing each count as it sends it.
const GOSSIP_STATS: [&str; 5] = [
    "cluster_info_stats",
    "cluster_info_stats2",
    "cluster_info_stats3",
    "cluster_info_stats4",
    "cluster_info_stats5",
];
const GOSSIP_ENTRIES: &str = "cluster_info_crds_stats";
const GOSSIP_ENTRY_FAILS: &str = "cluster_info_crds_stats_fails";

/// In the order gossip reports them.
pub const GOSSIP_ENTRY_TYPES: [&str; 14] = [
    "LegacyContactInfo",
    "Vote",
    "LowestSlot",
    "LegacySnapshotHashes",
    "AccountsHashes",
    "EpochSlots",
    "LegacyVersion",
    "Version",
    "NodeInstance",
    "DuplicateShred",
    "SnapshotHashes",
    "ContactInfo",
    "RestartLastVotedForkSlots",
    "RestartHeaviestFork",
];

const IS_LEADER: &str = "is_leader";

const IS_XDP: &str = "is_xdp";

const SLOT: &str = "slot";

/// About a minute and a half: shorter missed the program cache's mean by a third, as compilation
/// arrives in bursts.
const REPLAY_SLOTS: usize = 256;

const VOTE_TRACKING: &str = "event_handler_slot_tracking";

const VOTE_TRACKS: usize = 4096;

/// Read when replay freezes a slot; during a catch-up the blockstore fills far ahead of replay.
const SHRED_FILLS: usize = 4096;

const SLOT_WATERFALLS: usize = 500;

const WORKER_TIMINGS: usize = 2048;

const SCHEDULER_ID: &str = "id";

const OWN_SCHEDULER_ID: &str = "0";

#[derive(Debug, Default)]
pub struct MetricsTap {
    pub accounts_cache_hits: AtomicU64,
    pub accounts_cache_misses: AtomicU64,
    pub accounts_cache_evicts: AtomicU64,

    pub shreds_turbine: AtomicU64,
    pub shreds_repair: AtomicU64,

    pub packets_gossip: AtomicU64,
    pub packets_tpu_vote: AtomicU64,

    pub turbine_root: AtomicU64,
    pub turbine_layer_1: AtomicU64,
    pub turbine_layer_2: AtomicU64,
    pub turbine_layer_3: AtomicU64,
    pub xdp_dropped: AtomicU64,
    /// The `is_xdp` tag last seen: 0 none yet, 1 false, 2 true.
    retransmit_xdp: AtomicU8,

    pub gossip_sent_bytes: AtomicU64,
    pub gossip_sent_millis: AtomicU64,
    pub repair_sent_bytes: AtomicU64,
    pub repair_sent_millis: AtomicU64,

    accounts: Mutex<AccountsSet>,

    program_cache: Mutex<ProgramCacheSet>,

    /// Separate sets, since the stages either side of the scheduler do not reconcile.
    quic: Mutex<QuicSet>,
    quic_forwards: Mutex<QuicSet>,
    quic_vote: Mutex<QuicSet>,
    verify: Mutex<VerifyTotals>,
    executed: Mutex<ExecutedTotals>,
    bundles: Mutex<BundleTotals>,

    scheduler: Mutex<SchedulerTotals>,

    gossip: Mutex<GossipSet>,

    slot_waterfalls: Mutex<VecDeque<SlotWaterfall>>,

    scheduler_is_bam: AtomicBool,

    slot_costs: Mutex<VecDeque<SlotCost>>,

    slot_lists_revision: AtomicU64,

    /// Kept one by one because the panel wants the worst slot as well as the mean.
    replay_slots: Mutex<BTreeMap<Slot, ReplaySlotTimes>>,
    vote_tracks: Mutex<BTreeMap<Slot, VoteSent>>,

    shred_fills: Mutex<BTreeMap<Slot, ShredFill>>,

    bundle_slots: Mutex<BTreeMap<Slot, BundleLanding>>,

    worker_timings: Mutex<VecDeque<WorkerTiming>>,

    vote_timings: Mutex<BTreeMap<Slot, StageTimes>>,

    /// Latched: it cannot change while the process runs.
    xdp: Mutex<Option<XdpConfig>>,

    stake_in_gossip: Mutex<Option<StakeInGossip>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StakeInGossip {
    pub online: u64,
    pub offline: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct XdpConfig {
    /// Whether the socket bound with `XDP_ZEROCOPY`. The flag is passed straight to
    /// `bind`, which fails rather than falling back, so true means zero-copy.
    pub zero_copy: bool,
    pub driver: String,
    pub vendor: String,
    pub model: String,
    pub kernel_version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SlotWaterfall {
    pub slot: Slot,
    pub source: SchedulerSource,
    #[serde(flatten)]
    pub counts: SchedulerTotals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlotCost {
    pub slot: Slot,
    pub costliest_account: String,
    pub costliest_cost: u64,
    pub block_cost: u64,
    pub accounts: u64,
    /// Accounts more than one transaction wanted to write. The cost tracker's
    /// own definition: within five percent of the per-account ceiling.
    pub contended: u64,
    pub new_account_data: u64,
    pub in_flight: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ShredFill {
    pub slot: Slot,
    pub shreds: u64,
    pub repaired: u64,
    pub full_millis: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct StageTimes {
    pub cost_model: u64,
    pub load_execute: u64,
    pub freeze_lock: u64,
    pub record: u64,
    pub commit: u64,
    pub send_votes: u64,
}

impl StageTimes {
    fn add(&mut self, other: &StageTimes) {
        self.cost_model = self.cost_model.saturating_add(other.cost_model);
        self.load_execute = self.load_execute.saturating_add(other.load_execute);
        self.freeze_lock = self.freeze_lock.saturating_add(other.freeze_lock);
        self.record = self.record.saturating_add(other.record);
        self.commit = self.commit.saturating_add(other.commit);
        self.send_votes = self.send_votes.saturating_add(other.send_votes);
    }

    fn field(&mut self, name: &str) -> Option<&mut u64> {
        Some(match name {
            "cost_model_us" => &mut self.cost_model,
            "load_execute_us" => &mut self.load_execute,
            "freeze_lock_us" => &mut self.freeze_lock,
            "record_us" => &mut self.record,
            "commit_us" => &mut self.commit,
            "find_and_send_votes_us" => &mut self.send_votes,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WorkerTiming {
    at_millis: u64,
    worker: u64,
    times: StageTimes,
    longest_batch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct WorkerSum {
    pub workers: u64,
    pub times: StageTimes,
    pub longest_batch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BundleLanding {
    pub slot: Slot,
    pub sanitized: u64,
    pub executed: u64,
}

/// One replayed slot's timings, in microseconds: `fetch`, `confirming` and `completing` are
/// disjoint on replay's thread, the verify fields overlap, and the rest is worker thread time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReplaySlotTimes {
    pub slot: Slot,
    // Replay's own thread, sequential.
    pub fetch: u64,
    pub confirming: u64,
    pub completing: u64,

    // Verification jobs, concurrent. Relative only.
    pub poh_verify: u64,
    pub tx_verify: u64,
    pub dispatch: u64,

    // Thread time across the workers.
    pub execute: u64,
    pub bytecode: u64,
    pub serialising: u64,
    pub deserialising: u64,
    pub creating_vms: u64,
    pub load: u64,
    pub store: u64,
    pub program_cache: u64,
    pub compiling: u64,
    pub checking: u64,
    pub other: u64,

    pub transactions: u64,

    pub observed_millis: u64,
}

impl ReplaySlotTimes {
    pub fn serial(&self) -> u64 {
        self.fetch
            .saturating_add(self.confirming)
            .saturating_add(self.completing)
    }

    pub fn cpu(&self) -> u64 {
        self.execute
            .saturating_add(self.load)
            .saturating_add(self.store)
            .saturating_add(self.program_cache)
            .saturating_add(self.checking)
            .saturating_add(self.other)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SchedulerSource {
    #[default]
    Scheduler,
    /// BAM on jito; it receives batches rather than packets.
    Bam,
}

fn scheduler_source(point: &DataPoint) -> SchedulerSource {
    match point.tags.iter().find(|(name, _)| *name == SCHEDULER_ID) {
        None => SchedulerSource::Scheduler,
        Some((_, id)) if id == OWN_SCHEDULER_ID => SchedulerSource::Scheduler,
        Some(_) => SchedulerSource::Bam,
    }
}

/// `received` is left out: the two schedulers count it in different units.
fn describes_more_work(new: &SchedulerTotals, held: &SchedulerTotals) -> bool {
    (new.scheduled, new.finished, new.buffered) > (held.scheduled, held.finished, held.buffered)
}

pub trait WindowedCounters: Copy + Default {
    fn since(&self, previous: &Self) -> Self;
    fn plus(&self, other: &Self) -> Self;
}

/// Declares a set's totals and their window arithmetic from one field list, so no field can be
/// left out of the arithmetic and read nought for ever.
macro_rules! counter_totals {
    (
        $(#[$meta:meta])*
        pub struct $totals:ident {
            $($(#[$field_meta:meta])* pub $field:ident: u64,)*
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
        pub struct $totals {
            $($(#[$field_meta])* pub $field: u64,)*
        }

        impl WindowedCounters for $totals {
            /// Saturating: a lower reading means a mid-flight install or a reset counter.
            fn since(&self, previous: &Self) -> Self {
                Self {
                    $($field: self.$field.saturating_sub(previous.$field),)*
                }
            }

            fn plus(&self, other: &Self) -> Self {
                Self {
                    $($field: self.$field.saturating_add(other.$field),)*
                }
            }
        }
    };
}

counter_totals! {
    /// Reads are counted in accounts, since nothing on the load path counts bytes.
    pub struct AccountsTotals {
        pub loaded_from_write_cache: u64,
        pub loaded_from_read_cache: u64,
        pub loaded_from_storage: u64,
        pub stored_accounts: u64,
        pub stored_bytes: u64,
    }
}

/// Levels. The difference between the two storage figures is what shrink reclaims.
#[derive(Debug, Clone, Copy, Default)]
struct AccountsLevels {
    storage_bytes: u64,
    storage_alive_bytes: u64,
    storage_count: u64,
    cache_bytes: u64,
    cache_entries: u64,
}

#[derive(Debug, Clone, Copy, Default)]
struct AccountsSet {
    totals: AccountsTotals,
    levels: AccountsLevels,
}

counter_totals! {
    pub struct ProgramCacheTotals {
        pub hits: u64,
        pub misses: u64,
        pub evictions: u64,
        pub reloads: u64,
        pub insertions: u64,
        pub lost_insertions: u64,
        pub replacements: u64,
        pub one_hit_wonders: u64,
        pub prunes_orphan: u64,
        pub prunes_environment: u64,
        pub empty_entries: u64,
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ProgramCacheSet {
    totals: ProgramCacheTotals,
    /// Entries loaded when an eviction last ran, reset with each bank, so the panel takes the
    /// window's peak.
    water_level: u64,
}

counter_totals! {
    /// One window of a QUIC port's counters. They do not partition the offer: the listener drops
    /// uncounted on either side of the handshake.
    pub struct QuicTotals {
        /// Cumulative on the wire; the denominator for the rest.
        pub offered: u64,
        pub shed_all: u64,
        pub shed_address: u64,
        pub refused_full: u64,
        pub handshake_timeout: u64,
        pub handshake_error: u64,
        pub handshook: u64,
        /// Four overlapping counters for one event, never summed; see `refusedTable` in `tpuPath.ts`.
        pub add_failed: u64,
        pub add_failed_staked: u64,
        pub add_failed_unstaked: u64,
        pub add_failed_banned: u64,
        pub admitted_staked: u64,
        pub admitted_unstaked: u64,
        pub streams: u64,
        pub throttled_staked: u64,
        pub throttled_unstaked: u64,
        pub read_timeouts: u64,
        pub read_errors: u64,
        pub invalid_size: u64,
        pub handed_on: u64,
        pub bytes_handed_on: u64,
        /// The one row here meaning this validator could not keep up.
        pub queue_full: u64,
        pub disconnected: u64,
    }
}

/// Kept apart from the counters so a window cannot sum them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct QuicLevels {
    pub open: u64,
    pub active_streams: u64,
}

/// One QUIC port: who was let in, what they sent, and what got through.
#[derive(Debug, Clone, Copy, Default)]
struct QuicSet {
    totals: QuicTotals,
    levels: QuicLevels,
}

counter_totals! {
    pub struct BundleTotals {
        pub received: u64,
        pub packets: u64,
    }
}

counter_totals! {
    pub struct VerifyTotals {
        pub received: u64,
        /// Ordinary: the network sends transactions more than once.
        pub duplicate: u64,
        pub below_floor: u64,
        pub verified: u64,
        /// Batches, not transactions, so never added to a packet count.
        pub evicted_batches: u64,
    }
}

counter_totals! {
    pub struct ExecutedTotals {
        pub attempted: u64,
        pub cost_throttled: u64,
        pub retryable: u64,
        pub expired_bank: u64,
        pub processed: u64,
        /// The rest landed having failed, which still costs their fee.
        pub succeeded: u64,

        pub too_many_locks: u64,
        pub account_missing: u64,
        pub fee_payer_broke: u64,
        pub fee_payer_invalid: u64,
        pub blockhash_missing: u64,
        pub blockhash_old: u64,
        pub already_processed: u64,
        pub bad_compute_budget: u64,
        pub account_data_too_large: u64,
        pub program_not_executable: u64,
        pub program_restricted: u64,
    }
}

counter_totals! {
    pub struct SchedulerTotals {
        pub received: u64,

        // Lost at the door, before ever being buffered.
        /// Not held because the validator was forwarding rather than buffering.
        pub not_held: u64,
        pub check_queue_full: u64,
        pub unparsable: u64,
        pub bad_locks: u64,
        pub compute_budget: u64,
        pub too_old: u64,
        pub already_processed: u64,
        pub fee_payer: u64,
        pub filtered: u64,
        pub nonce_conflict: u64,

        pub buffered: u64,

        // Lost from the container, after being buffered.
        /// Pushed out by something of higher priority when the queue was full.
        pub queue_full: u64,
        pub nonce_evicted: u64,
        pub cleared: u64,
        pub cleaned: u64,

        pub scheduled: u64,
        /// Held back this pass for account conflicts or busy workers. Pressure, not
        /// losses.
        pub blocked_conflicts: u64,
        pub blocked_threads: u64,

        pub finished: u64,
        pub retried: u64,
    }
}

counter_totals! {
    /// Messages are counted in packets and the rest in entries; the times are in microseconds.
    pub struct GossipTotals {
        pub received_push: u64,
        pub received_pull_requests: u64,
        pub received_pull_responses: u64,
        pub received_ping: u64,
        pub received_pong: u64,
        pub received_prune: u64,
        pub sent_push: u64,
        pub sent_pull_requests: u64,
        pub sent_pull_responses: u64,
        pub sent_ping: u64,
        pub sent_pong: u64,
        pub sent_prune: u64,

        pub accepted_push: u64,
        pub accepted_pull: u64,
        pub rejected_push: u64,
        pub rejected_pull: u64,
        pub duplicate_push: u64,
        pub redundant_pull: u64,
        /// Timed out of the table.
        pub expired: u64,
        /// Trimmed once the table held more distinct pubkeys than it keeps.
        pub evicted: u64,

        pub dropped_in: u64,
        pub dropped_out: u64,
        pub pull_no_budget: u64,
        pub pull_scan_exhausted: u64,
        pub other_shred_version_push: u64,
        pub other_shred_version_pull_responses: u64,
        pub other_shred_version_pull_requests: u64,
        pub ping_check_failed: u64,
        /// Values whose sender has not yet answered a ping.
        pub unverified_addresses: u64,
        pub bad_prune_destination: u64,

        pub push_us: u64,
        pub pull_requests_us: u64,
        pub pull_responses_us: u64,
        pub ping_us: u64,
        pub pong_us: u64,
        pub prune_us: u64,
        pub verify_us: u64,
        /// Includes the six handling times above.
        pub process_us: u64,

        /// Points of the first kind seen, so a quiet gossip can be told from a silent one.
        pub reports: u64,
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GossipLevels {
    pub table_size: u64,
    pub pubkeys: u64,
    pub nodes: u64,
    pub staked_nodes: u64,
}

/// Per entry type, in the order of `GOSSIP_ENTRY_TYPES`; rejected is push and pull together.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GossipEntryTotals {
    pub push: [u64; GOSSIP_ENTRY_TYPES.len()],
    pub pull: [u64; GOSSIP_ENTRY_TYPES.len()],
    pub rejected: [u64; GOSSIP_ENTRY_TYPES.len()],
}

impl WindowedCounters for GossipEntryTotals {
    fn since(&self, previous: &Self) -> Self {
        let less = |a: &[u64; GOSSIP_ENTRY_TYPES.len()], b: &[u64; GOSSIP_ENTRY_TYPES.len()]| {
            std::array::from_fn(|index| a[index].saturating_sub(b[index]))
        };
        Self {
            push: less(&self.push, &previous.push),
            pull: less(&self.pull, &previous.pull),
            rejected: less(&self.rejected, &previous.rejected),
        }
    }

    fn plus(&self, other: &Self) -> Self {
        let more = |a: &[u64; GOSSIP_ENTRY_TYPES.len()], b: &[u64; GOSSIP_ENTRY_TYPES.len()]| {
            std::array::from_fn(|index| a[index].saturating_add(b[index]))
        };
        Self {
            push: more(&self.push, &other.push),
            pull: more(&self.pull, &other.pull),
            rejected: more(&self.rejected, &other.rejected),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct GossipSet {
    totals: GossipTotals,
    levels: GossipLevels,
    entries: GossipEntryTotals,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TapCounters {
    pub accounts_cache_hits: u64,
    pub accounts_cache_misses: u64,
    pub accounts_cache_evicts: u64,
    pub shreds_turbine: u64,
    pub shreds_repair: u64,
    pub packets_gossip: u64,
    pub packets_tpu_vote: u64,
    pub turbine_root: u64,
    pub turbine_layer_1: u64,
    pub turbine_layer_2: u64,
    pub turbine_layer_3: u64,
    pub xdp_dropped: u64,
    pub retransmit_xdp: Option<bool>,
    pub gossip_sent_bytes: u64,
    pub gossip_sent_millis: u64,
    pub repair_sent_bytes: u64,
    pub repair_sent_millis: u64,
    pub scheduler: SchedulerTotals,
    pub accounts: AccountsTotals,
    pub accounts_storage_bytes: u64,
    pub accounts_storage_alive_bytes: u64,
    pub accounts_storage_count: u64,
    pub accounts_cache_bytes: u64,
    pub accounts_cache_entries: u64,
    pub program_cache: ProgramCacheTotals,
    pub program_cache_water_level: u64,
    pub quic: QuicTotals,
    pub quic_forwards: QuicTotals,
    pub quic_vote: QuicTotals,
    pub quic_levels: QuicLevels,
    pub quic_forwards_levels: QuicLevels,
    pub quic_vote_levels: QuicLevels,
    pub verify: VerifyTotals,
    pub executed: ExecutedTotals,
    pub bundles: BundleTotals,
    pub gossip: GossipTotals,
    pub gossip_levels: GossipLevels,
    pub gossip_entries: GossipEntryTotals,
}

impl MetricsTap {
    /// The first observer keeps the process's one slot; a second gets a tap that stays at zero.
    pub fn install() -> Arc<Self> {
        let tap = Arc::new(Self::default());
        let observer = tap.clone();
        if !solana_metrics::set_datapoint_observer(Box::new(move |point| {
            observer.observe(point);
        })) {
            log::warn!("dashboard: something else is already watching metrics points");
        }
        tap
    }

    #[cfg(test)]
    pub(crate) fn observe_point(&self, point: &DataPoint) {
        self.observe(point);
    }

    fn observe(&self, point: &DataPoint) {
        match point.name {
            ACCOUNTS_DB_TIMINGS => {
                add_to(&self.accounts, point);
                for (name, value) in &point.fields {
                    let counter = match *name {
                        "read_only_accounts_cache_hits" => &self.accounts_cache_hits,
                        "read_only_accounts_cache_misses" => &self.accounts_cache_misses,
                        "read_only_accounts_cache_evicts" => &self.accounts_cache_evicts,
                        _ => continue,
                    };
                    add_field(counter, value);
                }
            }
            SHREDS_TURBINE => self.add_packets(&self.shreds_turbine, point),
            SHREDS_REPAIR => self.add_packets(&self.shreds_repair, point),
            GOSSIP_RECEIVER => self.add_packets(&self.packets_gossip, point),
            TPU_VOTE_RECEIVER => self.add_packets(&self.packets_tpu_vote, point),
            GOSSIP_SENDER => {
                self.add_sent(&self.gossip_sent_bytes, &self.gossip_sent_millis, point)
            }
            REPAIR_SENDER => {
                self.add_sent(&self.repair_sent_bytes, &self.repair_sent_millis, point)
            }
            SCHEDULER_COUNTS => {
                self.scheduler_is_bam.store(
                    scheduler_source(point) == SchedulerSource::Bam,
                    Ordering::Relaxed,
                );
                add_to(&self.scheduler, point)
            }
            SCHEDULER_SLOT_COUNTS => self.remember_slot(point),
            REPLAY_SLOT_STATS => self.remember_replay(point),
            VOTE_TRACKING => self.remember_vote_track(point),
            SHRED_FULL => self.remember_fill(point),
            BUNDLE_SLOT_STATS => self.remember_bundles(point),
            WORKER_TIMING => self.remember_worker_timing(point, timestamp()),
            VOTE_SLOT_TIMING => self.remember_vote_timing(point),
            XDP_NETWORK_CONFIG => self.remember_xdp(point),
            RETRANSMIT_STAGE => self.add_retransmit(point),
            RETRANSMIT_SLOT_STATS => self.add_turbine_layers(point),
            WFSM_GOSSIP => self.remember_stake_in_gossip(point),
            COST_TRACKER => self.remember_cost(point),
            ACCOUNTS_LOADS | ACCOUNTS_STORES | ACCOUNTS_FLUSH => add_to(&self.accounts, point),
            PROGRAM_CACHE => add_to(&self.program_cache, point),
            QUIC_TPU => add_to(&self.quic, point),
            QUIC_TPU_FORWARDS => add_to(&self.quic_forwards, point),
            QUIC_TPU_VOTE => add_to(&self.quic_vote, point),
            TPU_VERIFIER => add_to(&self.verify, point),
            BUNDLE_STAGE => add_to(&self.bundles, point),
            WORKER_COUNTS | WORKER_ERROR_METRICS => add_to(&self.executed, point),
            GOSSIP_ENTRIES | GOSSIP_ENTRY_FAILS => add_to(&self.gossip, point),
            name if GOSSIP_STATS.contains(&name) => add_to(&self.gossip, point),
            _ => (),
        }
    }

    fn add_retransmit(&self, point: &DataPoint) {
        for (name, value) in &point.fields {
            if *name == "num_shreds_dropped_xdp_full" {
                add_field(&self.xdp_dropped, value);
            }
        }
        if let Some((_, is_xdp)) = point.tags.iter().find(|(name, _)| *name == IS_XDP) {
            let flag = if is_xdp == "true" { 2 } else { 1 };
            self.retransmit_xdp.store(flag, Ordering::Relaxed);
        }
    }

    fn add_turbine_layers(&self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                "num_shreds_received_root" => &self.turbine_root,
                "num_shreds_received_1st_layer" => &self.turbine_layer_1,
                "num_shreds_received_2nd_layer" => &self.turbine_layer_2,
                "num_shreds_received_3rd_layer" => &self.turbine_layer_3,
                _ => continue,
            };
            add_field(counter, value);
        }
    }

    fn add_packets(&self, counter: &AtomicU64, point: &DataPoint) {
        for (name, value) in &point.fields {
            if *name == PACKETS_COUNT {
                add_field(counter, value);
                return;
            }
        }
    }

    fn add_sent(&self, bytes: &AtomicU64, millis: &AtomicU64, point: &DataPoint) {
        for (name, value) in &point.fields {
            match *name {
                SENT_BYTES => add_field(bytes, value),
                SENT_MILLIS => add_field(millis, value),
                _ => (),
            }
        }
    }

    fn remember_slot(&self, point: &DataPoint) {
        let Some(slot) = point
            .fields
            .iter()
            .find(|(name, _)| *name == SLOT)
            .and_then(|(_, value)| field_u64(value))
        else {
            return;
        };

        let mut counts = SchedulerTotals::default();
        counts.add_point(point);
        let waterfall = SlotWaterfall {
            slot,
            source: scheduler_source(point),
            counts,
        };

        let Ok(mut slots) = self.slot_waterfalls.lock() else {
            return;
        };
        // A build running two schedulers reports every leader slot twice; keep
        // the report that did the work.
        if let Some(held) = slots.iter_mut().find(|held| held.slot == slot) {
            if describes_more_work(&waterfall.counts, &held.counts) {
                *held = waterfall;
                self.note_slot_lists_changed();
            }
            return;
        }
        slots.push_back(waterfall);
        while slots.len() > SLOT_WATERFALLS {
            slots.pop_front();
        }
        self.note_slot_lists_changed();
    }

    fn note_slot_lists_changed(&self) {
        self.slot_lists_revision.fetch_add(1, Ordering::Relaxed);
    }

    /// `driver` and `zero_copy` are tags; an unparseable `zero_copy` reads as false.
    fn remember_xdp(&self, point: &DataPoint) {
        let tag = |wanted: &str| {
            point
                .tags
                .iter()
                .find(|(name, _)| *name == wanted)
                .map(|(_, value)| value.as_str())
        };
        let field = |wanted: &str| {
            point
                .fields
                .iter()
                .find(|(name, _)| *name == wanted)
                .map(|(_, value)| field_str(value))
                .unwrap_or_default()
        };

        let config = XdpConfig {
            zero_copy: tag("zero_copy") == Some("true"),
            driver: tag("driver").unwrap_or_default().to_string(),
            vendor: field("vendor"),
            model: field("model"),
            kernel_version: field("kernel_version"),
        };
        if let Ok(mut held) = self.xdp.lock() {
            *held = Some(config);
        }
    }

    fn remember_vote_track(&self, point: &DataPoint) {
        let field = |wanted: &str| {
            point
                .fields
                .iter()
                .find(|(name, _)| *name == wanted)
                .and_then(|(_, value)| field_u64(value))
        };
        let Some(slot) = field(SLOT) else {
            return;
        };
        let vote = VoteSent {
            first_shred_us: field("first_shred"),
            parent_ready_us: field("parent_ready"),
            notarize_us: field("vote_notarize"),
            skip_us: field("vote_skip"),
        };
        let Ok(mut tracks) = self.vote_tracks.lock() else {
            return;
        };
        tracks.insert(slot, vote);
        while tracks.len() > VOTE_TRACKS {
            tracks.pop_first();
        }
    }

    pub fn take_vote_tracks(&self) -> Vec<(Slot, VoteSent)> {
        match self.vote_tracks.lock() {
            Ok(mut tracks) => std::mem::take(&mut *tracks).into_iter().collect(),
            Err(_) => Vec::new(),
        }
    }

    fn remember_replay(&self, point: &DataPoint) {
        let mut slot = ReplaySlotTimes::default();
        let mut seen = false;
        for (name, value) in &point.fields {
            let Some(micros) = field_u64(value) else {
                continue;
            };
            if *name == SLOT {
                slot.slot = micros;
                continue;
            }
            let field = match *name {
                "fetch_entries_time" => &mut slot.fetch,
                // The second spellings are sent when a block's footer already collected the
                // scheduler's results, as every alpenglow block does; the values are the same.
                "confirmation_without_replay_us" | "confirmation_time_us" => &mut slot.confirming,
                "bank_complete_time_us" => &mut slot.completing,

                "entry_poh_verification_time" => &mut slot.poh_verify,
                "entry_transaction_verification_time" => &mut slot.tx_verify,
                "task_submission_us" | "replay_time" => &mut slot.dispatch,

                "execute_us" => &mut slot.execute,
                "execute_details_execute_inner_us" => &mut slot.bytecode,
                "execute_details_serialize_us" => &mut slot.serialising,
                "execute_details_deserialize_us" => &mut slot.deserialising,
                "execute_details_create_vm_us" => &mut slot.creating_vms,
                "load_us" => &mut slot.load,
                "store_us" => &mut slot.store,
                "program_cache_us" => &mut slot.program_cache,
                "total_transactions" => &mut slot.transactions,

                // Compiling a program that was not in the cache, summed: what a miss cost,
                // not which third of the compiler it went to.
                "execute_details_create_executor_load_elf_us"
                | "execute_details_create_executor_verify_code_us"
                | "execute_details_create_executor_jit_compile_us" => &mut slot.compiling,

                "validate_transactions_us" | "validate_fees_us" | "filter_executable_us" => {
                    &mut slot.checking
                }

                "collect_balances_us"
                | "collect_logs_us"
                | "update_stakes_cache_us"
                | "update_transaction_statuses"
                | "check_block_limits_us" => &mut slot.other,

                _ => continue,
            };
            *field = field.saturating_add(micros);
            seen = true;
        }

        // A point naming nothing read here would drag every mean towards nought.
        if !seen {
            return;
        }

        slot.observed_millis = timestamp();
        let Ok(mut slots) = self.replay_slots.lock() else {
            return;
        };
        // A slot replayed twice keeps the later report. Bounded from the lowest
        // slot, which is the oldest during ordinary running.
        slots.insert(slot.slot, slot);
        while slots.len() > REPLAY_SLOTS {
            slots.pop_first();
        }
    }

    /// The -1 the blockstore sends for an unknown last index drops the point.
    fn remember_fill(&self, point: &DataPoint) {
        let mut fill = ShredFill::default();
        let mut slot = None;
        let mut last_index = None;
        for (name, value) in &point.fields {
            let Some(number) = field_u64(value) else {
                continue;
            };
            match *name {
                SLOT => slot = Some(number),
                "last_index" => last_index = Some(number),
                "num_repaired" => fill.repaired = number,
                "total_time_ms" => fill.full_millis = number,
                _ => (),
            }
        }
        let (Some(slot), Some(last_index)) = (slot, last_index) else {
            return;
        };
        fill.slot = slot;
        fill.shreds = last_index.saturating_add(1);

        let Ok(mut fills) = self.shred_fills.lock() else {
            return;
        };
        fills.insert(slot, fill);
        while fills.len() > SHRED_FILLS {
            fills.pop_first();
        }
    }

    fn remember_worker_timing(&self, point: &DataPoint, at_millis: u64) {
        let mut times = StageTimes::default();
        let mut longest_batch = 0;
        for (name, value) in &point.fields {
            let Some(micros) = field_u64(value) else {
                continue;
            };
            if *name == "load_execute_us_max" {
                longest_batch = micros;
            } else if let Some(field) = times.field(name) {
                *field = micros;
            }
        }
        let worker = point
            .tags
            .iter()
            .find(|(name, _)| *name == WORKER_ID)
            .and_then(|(_, id)| id.parse().ok())
            .unwrap_or(u64::MAX);
        let Ok(mut timings) = self.worker_timings.lock() else {
            return;
        };
        timings.push_back(WorkerTiming {
            at_millis,
            worker,
            times,
            longest_batch,
        });
        while timings.len() > WORKER_TIMINGS {
            timings.pop_front();
        }
    }

    fn remember_vote_timing(&self, point: &DataPoint) {
        let mut times = StageTimes::default();
        let mut slot = None;
        for (name, value) in &point.fields {
            let Some(micros) = field_u64(value) else {
                continue;
            };
            if *name == SLOT {
                slot = Some(micros);
            } else if let Some(field) = times.field(name) {
                *field = micros;
            }
        }
        let Some(slot) = slot else {
            return;
        };
        let Ok(mut slots) = self.vote_timings.lock() else {
            return;
        };
        slots.insert(slot, times);
        while slots.len() > SLOT_WATERFALLS {
            slots.pop_first();
        }
    }

    fn remember_bundles(&self, point: &DataPoint) {
        let mut slot = None;
        let mut sanitized = 0;
        let mut executed = 0;
        for (name, value) in &point.fields {
            let Some(number) = field_u64(value) else {
                continue;
            };
            match *name {
                SLOT => slot = Some(number),
                "num_sanitized_ok" => sanitized = number,
                "execution_results_ok" => executed = number,
                _ => (),
            }
        }
        let Some(slot) = slot else {
            return;
        };

        let Ok(mut slots) = self.bundle_slots.lock() else {
            return;
        };
        let landing = slots.entry(slot).or_insert(BundleLanding {
            slot,
            ..BundleLanding::default()
        });
        landing.sanitized = landing.sanitized.saturating_add(sanitized);
        landing.executed = landing.executed.saturating_add(executed);
        while slots.len() > SLOT_WATERFALLS {
            slots.pop_first();
        }
    }

    fn remember_cost(&self, point: &DataPoint) {
        let is_leader = point
            .tags
            .iter()
            .any(|(name, value)| *name == IS_LEADER && value == "true");
        if !is_leader {
            return;
        }

        let mut slot = None;
        let mut cost = SlotCost {
            slot: 0,
            costliest_account: String::new(),
            costliest_cost: 0,
            block_cost: 0,
            accounts: 0,
            contended: 0,
            new_account_data: 0,
            in_flight: 0,
        };
        for (name, value) in &point.fields {
            match *name {
                "costliest_account" => cost.costliest_account = value.trim_matches('"').to_string(),
                "bank_slot" => slot = field_u64(value),
                "costliest_account_cost" => cost.costliest_cost = field_u64(value).unwrap_or(0),
                "block_cost" => cost.block_cost = field_u64(value).unwrap_or(0),
                "number_of_accounts" => cost.accounts = field_u64(value).unwrap_or(0),
                "number_of_contended_accounts" => cost.contended = field_u64(value).unwrap_or(0),
                "allocated_accounts_data_size" => {
                    cost.new_account_data = field_u64(value).unwrap_or(0)
                }
                "inflight_transaction_count" => cost.in_flight = field_u64(value).unwrap_or(0),
                _ => continue,
            }
        }

        let Some(slot_number) = slot else {
            return;
        };
        cost.slot = slot_number;

        let Ok(mut costs) = self.slot_costs.lock() else {
            return;
        };
        // Replaced if already held, so a repeat cannot push a real row off the end.
        if let Some(held) = costs.iter_mut().find(|held| held.slot == slot_number) {
            *held = cost;
            self.note_slot_lists_changed();
            return;
        }
        costs.push_back(cost);
        while costs.len() > SLOT_WATERFALLS {
            costs.pop_front();
        }
        self.note_slot_lists_changed();
    }

    pub fn slot_lists_revision(&self) -> u64 {
        self.slot_lists_revision.load(Ordering::Relaxed)
    }

    pub fn slot_costs(&self) -> Vec<SlotCost> {
        self.slot_costs
            .lock()
            .map(|costs| costs.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn remember_stake_in_gossip(&self, point: &DataPoint) {
        let mut seen = StakeInGossip {
            online: 0,
            offline: 0,
            total: 0,
        };
        for (name, value) in &point.fields {
            let Some(number) = field_u64(value) else {
                continue;
            };
            match *name {
                "online_stake" => seen.online = number,
                "offline_stake" => seen.offline = number,
                "total_activated_stake" => seen.total = number,
                _ => (),
            }
        }
        if seen.total == 0 {
            return;
        }
        if let Ok(mut held) = self.stake_in_gossip.lock() {
            *held = Some(seen);
        }
    }

    pub fn stake_in_gossip(&self) -> Option<StakeInGossip> {
        self.stake_in_gossip.lock().ok().and_then(|held| *held)
    }

    pub fn xdp(&self) -> Option<XdpConfig> {
        self.xdp.lock().ok().and_then(|held| held.clone())
    }

    pub fn replayed(&self, slot: Slot) -> Option<ReplaySlotTimes> {
        self.replay_slots.lock().ok()?.get(&slot).copied()
    }

    pub fn shred_fill(&self, slot: Slot) -> Option<ShredFill> {
        self.shred_fills.lock().ok()?.get(&slot).copied()
    }

    pub fn worker_time(&self, from: u64, to: u64) -> Option<WorkerSum> {
        let timings = self.worker_timings.lock().ok()?;
        let mut sum = WorkerSum::default();
        let mut workers = BTreeSet::new();
        let first = timings.partition_point(|timing| timing.at_millis < from);
        for timing in timings
            .range(first..)
            .take_while(|timing| timing.at_millis <= to)
        {
            sum.times.add(&timing.times);
            sum.longest_batch = sum.longest_batch.max(timing.longest_batch);
            workers.insert(timing.worker);
        }
        if workers.is_empty() {
            return None;
        }
        sum.workers = workers.len() as u64;
        Some(sum)
    }

    pub fn vote_time(&self, slot: Slot) -> Option<StageTimes> {
        self.vote_timings.lock().ok()?.get(&slot).copied()
    }

    pub fn bundles_landed(&self, slot: Slot) -> Option<BundleLanding> {
        self.bundle_slots.lock().ok()?.get(&slot).copied()
    }

    pub fn replay_slots(&self) -> Vec<ReplaySlotTimes> {
        self.replay_slots
            .lock()
            .map(|slots| slots.values().copied().collect())
            .unwrap_or_default()
    }

    pub fn scheduler_source(&self) -> SchedulerSource {
        if self.scheduler_is_bam.load(Ordering::Relaxed) {
            SchedulerSource::Bam
        } else {
            SchedulerSource::Scheduler
        }
    }

    pub fn slot_waterfalls(&self) -> Vec<SlotWaterfall> {
        self.slot_waterfalls
            .lock()
            .map(|slots| slots.iter().copied().collect())
            .unwrap_or_default()
    }

    pub fn counters(&self) -> TapCounters {
        let accounts = copy_of(&self.accounts);
        let program_cache = copy_of(&self.program_cache);
        let gossip = copy_of(&self.gossip);
        let (quic, quic_forwards, quic_vote) = (
            copy_of(&self.quic),
            copy_of(&self.quic_forwards),
            copy_of(&self.quic_vote),
        );
        TapCounters {
            accounts_cache_hits: self.accounts_cache_hits.load(Ordering::Relaxed),
            accounts_cache_misses: self.accounts_cache_misses.load(Ordering::Relaxed),
            accounts_cache_evicts: self.accounts_cache_evicts.load(Ordering::Relaxed),
            shreds_turbine: self.shreds_turbine.load(Ordering::Relaxed),
            shreds_repair: self.shreds_repair.load(Ordering::Relaxed),
            packets_gossip: self.packets_gossip.load(Ordering::Relaxed),
            packets_tpu_vote: self.packets_tpu_vote.load(Ordering::Relaxed),
            turbine_root: self.turbine_root.load(Ordering::Relaxed),
            turbine_layer_1: self.turbine_layer_1.load(Ordering::Relaxed),
            turbine_layer_2: self.turbine_layer_2.load(Ordering::Relaxed),
            turbine_layer_3: self.turbine_layer_3.load(Ordering::Relaxed),
            xdp_dropped: self.xdp_dropped.load(Ordering::Relaxed),
            retransmit_xdp: match self.retransmit_xdp.load(Ordering::Relaxed) {
                1 => Some(false),
                2 => Some(true),
                _ => None,
            },
            gossip_sent_bytes: self.gossip_sent_bytes.load(Ordering::Relaxed),
            gossip_sent_millis: self.gossip_sent_millis.load(Ordering::Relaxed),
            repair_sent_bytes: self.repair_sent_bytes.load(Ordering::Relaxed),
            repair_sent_millis: self.repair_sent_millis.load(Ordering::Relaxed),
            scheduler: copy_of(&self.scheduler),
            accounts: accounts.totals,
            accounts_storage_bytes: accounts.levels.storage_bytes,
            accounts_storage_alive_bytes: accounts.levels.storage_alive_bytes,
            accounts_storage_count: accounts.levels.storage_count,
            accounts_cache_bytes: accounts.levels.cache_bytes,
            accounts_cache_entries: accounts.levels.cache_entries,
            program_cache: program_cache.totals,
            program_cache_water_level: program_cache.water_level,
            quic: quic.totals,
            quic_forwards: quic_forwards.totals,
            quic_vote: quic_vote.totals,
            quic_levels: quic.levels,
            quic_forwards_levels: quic_forwards.levels,
            quic_vote_levels: quic_vote.levels,
            verify: copy_of(&self.verify),
            bundles: copy_of(&self.bundles),
            executed: copy_of(&self.executed),
            gossip: gossip.totals,
            gossip_levels: gossip.levels,
            gossip_entries: gossip.entries,
        }
    }
}

/// A set of figures one kind of metrics point adds into, under one lock.
trait AddPoint {
    fn add_point(&mut self, point: &DataPoint);
}

impl AddPoint for AccountsSet {
    fn add_point(&mut self, point: &DataPoint) {
        let (totals, levels) = (&mut self.totals, &mut self.levels);
        for (name, value) in &point.fields {
            let level = match *name {
                "total_bytes" => Some(&mut levels.storage_bytes),
                "total_alive_bytes" => Some(&mut levels.storage_alive_bytes),
                "total_count" => Some(&mut levels.storage_count),
                "read_only_accounts_cache_data_size" => Some(&mut levels.cache_bytes),
                "read_only_accounts_cache_entries" => Some(&mut levels.cache_entries),
                _ => None,
            };
            if let Some(level) = level {
                set_value(level, value);
                continue;
            }

            let counter = match *name {
                "num_loaded_from_write_cache" => &mut totals.loaded_from_write_cache,
                "num_loaded_from_read_cache" => &mut totals.loaded_from_read_cache,
                "num_loaded_from_index_storage" => &mut totals.loaded_from_storage,
                // Two spellings: 4.3 calls stored what 4.2 called flushed.
                "num_accounts_stored" | "num_accounts_flushed" => &mut totals.stored_accounts,
                "account_bytes_stored" | "account_bytes_flushed" => &mut totals.stored_bytes,
                _ => continue,
            };
            add_value(counter, value);
        }
    }
}

impl AddPoint for ProgramCacheSet {
    fn add_point(&mut self, point: &DataPoint) {
        let totals = &mut self.totals;
        for (name, value) in &point.fields {
            if *name == "water_level" {
                set_value(&mut self.water_level, value);
                continue;
            }
            let counter = match *name {
                "hits" => &mut totals.hits,
                "misses" => &mut totals.misses,
                "evictions" => &mut totals.evictions,
                "reloads" => &mut totals.reloads,
                "insertions" => &mut totals.insertions,
                "lost_insertions" => &mut totals.lost_insertions,
                "replace_entry" => &mut totals.replacements,
                "one_hit_wonders" => &mut totals.one_hit_wonders,
                "prunes_orphan" => &mut totals.prunes_orphan,
                "prunes_environment" => &mut totals.prunes_environment,
                "empty_entries" => &mut totals.empty_entries,
                _ => continue,
            };
            add_value(counter, value);
        }
    }
}

impl AddPoint for QuicSet {
    fn add_point(&mut self, point: &DataPoint) {
        let (totals, levels) = (&mut self.totals, &mut self.levels);
        for (name, value) in &point.fields {
            let set = match *name {
                // Cumulative on the wire, unlike the counters beside it: stored, not added.
                "total_incoming_connection_attempts" => Some(&mut totals.offered),
                // `peak_open_staked_connections` is reset as reported, neither a level nor a count.
                "open_connections" => Some(&mut levels.open),
                "active_streams" => Some(&mut levels.active_streams),
                _ => None,
            };
            if let Some(set) = set {
                set_value(set, value);
                continue;
            }
            let counter = match *name {
                "connection_rate_limited_across_all" => &mut totals.shed_all,
                "connection_rate_limited_per_ipaddr" => &mut totals.shed_address,
                "refused_connections_too_many_open_connections" => &mut totals.refused_full,
                "connection_setup_timeout" => &mut totals.handshake_timeout,
                "connection_setup_error" => &mut totals.handshake_error,
                "new_connections" => &mut totals.handshook,
                "connection_add_failed" => &mut totals.add_failed,
                "connection_add_failed_staked_node" => &mut totals.add_failed_staked,
                "connection_add_failed_unstaked_node" => &mut totals.add_failed_unstaked,
                "connection_add_failed_banned" => &mut totals.add_failed_banned,
                // `connection_add_failed_on_pruning` is raised on the same refusal as
                // `..._staked_node` and would count one event twice.
                "connection_added_from_staked_peer" => &mut totals.admitted_staked,
                "connection_added_from_unstaked_peer" => &mut totals.admitted_unstaked,
                "new_streams" => &mut totals.streams,
                "throttled_staked_streams" => &mut totals.throttled_staked,
                "throttled_unstaked_streams" => &mut totals.throttled_unstaked,
                "stream_read_timeouts" => &mut totals.read_timeouts,
                "stream_read_errors" => &mut totals.read_errors,
                "invalid_stream_size" => &mut totals.invalid_size,
                "packets_sent_to_consumer" => &mut totals.handed_on,
                "bytes_sent_to_consumer" => &mut totals.bytes_handed_on,
                "total_handle_chunk_to_packet_send_full_err" => &mut totals.queue_full,
                "total_handle_chunk_to_packet_send_disconnected_err" => &mut totals.disconnected,
                _ => continue,
            };
            add_value(counter, value);
        }
    }
}

impl AddPoint for BundleTotals {
    fn add_point(&mut self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                "num_bundles_received" => &mut self.received,
                "num_packets_received" => &mut self.packets,
                _ => continue,
            };
            add_value(counter, value);
        }
    }
}

impl AddPoint for VerifyTotals {
    fn add_point(&mut self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                "total_packets" => &mut self.received,
                "total_dedup" => &mut self.duplicate,
                "total_dropped_below_priority_floor" => &mut self.below_floor,
                "total_valid_packets" => &mut self.verified,
                "eviction_drops" => &mut self.evicted_batches,
                _ => continue,
            };
            add_value(counter, value);
        }
    }
}

impl AddPoint for ExecutedTotals {
    fn add_point(&mut self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                "transactions_attempted_processing_count" => &mut self.attempted,
                "cost_model_throttled_transactions_count" => &mut self.cost_throttled,
                "retryable_transaction_count" => &mut self.retryable,
                "retryable_expired_bank_count" => &mut self.expired_bank,
                "processed_transactions_count" => &mut self.processed,
                "processed_with_successful_result_count" => &mut self.succeeded,
                // And from the error point beside it. No name is shared with
                // the counts point, so both are read here.
                "too_many_account_locks" => &mut self.too_many_locks,
                "account_not_found" => &mut self.account_missing,
                "insufficient_funds" => &mut self.fee_payer_broke,
                "invalid_account_for_fee" => &mut self.fee_payer_invalid,
                "blockhash_not_found" => &mut self.blockhash_missing,
                "blockhash_too_old" => &mut self.blockhash_old,
                "already_processed" => &mut self.already_processed,
                "invalid_compute_budget" => &mut self.bad_compute_budget,
                "max_loaded_accounts_data_size_exceeded" => &mut self.account_data_too_large,
                "invalid_program_for_execution" => &mut self.program_not_executable,
                "program_execution_temporarily_restricted" => &mut self.program_restricted,
                // `max_queue_len` is a gauge, `num_messages_processed` counts batches, and
                // `total` sums errors drawn elsewhere.
                _ => continue,
            };
            add_value(counter, value);
        }
    }
}

impl AddPoint for SchedulerTotals {
    fn add_point(&mut self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                "num_received" => &mut self.received,
                "num_dropped_on_receive" => &mut self.not_held,
                "num_dropped_on_check_work_queue_full" => &mut self.check_queue_full,
                "num_dropped_on_parsing_and_sanitization" => &mut self.unparsable,
                "num_dropped_on_validate_locks" => &mut self.bad_locks,
                "num_dropped_on_receive_compute_budget" => &mut self.compute_budget,
                "num_dropped_on_receive_age" => &mut self.too_old,
                "num_dropped_on_receive_already_processed" => &mut self.already_processed,
                "num_dropped_on_receive_fee_payer" => &mut self.fee_payer,
                "num_dropped_on_filter_key" => &mut self.filtered,
                "num_dropped_on_nonce_dedup" => &mut self.nonce_conflict,
                "num_buffered" => &mut self.buffered,
                "num_dropped_on_capacity" => &mut self.queue_full,
                "num_evicted_on_nonce_dedup" => &mut self.nonce_evicted,
                "num_dropped_on_clear" => &mut self.cleared,
                "num_dropped_on_clean" => &mut self.cleaned,
                "num_scheduled" => &mut self.scheduled,
                "num_unschedulable_conflicts" => &mut self.blocked_conflicts,
                "num_unschedulable_threads" => &mut self.blocked_threads,
                "num_finished" => &mut self.finished,
                "num_retryable" => &mut self.retried,
                _ => continue,
            };
            add_value(counter, value);
        }
    }
}

impl AddPoint for GossipSet {
    fn add_point(&mut self, point: &DataPoint) {
        match point.name {
            GOSSIP_ENTRIES | GOSSIP_ENTRY_FAILS => self.add_entries(point),
            _ => self.add_stats(point),
        }
    }
}

impl GossipSet {
    /// Fields are named `<type>-push` and `<type>-pull`, with `all-` for the sum.
    fn add_entries(&mut self, point: &DataPoint) {
        let fails = point.name == GOSSIP_ENTRY_FAILS;
        let totals = &mut self.totals;
        let entries = &mut self.entries;
        for (name, value) in &point.fields {
            let Some((kind, route)) = name.rsplit_once('-') else {
                continue;
            };
            let push = match route {
                "push" => true,
                "pull" => false,
                _ => continue,
            };
            let counter = if kind == "all" {
                match (fails, push) {
                    (false, true) => &mut totals.accepted_push,
                    (false, false) => &mut totals.accepted_pull,
                    (true, true) => &mut totals.rejected_push,
                    (true, false) => &mut totals.rejected_pull,
                }
            } else {
                let Some(index) = GOSSIP_ENTRY_TYPES.iter().position(|known| *known == kind) else {
                    continue;
                };
                match (fails, push) {
                    (false, true) => &mut entries.push[index],
                    (false, false) => &mut entries.pull[index],
                    (true, _) => &mut entries.rejected[index],
                }
            };
            add_value(counter, value);
        }
    }

    fn add_stats(&mut self, point: &DataPoint) {
        if point.name == GOSSIP_STATS[0] {
            self.totals.reports = self.totals.reports.saturating_add(1);
        }
        let (totals, levels) = (&mut self.totals, &mut self.levels);
        for (name, value) in &point.fields {
            let level = match *name {
                "table_size" => Some(&mut levels.table_size),
                "num_pubkeys" => Some(&mut levels.pubkeys),
                "num_nodes" => Some(&mut levels.nodes),
                "num_nodes_staked" => Some(&mut levels.staked_nodes),
                _ => None,
            };
            if let Some(level) = level {
                set_value(level, value);
                continue;
            }
            let counter = match *name {
                "packets_received_push_messages_count" => &mut totals.received_push,
                "packets_received_pull_requests_count" => &mut totals.received_pull_requests,
                "packets_received_pull_responses_count" => &mut totals.received_pull_responses,
                "packets_received_ping_messages_count" => &mut totals.received_ping,
                "packets_received_pong_messages_count" => &mut totals.received_pong,
                "packets_received_prune_messages_count" => &mut totals.received_prune,
                "packets_sent_push_messages_count" => &mut totals.sent_push,
                "packets_sent_pull_requests_count" => &mut totals.sent_pull_requests,
                "packets_sent_pull_responses_count" => &mut totals.sent_pull_responses,
                "packets_sent_ping_messages_count" => &mut totals.sent_ping,
                "packets_sent_pong_messages_count" => &mut totals.sent_pong,
                "packets_sent_prune_messages_count" => &mut totals.sent_prune,
                "num_duplicate_push_messages" => &mut totals.duplicate_push,
                "num_redundant_pull_responses" => &mut totals.redundant_pull,
                "purge_count" => &mut totals.expired,
                "trim_crds_table_purged_values_count" => &mut totals.evicted,
                "gossip_packets_dropped_count" => &mut totals.dropped_in,
                "gossip_transmit_packets_dropped_count" => &mut totals.dropped_out,
                "gossip_pull_request_no_budget" => &mut totals.pull_no_budget,
                "pull_request_scan_budget_exhausted" => &mut totals.pull_scan_exhausted,
                "skip_push_message_shred_version" => &mut totals.other_shred_version_push,
                "skip_pull_response_shred_version" => {
                    &mut totals.other_shred_version_pull_responses
                }
                "skip_pull_shred_version" => &mut totals.other_shred_version_pull_requests,
                "pull_request_ping_pong_check_failed_count" => &mut totals.ping_check_failed,
                // Gossip's own spelling.
                "num_unverifed_gossip_addrs" => &mut totals.unverified_addresses,
                "bad_prune_destination" => &mut totals.bad_prune_destination,
                "handle_batch_push_messages_time" => &mut totals.push_us,
                "handle_batch_pull_requests_time" => &mut totals.pull_requests_us,
                "handle_batch_pull_responses_time" => &mut totals.pull_responses_us,
                "handle_batch_ping_messages_time" => &mut totals.ping_us,
                "handle_batch_pong_messages_time" => &mut totals.pong_us,
                "handle_batch_prune_messages_time" => &mut totals.prune_us,
                "verify_gossip_packets_time" => &mut totals.verify_us,
                "process_gossip_packets_time" => &mut totals.process_us,
                _ => continue,
            };
            add_value(counter, value);
        }
    }
}

/// Poisoning cannot happen, since only saturating additions run under these locks; one that did
/// would drop the point rather than panic on a validator thread.
fn add_to<T: AddPoint>(set: &Mutex<T>, point: &DataPoint) {
    if let Ok(mut set) = set.lock() {
        set.add_point(point);
    }
}

fn copy_of<T: Copy + Default>(set: &Mutex<T>) -> T {
    set.lock().map(|set| *set).unwrap_or_default()
}

fn add_field(counter: &AtomicU64, value: &str) {
    if let Some(delta) = field_u64(value) {
        counter.fetch_add(delta, Ordering::Relaxed);
    }
}

fn add_value(counter: &mut u64, value: &str) {
    if let Some(delta) = field_u64(value) {
        *counter = counter.saturating_add(delta);
    }
}

fn set_value(level: &mut u64, value: &str) {
    if let Some(latest) = field_u64(value) {
        *level = latest;
    }
}

/// The line protocol marks an integer with a trailing `i`; anything else is not a counter.
fn field_u64(value: &str) -> Option<u64> {
    value.strip_suffix('i')?.parse().ok()
}

fn field_str(value: &str) -> String {
    let inner = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(value);
    inner.replace("\\\"", "\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(name: &'static str, fields: &[(&'static str, &str)]) -> DataPoint {
        let mut point = DataPoint::new(name);
        for (field, value) in fields {
            point.fields.push((field, (*value).to_string()));
        }
        point
    }

    fn tagged_slot_point(id: &str, slot: u64, fields: &[(&'static str, &str)]) -> DataPoint {
        let mut point = slot_point(slot, fields);
        point.tags.push((SCHEDULER_ID, id.to_string()));
        point
    }

    fn point(fields: &[(&'static str, &str)]) -> DataPoint {
        named(ACCOUNTS_DB_TIMINGS, fields)
    }

    #[test]
    fn test_integer_fields_carry_the_line_protocol_suffix() {
        // What `add_field_i64` writes, which is not what a reader expects.
        assert_eq!(field_u64("42i"), Some(42));
        assert_eq!(field_u64("0i"), Some(0));
    }

    #[test]
    fn test_anything_that_is_not_an_integer_field_is_left_alone() {
        assert_eq!(field_u64("42"), None);
        assert_eq!(field_u64("1.5"), None);
        assert_eq!(field_u64("true"), None);
        assert_eq!(field_u64("\"words\"i"), None);
    }

    #[test]
    fn test_the_totals_accumulate_across_points() {
        // Each point carries what happened since the last, so the totals are the sum.
        let tap = MetricsTap::default();
        tap.observe(&point(&[
            ("read_only_accounts_cache_hits", "10i"),
            ("read_only_accounts_cache_misses", "2i"),
            ("read_only_accounts_cache_evicts", "1i"),
        ]));
        tap.observe(&point(&[
            ("read_only_accounts_cache_hits", "5i"),
            ("read_only_accounts_cache_misses", "1i"),
        ]));

        assert_eq!(
            tap.counters(),
            TapCounters {
                accounts_cache_hits: 15,
                accounts_cache_misses: 3,
                accounts_cache_evicts: 1,
                ..TapCounters::default()
            }
        );
    }

    #[test]
    fn test_the_retransmit_point_gives_the_xdp_drops_and_the_path() {
        let tap = MetricsTap::default();
        let mut point = named(RETRANSMIT_STAGE, &[("num_shreds_dropped_xdp_full", "12i")]);
        point.tags.push((IS_XDP, "true".to_string()));
        tap.observe(&point);
        tap.observe(&point);

        let counters = tap.counters();
        assert_eq!(counters.xdp_dropped, 24);
        assert_eq!(counters.retransmit_xdp, Some(true));
        assert_eq!(MetricsTap::default().counters().retransmit_xdp, None);
    }

    #[test]
    fn test_a_slot_stats_point_adds_each_layer_into_its_own_count() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            RETRANSMIT_SLOT_STATS,
            &[
                ("slot", "100i"),
                ("num_shreds_received_root", "3i"),
                ("num_shreds_received_1st_layer", "400i"),
                ("num_shreds_received_2nd_layer", "1100i"),
                ("num_shreds_received_3rd_layer", "0i"),
            ],
        ));
        let counters = tap.counters();
        assert_eq!(counters.turbine_root, 3);
        assert_eq!(counters.turbine_layer_1, 400);
        assert_eq!(counters.turbine_layer_2, 1100);
        assert_eq!(counters.turbine_layer_3, 0);
    }

    #[test]
    fn test_other_points_are_ignored() {
        let tap = MetricsTap::default();
        let mut other = DataPoint::new("banking_stage-loop-stats");
        other
            .fields
            .push(("read_only_accounts_cache_hits", "99i".to_string()));
        tap.observe(&other);
        assert_eq!(tap.counters(), TapCounters::default());
    }

    #[test]
    fn test_shreds_are_counted_by_the_socket_they_arrived_on() {
        let tap = MetricsTap::default();
        tap.observe(&named(SHREDS_TURBINE, &[("packets_count", "900i")]));
        tap.observe(&named(SHREDS_REPAIR, &[("packets_count", "12i")]));
        tap.observe(&named(SHREDS_TURBINE, &[("packets_count", "100i")]));

        let counters = tap.counters();
        assert_eq!(counters.shreds_turbine, 1_000);
        assert_eq!(counters.shreds_repair, 12);
    }

    #[test]
    fn test_each_socket_receiver_counts_into_its_own_port() {
        let tap = MetricsTap::default();
        tap.observe(&named(SHREDS_TURBINE, &[("packets_count", "900i")]));
        tap.observe(&named(GOSSIP_RECEIVER, &[("packets_count", "40i")]));
        tap.observe(&named(TPU_VOTE_RECEIVER, &[("packets_count", "70i")]));
        tap.observe(&named(GOSSIP_RECEIVER, &[("packets_count", "2i")]));

        let counters = tap.counters();
        assert_eq!(counters.shreds_turbine, 900);
        assert_eq!(counters.packets_gossip, 42);
        assert_eq!(counters.packets_tpu_vote, 70);
    }

    #[test]
    fn test_a_replayed_slot_can_be_asked_for_its_own_wall_time() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            REPLAY_SLOT_STATS,
            &[
                ("slot", "443895975i"),
                ("fetch_entries_time", "4300i"),
                ("confirmation_without_replay_us", "33500i"),
                ("bank_complete_time_us", "9400i"),
                ("execute_us", "231000i"),
            ],
        ));

        assert_eq!(
            tap.replayed(443_895_975).map(|times| times.serial()),
            Some(47_200)
        );
        assert!(tap.replayed(443_895_974).is_none());
    }

    #[test]
    fn test_a_replay_record_says_when_it_arrived() {
        let tap = MetricsTap::default();
        let before = timestamp();
        tap.observe(&named(
            REPLAY_SLOT_STATS,
            &[("slot", "443895975i"), ("execute_us", "231000i")],
        ));
        let observed = tap.replayed(443_895_975).unwrap().observed_millis;
        assert!(observed >= before && observed <= timestamp());
    }

    #[test]
    fn test_filled_slot_is_read_as_counts() {
        // Names from `ledger/src/slot_stats.rs`. The last index is the highest
        // shred, so the count is one more.
        let tap = MetricsTap::default();
        tap.observe(&named(
            SHRED_FULL,
            &[
                ("slot", "444422652i"),
                ("total_time_ms", "921i"),
                ("last_index", "927i"),
                ("num_repaired", "63i"),
                ("num_recovered", "12i"),
            ],
        ));

        let fill = tap.shred_fill(444_422_652).unwrap();
        assert_eq!(fill.shreds, 928);
        assert_eq!(fill.repaired, 63);
        assert_eq!(fill.full_millis, 921);
        assert!(tap.shred_fill(444_422_651).is_none());
    }

    #[test]
    fn test_a_fill_with_no_last_index_is_dropped() {
        // The blockstore writes -1 where it has not seen the last shred, which
        // is not a count and must not become one.
        let tap = MetricsTap::default();
        tap.observe(&named(
            SHRED_FULL,
            &[
                ("slot", "10i"),
                ("total_time_ms", "400i"),
                ("last_index", "-1i"),
            ],
        ));
        assert!(tap.shred_fill(10).is_none());
    }

    #[test]
    fn test_only_the_newest_filled_slots_are_kept() {
        let tap = MetricsTap::default();
        for slot in 0..SHRED_FILLS.saturating_add(10) {
            tap.observe(&named(
                SHRED_FULL,
                &[("slot", &format!("{slot}i")), ("last_index", "99i")],
            ));
        }
        assert!(tap.shred_fill(9).is_none(), "the first ten dropped");
        assert!(tap.shred_fill(10).is_some());
        assert!(
            tap.shred_fill((SHRED_FILLS as u64).saturating_add(9))
                .is_some()
        );
    }

    #[test]
    fn test_a_leader_slots_bundles_are_summed_across_the_stage_threads() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            BUNDLE_SLOT_STATS,
            &[
                ("id", "0i"),
                ("slot", "445527719i"),
                ("num_sanitized_ok", "10i"),
                ("execution_results_ok", "8i"),
            ],
        ));
        tap.observe(&named(
            BUNDLE_SLOT_STATS,
            &[
                ("id", "1i"),
                ("slot", "445527719i"),
                ("num_sanitized_ok", "7i"),
                ("execution_results_ok", "6i"),
            ],
        ));

        let landed = tap.bundles_landed(445_527_719).unwrap();
        assert_eq!((landed.sanitized, landed.executed), (17, 14));
        assert!(tap.bundles_landed(445_527_718).is_none());
    }

    #[test]
    fn test_a_bundle_point_without_a_slot_is_dropped() {
        let tap = MetricsTap::default();
        tap.observe(&named(BUNDLE_SLOT_STATS, &[("num_sanitized_ok", "3i")]));
        assert!(tap.bundle_slots.lock().unwrap().is_empty());
    }

    #[test]
    fn test_each_named_sender_keeps_its_bytes_and_its_window_apart() {
        let tap = MetricsTap::default();
        fn sent<'a>(bytes: &'a str, millis: &'a str) -> [(&'static str, &'a str); 3] {
            [
                (SENT_BYTES, bytes),
                (SENT_MILLIS, millis),
                ("streamer-send-host_count", "1000i"),
            ]
        }
        tap.observe(&named(GOSSIP_SENDER, &sent("22786715i", "5503i")));
        tap.observe(&named(REPAIR_SENDER, &sent("2138992i", "10004i")));
        tap.observe(&named(GOSSIP_SENDER, &sent("21012098i", "5383i")));

        let counters = tap.counters();
        assert_eq!(counters.gossip_sent_bytes, 43_798_813);
        assert_eq!(counters.gossip_sent_millis, 10_886);
        assert_eq!(counters.repair_sent_bytes, 2_138_992);
        assert_eq!(counters.repair_sent_millis, 10_004);
    }

    fn scheduler(fields: &[(&'static str, &str)]) -> DataPoint {
        named(SCHEDULER_COUNTS, fields)
    }

    #[test]
    fn test_the_waterfall_counters_land_where_they_belong() {
        // Several of these names differ only in their tail; a transposed pair would
        // put the wrong reason under a label.
        let tap = MetricsTap::default();
        tap.observe(&scheduler(&[
            ("num_received", "1000i"),
            ("num_dropped_on_receive", "900i"),
            ("num_dropped_on_check_work_queue_full", "1i"),
            ("num_dropped_on_parsing_and_sanitization", "2i"),
            ("num_dropped_on_validate_locks", "3i"),
            ("num_dropped_on_receive_compute_budget", "4i"),
            ("num_dropped_on_receive_age", "5i"),
            ("num_dropped_on_receive_already_processed", "6i"),
            ("num_dropped_on_receive_fee_payer", "7i"),
            ("num_dropped_on_filter_key", "8i"),
            ("num_dropped_on_nonce_dedup", "9i"),
            ("num_buffered", "55i"),
            ("num_dropped_on_capacity", "10i"),
            ("num_evicted_on_nonce_dedup", "11i"),
            ("num_dropped_on_clear", "12i"),
            ("num_dropped_on_clean", "13i"),
            ("num_scheduled", "40i"),
            ("num_unschedulable_conflicts", "14i"),
            ("num_unschedulable_threads", "15i"),
            ("num_finished", "38i"),
            ("num_retryable", "16i"),
        ]));

        let counters = tap.counters().scheduler;
        assert_eq!(counters.received, 1_000);
        assert_eq!(counters.not_held, 900);
        assert_eq!(counters.check_queue_full, 1);
        assert_eq!(counters.unparsable, 2);
        assert_eq!(counters.bad_locks, 3);
        assert_eq!(counters.compute_budget, 4);
        assert_eq!(counters.too_old, 5);
        assert_eq!(counters.already_processed, 6);
        assert_eq!(counters.fee_payer, 7);
        assert_eq!(counters.filtered, 8);
        assert_eq!(counters.nonce_conflict, 9);
        assert_eq!(counters.buffered, 55);
        assert_eq!(counters.queue_full, 10);
        assert_eq!(counters.nonce_evicted, 11);
        assert_eq!(counters.cleared, 12);
        assert_eq!(counters.cleaned, 13);
        assert_eq!(counters.scheduled, 40);
        assert_eq!(counters.blocked_conflicts, 14);
        assert_eq!(counters.blocked_threads, 15);
        assert_eq!(counters.finished, 38);
        assert_eq!(counters.retried, 16);
    }

    #[test]
    fn test_the_receive_stretch_of_that_point_balances() {
        // The identity the validator's own tests assert: everything received either
        // got in or has a reason it did not.
        let counters = MetricsTap::default();
        counters.observe(&scheduler(&[
            ("num_received", "1000i"),
            ("num_dropped_on_receive", "900i"),
            ("num_dropped_on_check_work_queue_full", "1i"),
            ("num_dropped_on_parsing_and_sanitization", "2i"),
            ("num_dropped_on_validate_locks", "3i"),
            ("num_dropped_on_receive_compute_budget", "4i"),
            ("num_dropped_on_receive_age", "5i"),
            ("num_dropped_on_receive_already_processed", "6i"),
            ("num_dropped_on_receive_fee_payer", "7i"),
            ("num_dropped_on_filter_key", "8i"),
            ("num_dropped_on_nonce_dedup", "9i"),
            ("num_buffered", "55i"),
        ]));

        let totals = counters.counters().scheduler;
        let accounted = [
            totals.not_held,
            totals.check_queue_full,
            totals.unparsable,
            totals.bad_locks,
            totals.compute_budget,
            totals.too_old,
            totals.already_processed,
            totals.fee_payer,
            totals.filtered,
            totals.nonce_conflict,
            totals.buffered,
        ]
        .into_iter()
        .fold(0u64, u64::saturating_add);
        assert_eq!(accounted, totals.received);
    }

    #[test]
    fn test_a_window_of_readings_differences_and_sums() {
        let first = SchedulerTotals {
            received: 100,
            buffered: 10,
            ..SchedulerTotals::default()
        };
        let second = SchedulerTotals {
            received: 250,
            buffered: 25,
            ..SchedulerTotals::default()
        };

        let step = second.since(&first);
        assert_eq!(step.received, 150);
        assert_eq!(step.buffered, 15);

        assert_eq!(step.plus(&step).received, 300);
        // Backwards, which only happens if a counter was reset under us.
        assert_eq!(first.since(&second).received, 0);
    }

    fn slot_point(slot: u64, fields: &[(&'static str, &str)]) -> DataPoint {
        let slot = format!("{slot}i");
        let mut all = vec![("slot", slot.as_str())];
        all.extend_from_slice(fields);
        named(SCHEDULER_SLOT_COUNTS, &all)
    }

    fn worker_point(id: &str, fields: &[(&'static str, &str)]) -> DataPoint {
        let mut point = named(WORKER_TIMING, fields);
        point.tags.push((WORKER_ID, id.to_string()));
        point
    }

    #[test]
    fn test_worker_reports_are_summed_inside_the_window_only() {
        let tap = MetricsTap::default();
        let fields = [
            ("load_execute_us", "100i"),
            ("load_execute_us_max", "40i"),
            ("record_us", "10i"),
            ("commit_us", "5i"),
        ];
        tap.remember_worker_timing(&worker_point("0", &fields), 999);
        tap.remember_worker_timing(&worker_point("0", &fields), 1_000);
        tap.remember_worker_timing(&worker_point("1", &[("load_execute_us_max", "70i")]), 1_300);
        tap.remember_worker_timing(&worker_point("0", &fields), 1_401);
        let sum = tap.worker_time(1_000, 1_400).unwrap();
        assert_eq!(sum.workers, 2);
        assert_eq!(sum.times.load_execute, 100);
        assert_eq!(sum.times.record, 10);
        assert_eq!(sum.times.commit, 5);
        assert_eq!(sum.longest_batch, 70);
        assert_eq!(
            tap.worker_time(2_000, 3_000),
            None,
            "no report in the window"
        );
    }

    #[test]
    fn test_the_vote_worker_report_is_kept_by_slot() {
        let tap = MetricsTap::default();
        let mut point = named(
            VOTE_SLOT_TIMING,
            &[("load_execute_us", "9100i"), ("record_us", "3900i")],
        );
        point.fields.push(("slot", "77i".to_string()));
        tap.observe_point(&point);
        let times = tap.vote_time(77).unwrap();
        assert_eq!(times.load_execute, 9_100);
        assert_eq!(times.record, 3_900);
        assert_eq!(
            times.cost_model, 0,
            "the vote worker has no cost model field"
        );
        assert_eq!(tap.vote_time(78), None);
    }

    fn cost_point(is_leader: bool, fields: &[(&'static str, &str)]) -> DataPoint {
        let mut point = named(COST_TRACKER, fields);
        point.tags.push((IS_LEADER, is_leader.to_string()));
        point
    }

    #[test]
    fn test_the_slot_lists_revision_moves_only_when_a_list_does() {
        let tap = MetricsTap::default();
        let start = tap.slot_lists_revision();
        tap.observe(&slot_point(430_789_128, &[("num_received", "500i")]));
        let after_waterfall = tap.slot_lists_revision();
        assert_ne!(after_waterfall, start);
        tap.observe(&slot_point(430_789_128, &[("num_received", "5i")]));
        assert_eq!(tap.slot_lists_revision(), after_waterfall);
        tap.observe(&cost_point(true, &[("bank_slot", "430789128i")]));
        assert_ne!(tap.slot_lists_revision(), after_waterfall);
    }

    #[test]
    fn test_a_block_this_validator_produced_is_kept() {
        let tap = MetricsTap::default();
        tap.observe(&cost_point(
            true,
            &[
                ("bank_slot", "441034909i"),
                ("block_cost", "42574937i"),
                (
                    "costliest_account",
                    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                ),
                ("costliest_account_cost", "11842006i"),
                ("number_of_accounts", "3847i"),
                ("number_of_contended_accounts", "412i"),
                ("allocated_accounts_data_size", "421888i"),
                ("inflight_transaction_count", "0i"),
            ],
        ));

        let held = tap.slot_costs();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].slot, 441_034_909);
        assert_eq!(
            held[0].costliest_account,
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        );
        assert_eq!(held[0].costliest_cost, 11_842_006);
        assert_eq!(held[0].contended, 412);
    }

    #[test]
    fn test_other_validators_blocks_are_dropped() {
        // This point arrives for every slot replayed; only the blocks we built are
        // kept.
        let tap = MetricsTap::default();
        tap.observe(&cost_point(
            false,
            &[("bank_slot", "441034910i"), ("block_cost", "1i")],
        ));
        assert!(tap.slot_costs().is_empty());
    }

    #[test]
    fn test_a_cost_point_with_no_slot_is_dropped() {
        let tap = MetricsTap::default();
        tap.observe(&cost_point(true, &[("block_cost", "42574937i")]));
        assert!(tap.slot_costs().is_empty());
    }

    #[test]
    fn test_the_leader_tag_is_read_as_a_tag_not_a_field() {
        let tap = MetricsTap::default();
        let mut point = named(COST_TRACKER, &[("bank_slot", "441034909i")]);
        point.fields.push((IS_LEADER, "true".to_string()));
        tap.observe(&point);
        assert!(
            tap.slot_costs().is_empty(),
            "the validator does not send it as a field"
        );
    }

    fn replay_point(fields: &[(&'static str, &str)]) -> DataPoint {
        named(REPLAY_SLOT_STATS, fields)
    }

    #[test]
    fn test_votor_timelines_are_kept_by_slot_until_taken() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            VOTE_TRACKING,
            &[
                ("slot", "6726788i"),
                ("first_shred", "1200i"),
                ("vote_notarize", "413200i"),
            ],
        ));
        tap.observe(&named(
            VOTE_TRACKING,
            &[
                ("slot", "6726789i"),
                ("parent_ready", "90i"),
                ("vote_notarize", "150i"),
            ],
        ));
        tap.observe(&named(VOTE_TRACKING, &[("first_shred", "5i")]));

        let tracks = tap.take_vote_tracks();
        assert_eq!(tracks.len(), 2, "the point without a slot is dropped");
        assert_eq!(
            tracks[0],
            (
                6_726_788,
                VoteSent {
                    first_shred_us: Some(1_200),
                    parent_ready_us: None,
                    notarize_us: Some(413_200),
                    skip_us: None,
                }
            )
        );
        assert_eq!(tracks[1].1.parent_ready_us, Some(90));
        assert!(tap.take_vote_tracks().is_empty(), "taken once");
    }

    #[test]
    fn test_a_replayed_slot_is_read_field_by_field() {
        let tap = MetricsTap::default();
        tap.observe(&replay_point(&[
            ("fetch_entries_time", "2034i"),
            ("confirmation_without_replay_us", "17288i"),
            ("bank_complete_time_us", "443i"),
            ("entry_poh_verification_time", "28601i"),
            ("entry_transaction_verification_time", "13644i"),
            ("task_submission_us", "9828i"),
            ("execute_us", "176771i"),
            ("load_us", "26210i"),
            ("store_us", "10150i"),
            ("program_cache_us", "22954i"),
            ("total_transactions", "1232i"),
        ]));

        let held = tap.replay_slots();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].confirming, 17_288);
        assert_eq!(held[0].execute, 176_771);
        assert_eq!(held[0].transactions, 1_232);
        assert_eq!(held[0].serial(), 2_034 + 17_288 + 443);
        assert_eq!(held[0].cpu(), 176_771 + 26_210 + 10_150 + 22_954);
    }

    #[test]
    fn test_an_alpenglow_slot_reports_the_same_timings_under_its_other_names() {
        let tap = MetricsTap::default();
        tap.observe(&replay_point(&[
            ("fetch_entries_time", "2034i"),
            ("confirmation_time_us", "17288i"),
            ("bank_complete_time_us", "443i"),
            ("replay_time", "9828i"),
            ("execute_batches_us", "50000i"),
        ]));
        let held = tap.replay_slots();
        assert_eq!(held[0].confirming, 17_288);
        assert_eq!(held[0].dispatch, 9_828);
        assert_eq!(held[0].serial(), 2_034 + 17_288 + 443);
        assert_eq!(held[0].cpu(), 0, "the batch wall clock is not thread time");
    }

    #[test]
    fn test_the_status_field_carries_no_micros_suffix() {
        // Every figure around it ends `_us` and this one does not.
        let tap = MetricsTap::default();
        tap.observe(&replay_point(&[("update_transaction_statuses", "1212i")]));
        assert_eq!(tap.replay_slots()[0].other, 1_212);
    }

    #[test]
    fn test_the_costs_of_a_program_cache_miss_are_summed() {
        let tap = MetricsTap::default();
        tap.observe(&replay_point(&[
            ("execute_details_create_executor_load_elf_us", "12506i"),
            ("execute_details_create_executor_verify_code_us", "1701i"),
            ("execute_details_create_executor_jit_compile_us", "7486i"),
        ]));
        assert_eq!(tap.replay_slots()[0].compiling, 12_506 + 1_701 + 7_486);
    }

    #[test]
    fn test_a_point_naming_nothing_this_reads_is_dropped() {
        // A point this does not understand would drag every mean down.
        let tap = MetricsTap::default();
        tap.observe(&replay_point(&[("some_field_from_a_later_release", "9i")]));
        assert!(tap.replay_slots().is_empty());
    }

    #[test]
    fn test_only_the_newest_replayed_slots_are_kept() {
        let tap = MetricsTap::default();
        for slot in 0..REPLAY_SLOTS.saturating_add(10) {
            tap.observe(&replay_point(&[
                ("slot", &format!("{slot}i")),
                ("execute_us", &format!("{slot}i")),
            ]));
        }

        let held = tap.replay_slots();
        assert_eq!(held.len(), REPLAY_SLOTS);
        assert_eq!(held[0].execute, 10, "lowest first, the first ten dropped");
    }

    #[test]
    fn test_a_leader_slot_is_kept_whole_rather_than_accumulated() {
        let tap = MetricsTap::default();
        tap.observe(&slot_point(
            430_789_128,
            &[("num_received", "500i"), ("num_buffered", "80i")],
        ));
        tap.observe(&slot_point(
            430_789_129,
            &[("num_received", "600i"), ("num_buffered", "90i")],
        ));

        let held = tap.slot_waterfalls();
        assert_eq!(held.len(), 2);
        assert_eq!(held[0].slot, 430_789_128);
        assert_eq!(held[0].counts.received, 500);
        assert_eq!(held[1].counts.buffered, 90);
        assert_eq!(tap.counters().scheduler.received, 0);
    }

    #[test]
    fn test_slot_is_read_as_an_integer_field() {
        // `add_field_i64` writes "430789128i"; a change upstream fails here rather than emptying
        // the panel.
        let tap = MetricsTap::default();
        let mut bare = DataPoint::new(SCHEDULER_SLOT_COUNTS);
        bare.fields.push(("slot", "430789128".to_string()));
        bare.fields.push(("num_received", "500i".to_string()));
        tap.observe(&bare);
        assert!(tap.slot_waterfalls().is_empty());

        tap.observe(&slot_point(430_789_128, &[("num_received", "500i")]));
        assert_eq!(tap.slot_waterfalls().len(), 1);
    }

    #[test]
    fn test_a_waterfall_with_no_slot_is_dropped() {
        let tap = MetricsTap::default();
        tap.observe(&named(SCHEDULER_SLOT_COUNTS, &[("num_received", "500i")]));
        assert!(tap.slot_waterfalls().is_empty());
    }

    #[test]
    fn test_a_slot_reported_twice_keeps_one_row() {
        // Appending would leave two rows for one slot.
        let tap = MetricsTap::default();
        tap.observe(&slot_point(100, &[("num_scheduled", "5i")]));
        tap.observe(&slot_point(100, &[("num_scheduled", "9i")]));

        let held = tap.slot_waterfalls();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].counts.scheduled, 9);
    }

    #[test]
    fn test_idle_scheduler_does_not_empty_a_slot() {
        // Two schedulers report every leader slot; keeping the last to arrive emptied the panel on
        // half of them.
        for order in [["10000", "0"], ["0", "10000"]] {
            let tap = MetricsTap::default();
            for id in order {
                let fields: &[(&'static str, &str)] = if id == "10000" {
                    &[
                        ("num_received", "40i"),
                        ("num_buffered", "700i"),
                        ("num_scheduled", "738i"),
                        ("num_finished", "735i"),
                    ]
                } else {
                    &[("num_received", "710i"), ("num_buffered", "717i")]
                };
                tap.observe(&tagged_slot_point(id, 100, fields));
            }

            let held = tap.slot_waterfalls();
            assert_eq!(held.len(), 1, "one row per slot, whatever the order");
            assert_eq!(held[0].counts.finished, 735, "arrival order {order:?}");
            assert_eq!(held[0].source, SchedulerSource::Bam);
        }
    }

    #[test]
    fn test_the_interval_counts_say_which_scheduler_sent_them() {
        let tap = MetricsTap::default();
        assert_eq!(
            tap.scheduler_source(),
            SchedulerSource::Scheduler,
            "a validator running one scheduler, before any point arrives"
        );

        let mut bam = named(SCHEDULER_COUNTS, &[("num_received", "5i")]);
        bam.tags.push((SCHEDULER_ID, "10000".to_string()));
        tap.observe(&bam);
        assert_eq!(tap.scheduler_source(), SchedulerSource::Bam);

        let mut own = named(SCHEDULER_COUNTS, &[("num_received", "5i")]);
        own.tags.push((SCHEDULER_ID, "0".to_string()));
        tap.observe(&own);
        assert_eq!(tap.scheduler_source(), SchedulerSource::Scheduler);

        tap.observe(&named(SCHEDULER_COUNTS, &[("num_received", "5i")]));
        assert_eq!(tap.scheduler_source(), SchedulerSource::Scheduler);
    }

    #[test]
    fn test_the_scheduler_that_built_the_slot_is_named() {
        let tap = MetricsTap::default();
        tap.observe(&tagged_slot_point("0", 1, &[("num_scheduled", "5i")]));
        tap.observe(&tagged_slot_point("10000", 2, &[("num_scheduled", "5i")]));
        tap.observe(&slot_point(3, &[("num_scheduled", "5i")]));

        let held = tap.slot_waterfalls();
        let sources: Vec<SchedulerSource> = held.iter().map(|slot| slot.source).collect();
        assert_eq!(
            sources,
            [
                SchedulerSource::Scheduler,
                SchedulerSource::Bam,
                SchedulerSource::Scheduler
            ]
        );
    }

    #[test]
    fn test_an_empty_leader_slot_keeps_the_report_that_saw_the_most() {
        let tap = MetricsTap::default();
        tap.observe(&tagged_slot_point("10000", 100, &[("num_received", "2i")]));
        tap.observe(&tagged_slot_point("0", 100, &[("num_buffered", "31i")]));

        let held = tap.slot_waterfalls();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].counts.buffered, 31);
        assert_eq!(held[0].source, SchedulerSource::Scheduler);
    }

    #[test]
    fn test_only_the_newest_leader_slots_are_kept() {
        let tap = MetricsTap::default();
        for slot in 0..u64::try_from(SLOT_WATERFALLS).unwrap().saturating_add(10) {
            tap.observe(&slot_point(slot, &[("num_received", "1i")]));
        }

        let held = tap.slot_waterfalls();
        assert_eq!(held.len(), SLOT_WATERFALLS);
        assert_eq!(held[0].slot, 10);
    }

    #[test]
    fn test_the_flush_point_is_read_under_either_spelling() {
        // The field was renamed between validator versions and this crate is carried
        // across both.
        for (accounts, bytes) in [
            ("num_accounts_stored", "account_bytes_stored"),
            ("num_accounts_flushed", "account_bytes_flushed"),
        ] {
            let tap = MetricsTap::default();
            tap.observe(&named(
                ACCOUNTS_FLUSH,
                &[(accounts, "500i"), (bytes, "64000i")],
            ));

            let read = tap.counters().accounts;
            assert_eq!(read.stored_accounts, 500, "{accounts}");
            assert_eq!(read.stored_bytes, 64_000, "{bytes}");
        }
    }

    const QUIC_POINT: &[(&str, &str)] = &[
        ("total_incoming_connection_attempts", "18420i"),
        ("connection_rate_limited_across_all", "2140i"),
        ("connection_rate_limited_per_ipaddr", "6880i"),
        ("refused_connections_too_many_open_connections", "412i"),
        ("connection_setup_timeout", "1205i"),
        ("connection_setup_error", "338i"),
        ("new_connections", "7445i"),
        ("connection_add_failed", "7i"),
        ("connection_added_from_staked_peer", "1890i"),
        ("connection_added_from_unstaked_peer", "5548i"),
        ("new_streams", "42880i"),
        ("throttled_staked_streams", "0i"),
        ("throttled_unstaked_streams", "3412i"),
        ("stream_read_timeouts", "288i"),
        ("stream_read_errors", "41i"),
        ("invalid_stream_size", "12i"),
        ("packets_sent_to_consumer", "900i"),
        ("bytes_sent_to_consumer", "64000i"),
        ("total_handle_chunk_to_packet_send_full_err", "8i"),
        ("total_handle_chunk_to_packet_send_disconnected_err", "1i"),
        ("open_connections", "1284i"),
        ("active_streams", "46i"),
    ];

    #[test]
    fn test_the_quic_fields_are_the_ones_the_point_carries() {
        // A name from the struct rather than the wire reads nought for ever.
        let tap = MetricsTap::default();
        tap.observe(&named(QUIC_TPU, QUIC_POINT));

        let read = tap.counters();
        let quic = read.quic;
        assert_eq!(quic.offered, 18_420);
        assert_eq!(quic.shed_all, 2_140);
        assert_eq!(quic.shed_address, 6_880);
        assert_eq!(quic.refused_full, 412);
        assert_eq!(quic.handshake_timeout, 1_205);
        assert_eq!(quic.handshake_error, 338);
        assert_eq!(quic.add_failed, 7);
        assert_eq!(quic.admitted_staked, 1_890);
        assert_eq!(quic.admitted_unstaked, 5_548);
        assert_eq!(quic.streams, 42_880);
        assert_eq!(quic.throttled_staked, 0);
        assert_eq!(quic.throttled_unstaked, 3_412);
        assert_eq!(quic.read_timeouts, 288);
        assert_eq!(quic.read_errors, 41);
        assert_eq!(quic.invalid_size, 12);
        assert_eq!(quic.handed_on, 900);
        assert_eq!(quic.bytes_handed_on, 64_000);
        assert_eq!(quic.queue_full, 8);
        assert_eq!(quic.disconnected, 1);
        assert_eq!(read.quic_levels.open, 1_284);
        assert_eq!(read.quic_levels.active_streams, 46);
    }

    #[test]
    fn test_the_shed_connections_account_for_the_offer() {
        // Every attempt is shed at one gate, fails the handshake, or is admitted.
        // This sample avoids the two uncounted drops.
        let tap = MetricsTap::default();
        tap.observe(&named(QUIC_TPU, QUIC_POINT));

        let quic = tap.counters().quic;
        let accounted = [
            quic.shed_all,
            quic.shed_address,
            quic.refused_full,
            quic.handshake_timeout,
            quic.handshake_error,
            quic.add_failed,
            quic.admitted_staked,
            quic.admitted_unstaked,
        ]
        .into_iter()
        .fold(0u64, u64::saturating_add);
        assert_eq!(accounted, quic.offered);
    }

    #[test]
    fn test_the_handshake_checkpoint_is_read() {
        let tap = MetricsTap::default();
        tap.observe(&named(QUIC_TPU, QUIC_POINT));

        let quic = tap.counters().quic;
        assert_eq!(quic.handshook, 7_445);
        let after = [
            quic.add_failed,
            quic.admitted_staked,
            quic.admitted_unstaked,
        ]
        .into_iter()
        .fold(0u64, u64::saturating_add);
        assert_eq!(after, quic.handshook);
    }

    #[test]
    fn test_the_refusal_counters_are_kept_apart_rather_than_summed() {
        // Four overlapping names for one refusal. The tap reads them apart; the panel
        // takes the larger rather than the sum.
        let tap = MetricsTap::default();
        tap.observe(&named(
            QUIC_TPU,
            &[
                ("connection_add_failed", "40i"),
                ("connection_add_failed_staked_node", "3i"),
                ("connection_add_failed_unstaked_node", "40i"),
                ("connection_add_failed_banned", "2i"),
            ],
        ));

        let quic = tap.counters().quic;
        assert_eq!(quic.add_failed, 40);
        assert_eq!(quic.add_failed_staked, 3);
        assert_eq!(quic.add_failed_unstaked, 40);
        assert_eq!(quic.add_failed_banned, 2);
    }

    #[test]
    fn test_the_pruning_alias_is_left_out_of_the_refusals() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            QUIC_TPU,
            &[
                ("connection_add_failed_on_pruning", "9i"),
                ("connection_add_failed_staked_node", "9i"),
            ],
        ));

        let quic = tap.counters().quic;
        assert_eq!(quic.add_failed_staked, 9);
        assert_eq!(quic.add_failed, 0);
        assert_eq!(quic.add_failed_unstaked, 0);
        assert_eq!(quic.add_failed_banned, 0);
    }

    #[test]
    fn test_the_cumulative_offer_is_stored_rather_than_added() {
        // Every counter is reported with `swap` except the offer, which arrives cumulative.
        let tap = MetricsTap::default();
        tap.observe(&named(
            QUIC_TPU,
            &[
                ("total_incoming_connection_attempts", "1000i"),
                ("new_streams", "10i"),
            ],
        ));
        tap.observe(&named(
            QUIC_TPU,
            &[
                ("total_incoming_connection_attempts", "1600i"),
                ("new_streams", "10i"),
            ],
        ));

        let quic = tap.counters().quic;
        assert_eq!(quic.offered, 1_600);
        assert_eq!(quic.streams, 20);
    }

    #[test]
    fn test_the_levels_are_the_latest_reading_rather_than_a_sum() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            QUIC_TPU,
            &[("open_connections", "900i"), ("active_streams", "12i")],
        ));
        tap.observe(&named(
            QUIC_TPU,
            &[("open_connections", "870i"), ("active_streams", "9i")],
        ));

        let levels = tap.counters().quic_levels;
        assert_eq!(levels.open, 870);
        assert_eq!(levels.active_streams, 9);
    }

    #[test]
    fn test_each_quic_port_counts_into_its_own_set() {
        // Three listeners share field names under three point names; summed, the busiest hides the
        // others.
        let tap = MetricsTap::default();
        tap.observe(&named(QUIC_TPU, &[("new_streams", "900i")]));
        tap.observe(&named(QUIC_TPU_FORWARDS, &[("new_streams", "40i")]));
        tap.observe(&named(QUIC_TPU_VOTE, &[("new_streams", "70i")]));

        let read = tap.counters();
        assert_eq!(read.quic.streams, 900);
        assert_eq!(read.quic_forwards.streams, 40);
        assert_eq!(read.quic_vote.streams, 70);
    }

    #[test]
    fn test_the_accounts_points_add_into_one_set_of_figures() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            ACCOUNTS_LOADS,
            &[
                ("num_loaded_from_write_cache", "10i"),
                ("num_loaded_from_read_cache", "900i"),
                ("num_loaded_from_index_storage", "40i"),
            ],
        ));
        tap.observe(&named(
            ACCOUNTS_FLUSH,
            &[
                ("num_accounts_stored", "500i"),
                ("account_bytes_stored", "64000i"),
            ],
        ));
        tap.observe(&named(
            ACCOUNTS_STORES,
            &[
                ("total_bytes", "137400000000i"),
                ("total_alive_bytes", "27700000000i"),
                ("total_count", "812i"),
            ],
        ));

        let counters = tap.counters();
        assert_eq!(counters.accounts.loaded_from_storage, 40);
        assert_eq!(counters.accounts.stored_bytes, 64_000);
        assert_eq!(counters.accounts_storage_alive_bytes, 27_700_000_000);
        assert_eq!(counters.accounts_storage_count, 812);
    }

    #[test]
    fn test_the_storage_levels_are_replaced_rather_than_summed() {
        // A level, not a count: summed, a steady hundred gigabytes would read as
        // terabytes within a minute.
        let tap = MetricsTap::default();
        tap.observe(&named(ACCOUNTS_STORES, &[("total_bytes", "100i")]));
        tap.observe(&named(ACCOUNTS_STORES, &[("total_bytes", "104i")]));
        assert_eq!(tap.counters().accounts_storage_bytes, 104);
    }

    #[test]
    fn test_a_level_is_replaced_rather_than_accumulated() {
        let tap = MetricsTap::default();
        tap.observe(&named(PROGRAM_CACHE, &[("water_level", "400i")]));
        tap.observe(&named(PROGRAM_CACHE, &[("water_level", "412i")]));
        assert_eq!(tap.counters().program_cache_water_level, 412);
    }

    #[test]
    fn test_replace_entry_lands_on_replacements() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            PROGRAM_CACHE,
            &[("replace_entry", "3i"), ("hits", "90i"), ("misses", "10i")],
        ));

        let cache = tap.counters().program_cache;
        assert_eq!(cache.replacements, 3);
        assert_eq!(cache.hits, 90);
        assert_eq!(cache.misses, 10);
    }

    #[test]
    fn test_the_verify_stage_accounts_for_every_packet_it_was_given() {
        // No counter exists for a failed signature; it is what is left once duplicates, underpaying
        // and verified are taken off.
        let tap = MetricsTap::default();
        tap.observe(&named(
            TPU_VERIFIER,
            &[
                ("total_packets", "1000i"),
                ("total_dedup", "300i"),
                ("total_dropped_below_priority_floor", "50i"),
                ("total_valid_packets", "620i"),
                ("total_verify_time_us", "4200i"),
            ],
        ));

        let verify = tap.counters().verify;
        assert_eq!(verify.received, 1_000);
        let accounted = verify
            .duplicate
            .saturating_add(verify.below_floor)
            .saturating_add(verify.verified);
        assert_eq!(verify.received.saturating_sub(accounted), 30);
    }

    #[test]
    fn test_the_bundle_stage_adds_into_one_set() {
        let tap = MetricsTap::default();
        for _ in 0..2 {
            tap.observe(&named(
                BUNDLE_STAGE,
                &[
                    ("num_bundles_received", "3i"),
                    ("num_packets_received", "11i"),
                ],
            ));
        }
        assert_eq!(
            tap.counters().bundles,
            BundleTotals {
                received: 6,
                packets: 22,
            }
        );
    }

    #[test]
    fn test_every_worker_adds_into_the_same_execution_totals() {
        let tap = MetricsTap::default();
        for _ in 0..4 {
            tap.observe(&named(
                WORKER_COUNTS,
                &[
                    ("transactions_attempted_processing_count", "100i"),
                    ("processed_transactions_count", "90i"),
                    ("processed_with_successful_result_count", "80i"),
                ],
            ));
        }

        let executed = tap.counters().executed;
        assert_eq!(executed.attempted, 400);
        assert_eq!(executed.processed, 360);
        assert_eq!(executed.succeeded, 320);
    }

    #[test]
    fn test_worker_error_reasons_join_its_counts() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            WORKER_COUNTS,
            &[
                ("transactions_attempted_processing_count", "101i"),
                ("retryable_transaction_count", "13i"),
                ("processed_transactions_count", "63i"),
                ("processed_with_successful_result_count", "63i"),
            ],
        ));
        tap.observe(&named(
            WORKER_ERROR_METRICS,
            &[
                ("blockhash_not_found", "12i"),
                ("insufficient_funds", "8i"),
                ("already_processed", "4i"),
                // Counted, but drawn as a retry rather than as a loss, so it
                // must not land in one of the reasons above.
                ("account_in_use", "13i"),
                // The sum of every error, including those drawn elsewhere.
                ("total", "37i"),
            ],
        ));

        let executed = tap.counters().executed;
        assert_eq!(executed.attempted, 101);
        assert_eq!(executed.retryable, 13);
        assert_eq!(executed.processed, 63);
        assert_eq!(executed.blockhash_missing, 12);
        assert_eq!(executed.fee_payer_broke, 8);
        assert_eq!(executed.already_processed, 4);
        assert_eq!(
            executed.attempted.saturating_sub(executed.processed),
            38,
            "nothing from the error point was added to the outcomes"
        );
    }

    #[test]
    fn test_the_vote_verifier_is_not_counted_with_the_rest() {
        // Votes never reach the scheduler, so counting them at the top would inflate a
        // total the stages below cannot account for.
        let tap = MetricsTap::default();
        tap.observe(&named("tpu-vote-verifier", &[("total_packets", "5000i")]));
        assert_eq!(tap.counters().verify.received, 0);
    }

    #[test]
    fn test_the_priority_gauges_are_left_out_of_the_waterfall() {
        let tap = MetricsTap::default();
        tap.observe(&scheduler(&[
            ("min_priority", "5i"),
            ("max_priority", "900000i"),
            ("num_received", "7i"),
        ]));
        assert_eq!(tap.counters().scheduler.received, 7);
    }

    #[test]
    fn test_only_the_packet_count_is_taken_from_a_receiver() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            SHREDS_TURBINE,
            &[
                ("packet_batches_count", "7i"),
                ("packets_count", "900i"),
                ("channel_len", "3i"),
            ],
        ));
        assert_eq!(tap.counters().shreds_turbine, 900);
    }

    fn xdp_point(
        zero_copy: bool,
        driver: &str,
        vendor: &str,
        model: &str,
        kernel: &str,
    ) -> DataPoint {
        let mut point = DataPoint::new(XDP_NETWORK_CONFIG);
        point.add_tag("driver", driver);
        point.add_tag("zero_copy", &zero_copy.to_string());
        point.add_field_str("kernel_version", kernel);
        point.add_field_str("vendor", vendor);
        point.add_field_str("model", model);
        point
    }

    #[test]
    fn test_xdp_config_is_read_from_tags_and_fields() {
        // A tag keeps its value; a string field arrives wrapped in quotes for the line
        // protocol.
        let tap = MetricsTap::default();
        tap.observe(&xdp_point(
            true,
            "ice",
            "Intel Corporation",
            "Ethernet Controller E810-C for QSFP",
            "6.8.0-45-generic",
        ));

        let xdp = tap.xdp().expect("a reported config is held");
        assert!(xdp.zero_copy);
        assert_eq!(xdp.driver, "ice");
        assert_eq!(xdp.vendor, "Intel Corporation");
        assert_eq!(xdp.model, "Ethernet Controller E810-C for QSFP");
        assert_eq!(xdp.kernel_version, "6.8.0-45-generic");
    }

    #[test]
    fn test_there_is_no_xdp_config_where_none_was_ever_reported() {
        let tap = MetricsTap::default();
        tap.observe(&named(SHREDS_TURBINE, &[("packets_count", "1i")]));
        assert!(tap.xdp().is_none());
    }

    #[test]
    fn test_missing_zero_copy_tag_reads_as_copy() {
        let mut point = DataPoint::new(XDP_NETWORK_CONFIG);
        point.add_tag("driver", "mlx5_core");
        point.add_field_str("model", "MT2892 Family");
        let tap = MetricsTap::default();
        tap.observe(&point);

        let xdp = tap
            .xdp()
            .expect("a config with no zero_copy tag is still a config");
        assert!(!xdp.zero_copy);
        assert_eq!(xdp.driver, "mlx5_core");
        assert_eq!(xdp.kernel_version, "");
    }

    #[test]
    fn test_the_latest_xdp_report_stands() {
        // Overwriting lets a config read once the PCI database is available win over an early read.
        let tap = MetricsTap::default();
        tap.observe(&xdp_point(false, "ice", "unknown", "unknown", "6.8.0"));
        tap.observe(&xdp_point(
            false,
            "ice",
            "Intel Corporation",
            "Ethernet Controller E810-C for QSFP",
            "6.8.0",
        ));
        assert_eq!(tap.xdp().unwrap().vendor, "Intel Corporation");
    }

    #[test]
    fn test_a_string_field_keeps_a_quote_that_was_part_of_the_value() {
        // The wrapper is one pair, not every quote at either end, and a quote
        // inside the value arrives escaped.
        assert_eq!(field_str(r#""6.8.0""#), "6.8.0");
        assert_eq!(field_str(r#""a \"b\" c""#), r#"a "b" c"#);
        assert_eq!(field_str("unquoted"), "unquoted");
    }

    #[test]
    fn test_the_stake_seen_in_gossip_is_read_in_lamports() {
        let tap = MetricsTap::default();
        assert!(tap.stake_in_gossip().is_none());
        tap.observe(&named(
            WFSM_GOSSIP,
            &[
                ("online_stake", "2350000000000000i"),
                ("offline_stake", "401650000000000000i"),
                ("total_activated_stake", "404000000000000000i"),
            ],
        ));
        assert_eq!(
            tap.stake_in_gossip(),
            Some(StakeInGossip {
                online: 2_350_000_000_000_000,
                offline: 401_650_000_000_000_000,
                total: 404_000_000_000_000_000,
            })
        );
    }

    #[test]
    fn test_a_stake_point_without_a_total_is_dropped() {
        let tap = MetricsTap::default();
        tap.observe(&named(WFSM_GOSSIP, &[("online_stake", "5i")]));
        assert!(tap.stake_in_gossip().is_none());
    }

    #[test]
    fn test_the_latest_stake_count_stands() {
        let tap = MetricsTap::default();
        for online in ["1i", "2i"] {
            tap.observe(&named(
                WFSM_GOSSIP,
                &[("online_stake", online), ("total_activated_stake", "10i")],
            ));
        }
        assert_eq!(tap.stake_in_gossip().unwrap().online, 2);
    }

    #[test]
    fn test_gossip_reports_add_into_their_totals_and_levels() {
        let tap = MetricsTap::default();
        for _ in 0..2 {
            tap.observe(&named(
                "cluster_info_stats",
                &[
                    ("table_size", "231904i"),
                    ("num_pubkeys", "4112i"),
                    ("num_nodes", "4100i"),
                    ("num_nodes_staked", "1212i"),
                ],
            ));
            tap.observe(&named(
                "cluster_info_stats2",
                &[
                    ("purge_count", "352i"),
                    ("process_gossip_packets_time", "900i"),
                    ("handle_batch_push_messages_time", "600i"),
                ],
            ));
            tap.observe(&named(
                "cluster_info_stats4",
                &[
                    ("skip_push_message_shred_version", "14i"),
                    ("num_duplicate_push_messages", "8i"),
                ],
            ));
            tap.observe(&named(
                "cluster_info_stats5",
                &[
                    ("packets_received_push_messages_count", "23000i"),
                    ("packets_sent_pong_messages_count", "24i"),
                    ("num_unverifed_gossip_addrs", "3i"),
                ],
            ));
        }
        let counters = tap.counters();
        assert_eq!(
            counters.gossip_levels,
            GossipLevels {
                table_size: 231_904,
                pubkeys: 4_112,
                nodes: 4_100,
                staked_nodes: 1_212
            }
        );
        let gossip = counters.gossip;
        assert_eq!(gossip.reports, 2);
        assert_eq!(gossip.expired, 704);
        assert_eq!((gossip.process_us, gossip.push_us), (1_800, 1_200));
        assert_eq!(
            (gossip.other_shred_version_push, gossip.duplicate_push),
            (28, 16)
        );
        assert_eq!(
            (
                gossip.received_push,
                gossip.sent_pong,
                gossip.unverified_addresses
            ),
            (46_000, 48, 6)
        );
    }

    #[test]
    fn test_gossip_entries_count_by_type_and_in_total() {
        let tap = MetricsTap::default();
        tap.observe(&named(
            GOSSIP_ENTRIES,
            &[
                ("Vote-push", "3900i"),
                ("Vote-pull", "41i"),
                ("ContactInfo-push", "318i"),
                ("all-push", "4218i"),
                ("all-pull", "41i"),
            ],
        ));
        tap.observe(&named(
            GOSSIP_ENTRY_FAILS,
            &[
                ("Vote-push", "280i"),
                ("Vote-pull", "8i"),
                ("all-push", "280i"),
                ("all-pull", "8i"),
            ],
        ));
        let counters = tap.counters();
        let vote = GOSSIP_ENTRY_TYPES
            .iter()
            .position(|kind| *kind == "Vote")
            .unwrap();
        let contact = GOSSIP_ENTRY_TYPES
            .iter()
            .position(|kind| *kind == "ContactInfo")
            .unwrap();
        let entries = counters.gossip_entries;
        assert_eq!(
            (
                entries.push[vote],
                entries.pull[vote],
                entries.rejected[vote]
            ),
            (3_900, 41, 288)
        );
        assert_eq!(entries.push[contact], 318);
        let gossip = counters.gossip;
        assert_eq!(
            (
                gossip.accepted_push,
                gossip.accepted_pull,
                gossip.rejected_push,
                gossip.rejected_pull
            ),
            (4_218, 41, 280, 8)
        );
    }

    #[test]
    fn test_gossip_entry_windows_difference_and_sum() {
        let mut a = GossipEntryTotals::default();
        let mut b = GossipEntryTotals::default();
        a.push[1] = 10;
        b.push[1] = 4;
        b.rejected[3] = 9;
        assert_eq!(a.since(&b).push[1], 6);
        assert_eq!(a.since(&b).rejected[3], 0, "saturates rather than wrapping");
        assert_eq!(a.plus(&b).push[1], 14);
    }
}
