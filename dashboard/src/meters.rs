//! The once-a-second readings: throughput, host, network, sockets, caches and
//! the TPU path. On their own thread, reading the working bank without bank
//! forks' lock.

use {
    crate::{
        collect::{CATCH_UP_SLOTS_PER_SECOND, FAILED_UNREAD, system_time_nanos},
        context::{DashboardContext, StartProgress},
        host_stats::{self, CpuUse, HostSnapshot, ResidentKinds},
        metrics_tap::{
            AccountsFiles, AccountsTotals, BundleTotals, ExecutedTotals, GOSSIP_ENTRY_TYPES,
            GossipEntryTotals, GossipTotals, LedgerFiles, MemoryParts, MetricsTap,
            ProgramCacheTotals, QuicLevels, QuicTotals, ReplaySlotTimes, TapCounters, VerifyTotals,
            WindowedCounters, XdpConfig,
        },
        net_ifaces::{self, InterfaceKind, InterfaceReading},
        net_stats::{self, Counted, InterfaceCounters, NetCounters, NetReading},
        proto::{Debounced, Publisher, TOPIC_SUMMARY},
        snapshot::{self, ArchiveBytes},
        thread_stats::{self, ThreadGroup, ThreadReading},
        udp_drops::{self, PortCounters, PortWindow},
    },
    agave_snapshots::snapshot_config::SnapshotConfig,
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_core::validator::ValidatorStartProgress,
    solana_gossip::contact_info::{ContactInfo, Protocol},
    solana_ledger::blockstore_options::BLOCKSTORE_DIRECTORY_ROCKS_LEVEL,
    solana_program_runtime::loaded_programs::MAX_LOADED_ENTRY_COUNT,
    solana_runtime::{bank::Bank, bank_forks::SharableBanks},
    std::{
        collections::{BTreeMap, HashMap, HashSet, VecDeque},
        net::SocketAddr,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
        time::{Duration, Instant, SystemTime},
    },
};

pub const METER_INTERVAL: Duration = Duration::from_secs(1);

const CHART_HISTORY: usize = 300;

/// Leader slots' waterfalls and costs sent to a connecting client, as many as its blocks.
const SLOT_LISTS_SENT: usize = 500;

const THREADS_HISTORY: usize = 60;

/// The host and thread readings stop while nobody watches; one older than this spans such a gap.
const WATCH_GAP: Duration = Duration::from_secs(5);

const THREAD_ROWS: usize = 8;

/// Every thread's name is read again this often; between, names carry over from the last reading.
const THREAD_NAMES_REFRESH: Duration = Duration::from_secs(60);

const DROPS_WINDOW: Duration = Duration::from_secs(60);

const ACCOUNTS_CACHE_WINDOW: usize = 60;

const SHREDS_WINDOW: usize = 300;

const WATERFALL_WINDOW: usize = 300;

/// One sample is one slot's handful of loads, too few for a rate.
const PROGRAM_CACHE_WINDOW: usize = 60;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Shreds {
    pub received: u64,
    pub repaired: u64,
    pub repair_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Turbine {
    pub root: u64,
    pub layer_1: u64,
    pub layer_2: u64,
    pub layer_3: u64,
    pub xdp_dropped: u64,
    pub xdp: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountsCache {
    pub read: u64,
    pub hit_rate: f64,
    pub evictions: u64,
    pub cache_bytes: u64,
    pub cache_entries: u64,

    /// Only `from_storage` touches a file; counted in accounts because nothing counts bytes.
    pub from_write_cache: u64,
    pub from_read_cache: u64,
    pub from_storage: u64,

    pub stored_accounts: u64,
    pub stored_bytes: u64,
    pub window_seconds: f64,

    pub disk: Option<AccountsDisk>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountsDisk {
    pub used: u64,
    pub allocated: u64,
    pub fragmented: u64,
    pub storages: u64,
}

/// The counters reset per bank, so `looked_up` is the window's own total.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProgramCache {
    pub looked_up: u64,
    pub hits: u64,
    pub misses: u64,
    pub hit_rate: f64,
    pub evictions: u64,
    pub reloads: u64,
    pub insertions: u64,
    pub lost_insertions: u64,
    pub replacements: u64,
    pub one_hit_wonders: u64,
    pub prunes_orphan: u64,
    pub prunes_environment: u64,
    pub peak_entries: Option<u64>,
    pub entry_limit: u64,
}

/// `None` while nothing has been asked, so an idle cache does not read as failing.
fn cache_rate(window: &VecDeque<(u64, u64, u64)>) -> Option<(u64, f64, u64)> {
    let mut hits = 0u64;
    let mut misses = 0u64;
    let mut evictions = 0u64;
    for (sample_hits, sample_misses, sample_evictions) in window {
        hits = hits.saturating_add(*sample_hits);
        misses = misses.saturating_add(*sample_misses);
        evictions = evictions.saturating_add(*sample_evictions);
    }

    let asked = hits.saturating_add(misses);
    (asked > 0).then(|| (asked, hits as f64 / asked as f64, evictions))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tps {
    pub total: f64,
    pub vote: f64,
    pub non_vote_success: f64,
    pub non_vote_failed: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TpsSample {
    pub slot: Slot,
    pub timestamp_nanos: u64,
    #[serde(flatten)]
    pub tps: Tps,
}

/// In bytes per second.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Network {
    pub received_per_second: u64,
    pub sent_per_second: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NetInterface {
    pub name: String,
    pub kind: InterfaceKind,
    pub up: bool,
    pub mtu: Option<u32>,
    pub routes: u32,
    /// The most routes it carried in any hour of the last day, this one included.
    pub routes_peak: u32,
    /// The interface it is a port of (its master), such as a bond, bridge or team.
    pub member_of: Option<String>,
    /// On a tunnel, the interface holding the default route, which carries its packets.
    pub inside: Option<String>,
    /// `None` until a second reading is in, or after a counter went backwards.
    pub received_per_second: Option<u64>,
    pub sent_per_second: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Host {
    pub cores: usize,
    pub load_one: f64,
    pub load_five: f64,
    pub load_fifteen: f64,
    pub threads: u64,
    pub running: u64,
    pub cpu: Option<CpuUse>,
    pub cpu_governor: Option<String>,

    pub memory_total: u64,
    pub memory_available: u64,
    /// "Used" counts it, and sixty gigabytes of page cache is not a shortage.
    pub memory_reclaimable: u64,
    pub memory_free: u64,
    pub swap: Option<Swap>,
    pub process_resident: Option<u64>,
    pub process_resident_hour_ago: Option<u64>,
    pub process_kinds: Option<ResidentKinds>,
    pub memory_parts: MemoryParts,
    pub snapshot_device: Option<String>,

    pub filesystems: Vec<FilesystemUsage>,
    pub devices: Vec<DeviceLoad>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Swap {
    pub total: u64,
    pub used: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FilesystemUsage {
    pub name: String,
    pub path: String,
    pub total: u64,
    pub available: u64,
    pub reserved: u64,
    pub parts: Vec<DiskPart>,
    /// Directories named `*_to_be_deleted`, which only the thread that renamed them removes.
    pub leftovers: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DiskPart {
    pub key: DiskPartKey,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiskPartKey {
    Shreds,
    History,
    Metadata,
    Live,
    Fragmented,
    Full,
    Incremental,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceLoad {
    pub device: String,
    pub roles: Vec<String>,
    pub busy: f64,
    pub wait_ms: Option<f64>,
    pub operations_per_second: u64,
    pub read_per_second: u64,
    pub write_per_second: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NetworkSample {
    pub timestamp_nanos: u64,
    #[serde(flatten)]
    pub rates: Network,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ThreadsSample {
    pub timestamp_nanos: u64,
    pub threads: usize,
    pub groups: Vec<ThreadGroup>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IngestPath {
    pub name: &'static str,
    pub port: u16,
    /// Always sent, including as zero, so a healthy row differs from an unmeasured one.
    pub drops_recent: u64,
    pub drops_total: u64,
    pub queued_bytes: u64,

    /// Packets the port handed over across the same window. `None` for a port with no receiver
    /// reporting one; `Some(0)` where the validator logs below info.
    pub received_recent: Option<u64>,
    pub received_total: Option<u64>,
    /// False where the receiver counts messages, as votor counts votes, so a share of packets
    /// would be off.
    pub received_in_packets: bool,

    pub quic: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuicPort {
    pub name: &'static str,
    #[serde(flatten)]
    pub counts: QuicTotals,
    #[serde(flatten)]
    pub levels: QuicLevels,
    /// Datagrams the kernel discarded on this port over the same span. Whole datagrams, unlike the
    /// counts beside them, so never added to them.
    pub kernel_drops: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuicPaths {
    pub ports: Vec<QuicPort>,
    pub tpu_offhost: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IngestSummary {
    pub window_seconds: f64,
    pub paths: Vec<IngestPath>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct EpochSpan {
    pub epoch: Epoch,
    pub elapsed_slots: u64,
    pub counted_slots: u64,
    pub slots_in_epoch: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EpochPosition {
    epoch: Epoch,
    slot: Slot,
    start_slot: Slot,
    slots_in_epoch: u64,
}

#[derive(Debug, Clone, Copy, Default)]
struct LeaderTotals {
    epoch: Option<Epoch>,
    from_slot: Slot,
    verify: VerifyTotals,
    executed: ExecutedTotals,
    bundles: BundleTotals,
}

impl LeaderTotals {
    fn add(
        &mut self,
        at: EpochPosition,
        verify: VerifyTotals,
        executed: ExecutedTotals,
        bundles: BundleTotals,
    ) {
        if self.epoch != Some(at.epoch) {
            self.epoch = Some(at.epoch);
            self.from_slot = at.slot;
            self.verify = VerifyTotals::default();
            self.executed = ExecutedTotals::default();
            self.bundles = BundleTotals::default();
        }
        self.verify = self.verify.plus(&verify);
        self.executed = self.executed.plus(&executed);
        self.bundles = self.bundles.plus(&bundles);
    }

    /// `from_slot` is clamped to the epoch's first slot, since a bank read can land before the one
    /// that turned it.
    fn span(&self, at: EpochPosition) -> EpochSpan {
        let from_slot = self.from_slot.max(at.start_slot);
        EpochSpan {
            epoch: at.epoch,
            elapsed_slots: at
                .slot
                .saturating_sub(at.start_slot)
                .saturating_add(1)
                .min(at.slots_in_epoch),
            counted_slots: at
                .slot
                .saturating_sub(from_slot)
                .saturating_add(1)
                .min(at.slots_in_epoch),
            slots_in_epoch: at.slots_in_epoch,
        }
    }
}

/// In microseconds: means per slot, and two peaks that are the worst single slot's sums.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ReplayWindow {
    pub slots: usize,
    pub transactions: u64,

    // Replay's own thread. Disjoint spans; these add up.
    pub fetch: u64,
    pub confirming: u64,
    pub completing: u64,
    pub serial_peak: u64,

    // Verification jobs. Concurrent and each parallel inside, so these are
    // comparable to one another and to nothing else.
    pub poh_verify: u64,
    pub tx_verify: u64,
    pub dispatch: u64,

    // Thread time across the workers. These partition.
    pub execute: u64,
    pub bytecode: u64,
    pub serialising: u64,
    pub deserialising: u64,
    pub load: u64,
    pub store: u64,
    pub program_cache: u64,
    pub compiling: u64,
    pub program_cache_peak: u64,
    pub checking: u64,
    pub other: u64,
}

fn replay_window(slots: &[ReplaySlotTimes]) -> Option<ReplayWindow> {
    let count = u64::try_from(slots.len()).ok().filter(|n| *n > 0)?;
    let mean = |total: u64| total.checked_div(count).unwrap_or_default();
    let sum = |pick: fn(&ReplaySlotTimes) -> u64| {
        slots
            .iter()
            .fold(0u64, |total, slot| total.saturating_add(pick(slot)))
    };
    let peak = |pick: fn(&ReplaySlotTimes) -> u64| slots.iter().map(pick).max().unwrap_or_default();

    Some(ReplayWindow {
        slots: slots.len(),
        transactions: mean(sum(|s| s.transactions)),

        fetch: mean(sum(|s| s.fetch)),
        confirming: mean(sum(|s| s.confirming)),
        completing: mean(sum(|s| s.completing)),
        serial_peak: peak(ReplaySlotTimes::serial),

        poh_verify: mean(sum(|s| s.poh_verify)),
        tx_verify: mean(sum(|s| s.tx_verify)),
        dispatch: mean(sum(|s| s.dispatch)),

        execute: mean(sum(|s| s.execute)),
        bytecode: mean(sum(|s| s.bytecode)),
        serialising: mean(sum(|s| s.serialising)),
        deserialising: mean(sum(|s| s.deserialising)),
        load: mean(sum(|s| s.load)),
        store: mean(sum(|s| s.store)),
        program_cache: mean(sum(|s| s.program_cache)),
        compiling: mean(sum(|s| s.compiling)),
        program_cache_peak: peak(|s| s.program_cache),
        checking: mean(sum(|s| s.checking)),
        other: mean(sum(|s| s.other)),
    })
}

struct IngestPort {
    name: &'static str,
    port: u16,
    received: Option<u64>,
    received_in_packets: bool,
    quic: bool,
}

/// `errors` is the collector's running count of failed transactions along the working fork.
#[derive(Clone, Copy)]
struct TxnCounters {
    slot: Slot,
    total: u64,
    non_vote: u64,
    errors: u64,
    sampled_at: Instant,
}

impl TxnCounters {
    fn read(bank: &Bank, errors: u64) -> Self {
        Self {
            slot: bank.slot(),
            total: bank.transaction_count(),
            non_vote: bank.non_vote_transaction_count_since_restart(),
            errors,
            sampled_at: Instant::now(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct HostPath {
    name: String,
    path: PathBuf,
    device: Option<String>,
    filesystem: u64,
}

impl HostPath {
    fn new(name: String, path: PathBuf, filesystem: u64) -> Self {
        let device = host_stats::device_for(&path).ok().flatten();
        Self {
            name,
            path,
            device,
            filesystem,
        }
    }
}

/// Which filesystem each part of a row's split lives on.
#[derive(Debug, Clone, Default, PartialEq)]
struct DiskLayout {
    ledger: Option<u64>,
    /// `None` across several filesystems: the storage figures cover every accounts path.
    accounts: Option<u64>,
    /// Where a renamed accounts directory would sit.
    account_parents: Vec<(u64, PathBuf)>,
    full: Option<u64>,
    incremental: Option<u64>,
}

fn resolve_disk_layout(ctx: &DashboardContext) -> DiskLayout {
    let rocksdb = ctx
        .blockstore
        .ledger_path()
        .join(BLOCKSTORE_DIRECTORY_ROCKS_LEVEL);
    let mut account_ids = HashSet::new();
    let mut account_parents = Vec::new();
    for path in &ctx.account_paths {
        let Ok(id) = host_stats::filesystem_id(path) else {
            continue;
        };
        account_ids.insert(id);
        if let Some(parent) = path.parent().map(Path::to_path_buf)
            && !account_parents.iter().any(|(_, held)| *held == parent)
        {
            account_parents.push((id, parent));
        }
    }
    let archives = |dir: fn(&SnapshotConfig) -> &PathBuf| {
        let config = ctx.snapshot_config.as_ref()?;
        host_stats::filesystem_id(dir(config)).ok()
    };
    DiskLayout {
        ledger: host_stats::filesystem_id(&rocksdb).ok(),
        accounts: match account_ids.len() {
            1 => account_ids.into_iter().next(),
            _ => None,
        },
        account_parents,
        full: archives(|config| &config.full_snapshot_archives_dir),
        incremental: archives(|config| &config.incremental_snapshot_archives_dir),
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct DiskReadings {
    ledger: Option<LedgerFiles>,
    accounts: Option<AccountsFiles>,
    archives: Option<ArchiveBytes>,
}

/// In the order they are drawn.
fn disk_parts(filesystem: u64, layout: &DiskLayout, readings: &DiskReadings) -> Vec<DiskPart> {
    let part = |key, bytes| DiskPart { key, bytes };
    let mut parts = Vec::new();
    if layout.ledger == Some(filesystem)
        && let Some(files) = readings.ledger
    {
        parts.push(part(DiskPartKey::Shreds, files.shreds));
        parts.push(part(DiskPartKey::History, files.history));
        parts.push(part(DiskPartKey::Metadata, files.metadata));
    }
    if layout.accounts == Some(filesystem)
        && let Some(files) = readings.accounts
    {
        parts.push(part(DiskPartKey::Live, files.live));
        parts.push(part(DiskPartKey::Fragmented, files.fragmented));
    }
    if let Some(archives) = readings.archives {
        if layout.full == Some(filesystem) {
            parts.push(part(DiskPartKey::Full, archives.full));
        }
        if layout.incremental == Some(filesystem) {
            parts.push(part(DiskPartKey::Incremental, archives.incremental));
        }
    }
    parts
}

const LEFTOVER_SUFFIX: &str = "_to_be_deleted";

/// Each leftover directory and the filesystem it is on.
fn read_leftovers(layout: &DiskLayout) -> Vec<(u64, String)> {
    let mut leftovers = Vec::new();
    for (filesystem, parent) in &layout.account_parents {
        let Ok(entries) = std::fs::read_dir(parent) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(LEFTOVER_SUFFIX) {
                leftovers.push((*filesystem, name.into_owned()));
            }
        }
    }
    leftovers.sort();
    leftovers.dedup();
    leftovers
}

fn resolve_host_paths(ctx: &DashboardContext) -> Vec<HostPath> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    let ledger = ctx.blockstore.ledger_path().clone();
    if let Ok(id) = host_stats::filesystem_id(&ledger) {
        seen.insert(id);
        paths.push(HostPath::new("ledger".to_owned(), ledger, id));
    }

    let mut accounts = Vec::new();
    for path in &ctx.account_paths {
        let Ok(id) = host_stats::filesystem_id(path) else {
            continue;
        };
        if seen.insert(id) {
            accounts.push((path.clone(), id));
        }
    }
    let numbered = accounts.len() > 1;
    for (index, (path, id)) in accounts.into_iter().enumerate() {
        let ordinal = index.saturating_add(1);
        let name = if numbered {
            format!("accounts {ordinal}")
        } else {
            "accounts".to_owned()
        };
        paths.push(HostPath::new(name, path, id));
    }

    if let Some(archives) = ctx
        .snapshot_config
        .as_ref()
        .map(|config| &config.full_snapshot_archives_dir)
        && let Ok(id) = host_stats::filesystem_id(archives)
        && seen.insert(id)
    {
        paths.push(HostPath::new("snapshots".to_owned(), archives.clone(), id));
    }

    paths
}

fn device_loads(
    paths: &[HostPath],
    current: &HostSnapshot,
    previous: &HostSnapshot,
    interval_ms: f64,
    seconds: f64,
) -> Vec<DeviceLoad> {
    let mut roles: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for path in paths {
        if let Some(device) = &path.device {
            roles
                .entry(device.clone())
                .or_default()
                .push(path.name.clone());
        }
    }

    roles
        .into_iter()
        .filter_map(|(device, roles)| {
            let now = current.disks.get(&device)?;
            let before = previous.disks.get(&device)?;
            let delta = now.since(before)?;
            Some(DeviceLoad {
                device,
                roles,
                busy: delta.busy(interval_ms).unwrap_or_default(),
                wait_ms: delta.wait_ms(),
                operations_per_second: (delta.operations() as f64 / seconds) as u64,
                read_per_second: (delta.read_bytes() as f64 / seconds) as u64,
                write_per_second: (delta.write_bytes() as f64 / seconds) as u64,
            })
        })
        .collect()
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1)
}

/// Gossip reports every two seconds, so rates are read over several reports.
const GOSSIP_RATE_WINDOW: usize = 10;
const GOSSIP_MINUTE: usize = 60;

/// Gossip's `CRDS_UNIQUE_PUBKEY_CAPACITY`, which is crate-private: above it the table is trimmed to
/// staked nodes.
const GOSSIP_PUBKEY_CAPACITY: u64 = 8192;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Gossip {
    pub table: GossipTable,
    pub messages: Vec<GossipMessage>,
    pub entries: GossipEntries,
    pub pressure: GossipPressure,
    /// Milliseconds spent per second.
    pub time: GossipTime,
    /// Packets dropped either way over the last minute.
    pub dropped_last_minute: u64,
    /// Packets received and sent over the last minute, against which drops are judged.
    pub packets_last_minute: u64,
    /// Packets received and sent per second.
    pub packets_per_second: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GossipTable {
    pub entries: u64,
    pub pubkeys: u64,
    pub pubkey_capacity: u64,
    pub nodes: u64,
    pub staked_nodes: u64,
    pub expired_per_second: f64,
    pub evicted_last_minute: u64,
}

/// In packets per second.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GossipMessage {
    pub kind: &'static str,
    pub received: f64,
    pub sent: f64,
}

/// Per second.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GossipEntries {
    pub accepted_push: f64,
    pub accepted_pull: f64,
    pub duplicate_push: f64,
    pub redundant_pull: f64,
    pub rejected_push: f64,
    pub rejected_pull: f64,
    /// Busiest first.
    pub types: Vec<GossipEntryType>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GossipEntryType {
    pub kind: &'static str,
    pub push: f64,
    pub pull: f64,
    pub rejected: f64,
}

/// Per second.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GossipPressure {
    pub dropped_in: f64,
    pub dropped_out: f64,
    pub pull_no_budget: f64,
    pub pull_scan_exhausted: f64,
    /// Pull requests, pushed entries and pulled entries together.
    pub other_shred_version: f64,
    pub ping_check_failed: f64,
    pub unverified_addresses: f64,
    pub bad_prune_destination: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GossipTime {
    pub push: f64,
    pub pull_requests: f64,
    pub pull_responses: f64,
    pub ping_pong_prune: f64,
    pub verify: f64,
    pub other: f64,
}

/// Packets received and sent; drops are counted at both ends.
fn gossip_packets(totals: &GossipTotals) -> u64 {
    totals
        .received
        .saturating_add(totals.sent_push)
        .saturating_add(totals.sent_pull_requests)
        .saturating_add(totals.sent_pull_responses)
        .saturating_add(totals.sent_ping)
        .saturating_add(totals.sent_pong)
        .saturating_add(totals.sent_prune)
}

struct GossipMeter {
    window: VecDeque<GossipTotals>,
    entries: VecDeque<GossipEntryTotals>,
    published: Debounced<Option<Gossip>>,
}

impl GossipMeter {
    fn new() -> Self {
        Self {
            window: VecDeque::with_capacity(GOSSIP_MINUTE),
            entries: VecDeque::with_capacity(GOSSIP_RATE_WINDOW),
            published: Debounced::new(TOPIC_SUMMARY, "gossip"),
        }
    }

    /// Publishes nothing while no report has arrived for the rate window: gossip's points are
    /// info-level, so the page can say why rather than show zeros.
    fn tick(&mut self, previous: &TapCounters, current: &TapCounters, publisher: &Publisher) {
        self.window
            .push_back(current.gossip.since(&previous.gossip));
        while self.window.len() > GOSSIP_MINUTE {
            self.window.pop_front();
        }
        let entries = sum_window(
            &mut self.entries,
            current.gossip_entries.since(&previous.gossip_entries),
            GOSSIP_RATE_WINDOW,
        );
        let recent = self.window.len().min(GOSSIP_RATE_WINDOW);
        let rates = self
            .window
            .iter()
            .skip(self.window.len().saturating_sub(recent))
            .fold(GossipTotals::default(), |total, sample| total.plus(sample));
        let minute = self
            .window
            .iter()
            .fold(GossipTotals::default(), |total, sample| total.plus(sample));

        let gossip = (rates.reports > 0).then(|| {
            let seconds = recent as f64 * METER_INTERVAL.as_secs_f64();
            let per_second = |count: u64| count as f64 / seconds;
            let millis = |micros: u64| micros as f64 / 1_000.0 / seconds;
            let levels = &current.gossip_levels;
            let handled = rates
                .push_us
                .saturating_add(rates.pull_requests_us)
                .saturating_add(rates.pull_responses_us)
                .saturating_add(rates.ping_us)
                .saturating_add(rates.pong_us)
                .saturating_add(rates.prune_us);
            let mut types: Vec<GossipEntryType> = GOSSIP_ENTRY_TYPES
                .iter()
                .enumerate()
                .map(|(index, kind)| GossipEntryType {
                    kind,
                    push: per_second(entries.push[index]),
                    pull: per_second(entries.pull[index]),
                    rejected: per_second(entries.rejected[index]),
                })
                .collect();
            types.sort_by(|a, b| (b.push + b.pull).total_cmp(&(a.push + a.pull)));
            Gossip {
                table: GossipTable {
                    entries: levels.table_size,
                    pubkeys: levels.pubkeys,
                    pubkey_capacity: GOSSIP_PUBKEY_CAPACITY,
                    nodes: levels.nodes,
                    staked_nodes: levels.staked_nodes,
                    expired_per_second: per_second(rates.expired),
                    evicted_last_minute: minute.evicted,
                },
                messages: [
                    ("push", rates.received_push, rates.sent_push),
                    (
                        "pull_request",
                        rates.received_pull_requests,
                        rates.sent_pull_requests,
                    ),
                    (
                        "pull_response",
                        rates.received_pull_responses,
                        rates.sent_pull_responses,
                    ),
                    ("ping", rates.received_ping, rates.sent_ping),
                    ("pong", rates.received_pong, rates.sent_pong),
                    ("prune", rates.received_prune, rates.sent_prune),
                ]
                .into_iter()
                .map(|(kind, received, sent)| GossipMessage {
                    kind,
                    received: per_second(received),
                    sent: per_second(sent),
                })
                .collect(),
                entries: GossipEntries {
                    accepted_push: per_second(rates.accepted_push),
                    accepted_pull: per_second(rates.accepted_pull),
                    duplicate_push: per_second(rates.duplicate_push),
                    redundant_pull: per_second(rates.redundant_pull),
                    rejected_push: per_second(rates.rejected_push),
                    rejected_pull: per_second(rates.rejected_pull),
                    types,
                },
                pressure: GossipPressure {
                    dropped_in: per_second(rates.dropped_in),
                    dropped_out: per_second(rates.dropped_out),
                    pull_no_budget: per_second(rates.pull_no_budget),
                    pull_scan_exhausted: per_second(rates.pull_scan_exhausted),
                    other_shred_version: per_second(
                        rates
                            .other_shred_version_push
                            .saturating_add(rates.other_shred_version_pull_responses)
                            .saturating_add(rates.other_shred_version_pull_requests),
                    ),
                    ping_check_failed: per_second(rates.ping_check_failed),
                    unverified_addresses: per_second(rates.unverified_addresses),
                    bad_prune_destination: per_second(rates.bad_prune_destination),
                },
                time: GossipTime {
                    push: millis(rates.push_us),
                    pull_requests: millis(rates.pull_requests_us),
                    pull_responses: millis(rates.pull_responses_us),
                    ping_pong_prune: millis(
                        rates
                            .ping_us
                            .saturating_add(rates.pong_us)
                            .saturating_add(rates.prune_us),
                    ),
                    verify: millis(rates.verify_us),
                    other: millis(rates.process_us.saturating_sub(handled)),
                },
                dropped_last_minute: minute.dropped_in.saturating_add(minute.dropped_out),
                packets_last_minute: gossip_packets(&minute),
                packets_per_second: per_second(gossip_packets(&rates)),
            }
        });
        self.published.publish(publisher, gossip);
    }
}

pub struct Meters {
    ctx: DashboardContext,
    /// The working bank without bank forks' lock.
    sharable_banks: SharableBanks,
    publisher: Arc<Publisher>,
    startup_progress: StartProgress,
    started: SystemTime,
    metrics_tap: Arc<MetricsTap>,
    last_tap: Option<TapCounters>,

    throughput: Throughput,
    network: NetworkMeter,
    interfaces: InterfaceMeter,
    host: HostMeter,
    sockets: SocketMeter,
    shreds: ShredMeter,
    turbine: TurbineMeter,
    egress: EgressMeter,
    accounts: AccountsMeter,
    program_cache: ProgramCacheMeter,
    tpu: TpuMeter,
    threads: ThreadMeter,
    gossip: GossipMeter,
}

impl Meters {
    pub fn new(
        ctx: DashboardContext,
        publisher: Arc<Publisher>,
        startup_progress: StartProgress,
        started: SystemTime,
        metrics_tap: Arc<MetricsTap>,
        failed_total: Arc<AtomicU64>,
    ) -> Self {
        let sharable_banks = ctx.bank_forks.read().unwrap().sharable_banks();
        Self {
            ctx,
            sharable_banks,
            publisher,
            startup_progress,
            started,
            metrics_tap,
            last_tap: None,
            throughput: Throughput::new(failed_total),
            network: NetworkMeter::default(),
            interfaces: InterfaceMeter::default(),
            host: HostMeter::default(),
            sockets: SocketMeter::new(),
            shreds: ShredMeter::new(),
            turbine: TurbineMeter::new(),
            egress: EgressMeter::default(),
            accounts: AccountsMeter::new(),
            program_cache: ProgramCacheMeter::new(),
            tpu: TpuMeter::new(),
            threads: ThreadMeter::default(),
            gossip: GossipMeter::new(),
        }
    }

    pub fn tick(&mut self) {
        self.collect_clock();

        let alpenglow = {
            let working_bank = self.sharable_banks.working();
            self.throughput.tick(&working_bank, &self.publisher);
            self.tpu.note_epoch(&working_bank);
            working_bank.is_alpenglow()
        };

        let interface_rates = self.network.tick(&self.publisher);
        // Read whether or not anyone watches, so the route peak covers the whole day.
        self.interfaces.tick(&self.publisher, interface_rates);
        self.tpu.collect_xdp(&self.metrics_tap, &self.publisher);
        // The `/proc` walks run only while somebody is watching. The rest is
        // cheap and keeps the charts whole for a viewer connecting.
        let watched = self.publisher.subscriber_count() > 0;
        if watched {
            self.host
                .tick(&self.ctx, &self.metrics_tap, &self.publisher);
            self.threads.tick(&self.publisher);
        }
        // Until startup ends whether or not anyone watches, so the totals begin there.
        if watched || self.sockets.drops_baseline.is_none() {
            let running = matches!(
                *self.startup_progress.read().unwrap(),
                ValidatorStartProgress::Running
            );
            self.sockets.tick(
                &self.ctx,
                &self.metrics_tap.counters(),
                running,
                alpenglow,
                &self.publisher,
            );
        }
        self.collect_from_metrics();
    }

    fn collect_clock(&self) {
        let now = SystemTime::now();
        self.publisher
            .publish(TOPIC_SUMMARY, "server_time_nanos", &system_time_nanos(now));
        let uptime = now
            .duration_since(self.started)
            .unwrap_or_default()
            .as_nanos() as u64;
        self.publisher
            .publish(TOPIC_SUMMARY, "uptime_nanos", &uptime);
    }

    fn collect_from_metrics(&mut self) {
        let current = self.metrics_tap.counters();
        let Some(previous) = self.last_tap.replace(current) else {
            return;
        };
        self.shreds.tick(&previous, &current, &self.publisher);
        self.turbine.tick(&previous, &current, &self.publisher);
        self.egress.tick(&previous, &current, &self.publisher);
        self.collect_waterfall(&previous, &current);
        self.program_cache
            .tick(&previous, &current, &self.publisher);
        self.accounts.tick(&previous, &current, &self.publisher);
        self.gossip.tick(&previous, &current, &self.publisher);
    }

    fn collect_waterfall(&mut self, previous: &TapCounters, current: &TapCounters) {
        let tpu_offhost = self.sockets.sampled
            && !self.sockets.unavailable
            && !self.sockets.kernel_drops.contains_key("tpu");
        self.tpu.tick(
            &self.metrics_tap,
            previous,
            current,
            &self.sockets.kernel_drops,
            tpu_offhost,
            &self.publisher,
        );
    }
}

struct Throughput {
    last_counters: Option<TxnCounters>,
    failed_total: Arc<AtomicU64>,
    history: Vec<TpsSample>,
}

impl Throughput {
    fn new(failed_total: Arc<AtomicU64>) -> Self {
        Self {
            last_counters: None,
            failed_total,
            history: Vec::with_capacity(CHART_HISTORY),
        }
    }

    fn tick(&mut self, working_bank: &Bank, publisher: &Publisher) {
        let errors = self.failed_total.load(Ordering::Relaxed);
        // The collector's first count spans every bank drained at attach, so it is a baseline only.
        if errors == FAILED_UNREAD {
            return;
        }
        let current = TxnCounters::read(working_bank, errors);
        let Some(previous) = self.last_counters.replace(current) else {
            return;
        };
        // A fork switch or a restart makes the counters incomparable; the same bank's are not.
        if current.slot < previous.slot
            || current.total < previous.total
            || current.errors < previous.errors
        {
            return;
        }
        let seconds = current
            .sampled_at
            .duration_since(previous.sampled_at)
            .as_secs_f64();
        if seconds <= 0.0 {
            return;
        }

        // While catching up, replay chews through slots far faster than the cluster
        // produces them, and one such sample would pin the chart's scale.
        let slots_per_second = current.slot.saturating_sub(previous.slot) as f64 / seconds;
        if slots_per_second > CATCH_UP_SLOTS_PER_SECOND {
            return;
        }

        let total = current.total.saturating_sub(previous.total) as f64 / seconds;
        let non_vote = current.non_vote.saturating_sub(previous.non_vote) as f64 / seconds;
        let failed = current.errors.saturating_sub(previous.errors) as f64 / seconds;
        let tps = Tps {
            total,
            vote: (total - non_vote).max(0.0),
            non_vote_success: (non_vote - failed).max(0.0),
            non_vote_failed: failed.min(non_vote),
        };

        let sample = TpsSample {
            slot: current.slot,
            timestamp_nanos: system_time_nanos(SystemTime::now()),
            tps,
        };
        publisher.publish_ephemeral(TOPIC_SUMMARY, "tps_sample", &sample);

        push_history(
            &mut self.history,
            sample,
            CHART_HISTORY,
            publisher,
            "tps_history",
        );
    }
}

#[derive(Default)]
struct NetworkMeter {
    last: Option<(NetReading, Instant)>,
    history: Vec<NetworkSample>,
    /// Each interface's bytes a second over the same interval as the host total.
    interface_rates: HashMap<String, (u64, u64)>,
    unavailable: bool,
}

impl NetworkMeter {
    /// Returns each interface's rates over the same interval as the host total it published.
    fn tick(&mut self, publisher: &Publisher) -> &HashMap<String, (u64, u64)> {
        if self.unavailable {
            return &self.interface_rates;
        }
        let rates = match net_stats::read() {
            Ok(reading) => self.note(reading, Instant::now()),
            Err(err) => {
                self.give_up();
                log::info!("dashboard: network counters unavailable, panel disabled: {err}");
                None
            }
        };
        if let Some(rates) = rates {
            self.publish(publisher, rates);
        }
        &self.interface_rates
    }

    /// The host total since the last reading, and each interface's rates over the same interval.
    fn note(&mut self, current: NetReading, now: Instant) -> Option<Network> {
        let previous = self.last.take();
        let rates = previous.as_ref().and_then(|(before, sampled_at)| {
            let elapsed = now.duration_since(*sampled_at);
            self.interface_rates =
                interface_rates(&before.interfaces, &current.interfaces, elapsed);
            network_rates(
                (before.total, before.counted),
                (current.total, current.counted),
                elapsed,
            )
        });
        self.last = Some((current, now));
        rates
    }

    /// For good, with no interface rates left to be shown as current.
    fn give_up(&mut self) {
        self.unavailable = true;
        self.interface_rates.clear();
    }

    fn publish(&mut self, publisher: &Publisher, rates: Network) {
        publisher.publish(TOPIC_SUMMARY, "network", &rates);

        let sample = NetworkSample {
            timestamp_nanos: system_time_nanos(SystemTime::now()),
            rates,
        };
        publisher.publish_ephemeral(TOPIC_SUMMARY, "network_sample", &sample);

        push_history(
            &mut self.history,
            sample,
            CHART_HISTORY,
            publisher,
            "network_history",
        );
    }
}

/// Bytes a second since the previous reading; none where a counter went backwards or the reading
/// switched between the cards and every interface, as when the cards vanish.
fn network_rates(
    (previous, previous_counted): (NetCounters, Counted),
    (current, counted): (NetCounters, Counted),
    elapsed: Duration,
) -> Option<Network> {
    let seconds = elapsed.as_secs_f64();
    if seconds <= 0.0 || counted != previous_counted {
        return None;
    }
    // Counters are unsigned and wrap or reset when an interface goes down,
    // so a decrease is discarded rather than read as negative throughput.
    let received = current.received.checked_sub(previous.received)?;
    let sent = current.sent.checked_sub(previous.sent)?;
    Some(Network {
        received_per_second: (received as f64 / seconds) as u64,
        sent_per_second: (sent as f64 / seconds) as u64,
    })
}

/// Each interface's kind, state and routes are read this often. Its traffic comes every second,
/// with the host total.
const INTERFACE_INTERVAL: Duration = Duration::from_secs(5);

/// How far back an interface's highest route count reaches.
const ROUTE_PEAK_HOURS: u64 = 24;

#[derive(Default)]
struct InterfaceMeter {
    started: Option<Instant>,
    /// The last reading of each interface, with its highest route count of the last day.
    described: Option<(Instant, Vec<(InterfaceReading, u32)>)>,
    /// Per interface, its highest route count in each hour since the meter started, oldest first.
    peaks: HashMap<String, VecDeque<(u64, u32)>>,
    unavailable: bool,
}

impl InterfaceMeter {
    /// Published every second with the host total's interface rates, so the two agree.
    fn tick(&mut self, publisher: &Publisher, rates: &HashMap<String, (u64, u64)>) {
        if self.unavailable {
            return;
        }
        let now = Instant::now();
        if self
            .described
            .as_ref()
            .is_none_or(|(at, _)| now.duration_since(*at) >= INTERFACE_INTERVAL)
        {
            let readings = match net_ifaces::read() {
                Ok(readings) => readings,
                Err(err) => {
                    self.unavailable = true;
                    log::info!("dashboard: network interfaces unavailable: {err}");
                    return;
                }
            };
            self.described = Some((now, self.note_peaks(now, readings)));
        }
        let Some((_, described)) = &self.described else {
            return;
        };
        let interfaces: Vec<NetInterface> = described
            .iter()
            .filter_map(|(reading, peak)| {
                interface_shown(reading, *peak, rates.get(&reading.name).copied())
            })
            .collect();
        publisher.publish(TOPIC_SUMMARY, "net_interfaces", &interfaces);
    }

    fn note_peaks(
        &mut self,
        now: Instant,
        readings: Vec<InterfaceReading>,
    ) -> Vec<(InterfaceReading, u32)> {
        let hour = now
            .duration_since(*self.started.get_or_insert(now))
            .as_secs()
            .checked_div(3600)
            .unwrap_or_default();
        // Interfaces come and go, as containers' do; only those present keep a history.
        self.peaks
            .retain(|name, _| readings.iter().any(|reading| &reading.name == name));
        readings
            .into_iter()
            .map(|reading| {
                let peak = note_routes(
                    self.peaks.entry(reading.name.clone()).or_default(),
                    hour,
                    reading.routes,
                );
                (reading, peak)
            })
            .collect()
    }
}

/// Records a reading's route count against its hour and returns the highest of the last day.
fn note_routes(hours: &mut VecDeque<(u64, u32)>, hour: u64, routes: u32) -> u32 {
    match hours.back_mut() {
        Some((at, most)) if *at == hour => *most = (*most).max(routes),
        _ => hours.push_back((hour, routes)),
    }
    while hours
        .front()
        .is_some_and(|(at, _)| at.saturating_add(ROUTE_PEAK_HOURS) <= hour)
    {
        hours.pop_front();
    }
    hours.iter().map(|(_, most)| *most).max().unwrap_or(routes)
}

/// Each interface's bytes a second in and out between two readings; none for an interface new
/// since the earlier one or whose counter went backwards.
fn interface_rates(
    before: &InterfaceCounters,
    after: &InterfaceCounters,
    elapsed: Duration,
) -> HashMap<String, (u64, u64)> {
    let seconds = elapsed.as_secs_f64();
    if seconds <= 0.0 {
        return HashMap::new();
    }
    after
        .iter()
        .filter_map(|(name, (received, sent))| {
            let (received_before, sent_before) = before.get(name)?;
            Some((
                name.clone(),
                (
                    (received.checked_sub(*received_before)? as f64 / seconds) as u64,
                    (sent.checked_sub(*sent_before)? as f64 / seconds) as u64,
                ),
            ))
        })
        .collect()
}

/// `None` for an idle interface: down, with no routes and no traffic.
fn interface_shown(
    reading: &InterfaceReading,
    routes_peak: u32,
    rates: Option<(u64, u64)>,
) -> Option<NetInterface> {
    let quiet = rates.is_none_or(|(received, sent)| received == 0 && sent == 0);
    if !reading.up && reading.routes == 0 && quiet {
        return None;
    }
    Some(NetInterface {
        name: reading.name.clone(),
        kind: reading.kind,
        up: reading.up,
        mtu: reading.mtu,
        routes: reading.routes,
        routes_peak,
        member_of: reading.member_of.clone(),
        inside: reading.inside.clone(),
        received_per_second: rates.map(|(received, _)| received),
        sent_per_second: rates.map(|(_, sent)| sent),
    })
}

#[derive(Default)]
struct HostMeter {
    last: Option<(HostSnapshot, Instant)>,
    unavailable: bool,
    paths: Option<Vec<HostPath>>,
    layout: Option<DiskLayout>,
    resident: VecDeque<(Instant, u64)>,
    snapshot_device: Option<Option<String>>,
}

const RESIDENT_HISTORY: Duration = Duration::from_secs(3600);
const RESIDENT_HOUR_AGO: Duration = Duration::from_secs(3300);

impl HostMeter {
    fn tick(&mut self, ctx: &DashboardContext, tap: &MetricsTap, publisher: &Publisher) {
        if self.unavailable {
            return;
        }
        let current = match host_stats::read() {
            Ok(snapshot) => snapshot,
            Err(err) => {
                self.unavailable = true;
                log::info!("dashboard: host counters unavailable, panel disabled: {err}");
                return;
            }
        };
        let now = Instant::now();
        let paths = self.paths.get_or_insert_with(|| resolve_host_paths(ctx));
        let snapshot_device = self
            .snapshot_device
            .get_or_insert_with(|| {
                ctx.snapshot_config
                    .as_ref()
                    .and_then(|config| {
                        host_stats::device_for(&config.full_snapshot_archives_dir).ok()
                    })
                    .flatten()
            })
            .clone();
        let process_memory = host_stats::process_memory().ok();
        let process_resident = process_memory.map(|memory| memory.resident);
        if let Some(resident) = process_resident {
            self.resident.push_back((now, resident));
        }
        while self
            .resident
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > RESIDENT_HISTORY)
        {
            self.resident.pop_front();
        }
        let process_resident_hour_ago = self
            .resident
            .front()
            .filter(|(at, _)| now.duration_since(*at) >= RESIDENT_HOUR_AGO)
            .map(|(_, resident)| *resident);

        let Some((previous, sampled_at)) = self.last.take() else {
            self.last = Some((current, now));
            return;
        };
        let interval_ms = now.duration_since(sampled_at).as_secs_f64() * 1000.0;
        if interval_ms <= 0.0 || now.duration_since(sampled_at) > WATCH_GAP {
            self.last = Some((current, now));
            return;
        }
        let seconds = interval_ms / 1000.0;

        let swap_used = current
            .memory
            .swap_total
            .saturating_sub(current.memory.swap_free);
        let layout = self.layout.get_or_insert_with(|| resolve_disk_layout(ctx));
        let readings = DiskReadings {
            ledger: tap.ledger_files(),
            accounts: tap.accounts_files(),
            archives: ctx
                .snapshot_config
                .as_ref()
                .and_then(snapshot::archive_bytes),
        };
        let leftovers = read_leftovers(layout);
        let host = Host {
            cores: num_cpus(),
            load_one: current.load.one,
            load_five: current.load.five,
            load_fifteen: current.load.fifteen,
            threads: current.load.threads,
            running: current.load.running,
            cpu: current
                .cpu
                .zip(previous.cpu)
                .and_then(|(now, before)| now.since(&before)?.shares()),
            cpu_governor: host_stats::cpu_governor(),
            memory_total: current.memory.total,
            memory_available: current.memory.available,
            memory_reclaimable: current.memory.reclaimable,
            memory_free: current.memory.free,
            swap: (current.memory.swap_total > 0).then_some(Swap {
                total: current.memory.swap_total,
                used: swap_used,
            }),
            process_resident,
            process_resident_hour_ago,
            process_kinds: process_memory.and_then(|memory| memory.kinds),
            memory_parts: tap.memory_parts(),
            snapshot_device,
            filesystems: paths
                .iter()
                .filter_map(|path| {
                    let usage = host_stats::filesystem(&path.path).ok()?;
                    Some(FilesystemUsage {
                        name: path.name.clone(),
                        path: path.path.to_string_lossy().into_owned(),
                        total: usage.total,
                        available: usage.available,
                        reserved: usage.reserved,
                        parts: disk_parts(path.filesystem, layout, &readings),
                        leftovers: leftovers
                            .iter()
                            .filter(|(filesystem, _)| *filesystem == path.filesystem)
                            .map(|(_, name)| name.clone())
                            .collect(),
                    })
                })
                .collect(),
            devices: device_loads(paths, &current, &previous, interval_ms, seconds),
        };
        self.last = Some((current, now));
        publisher.publish(TOPIC_SUMMARY, "host", &host);
    }
}

#[derive(Default)]
struct ThreadMeter {
    last: Option<(HashMap<u64, ThreadReading>, Instant)>,
    pinning: HashMap<u64, Option<String>>,
    recent: VecDeque<Vec<(String, f64)>>,
    /// When every thread's name was last read.
    named_at: Option<Instant>,
    history: Vec<ThreadsSample>,
    unavailable: bool,
}

impl ThreadMeter {
    fn tick(&mut self, publisher: &Publisher) {
        if self.unavailable {
            return;
        }
        let refresh_names = self
            .named_at
            .is_none_or(|at| at.elapsed() >= THREAD_NAMES_REFRESH);
        let known = if refresh_names {
            None
        } else {
            self.last.as_ref().map(|(by_tid, _)| by_tid)
        };
        let current = match thread_stats::read(known) {
            Ok(threads) => threads,
            Err(err) => {
                self.unavailable = true;
                log::info!("dashboard: thread counters unavailable, panel disabled: {err}");
                return;
            }
        };
        if refresh_names {
            self.named_at = Some(Instant::now());
        }
        let cores = num_cpus();
        for thread in &current {
            self.pinning.entry(thread.tid).or_insert_with(|| {
                thread_stats::cores_allowed(thread.tid)
                    .filter(|list| thread_stats::cores_in(list) < cores)
            });
        }

        let now = Instant::now();
        // Resumed, it would average the gap into one second beside a minute long gone.
        if self
            .last
            .as_ref()
            .is_some_and(|(_, at)| now.duration_since(*at) > WATCH_GAP)
        {
            self.last = None;
            self.recent.clear();
            self.history.clear();
            publisher.publish(TOPIC_SUMMARY, "threads_history", &self.history);
        }
        let threads = current.len();
        let groups = self.last.take().and_then(|(previous, sampled_at)| {
            let interval = now.duration_since(sampled_at).as_nanos() as u64;
            (interval > 0)
                .then(|| thread_stats::group_shares(&previous, &current, &self.pinning, interval))
        });
        let by_tid: HashMap<u64, ThreadReading> = current
            .into_iter()
            .map(|thread| (thread.tid, thread))
            .collect();
        self.pinning.retain(|tid, _| by_tid.contains_key(tid));
        self.last = Some((by_tid, now));
        let Some(groups) = groups else {
            return;
        };

        self.recent.push_back(
            groups
                .iter()
                .map(|group| (group.name.clone(), group.on_cpu))
                .collect(),
        );
        while self.recent.len() > THREADS_HISTORY {
            self.recent.pop_front();
        }
        let means = thread_stats::window_means(&self.recent);
        let sample = ThreadsSample {
            timestamp_nanos: system_time_nanos(SystemTime::now()),
            threads,
            groups: thread_stats::select_rows(groups, &means, THREAD_ROWS),
        };
        publisher.publish_ephemeral(TOPIC_SUMMARY, "threads_sample", &sample);
        push_history(
            &mut self.history,
            sample,
            THREADS_HISTORY,
            publisher,
            "threads_history",
        );
    }
}

struct SocketMeter {
    drops_window: PortWindow,
    quic_drops_window: PortWindow,
    kernel_drops: HashMap<&'static str, u64>,
    /// Per-port drops when the validator finished starting, so the startup burst is not carried for
    /// the life of the process.
    drops_baseline: Option<HashMap<u16, u64>>,
    received_window: PortWindow,
    received_baseline: Option<HashMap<u16, u64>>,
    /// Last counters seen per reported port: `/proc/net/udp` is not read atomically, so a bound
    /// socket can drop out of one snapshot.
    known_sockets: HashMap<u16, PortCounters>,
    unavailable: bool,
    /// Set once the table has been read, so an empty table before then does not say the TPU port is
    /// bound elsewhere.
    sampled: bool,
    published: Debounced<IngestSummary>,
}

impl SocketMeter {
    fn new() -> Self {
        Self {
            drops_window: PortWindow::new(DROPS_WINDOW),
            quic_drops_window: PortWindow::new(Duration::from_secs(WATERFALL_WINDOW as u64)),
            kernel_drops: HashMap::new(),
            drops_baseline: None,
            received_window: PortWindow::new(DROPS_WINDOW),
            received_baseline: None,
            known_sockets: HashMap::new(),
            unavailable: false,
            sampled: false,
            published: Debounced::new(TOPIC_SUMMARY, "ingest_paths"),
        }
    }

    fn tick(
        &mut self,
        ctx: &DashboardContext,
        tap: &TapCounters,
        running: bool,
        alpenglow: bool,
        publisher: &Publisher,
    ) {
        if self.unavailable {
            return;
        }
        let current = match udp_drops::read() {
            Ok(ports) => ports,
            Err(err) => {
                self.unavailable = true;
                // Emptied: this latches, and a reading kept here would show on the TPU path
                // card as current for the rest of the process.
                self.kernel_drops.clear();
                log::info!("dashboard: socket counters unavailable, panel disabled: {err}");
                return;
            }
        };
        self.sampled = true;
        let now = Instant::now();
        let ports = ingest_ports(&ctx.cluster_info.my_contact_info(), tap, alpenglow);

        for port in &ports {
            if let Some(counters) = current.get(&port.port) {
                self.known_sockets.insert(port.port, *counters);
            }
        }

        let drops: HashMap<u16, u64> = ports
            .iter()
            .filter_map(|port| Some((port.port, self.known_sockets.get(&port.port)?.drops)))
            .collect();
        let received: HashMap<u16, u64> = ports
            .iter()
            .filter_map(|port| Some((port.port, port.received?)))
            .collect();

        if self.drops_baseline.is_none() && running {
            self.drops_baseline = Some(drops.clone());
            self.received_baseline = Some(received.clone());
        }
        self.drops_window.push(now, drops.clone());
        self.received_window.push(now, received);
        self.quic_drops_window.push(now, drops);
        let kernel_drops: HashMap<&'static str, u64> = ports
            .iter()
            .filter(|port| port.quic)
            .filter_map(|port| {
                let counters = self.known_sockets.get(&port.port)?;
                Some((
                    port.name,
                    self.quic_drops_window.since(port.port, counters.drops),
                ))
            })
            .collect();
        self.kernel_drops = kernel_drops;

        let paths: Vec<IngestPath> = ports
            .iter()
            .filter_map(|port| {
                let counters = self.known_sockets.get(&port.port)?;
                let dropped_by = at_baseline(self.drops_baseline.as_ref(), port.port);
                let received_by = at_baseline(self.received_baseline.as_ref(), port.port);
                Some(IngestPath {
                    name: port.name,
                    port: port.port,
                    drops_recent: self.drops_window.since(port.port, counters.drops),
                    // Saturating rather than wrapping: a socket rebound after
                    // the baseline was taken restarts below it.
                    drops_total: counters.drops.saturating_sub(dropped_by),
                    queued_bytes: counters.queued,
                    received_recent: port
                        .received
                        .map(|total| self.received_window.since(port.port, total)),
                    received_total: port.received.map(|total| total.saturating_sub(received_by)),
                    received_in_packets: port.received_in_packets,
                    quic: port.quic,
                })
            })
            .collect();

        // Empty means none of the advertised ports is bound here, as behind a port
        // forward. Zeroed rows would report healthy on a failed lookup.
        if paths.is_empty() {
            return;
        }
        let summary = IngestSummary {
            window_seconds: self
                .drops_window
                .covers(now)
                .min(DROPS_WINDOW)
                .as_secs_f64(),
            paths,
        };
        self.published.publish(publisher, summary);
    }
}

/// Under alpenglow votes reach votor's port and nothing reaches the TPU vote ports, so the one
/// replaces the other.
fn ingest_ports(info: &ContactInfo, tap: &TapCounters, alpenglow: bool) -> Vec<IngestPort> {
    let port = |name, addr: Option<SocketAddr>, received, received_in_packets, quic| {
        Some(IngestPort {
            name,
            port: addr?.port(),
            received,
            received_in_packets,
            quic,
        })
    };
    let datagrams = |name, addr, received| port(name, addr, received, true, false);
    let quic = |name, addr| port(name, addr, None, true, true);

    let mut ports = vec![
        // Everything arriving on the TVU port is a shred, so the count the
        // shred receiver keeps is the count of what the port delivered.
        datagrams("turbine", info.tvu(Protocol::UDP), Some(tap.shreds_turbine)),
        quic("tpu", info.tpu(Protocol::QUIC)),
        quic("tpu forwards", info.tpu_forwards(Protocol::QUIC)),
    ];
    if alpenglow {
        ports.push(port(
            "votor",
            info.alpenglow(),
            Some(tap.votes_votor),
            false,
            false,
        ));
    } else {
        ports.push(datagrams(
            "tpu vote",
            info.tpu_vote(Protocol::UDP),
            Some(tap.packets_tpu_vote),
        ));
        ports.push(quic("tpu vote quic", info.tpu_vote(Protocol::QUIC)));
    }
    ports.push(datagrams("gossip", info.gossip(), Some(tap.packets_gossip)));
    // The one port that could have a count and does not: its receiver keeps
    // counters nothing reports. Reaching them means a change to `core`.
    ports.push(datagrams(
        "serve repair",
        info.serve_repair(Protocol::UDP),
        None,
    ));
    ports.into_iter().flatten().collect()
}

/// In bytes per second; `None` until a sender has reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
struct EgressSplit {
    gossip_per_second: Option<u64>,
    repair_per_second: Option<u64>,
}

struct EgressMeter {
    split: EgressSplit,
    published: Debounced<EgressSplit>,
}

impl Default for EgressMeter {
    fn default() -> Self {
        Self {
            split: EgressSplit::default(),
            published: Debounced::new(TOPIC_SUMMARY, "network_egress"),
        }
    }
}

impl EgressMeter {
    fn tick(&mut self, previous: &TapCounters, current: &TapCounters, publisher: &Publisher) {
        let rate = |bytes: u64, millis: u64, was: Option<u64>| {
            (millis > 0)
                .then(|| bytes.saturating_mul(1000).checked_div(millis))
                .flatten()
                .or(was)
        };
        self.split = EgressSplit {
            gossip_per_second: rate(
                current
                    .gossip_sent_bytes
                    .saturating_sub(previous.gossip_sent_bytes),
                current
                    .gossip_sent_millis
                    .saturating_sub(previous.gossip_sent_millis),
                self.split.gossip_per_second,
            ),
            repair_per_second: rate(
                current
                    .repair_sent_bytes
                    .saturating_sub(previous.repair_sent_bytes),
                current
                    .repair_sent_millis
                    .saturating_sub(previous.repair_sent_millis),
                self.split.repair_per_second,
            ),
        };
        self.published.publish(publisher, self.split);
    }
}

struct ShredMeter {
    window: VecDeque<(u64, u64)>,
    published: Debounced<Option<Shreds>>,
}

impl ShredMeter {
    fn new() -> Self {
        Self {
            window: VecDeque::with_capacity(SHREDS_WINDOW),
            published: Debounced::new(TOPIC_SUMMARY, "shreds"),
        }
    }

    fn tick(&mut self, previous: &TapCounters, current: &TapCounters, publisher: &Publisher) {
        self.window.push_back((
            current
                .shreds_turbine
                .saturating_sub(previous.shreds_turbine),
            current.shreds_repair.saturating_sub(previous.shreds_repair),
        ));
        while self.window.len() > SHREDS_WINDOW {
            self.window.pop_front();
        }

        let mut turbine = 0u64;
        let mut repaired = 0u64;
        for (sample_turbine, sample_repair) in &self.window {
            turbine = turbine.saturating_add(*sample_turbine);
            repaired = repaired.saturating_add(*sample_repair);
        }

        let received = turbine.saturating_add(repaired);
        let shreds = (received > 0).then(|| Shreds {
            received,
            repaired,
            repair_rate: repaired as f64 / received as f64,
        });
        self.published.publish(publisher, shreds);
    }
}

struct TurbineMeter {
    window: VecDeque<[u64; 5]>,
    published: Debounced<Option<Turbine>>,
}

impl TurbineMeter {
    fn new() -> Self {
        Self {
            window: VecDeque::with_capacity(SHREDS_WINDOW),
            published: Debounced::new(TOPIC_SUMMARY, "turbine"),
        }
    }

    fn tick(&mut self, previous: &TapCounters, current: &TapCounters, publisher: &Publisher) {
        self.window.push_back([
            current.turbine_root.saturating_sub(previous.turbine_root),
            current
                .turbine_layer_1
                .saturating_sub(previous.turbine_layer_1),
            current
                .turbine_layer_2
                .saturating_sub(previous.turbine_layer_2),
            current
                .turbine_layer_3
                .saturating_sub(previous.turbine_layer_3),
            current.xdp_dropped.saturating_sub(previous.xdp_dropped),
        ]);
        while self.window.len() > SHREDS_WINDOW {
            self.window.pop_front();
        }

        let mut sum = [0u64; 5];
        for sample in &self.window {
            for (total, part) in sum.iter_mut().zip(sample) {
                *total = total.saturating_add(*part);
            }
        }
        let [root, layer_1, layer_2, layer_3, xdp_dropped] = sum;

        let reported = current.retransmit_xdp.is_some()
            || root
                .saturating_add(layer_1)
                .saturating_add(layer_2)
                .saturating_add(layer_3)
                > 0;
        let turbine = reported.then_some(Turbine {
            root,
            layer_1,
            layer_2,
            layer_3,
            xdp_dropped,
            xdp: current.retransmit_xdp,
        });
        self.published.publish(publisher, turbine);
    }
}

struct AccountsMeter {
    cache_window: VecDeque<(u64, u64, u64)>,
    window: VecDeque<AccountsTotals>,
    published: Debounced<Option<AccountsCache>>,
}

impl AccountsMeter {
    fn new() -> Self {
        Self {
            cache_window: VecDeque::with_capacity(ACCOUNTS_CACHE_WINDOW),
            window: VecDeque::with_capacity(ACCOUNTS_CACHE_WINDOW),
            published: Debounced::new(TOPIC_SUMMARY, "accounts_cache"),
        }
    }

    fn tick(&mut self, previous: &TapCounters, current: &TapCounters, publisher: &Publisher) {
        self.cache_window.push_back((
            current
                .accounts_cache_hits
                .saturating_sub(previous.accounts_cache_hits),
            current
                .accounts_cache_misses
                .saturating_sub(previous.accounts_cache_misses),
            current
                .accounts_cache_evicts
                .saturating_sub(previous.accounts_cache_evicts),
        ));
        while self.cache_window.len() > ACCOUNTS_CACHE_WINDOW {
            self.cache_window.pop_front();
        }

        let totals = sum_window(
            &mut self.window,
            current.accounts.since(&previous.accounts),
            ACCOUNTS_CACHE_WINDOW,
        );
        // What the window actually spans, not what it will span once full. A
        // rate taken against the full minute would read low for the first one.
        let window_seconds = self.cache_window.len() as f64 * METER_INTERVAL.as_secs_f64();

        let disk = (current.accounts_storage_bytes > 0).then(|| AccountsDisk {
            used: current.accounts_storage_alive_bytes,
            allocated: current.accounts_storage_bytes,
            fragmented: current
                .accounts_storage_bytes
                .saturating_sub(current.accounts_storage_alive_bytes),
            storages: current.accounts_storage_count,
        });

        let rate =
            cache_rate(&self.cache_window).map(|(read, hit_rate, evictions)| AccountsCache {
                read,
                hit_rate,
                evictions,
                cache_bytes: current.accounts_cache_bytes,
                cache_entries: current.accounts_cache_entries,
                from_write_cache: totals.loaded_from_write_cache,
                from_read_cache: totals.loaded_from_read_cache,
                from_storage: totals.loaded_from_storage,
                stored_accounts: totals.stored_accounts,
                stored_bytes: totals.stored_bytes,
                window_seconds,
                disk,
            });
        self.published.publish(publisher, rate);
    }
}

struct ProgramCacheMeter {
    window: VecDeque<ProgramCacheTotals>,
    levels: VecDeque<u64>,
    published: Debounced<Option<ProgramCache>>,
}

impl ProgramCacheMeter {
    fn new() -> Self {
        Self {
            window: VecDeque::with_capacity(PROGRAM_CACHE_WINDOW),
            levels: VecDeque::with_capacity(PROGRAM_CACHE_WINDOW),
            published: Debounced::new(TOPIC_SUMMARY, "program_cache"),
        }
    }

    fn tick(&mut self, previous: &TapCounters, current: &TapCounters, publisher: &Publisher) {
        let sample = current.program_cache.since(&previous.program_cache);
        let totals = sum_window(&mut self.window, sample, PROGRAM_CACHE_WINDOW);

        // The level is not differenced — it is where the cache stood, not what
        // happened — so it is kept as its own window and read as a peak.
        self.levels.push_back(current.program_cache_water_level);
        while self.levels.len() > PROGRAM_CACHE_WINDOW {
            self.levels.pop_front();
        }
        let peak_entries = self.levels.iter().copied().max().filter(|peak| *peak > 0);

        let looked_up = totals.hits.saturating_add(totals.misses);
        let cache = (looked_up > 0).then(|| ProgramCache {
            looked_up,
            hits: totals.hits,
            misses: totals.misses,
            hit_rate: totals.hits as f64 / looked_up as f64,
            evictions: totals.evictions,
            reloads: totals.reloads,
            insertions: totals.insertions,
            lost_insertions: totals.lost_insertions,
            replacements: totals.replacements,
            one_hit_wonders: totals.one_hit_wonders,
            prunes_orphan: totals.prunes_orphan,
            prunes_environment: totals.prunes_environment,
            peak_entries,
            entry_limit: MAX_LOADED_ENTRY_COUNT as u64,
        });
        self.published.publish(publisher, cache);
    }
}

struct TpuMeter {
    quic_window: VecDeque<QuicTotals>,
    quic_forwards_window: VecDeque<QuicTotals>,
    quic_vote_window: VecDeque<QuicTotals>,
    quic_paths: Debounced<Option<QuicPaths>>,
    /// The vote port is listed from its first connection until an epoch
    /// passes without another: under alpenglow votes leave it for good.
    vote_quiet: bool,
    vote_offered_at_epoch: Option<(Epoch, u64)>,
    xdp: Debounced<Option<XdpConfig>>,
    epoch_now: Option<EpochPosition>,
    leader_totals: LeaderTotals,
    epoch_span: Debounced<Option<EpochSpan>>,
    verify: Debounced<Option<VerifyTotals>>,
    executed: Debounced<Option<ExecutedTotals>>,
    bundles: Debounced<Option<BundleTotals>>,
    slot_lists_seen: Option<u64>,
    replay: Debounced<Option<ReplayWindow>>,
}

impl TpuMeter {
    fn new() -> Self {
        Self {
            quic_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            quic_forwards_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            quic_vote_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            quic_paths: Debounced::new(TOPIC_SUMMARY, "quic_paths"),
            vote_quiet: true,
            vote_offered_at_epoch: None,
            xdp: Debounced::new(TOPIC_SUMMARY, "xdp"),
            epoch_now: None,
            leader_totals: LeaderTotals::default(),
            epoch_span: Debounced::new(TOPIC_SUMMARY, "epoch_span"),
            verify: Debounced::new(TOPIC_SUMMARY, "verify"),
            executed: Debounced::new(TOPIC_SUMMARY, "executed"),
            bundles: Debounced::new(TOPIC_SUMMARY, "bundles"),
            slot_lists_seen: None,
            replay: Debounced::new(TOPIC_SUMMARY, "replay"),
        }
    }

    fn note_epoch(&mut self, working_bank: &Bank) {
        let schedule = working_bank.epoch_schedule();
        let slot = working_bank.slot();
        let epoch = schedule.get_epoch(slot);
        self.epoch_now = Some(EpochPosition {
            epoch,
            slot,
            start_slot: schedule.get_first_slot_in_epoch(epoch),
            slots_in_epoch: schedule.get_slots_in_epoch(epoch),
        });
    }

    fn collect_xdp(&mut self, tap: &MetricsTap, publisher: &Publisher) {
        self.xdp.publish(publisher, tap.xdp());
    }

    fn tick(
        &mut self,
        tap: &MetricsTap,
        previous: &TapCounters,
        current: &TapCounters,
        kernel_drops: &HashMap<&'static str, u64>,
        tpu_offhost: bool,
        publisher: &Publisher,
    ) {
        if current.quic_vote.offered > previous.quic_vote.offered {
            self.vote_quiet = false;
        }
        if let Some(at) = self.epoch_now {
            let offered = current.quic_vote.offered;
            match self.vote_offered_at_epoch {
                Some((epoch, before)) if epoch != at.epoch => {
                    self.vote_quiet = offered == before;
                    self.vote_offered_at_epoch = Some((at.epoch, offered));
                }
                Some(_) => {}
                None => self.vote_offered_at_epoch = Some((at.epoch, offered)),
            }
        }
        let vote_quiet = self.vote_quiet;

        // Present once any port has taken a connection, not within the window: behind a proxy the
        // only inbound QUIC is votes in leader slots.
        let ports: Vec<QuicPort> = [
            (
                "tpu",
                &mut self.quic_window,
                current.quic.since(&previous.quic),
                current.quic_levels,
            ),
            (
                "tpu forwards",
                &mut self.quic_forwards_window,
                current.quic_forwards.since(&previous.quic_forwards),
                current.quic_forwards_levels,
            ),
            (
                "tpu vote quic",
                &mut self.quic_vote_window,
                current.quic_vote.since(&previous.quic_vote),
                current.quic_vote_levels,
            ),
        ]
        .into_iter()
        .map(|(name, window, sample, levels)| QuicPort {
            name,
            counts: sum_window(window, sample, WATERFALL_WINDOW),
            levels,
            kernel_drops: kernel_drops.get(name).copied(),
        })
        .filter(|port| port.name != "tpu vote quic" || !vote_quiet)
        .collect();
        let ever_offered = current.quic.offered > 0
            || current.quic_forwards.offered > 0
            || current.quic_vote.offered > 0;
        self.quic_paths.publish(
            publisher,
            ever_offered.then_some(QuicPaths { ports, tpu_offhost }),
        );

        // Summed over the epoch, not the window: these stages run only while
        // leader. Nothing is published until a bank has said which epoch.
        if let Some(at) = self.epoch_now {
            self.leader_totals.add(
                at,
                current.verify.since(&previous.verify),
                current.executed.since(&previous.executed),
                current.bundles.since(&previous.bundles),
            );
            let LeaderTotals {
                verify,
                executed,
                bundles,
                ..
            } = self.leader_totals;
            let span = self.leader_totals.span(at);

            self.epoch_span.publish(
                publisher,
                (verify.received > 0 || executed.attempted > 0 || bundles.received > 0)
                    .then_some(span),
            );
            self.verify
                .publish(publisher, (verify.received > 0).then_some(verify));
            self.executed
                .publish(publisher, (executed.attempted > 0).then_some(executed));
            self.bundles
                .publish(publisher, (bundles.received > 0).then_some(bundles));
        }

        // Joined by slot in the browser, since the produced block is captured on another thread.
        // The newest few are kept for a connecting client; a connected one is sent each slot that
        // changed. Read only when the tap's revision says a list moved.
        let revision = tap.slot_lists_revision();
        if self.slot_lists_seen != Some(revision) {
            self.slot_lists_seen = Some(revision);
            publisher.retain_only(
                TOPIC_SUMMARY,
                "slot_waterfalls",
                &tap.recent_waterfalls(SLOT_LISTS_SENT),
            );
            publisher.retain_only(
                TOPIC_SUMMARY,
                "slot_costs",
                &tap.recent_costs(SLOT_LISTS_SENT),
            );
            for waterfall in tap.take_changed_waterfalls() {
                publisher.publish_update(
                    TOPIC_SUMMARY,
                    "slot_waterfall",
                    waterfall.slot,
                    &waterfall,
                );
            }
            for cost in tap.take_changed_costs() {
                publisher.publish_update(TOPIC_SUMMARY, "slot_cost", cost.slot, &cost);
            }
        }

        self.replay
            .publish(publisher, replay_window(&tap.replay_slots()));
    }
}

fn sum_window<T: WindowedCounters>(window: &mut VecDeque<T>, sample: T, span: usize) -> T {
    window.push_back(sample);
    while window.len() > span {
        window.pop_front();
    }
    window
        .iter()
        .fold(T::default(), |total, sample| total.plus(sample))
}

fn at_baseline(baseline: Option<&HashMap<u16, u64>>, port: u16) -> u64 {
    baseline
        .and_then(|baseline| baseline.get(&port))
        .copied()
        .unwrap_or(0)
}

fn push_history<T: Serialize>(
    history: &mut Vec<T>,
    sample: T,
    keep: usize,
    publisher: &Publisher,
    key: &'static str,
) {
    history.push(sample);
    if history.len() > keep {
        let excess = history.len().saturating_sub(keep);
        history.drain(..excess);
    }
    publisher.retain_only(TOPIC_SUMMARY, key, history);
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::fixture::fixture,
        solana_metrics::datapoint::DataPoint,
        solana_pubkey::Pubkey,
        solana_rpc::optimistically_confirmed_bank_tracker::BankNotification,
        std::{net::Ipv4Addr, thread::sleep},
    };

    /// The newest sample of the retained chart series.
    fn last_tps(harness: &crate::fixture::Fixture) -> Option<serde_json::Value> {
        let message = harness.published_key("summary", "tps_history")?;
        let history: serde_json::Value = serde_json::from_str(&message).unwrap();
        history["value"].as_array()?.last().cloned()
    }

    fn quic_tap(offered: u64) -> TapCounters {
        TapCounters {
            quic: QuicTotals {
                offered,
                ..QuicTotals::default()
            },
            ..TapCounters::default()
        }
    }

    const LEDGER_DISK: u64 = 1;
    const ACCOUNTS_DISK: u64 = 2;

    fn disk_readings() -> DiskReadings {
        DiskReadings {
            ledger: Some(LedgerFiles {
                shreds: 10,
                history: 20,
                metadata: 30,
            }),
            accounts: Some(AccountsFiles {
                live: 40,
                fragmented: 50,
            }),
            archives: Some(ArchiveBytes {
                full: 60,
                incremental: 70,
            }),
        }
    }

    fn disk_keys(parts: &[DiskPart]) -> Vec<DiskPartKey> {
        parts.iter().map(|part| part.key).collect()
    }

    #[test]
    fn test_disk_parts_land_on_the_filesystem_each_lives_on() {
        let layout = DiskLayout {
            ledger: Some(LEDGER_DISK),
            accounts: Some(ACCOUNTS_DISK),
            full: Some(LEDGER_DISK),
            incremental: Some(ACCOUNTS_DISK),
            ..DiskLayout::default()
        };
        let readings = disk_readings();
        assert_eq!(
            disk_keys(&disk_parts(LEDGER_DISK, &layout, &readings)),
            [
                DiskPartKey::Shreds,
                DiskPartKey::History,
                DiskPartKey::Metadata,
                DiskPartKey::Full,
            ]
        );
        assert_eq!(
            disk_parts(ACCOUNTS_DISK, &layout, &readings),
            [
                DiskPart {
                    key: DiskPartKey::Live,
                    bytes: 40,
                },
                DiskPart {
                    key: DiskPartKey::Fragmented,
                    bytes: 50,
                },
                DiskPart {
                    key: DiskPartKey::Incremental,
                    bytes: 70,
                },
            ]
        );
    }

    #[test]
    fn test_storage_figures_name_no_filesystem_across_several_accounts_paths() {
        let layout = DiskLayout {
            ledger: Some(LEDGER_DISK),
            accounts: None,
            ..DiskLayout::default()
        };
        assert_eq!(
            disk_keys(&disk_parts(ACCOUNTS_DISK, &layout, &disk_readings())),
            []
        );
    }

    #[test]
    fn test_a_part_not_yet_reported_is_left_out() {
        let layout = DiskLayout {
            ledger: Some(LEDGER_DISK),
            accounts: Some(LEDGER_DISK),
            full: Some(LEDGER_DISK),
            incremental: Some(LEDGER_DISK),
            ..DiskLayout::default()
        };
        assert_eq!(
            disk_parts(LEDGER_DISK, &layout, &DiskReadings::default()),
            []
        );
    }

    #[test]
    fn test_only_directories_named_for_deletion_are_leftovers() {
        let dir = tempfile::TempDir::new().unwrap();
        for name in [
            "run",
            "snapshot",
            "run_to_be_deleted",
            "snapshot_to_be_deleted",
        ] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        let layout = DiskLayout {
            account_parents: vec![
                (ACCOUNTS_DISK, dir.path().to_path_buf()),
                (ACCOUNTS_DISK, dir.path().join("gone")),
            ],
            ..DiskLayout::default()
        };
        assert_eq!(
            read_leftovers(&layout),
            [
                (ACCOUNTS_DISK, "run_to_be_deleted".to_owned()),
                (ACCOUNTS_DISK, "snapshot_to_be_deleted".to_owned()),
            ]
        );
    }

    #[test]
    fn test_the_route_peak_is_the_highest_hour_of_the_last_day() {
        let mut hours = VecDeque::new();
        assert_eq!(note_routes(&mut hours, 0, 115), 115);
        assert_eq!(
            note_routes(&mut hours, 0, 2),
            115,
            "a wipe within the hour keeps its high"
        );
        assert_eq!(note_routes(&mut hours, 23, 2), 115);
        assert_eq!(
            note_routes(&mut hours, 24, 2),
            2,
            "a day later the hour that saw 115 has gone"
        );
        assert_eq!(hours.len(), 2);
    }

    fn reading(name: &str, up: bool, routes: u32) -> InterfaceReading {
        InterfaceReading {
            name: name.to_string(),
            kind: InterfaceKind::Physical,
            up,
            mtu: Some(1500),
            routes,
            member_of: None,
            inside: None,
        }
    }

    #[test]
    fn test_rates_per_interface_and_none_for_a_counter_that_went_backwards() {
        let before = HashMap::from([
            ("eno1".to_string(), (1_000, 2_000)),
            ("eno2".to_string(), (9_000, 9_000)),
        ]);
        let after = HashMap::from([
            ("eno1".to_string(), (6_000, 12_000)),
            ("eno2".to_string(), (500, 9_000)),
            ("doublezero0".to_string(), (1, 1)),
        ]);
        let rates = interface_rates(&before, &after, Duration::from_secs(5));
        assert_eq!(rates, HashMap::from([("eno1".to_string(), (1_000, 2_000))]));
        assert!(interface_rates(&before, &after, Duration::ZERO).is_empty());
    }

    #[test]
    fn test_the_interfaces_get_their_rates_from_the_readings_the_host_total_used() {
        // One card carries everything, so its rate and the host's must match at every reading.
        let at = |received: u64, sent: u64, tunnel: u64, counted| NetReading {
            total: NetCounters { received, sent },
            counted,
            interfaces: HashMap::from([
                ("eno1".to_string(), (received, sent)),
                ("doublezero0".to_string(), (tunnel, tunnel)),
            ]),
        };
        let mut meter = NetworkMeter::default();
        let start = Instant::now();
        assert_eq!(
            meter.note(at(10_000, 40_000, 7, Counted::Cards), start),
            None
        );
        assert!(
            meter.interface_rates.is_empty(),
            "nothing to compare a first reading with"
        );

        let second = start + Duration::from_millis(1_003);
        let host = meter
            .note(at(22_500, 55_640, 1_007, Counted::Cards), second)
            .unwrap();
        assert_eq!(
            meter.interface_rates["eno1"],
            (host.received_per_second, host.sent_per_second)
        );
        assert_eq!(meter.interface_rates["doublezero0"], (997, 997));

        // A reading that summed other interfaces has no host total, but each interface still moves.
        let third = second + Duration::from_secs(1);
        assert_eq!(
            meter.note(at(30_000, 60_000, 2_007, Counted::Every), third),
            None
        );
        assert_eq!(meter.interface_rates["doublezero0"], (1_000, 1_000));

        meter.give_up();
        assert!(
            meter.interface_rates.is_empty(),
            "no rate outlives the readings"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_the_interfaces_are_sent_every_tick_with_the_rates_handed_to_them() {
        let Some(name) = net_ifaces::read()
            .ok()
            .and_then(|readings| readings.into_iter().next())
            .map(|reading| reading.name)
        else {
            return;
        };
        let publisher = Publisher::new();
        let sent_for = |publisher: &Publisher| {
            let message = publisher
                .snapshot()
                .iter()
                .map(|message| message.to_string())
                .find(|message| message.contains(r#""key":"net_interfaces""#))
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(&message).unwrap();
            value["value"]
                .as_array()
                .unwrap()
                .iter()
                .find(|interface| interface["name"] == name.as_str())
                .map(|interface| interface["received_per_second"].clone())
        };
        let mut meter = InterfaceMeter::default();
        meter.tick(&publisher, &HashMap::from([(name.clone(), (10, 20))]));
        assert_eq!(sent_for(&publisher), Some(serde_json::json!(10)));
        // Well inside the five seconds between readings of the interfaces themselves.
        meter.tick(&publisher, &HashMap::from([(name.clone(), (30, 40))]));
        assert_eq!(sent_for(&publisher), Some(serde_json::json!(30)));
    }

    #[test]
    fn test_only_an_interface_down_with_no_routes_and_no_traffic_is_left_out() {
        let idle = reading("docker0", false, 0);
        assert_eq!(interface_shown(&idle, 0, Some((0, 0))), None);
        assert_eq!(interface_shown(&idle, 0, None), None);
        assert!(interface_shown(&reading("docker0", false, 1), 1, Some((0, 0))).is_some());
        assert!(interface_shown(&idle, 0, Some((10, 0))).is_some());
        let shown = interface_shown(&reading("doublezero0", true, 2), 115, None).unwrap();
        assert_eq!((shown.routes, shown.routes_peak), (2, 115));
        assert_eq!(shown.received_per_second, None);
    }

    #[test]
    fn test_a_port_and_a_tunnel_keep_where_they_sit() {
        let port = InterfaceReading {
            member_of: Some("bond0".to_string()),
            ..reading("eno1", true, 0)
        };
        let tunnel = InterfaceReading {
            kind: InterfaceKind::Tunnel,
            inside: Some("bond0".to_string()),
            ..reading("doublezero0", true, 115)
        };
        assert_eq!(
            interface_shown(&port, 0, None)
                .unwrap()
                .member_of
                .as_deref(),
            Some("bond0")
        );
        assert_eq!(
            interface_shown(&tunnel, 115, None)
                .unwrap()
                .inside
                .as_deref(),
            Some("bond0")
        );
    }

    #[test]
    fn test_host_rates_skip_a_reading_that_summed_other_interfaces() {
        let counters = |received, sent| NetCounters { received, sent };
        let second = Duration::from_secs(1);
        let cards = (counters(1_000, 2_000), Counted::Cards);
        assert_eq!(
            network_rates(cards, (counters(3_000, 2_500), Counted::Cards), second),
            Some(Network {
                received_per_second: 2_000,
                sent_per_second: 500,
            })
        );
        // A driver reload drops the cards, and the bond's lifetime totals are summed instead.
        let fallback = (
            counters(9_000_000_000_000, 9_000_000_000_000),
            Counted::Every,
        );
        assert_eq!(network_rates(cards, fallback, second), None);
        assert_eq!(network_rates(fallback, cards, second), None);
        assert_eq!(
            network_rates(cards, (counters(500, 2_500), Counted::Cards), second),
            None
        );
        assert_eq!(network_rates(cards, cards, Duration::ZERO), None);
    }

    fn window(samples: &[(u64, u64, u64)]) -> VecDeque<(u64, u64, u64)> {
        samples.iter().copied().collect()
    }

    fn replayed(set: impl Fn(&mut ReplaySlotTimes)) -> ReplaySlotTimes {
        let mut slot = ReplaySlotTimes::default();
        set(&mut slot);
        slot
    }

    #[test]
    fn test_a_replay_window_reports_the_mean_slot() {
        let window = replay_window(&[
            replayed(|s| {
                s.confirming = 10;
                s.execute = 100;
            }),
            replayed(|s| {
                s.confirming = 30;
                s.execute = 300;
            }),
        ])
        .unwrap();

        assert_eq!(window.slots, 2);
        assert_eq!(window.confirming, 20);
        assert_eq!(window.execute, 200);
    }

    #[test]
    fn test_a_peak_is_the_worst_slot_not_the_worst_of_each_field() {
        // The maxima land on different slots; adding them would describe a slot that
        // never happened.
        let window = replay_window(&[
            replayed(|s| {
                s.fetch = 50;
                s.confirming = 1;
            }),
            replayed(|s| {
                s.fetch = 1;
                s.confirming = 40;
            }),
        ])
        .unwrap();

        assert_eq!(window.serial_peak, 51, "the worse of the two slots");
        assert_ne!(window.serial_peak, 90, "not the two maxima added");
    }

    #[test]
    fn test_the_program_cache_carries_its_own_peak() {
        let mut slots = vec![replayed(|s| s.program_cache = 1_000); 9];
        slots.push(replayed(|s| s.program_cache = 45_000));
        let window = replay_window(&slots).unwrap();

        assert_eq!(window.program_cache, 5_400);
        assert_eq!(window.program_cache_peak, 45_000);
    }

    #[test]
    fn test_no_replayed_slots_is_no_panel() {
        assert!(replay_window(&[]).is_none());
    }

    #[test]
    fn test_the_rate_is_taken_over_the_whole_window() {
        // Taken one at a time the rate is 100%, 50%, 0; over the window it is the six
        // in nine it was.
        let (asked, rate, _) = cache_rate(&window(&[(4, 0, 0), (1, 1, 0), (1, 2, 0)])).unwrap();
        assert_eq!(asked, 9);
        assert!((rate - 6.0 / 9.0).abs() < f64::EPSILON, "{rate}");
    }

    #[test]
    fn test_evictions_are_summed_alongside() {
        let (_, _, evictions) = cache_rate(&window(&[(10, 1, 2), (10, 1, 3)])).unwrap();
        assert_eq!(evictions, 5);
    }

    #[test]
    fn test_nothing_asked_reports_nothing() {
        // Not zero: a cache that has not been asked is not a cache that is failing.
        assert!(cache_rate(&window(&[])).is_none());
        assert!(cache_rate(&window(&[(0, 0, 0), (0, 0, 4)])).is_none());
    }

    #[test]
    fn test_received_figure_only_on_datagram_ports() {
        // Only this join knows `shred_fetch_receiver` is the socket gossip advertises as `tvu`.
        let harness = fixture();
        let counted = ingest_ports(
            &harness.ctx.cluster_info.my_contact_info(),
            &TapCounters {
                shreds_turbine: 900,
                packets_gossip: 40,
                packets_tpu_vote: 70,
                ..TapCounters::default()
            },
            false,
        );
        let by_name: HashMap<&str, Option<u64>> = counted
            .iter()
            .map(|port| (port.name, port.received))
            .collect();

        assert_eq!(by_name["turbine"], Some(900));
        assert_eq!(by_name["gossip"], Some(40));
        assert_eq!(by_name["tpu vote"], Some(70));

        // Nothing rather than nought: no packets received alongside any drops works
        // out to every packet lost.
        assert_eq!(
            by_name["tpu"], None,
            "QUIC counts transactions, not packets"
        );
        assert_eq!(by_name["tpu forwards"], None);
        assert_eq!(
            by_name["serve repair"], None,
            "its receiver keeps counters that nothing reports"
        );
    }

    #[test]
    fn test_the_quic_ports_are_flagged_and_the_udp_vote_port_is_not() {
        let harness = fixture();
        let ports = ingest_ports(
            &harness.ctx.cluster_info.my_contact_info(),
            &TapCounters::default(),
            false,
        );
        let quic: HashMap<&str, bool> = ports.iter().map(|port| (port.name, port.quic)).collect();

        assert_eq!(quic.get("tpu"), Some(&true));
        assert_eq!(quic.get("tpu forwards"), Some(&true));
        assert_eq!(quic.get("tpu vote"), Some(&false));
        assert_eq!(quic.get("turbine"), Some(&false));
        assert_eq!(quic.get("gossip"), Some(&false));
        assert_eq!(quic.get("serve repair"), Some(&false));
        assert_ne!(quic.get("tpu vote quic"), Some(&false));
    }

    #[test]
    fn test_under_alpenglow_votor_takes_the_place_of_the_vote_ports() {
        let mut info = ContactInfo::new_localhost(&Pubkey::new_unique(), 0);
        info.set_alpenglow((Ipv4Addr::LOCALHOST, 8011)).unwrap();
        let tap = TapCounters {
            packets_tpu_vote: 70,
            votes_votor: 400,
            ..TapCounters::default()
        };
        let names = |ports: &[IngestPort]| ports.iter().map(|port| port.name).collect::<Vec<_>>();

        let tower = ingest_ports(&info, &tap, false);
        assert_eq!(
            names(&tower),
            [
                "turbine",
                "tpu",
                "tpu forwards",
                "tpu vote",
                "tpu vote quic",
                "gossip",
                "serve repair"
            ]
        );
        assert!(tower.iter().all(|port| port.received_in_packets));

        let alpenglow = ingest_ports(&info, &tap, true);
        assert_eq!(
            names(&alpenglow),
            [
                "turbine",
                "tpu",
                "tpu forwards",
                "votor",
                "gossip",
                "serve repair"
            ]
        );
        let votor = &alpenglow[3];
        assert_eq!(votor.port, 8011);
        assert_eq!(votor.received, Some(400));
        assert!(
            !votor.received_in_packets,
            "votor counts votes, not packets"
        );
        assert!(
            !votor.quic,
            "kept on this card rather than the TPU path card"
        );
    }

    #[test]
    fn test_a_port_with_no_baseline_yet_counts_from_its_own_start() {
        assert_eq!(at_baseline(None, 8001), 0);
        assert_eq!(at_baseline(Some(&HashMap::new()), 8001), 0);
        assert_eq!(at_baseline(Some(&HashMap::from([(8001, 42)])), 8001), 42);
    }

    fn turbine_tap(layers: [u64; 4], dropped: u64, xdp: Option<bool>) -> TapCounters {
        TapCounters {
            turbine_root: layers[0],
            turbine_layer_1: layers[1],
            turbine_layer_2: layers[2],
            turbine_layer_3: layers[3],
            xdp_dropped: dropped,
            retransmit_xdp: xdp,
            ..TapCounters::default()
        }
    }

    #[test]
    fn test_the_turbine_layers_and_drops_are_differenced_over_the_window() {
        let publisher = Publisher::new();
        let mut meter = TurbineMeter::new();
        meter.tick(
            &turbine_tap([10, 100, 200, 0], 5, Some(true)),
            &turbine_tap([12, 140, 260, 1], 5, Some(true)),
            &publisher,
        );
        meter.tick(
            &turbine_tap([12, 140, 260, 1], 5, Some(true)),
            &turbine_tap([12, 150, 270, 1], 9, Some(true)),
            &publisher,
        );
        let sent = publisher.snapshot().pop().unwrap();
        assert!(sent.contains(r#""root":2"#), "{sent}");
        assert!(sent.contains(r#""layer_1":50"#), "{sent}");
        assert!(sent.contains(r#""layer_2":70"#), "{sent}");
        assert!(sent.contains(r#""xdp_dropped":4"#), "{sent}");
        assert!(sent.contains(r#""xdp":true"#), "{sent}");
    }

    #[test]
    fn test_no_turbine_figure_before_a_point_has_reported() {
        let publisher = Publisher::new();
        let mut meter = TurbineMeter::new();
        meter.tick(&TapCounters::default(), &TapCounters::default(), &publisher);
        let sent = publisher.snapshot().pop().unwrap();
        assert!(sent.contains(r#""value":null"#), "{sent}");
    }

    fn at(epoch: Epoch, slots_in: u64) -> EpochPosition {
        let start_slot = epoch.saturating_mul(432_000);
        EpochPosition {
            epoch,
            slot: start_slot.saturating_add(slots_in),
            start_slot,
            slots_in_epoch: 432_000,
        }
    }

    fn verified(received: u64) -> VerifyTotals {
        VerifyTotals {
            received,
            verified: received,
            ..VerifyTotals::default()
        }
    }

    fn attempted(attempted: u64) -> ExecutedTotals {
        ExecutedTotals {
            attempted,
            succeeded: attempted,
            ..ExecutedTotals::default()
        }
    }

    fn bundled(received: u64, packets: u64) -> BundleTotals {
        BundleTotals {
            received,
            packets,
            processed: 0,
        }
    }

    #[test]
    fn test_leader_totals_add_the_whole_epoch() {
        let mut totals = LeaderTotals::default();
        totals.add(at(842, 10), verified(100), attempted(40), bundled(6, 21));
        totals.add(at(842, 20), verified(0), attempted(0), bundled(0, 0));
        totals.add(at(842, 30), verified(70), attempted(25), bundled(4, 9));

        assert_eq!(totals.bundles, bundled(10, 30));
        assert_eq!(totals.verify.received, 170);
        assert_eq!(totals.executed.attempted, 65);
        assert_eq!(totals.executed.succeeded, 65);
    }

    #[test]
    fn test_the_leader_totals_start_over_when_the_epoch_turns() {
        // The leader schedule and the stake behind it are drawn per epoch, so a total
        // spanning two is a total of two schedules.
        let mut totals = LeaderTotals::default();
        totals.add(
            at(842, 400_000),
            verified(900),
            attempted(300),
            bundled(80, 240),
        );
        totals.add(at(843, 3), verified(11), attempted(4), bundled(1, 2));

        assert_eq!(totals.epoch, Some(843));
        assert_eq!(totals.bundles, bundled(1, 2));
        assert_eq!(totals.verify.received, 11);
        assert_eq!(totals.executed.attempted, 4);
        assert_eq!(totals.span(at(843, 3)).counted_slots, 1);
    }

    #[test]
    fn test_span_reports_the_counted_slots() {
        // A validator restarted part way through an epoch has totals honest about a
        // shorter span than the heading.
        let mut totals = LeaderTotals::default();
        totals.add(
            at(842, 300_000),
            verified(5),
            attempted(2),
            BundleTotals::default(),
        );
        let span = totals.span(at(842, 320_000));

        assert_eq!(span.elapsed_slots, 320_001);
        assert_eq!(span.counted_slots, 20_001);
        assert_eq!(span.slots_in_epoch, 432_000);
    }

    #[test]
    fn test_counted_span_stays_within_the_epoch() {
        // A bank read can land either side of the one that turned the epoch over.
        let totals = LeaderTotals {
            epoch: Some(842),
            from_slot: 842u64.saturating_mul(432_000).saturating_sub(50),
            ..LeaderTotals::default()
        };
        let span = totals.span(at(842, 10));

        assert_eq!(span.counted_slots, 11);
        assert!(span.counted_slots <= span.elapsed_slots);
    }

    #[test]
    fn test_leader_stages_carry_their_epoch() {
        let harness = fixture();
        let mut meters = harness.meters();
        meters.tpu.epoch_now = Some(at(842, 216_000));

        let previous = TapCounters::default();
        let current = TapCounters {
            verify: verified(4_000),
            executed: attempted(1_500),
            ..TapCounters::default()
        };
        meters.collect_waterfall(&previous, &current);

        let span = harness.published_key("summary", "epoch_span").unwrap();
        assert!(span.contains(r#""epoch":842"#), "{span}");
        assert!(span.contains(r#""slots_in_epoch":432000"#), "{span}");
        let verify = harness.published_key("summary", "verify").unwrap();
        assert!(verify.contains(r#""received":4000"#), "{verify}");
        let executed = harness.published_key("summary", "executed").unwrap();
        assert!(executed.contains(r#""attempted":1500"#), "{executed}");
    }

    #[test]
    fn test_leader_stages_wait_for_an_epoch() {
        let harness = fixture();
        let mut meters = harness.meters();
        assert!(meters.tpu.epoch_now.is_none());

        let current = TapCounters {
            verify: verified(900),
            ..TapCounters::default()
        };
        meters.collect_waterfall(&TapCounters::default(), &current);

        assert!(harness.published_key("summary", "verify").is_none());
        assert!(harness.published_key("summary", "epoch_span").is_none());
    }

    #[test]
    fn test_epoch_position_comes_from_the_working_bank() {
        let harness = fixture();
        let mut meters = harness.meters();
        let bank = harness.advance_to(64);
        meters.tpu.note_epoch(&bank);

        let position = meters.tpu.epoch_now.unwrap();
        assert_eq!(position.slot, 64);
        assert_eq!(position.epoch, bank.epoch_schedule().get_epoch(64));
        assert!(position.start_slot <= 64);
    }

    #[test]
    fn test_no_xdp_is_published_where_the_validator_reported_none() {
        let harness = fixture();
        let mut meters = harness.meters();
        meters
            .tpu
            .collect_xdp(&meters.metrics_tap, &meters.publisher);

        let published = harness.published_key("summary", "xdp").unwrap();
        assert!(published.contains(r#""value":null"#), "{published}");
    }

    #[test]
    fn test_a_reported_xdp_config_reaches_the_wire_whole() {
        let harness = fixture();
        let mut meters = harness.meters();
        let mut point = DataPoint::new("xdp-network-config");
        point.add_tag("driver", "ice");
        point.add_tag("zero_copy", "true");
        point.add_field_str("model", "Ethernet Controller E810-C for QSFP");
        meters.metrics_tap.observe_point(&point);
        meters
            .tpu
            .collect_xdp(&meters.metrics_tap, &meters.publisher);

        let published = harness.published_key("summary", "xdp").unwrap();
        assert!(published.contains(r#""zero_copy":true"#), "{published}");
        assert!(published.contains(r#""driver":"ice""#), "{published}");
        assert!(
            published.contains(r#""model":"Ethernet Controller E810-C for QSFP""#),
            "{published}"
        );
    }

    #[test]
    fn test_the_path_card_stays_once_a_port_has_ever_been_used() {
        let harness = fixture();
        let mut meters = harness.meters();
        let used = quic_tap(40);
        meters.collect_waterfall(&used, &used);

        let published = harness.published_key("summary", "quic_paths").unwrap();
        assert!(!published.contains(r#""value":null"#), "{published}");
        assert!(published.contains(r#""offered":0"#), "{published}");
    }

    #[test]
    fn test_the_vote_port_is_listed_from_its_first_connection_to_a_quiet_epoch() {
        let harness = fixture();
        let mut meters = harness.meters();
        let vote = |offered| TapCounters {
            quic_vote: QuicTotals {
                offered,
                ..QuicTotals::default()
            },
            ..quic_tap(1)
        };
        let listed = || {
            harness
                .published_key("summary", "quic_paths")
                .unwrap()
                .contains(r#""name":"tpu vote quic""#)
        };

        meters.tpu.epoch_now = Some(at(1, 100));
        meters.collect_waterfall(&vote(0), &vote(0));
        assert!(!listed(), "nothing has arrived");
        meters.collect_waterfall(&vote(0), &vote(3));
        assert!(listed(), "the first connection lists it");

        meters.tpu.epoch_now = Some(at(2, 100));
        meters.collect_waterfall(&vote(3), &vote(3));
        assert!(listed(), "the epoch had connections");

        meters.tpu.epoch_now = Some(at(3, 100));
        meters.collect_waterfall(&vote(3), &vote(3));
        assert!(!listed(), "an epoch passed with none");
        meters.collect_waterfall(&vote(3), &vote(4));
        assert!(listed(), "back at once when one arrives");
    }

    #[test]
    fn test_no_path_card_before_any_offer() {
        let harness = fixture();
        let mut meters = harness.meters();
        meters.collect_waterfall(&TapCounters::default(), &TapCounters::default());

        let published = harness.published_key("summary", "quic_paths").unwrap();
        assert!(published.contains(r#""value":null"#), "{published}");
    }

    #[test]
    fn test_an_advertised_tpu_bound_elsewhere_is_said_to_be() {
        // Behind a relayer the socket join finds no TPU port here.
        let harness = fixture();
        let mut meters = harness.meters();
        meters.sockets.sampled = true;
        let used = quic_tap(1);
        meters.collect_waterfall(&used, &used);
        let published = harness.published_key("summary", "quic_paths").unwrap();
        assert!(published.contains(r#""tpu_offhost":true"#), "{published}");

        meters.sockets.kernel_drops.insert("tpu", 0);
        meters.collect_waterfall(&used, &used);
        let published = harness.published_key("summary", "quic_paths").unwrap();
        assert!(published.contains(r#""tpu_offhost":false"#), "{published}");
    }

    #[test]
    fn test_unreadable_sockets_do_not_say_tpu_moved() {
        // Once the socket table is unreadable every port looks absent, and the honest
        // answer is that we cannot tell.
        let harness = fixture();
        let mut meters = harness.meters();
        meters.sockets.unavailable = true;
        let used = quic_tap(1);
        meters.collect_waterfall(&used, &used);

        let published = harness.published_key("summary", "quic_paths").unwrap();
        assert!(published.contains(r#""tpu_offhost":false"#), "{published}");
    }

    #[test]
    fn test_an_unread_socket_table_does_not_say_tpu_moved() {
        // The socket meter waits for a viewer, so an empty table may never have been read.
        let harness = fixture();
        let mut meters = harness.meters();
        let used = quic_tap(1);
        meters.collect_waterfall(&used, &used);

        let published = harness.published_key("summary", "quic_paths").unwrap();
        assert!(published.contains(r#""tpu_offhost":false"#), "{published}");
    }

    #[test]
    fn test_a_tick_always_publishes_the_clock() {
        let harness = fixture();
        let mut meters = harness.meters();
        meters.tick();

        assert!(
            harness
                .published_key("summary", "server_time_nanos")
                .is_some()
        );
        assert!(harness.published_key("summary", "uptime_nanos").is_some());
    }

    #[test]
    fn test_a_busy_bank_forks_costs_neither_a_sample_nor_the_heartbeat() {
        // Waiting on replay's lock would stop the clock, which looks like a dead feed.
        let harness = fixture();
        let mut meters = harness.meters();
        harness.failed_total.store(0, Ordering::Relaxed);
        meters.tick();
        sleep(Duration::from_millis(250));
        harness.advance_to(1);
        let held = harness.bank_forks.write().unwrap();

        meters.tick();
        drop(held);

        assert!(
            harness
                .published_key("summary", "server_time_nanos")
                .is_some(),
            "the heartbeat stopped while replay held the lock"
        );
        assert!(
            last_tps(&harness).is_some(),
            "the sample was skipped while replay held the lock"
        );
    }

    #[test]
    fn test_a_second_with_no_new_bank_reports_a_rate_of_nought() {
        let harness = fixture();
        let mut meters = harness.meters();
        harness.failed_total.store(0, Ordering::Relaxed);
        meters.tick();
        sleep(Duration::from_millis(20));
        meters.tick();
        let rate = last_tps(&harness).unwrap();
        assert_eq!(rate["total"].as_f64(), Some(0.0), "{rate}");
    }

    #[test]
    fn test_throughput_needs_two_samples() {
        let harness = fixture();
        let mut meters = harness.meters();
        harness.failed_total.store(0, Ordering::Relaxed);

        meters.tick();
        assert!(
            last_tps(&harness).is_none(),
            "a rate was reported from one reading"
        );

        sleep(Duration::from_millis(250));
        harness.advance_to(1);
        meters.tick();

        assert!(
            last_tps(&harness).is_some(),
            "two readings should have produced a rate"
        );
        assert!(
            harness.published_key("summary", "tps_history").is_some(),
            "the chart series is retained for a client connecting later"
        );
    }

    #[test]
    fn test_failures_are_summed_as_banks_freeze() {
        // The error counter resets per bank; differenced, it read nought whenever a bank had fewer
        // failures than the last.
        let harness = fixture();
        let mut collector = harness.collector();
        let mut meters = harness.meters();

        meters.tick();
        sleep(Duration::from_millis(250));
        harness.advance_with_failures(1, 3);
        collector.tick();
        assert_eq!(harness.failed_total.load(Ordering::Relaxed), 3);
        meters.tick();
        sleep(Duration::from_millis(250));
        harness.advance_with_failures(2, 1);
        collector.tick();
        collector.tick();
        assert_eq!(harness.failed_total.load(Ordering::Relaxed), 4);
        meters.tick();

        let tps = last_tps(&harness).unwrap();
        let failed = tps["non_vote_failed"].as_f64().unwrap();
        let non_vote = failed + tps["non_vote_success"].as_f64().unwrap();
        assert!(
            failed > 0.0,
            "one failure in the last slot was reported as none"
        );
        assert!(
            (failed - non_vote).abs() < 1e-9,
            "every non-vote transaction failed, so the two rates should agree: {tps}"
        );
    }

    #[test]
    fn test_failures_count_in_a_bank_pruned_between_samples() {
        // Under alpenglow the root follows finalization, so a bank can leave bank forks before
        // the collector drains its notification.
        let harness = fixture();
        let (sender, receiver) = crossbeam_channel::unbounded();
        let mut collector = harness.notified_collector(receiver);
        let mut meters = harness.meters();
        // The collector's first count, which the meters take as their baseline.
        sender
            .send((BankNotification::Frozen(harness.working_bank()), None))
            .unwrap();
        collector.tick();

        meters.tick();
        sleep(Duration::from_millis(250));
        let pruned = harness.advance_with_failures(1, 3);
        let bank = harness.advance_to(2);
        harness.bank_forks.write().unwrap().set_root(2, None, None);
        for bank in [pruned, bank] {
            sender.send((BankNotification::Frozen(bank), None)).unwrap();
        }
        collector.tick();
        assert_eq!(harness.failed_total.load(Ordering::Relaxed), 3);
        meters.tick();

        let tps = last_tps(&harness).unwrap();
        let failed = tps["non_vote_failed"].as_f64().unwrap();
        let non_vote = failed + tps["non_vote_success"].as_f64().unwrap();
        assert!(
            failed > 0.0,
            "the failures of a bank pruned before the sample were lost: {tps}"
        );
        assert!(
            (failed - non_vote).abs() < 1e-9,
            "every non-vote transaction failed, so the two rates should agree: {tps}"
        );
    }

    #[test]
    fn test_no_rate_is_reported_before_the_collectors_first_count() {
        let harness = fixture();
        let mut meters = harness.meters();

        meters.tick();
        sleep(Duration::from_millis(250));
        harness.advance_to(1);
        meters.tick();

        assert!(
            last_tps(&harness).is_none(),
            "a rate was reported before the collector counted"
        );
    }

    #[test]
    fn test_the_collectors_first_count_is_a_baseline_and_not_a_spike() {
        // The first count sums every bank drained at attach; differenced from nought, it put them
        // all into one second.
        let harness = fixture();
        let mut collector = harness.collector();
        let mut meters = harness.meters();

        meters.tick();
        sleep(Duration::from_millis(250));
        harness.advance_with_failures(1, 3);
        collector.tick();
        assert_eq!(harness.failed_total.load(Ordering::Relaxed), 3);
        meters.tick();
        assert!(
            last_tps(&harness).is_none(),
            "the failures drained at attach were reported as one second's"
        );

        sleep(Duration::from_millis(250));
        harness.advance_to(2);
        collector.tick();
        meters.tick();
        let tps = last_tps(&harness).unwrap();
        assert_eq!(tps["non_vote_failed"].as_f64(), Some(0.0), "{tps}");
    }

    #[test]
    fn test_a_failed_count_that_goes_back_skips_the_sample() {
        // The collector's count follows the working fork, so a fork switch can lower it.
        let harness = fixture();
        let mut meters = harness.meters();

        harness.failed_total.store(5, Ordering::Relaxed);
        meters.tick();
        sleep(Duration::from_millis(250));
        harness.advance_to(1);
        harness.failed_total.store(2, Ordering::Relaxed);
        meters.tick();

        assert!(
            last_tps(&harness).is_none(),
            "a sample was taken across a fork switch"
        );
    }

    #[test]
    fn test_a_replayed_burst_is_not_reported_as_throughput() {
        let harness = fixture();
        let mut meters = harness.meters();
        harness.failed_total.store(0, Ordering::Relaxed);

        meters.tick();
        // Thirty slots between back-to-back ticks stay above the guard for ticks up to 1.5 s
        // apart, so a loaded machine cannot slow the rate under it.
        harness.advance_to(30);
        meters.tick();

        assert!(
            last_tps(&harness).is_none(),
            "replay throughput was reported as cluster throughput"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_the_proc_walks_wait_for_a_viewer() {
        let harness = fixture();
        let mut meters = harness.meters();
        meters.tick();
        sleep(Duration::from_millis(20));
        meters.tick();
        assert!(
            harness
                .published_key("summary", "threads_history")
                .is_none(),
            "the thread walk ran with nobody watching"
        );

        let _viewer = harness.publisher.subscribe();
        meters.tick();
        assert!(
            harness
                .published_key("summary", "threads_history")
                .is_none(),
            "the threads were published before a second reading"
        );
        sleep(Duration::from_millis(20));
        meters.tick();
        let published = harness.published_key("summary", "threads_history").unwrap();
        assert!(published.contains(r#""groups":["#), "{published}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_a_thread_reading_from_before_a_gap_starts_the_minute_again() {
        let harness = fixture();
        let mut meter = ThreadMeter::default();
        meter.tick(&harness.publisher);
        sleep(Duration::from_millis(20));
        meter.tick(&harness.publisher);
        assert_eq!(meter.history.len(), 1);

        let before_gap = Instant::now().checked_sub(WATCH_GAP * 2).unwrap();
        meter.last.as_mut().unwrap().1 = before_gap;
        meter.tick(&harness.publisher);
        assert!(meter.history.is_empty() && meter.recent.is_empty());
        assert!(
            harness
                .published_key("summary", "threads_history")
                .unwrap()
                .contains("[]")
        );
        sleep(Duration::from_millis(20));
        meter.tick(&harness.publisher);
        assert_eq!(meter.history.len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_thread_names_carry_over_until_the_refresh() {
        let harness = fixture();
        let mut meter = ThreadMeter::default();
        meter.tick(&harness.publisher);
        let named = |meter: &ThreadMeter, name: &str| {
            meter
                .last
                .as_ref()
                .unwrap()
                .0
                .values()
                .any(|reading| reading.name == name)
        };
        for reading in meter.last.as_mut().unwrap().0.values_mut() {
            reading.name = "carried".to_string();
        }
        meter.tick(&harness.publisher);
        assert!(named(&meter, "carried"));

        meter.named_at = Instant::now().checked_sub(THREAD_NAMES_REFRESH);
        meter.tick(&harness.publisher);
        assert!(!named(&meter, "carried"));
    }

    fn gossip_tap(reports: u64, received_push: u64, process_us: u64, push_us: u64) -> TapCounters {
        TapCounters {
            gossip: GossipTotals {
                reports,
                received_push,
                process_us,
                push_us,
                evicted: reports,
                ..GossipTotals::default()
            },
            ..TapCounters::default()
        }
    }

    #[test]
    fn test_no_gossip_figure_until_a_report_arrives() {
        let publisher = Publisher::new();
        let mut meter = GossipMeter::new();
        meter.tick(&TapCounters::default(), &TapCounters::default(), &publisher);
        let sent = publisher.snapshot().pop().unwrap();
        assert!(sent.contains(r#""value":null"#), "{sent}");
    }

    #[test]
    fn test_gossip_rates_are_read_over_the_window() {
        let publisher = Publisher::new();
        let mut meter = GossipMeter::new();
        // One report every other second, each carrying 2,000 pushes.
        let mut previous = TapCounters::default();
        for second in 1..=12u64 {
            let reports = second / 2;
            let current = gossip_tap(reports, reports * 2_000, reports * 900, reports * 600);
            meter.tick(&previous, &current, &publisher);
            previous = current;
        }
        let sent = publisher.snapshot().pop().unwrap();
        assert!(
            sent.contains(r#""kind":"push","received":1000.0"#),
            "{sent}"
        );
        // 600 µs of pushes and 300 more of other processing per report, a report every 2 s.
        assert!(sent.contains(r#""push":0.3"#), "{sent}");
        assert!(sent.contains(r#""other":0.15"#), "{sent}");
        assert!(sent.contains(r#""evicted_last_minute":6"#), "{sent}");
    }

    #[test]
    fn test_gossip_drops_are_judged_against_packets_both_ways() {
        let publisher = Publisher::new();
        let mut meter = GossipMeter::new();
        // A report every second: 900 packets in, 100 out, 3 dropped.
        let tap = |reports: u64| TapCounters {
            gossip: GossipTotals {
                reports,
                received: reports * 900,
                sent_push: reports * 60,
                sent_prune: reports * 40,
                dropped_in: reports * 3,
                ..GossipTotals::default()
            },
            ..TapCounters::default()
        };
        let mut previous = TapCounters::default();
        for second in 1..=GOSSIP_MINUTE as u64 {
            let current = tap(second);
            meter.tick(&previous, &current, &publisher);
            previous = current;
        }
        let sent = publisher.snapshot().pop().unwrap();
        let minute = GOSSIP_MINUTE as u64;
        assert!(
            sent.contains(&format!(
                r#""dropped_last_minute":{},"packets_last_minute":{},"packets_per_second":1000.0"#,
                minute * 3,
                minute * 1_000
            )),
            "{sent}"
        );
    }

    #[test]
    fn test_gossip_that_stops_reporting_is_withdrawn() {
        let publisher = Publisher::new();
        let mut meter = GossipMeter::new();
        let reported = gossip_tap(1, 10, 0, 0);
        meter.tick(&TapCounters::default(), &reported, &publisher);
        for _ in 0..GOSSIP_RATE_WINDOW {
            meter.tick(&reported, &reported, &publisher);
        }
        let sent = publisher.snapshot().pop().unwrap();
        assert!(sent.contains(r#""value":null"#), "{sent}");
    }
}
