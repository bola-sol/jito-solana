//! The once-a-second readings: throughput, host, network, sockets, caches and
//! the TPU path. On their own thread; bank forks is taken with `try_read` and
//! a sample skipped when replay holds it.

use {
    crate::{
        collect::{CATCH_UP_SLOTS_PER_SECOND, system_time_nanos},
        context::{DashboardContext, StartProgress},
        host_stats::{self, CpuUse, HostSnapshot},
        metrics_tap::{
            AccountsTotals, BundleTotals, ExecutedTotals, MetricsTap, ProgramCacheTotals,
            QuicLevels, QuicTotals, ReplaySlotTimes, SchedulerSource, SchedulerTotals, SlotCost,
            SlotWaterfall, TapCounters, VerifyTotals, WindowedCounters, XdpConfig,
        },
        net_stats::{self, NetCounters},
        proto::{Debounced, Publisher, TOPIC_SUMMARY},
        thread_stats::{self, ThreadGroup, ThreadReading},
        udp_drops::{self, PortCounters, PortWindow},
    },
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_core::validator::ValidatorStartProgress,
    solana_gossip::contact_info::Protocol,
    solana_program_runtime::loaded_programs::MAX_LOADED_ENTRY_COUNT,
    solana_runtime::{bank::Bank, bank_forks::BankForks},
    std::{
        collections::{BTreeMap, HashMap, HashSet, VecDeque},
        path::PathBuf,
        sync::Arc,
        thread,
        time::{Duration, Instant, SystemTime},
    },
};

pub const METER_INTERVAL: Duration = Duration::from_secs(1);

const LOCK_ATTEMPTS: u32 = 5;
const LOCK_RETRY: Duration = Duration::from_millis(5);

const CHART_HISTORY: usize = 300;

const THREADS_HISTORY: usize = 60;

const THREAD_ROWS: usize = 8;

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
    pub window_seconds: u64,
    pub root: u64,
    pub layer_1: u64,
    pub layer_2: u64,
    pub layer_3: u64,
    pub xdp_dropped: u64,
    pub xdp_dropped_total: u64,
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
pub struct Host {
    pub cores: usize,
    pub load_one: f64,
    pub load_five: f64,
    pub load_fifteen: f64,
    pub threads: u64,
    pub running: u64,
    pub cpu: Option<CpuUse>,

    pub memory_total: u64,
    pub memory_available: u64,
    /// "Used" counts it, and sixty gigabytes of page cache is not a shortage.
    pub memory_reclaimable: u64,
    pub memory_free: u64,
    pub swap: Option<Swap>,
    pub process_resident: Option<u64>,
    pub process_resident_hour_ago: Option<u64>,
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
    pub window_seconds: f64,
    pub ports: Vec<QuicPort>,
    pub tpu_offhost: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IngestSummary {
    pub window_seconds: f64,
    pub paths: Vec<IngestPath>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WaterfallWindow {
    #[serde(flatten)]
    pub counts: SchedulerTotals,
    pub source: SchedulerSource,
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
    pub cpu_peak: u64,
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
        cpu_peak: peak(ReplaySlotTimes::cpu),
    })
}

struct IngestPort {
    name: &'static str,
    port: u16,
    received: Option<u64>,
    quic: bool,
}

/// `errors` resets per bank, so it is a running sum the caller keeps.
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

fn frozen_errors(bank_forks: &BankForks, counted_to: Option<Slot>) -> (u64, Option<Slot>) {
    let mut errors = 0u64;
    let mut newest = counted_to;
    for (slot, bank) in bank_forks.frozen_banks() {
        if counted_to.is_some_and(|counted_to| slot > counted_to) {
            errors = errors.saturating_add(bank.transaction_error_count());
        }
        if newest.is_none_or(|newest| slot > newest) {
            newest = Some(slot);
        }
    }
    (errors, newest)
}

#[derive(Debug, Clone, PartialEq)]
struct HostPath {
    name: String,
    path: PathBuf,
}

fn resolve_host_paths(ctx: &DashboardContext) -> Vec<HostPath> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    let ledger = ctx.blockstore.ledger_path().clone();
    if let Ok(id) = host_stats::filesystem_id(&ledger) {
        seen.insert(id);
        paths.push(HostPath {
            name: "ledger".to_owned(),
            path: ledger,
        });
    }

    let mut accounts = Vec::new();
    for path in &ctx.account_paths {
        let Ok(id) = host_stats::filesystem_id(path) else {
            continue;
        };
        if seen.insert(id) {
            accounts.push(path.clone());
        }
    }
    let numbered = accounts.len() > 1;
    for (index, path) in accounts.into_iter().enumerate() {
        let ordinal = index.saturating_add(1);
        paths.push(HostPath {
            name: if numbered {
                format!("accounts {ordinal}")
            } else {
                "accounts".to_owned()
            },
            path,
        });
    }

    if let Some(archives) = ctx
        .snapshot_config
        .as_ref()
        .map(|config| &config.full_snapshot_archives_dir)
        && let Ok(id) = host_stats::filesystem_id(archives)
        && seen.insert(id)
    {
        paths.push(HostPath {
            name: "snapshots".to_owned(),
            path: archives.clone(),
        });
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
        if let Ok(Some(device)) = host_stats::device_for(&path.path) {
            roles.entry(device).or_default().push(path.name.clone());
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

pub struct Meters {
    ctx: DashboardContext,
    publisher: Arc<Publisher>,
    startup_progress: StartProgress,
    started: SystemTime,
    metrics_tap: Arc<MetricsTap>,
    last_tap: Option<TapCounters>,

    throughput: Throughput,
    network: NetworkMeter,
    host: HostMeter,
    sockets: SocketMeter,
    shreds: ShredMeter,
    turbine: TurbineMeter,
    egress: EgressMeter,
    accounts: AccountsMeter,
    program_cache: ProgramCacheMeter,
    tpu: TpuMeter,
    threads: ThreadMeter,
}

impl Meters {
    pub fn new(
        ctx: DashboardContext,
        publisher: Arc<Publisher>,
        startup_progress: StartProgress,
        started: SystemTime,
        metrics_tap: Arc<MetricsTap>,
    ) -> Self {
        Self {
            ctx,
            publisher,
            startup_progress,
            started,
            metrics_tap,
            last_tap: None,
            throughput: Throughput::new(),
            network: NetworkMeter::default(),
            host: HostMeter::default(),
            sockets: SocketMeter::new(),
            shreds: ShredMeter::new(),
            turbine: TurbineMeter::new(),
            egress: EgressMeter::default(),
            accounts: AccountsMeter::new(),
            program_cache: ProgramCacheMeter::new(),
            tpu: TpuMeter::new(),
            threads: ThreadMeter::default(),
        }
    }

    pub fn tick(&mut self) {
        self.collect_clock();

        // Taken without waiting long: replay holds bank forks to advance, and
        // this thread exists so the readings survive a busy validator.
        let mut working_bank = None;
        for attempt in 0..LOCK_ATTEMPTS {
            if attempt > 0 {
                thread::sleep(LOCK_RETRY);
            }
            if let Ok(bank_forks) = self.ctx.bank_forks.try_read() {
                self.throughput.count_frozen(&bank_forks);
                working_bank = Some(bank_forks.working_bank());
                break;
            }
        }
        if let Some(working_bank) = working_bank {
            self.throughput.tick(&working_bank, &self.publisher);
            self.tpu.note_epoch(&working_bank);
        }

        self.network.tick(&self.publisher);
        self.tpu.collect_xdp(&self.metrics_tap, &self.publisher);
        // The `/proc` walks run only while somebody is watching. The rest is
        // cheap and keeps the charts whole for a viewer connecting.
        if self.publisher.subscriber_count() > 0 {
            self.host.tick(&self.ctx, &self.publisher);
            self.threads.tick(&self.publisher);
            let running = matches!(
                *self.startup_progress.read().unwrap(),
                ValidatorStartProgress::Running
            );
            self.sockets.tick(
                &self.ctx,
                &self.metrics_tap.counters(),
                running,
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
    errors_total: u64,
    errors_counted_to: Option<Slot>,
    history: Vec<TpsSample>,
}

impl Throughput {
    fn new() -> Self {
        Self {
            last_counters: None,
            errors_total: 0,
            errors_counted_to: None,
            history: Vec::with_capacity(CHART_HISTORY),
        }
    }

    fn count_frozen(&mut self, bank_forks: &BankForks) {
        let (errors, counted_to) = frozen_errors(bank_forks, self.errors_counted_to);
        self.errors_total = self.errors_total.saturating_add(errors);
        self.errors_counted_to = counted_to;
    }

    fn tick(&mut self, working_bank: &Bank, publisher: &Publisher) {
        let current = TxnCounters::read(working_bank, self.errors_total);
        let Some(previous) = self.last_counters.replace(current) else {
            return;
        };
        // A fork switch or a restart makes the counters incomparable.
        if current.slot <= previous.slot || current.total < previous.total {
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

        publisher.publish(TOPIC_SUMMARY, "estimated_tps", &tps);

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
    last: Option<(NetCounters, Instant)>,
    history: Vec<NetworkSample>,
    unavailable: bool,
}

impl NetworkMeter {
    fn tick(&mut self, publisher: &Publisher) {
        if self.unavailable {
            return;
        }
        let current = match net_stats::read() {
            Ok(counters) => counters,
            Err(err) => {
                self.unavailable = true;
                log::info!("dashboard: network counters unavailable, panel disabled: {err}");
                return;
            }
        };
        let now = Instant::now();
        let Some((previous, sampled_at)) = self.last.replace((current, now)) else {
            return;
        };

        let seconds = now.duration_since(sampled_at).as_secs_f64();
        if seconds <= 0.0 {
            return;
        }
        // Counters are unsigned and wrap or reset when an interface goes down,
        // so a decrease is discarded rather than read as negative throughput.
        let (Some(received), Some(sent)) = (
            current.received.checked_sub(previous.received),
            current.sent.checked_sub(previous.sent),
        ) else {
            return;
        };

        let rates = Network {
            received_per_second: (received as f64 / seconds) as u64,
            sent_per_second: (sent as f64 / seconds) as u64,
        };
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

#[derive(Default)]
struct HostMeter {
    last: Option<(HostSnapshot, Instant)>,
    unavailable: bool,
    paths: Option<Vec<HostPath>>,
    resident: VecDeque<(Instant, u64)>,
    snapshot_device: Option<Option<String>>,
}

const RESIDENT_HISTORY: Duration = Duration::from_secs(3600);
const RESIDENT_HOUR_AGO: Duration = Duration::from_secs(3300);

impl HostMeter {
    fn tick(&mut self, ctx: &DashboardContext, publisher: &Publisher) {
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
        let paths = self
            .paths
            .get_or_insert_with(|| resolve_host_paths(ctx))
            .clone();
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
        let process_resident = host_stats::process_resident().ok();
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

        let Some((previous, sampled_at)) = self.last.replace((current.clone(), now)) else {
            return;
        };
        let interval_ms = now.duration_since(sampled_at).as_secs_f64() * 1000.0;
        if interval_ms <= 0.0 {
            return;
        }
        let seconds = interval_ms / 1000.0;

        let swap_used = current
            .memory
            .swap_total
            .saturating_sub(current.memory.swap_free);
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
                    })
                })
                .collect(),
            devices: device_loads(&paths, &current, &previous, interval_ms, seconds),
        };
        publisher.publish(TOPIC_SUMMARY, "host", &host);
    }
}

#[derive(Default)]
struct ThreadMeter {
    last: Option<(HashMap<u64, ThreadReading>, Instant)>,
    pinning: HashMap<u64, Option<String>>,
    recent: VecDeque<Vec<(String, f64)>>,
    history: Vec<ThreadsSample>,
    unavailable: bool,
}

impl ThreadMeter {
    fn tick(&mut self, publisher: &Publisher) {
        if self.unavailable {
            return;
        }
        let current = match thread_stats::read() {
            Ok(threads) => threads,
            Err(err) => {
                self.unavailable = true;
                log::info!("dashboard: thread counters unavailable, panel disabled: {err}");
                return;
            }
        };
        let cores = num_cpus();
        for thread in &current {
            self.pinning.entry(thread.tid).or_insert_with(|| {
                thread_stats::cores_allowed(thread.tid)
                    .filter(|list| thread_stats::cores_in(list) < cores)
            });
        }
        let live: HashSet<u64> = current.iter().map(|thread| thread.tid).collect();
        self.pinning.retain(|tid, _| live.contains(tid));

        let now = Instant::now();
        let by_tid: HashMap<u64, ThreadReading> = current
            .iter()
            .cloned()
            .map(|thread| (thread.tid, thread))
            .collect();
        let Some((previous, sampled_at)) = self.last.replace((by_tid, now)) else {
            return;
        };
        let interval = now.duration_since(sampled_at).as_nanos() as u64;
        if interval == 0 {
            return;
        }

        let groups = thread_stats::group_shares(&previous, &current, &self.pinning, interval);
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
            threads: current.len(),
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
            published: Debounced::default(),
        }
    }

    fn tick(
        &mut self,
        ctx: &DashboardContext,
        tap: &TapCounters,
        running: bool,
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
        let ports = ingest_ports(ctx, tap);

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
        self.published
            .publish(publisher, TOPIC_SUMMARY, "ingest_paths", summary);
    }
}

fn ingest_ports(ctx: &DashboardContext, tap: &TapCounters) -> Vec<IngestPort> {
    let info = ctx.cluster_info.my_contact_info();
    [
        // Everything arriving on the TVU port is a shred, so the count the
        // shred receiver keeps is the count of what the port delivered.
        (
            "turbine",
            info.tvu(Protocol::UDP),
            Some(tap.shreds_turbine),
            false,
        ),
        ("tpu", info.tpu(Protocol::QUIC), None, true),
        (
            "tpu forwards",
            info.tpu_forwards(Protocol::QUIC),
            None,
            true,
        ),
        (
            "tpu vote",
            info.tpu_vote(Protocol::UDP),
            Some(tap.packets_tpu_vote),
            false,
        ),
        ("tpu vote quic", info.tpu_vote(Protocol::QUIC), None, true),
        ("gossip", info.gossip(), Some(tap.packets_gossip), false),
        // The one port that could have a count and does not: its receiver keeps
        // counters nothing reports. Reaching them means a change to `core`.
        (
            "serve repair",
            info.serve_repair(Protocol::UDP),
            None,
            false,
        ),
    ]
    .into_iter()
    .filter_map(|(name, addr, received, quic)| {
        Some(IngestPort {
            name,
            port: addr?.port(),
            received,
            quic,
        })
    })
    .collect()
}

/// In bytes per second; `None` until a sender has reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
struct EgressSplit {
    gossip_per_second: Option<u64>,
    repair_per_second: Option<u64>,
}

#[derive(Default)]
struct EgressMeter {
    split: EgressSplit,
    published: Debounced<EgressSplit>,
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
        self.published
            .publish(publisher, TOPIC_SUMMARY, "network_egress", self.split);
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
            published: Debounced::default(),
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
        self.published
            .publish(publisher, TOPIC_SUMMARY, "shreds", shreds);
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
            published: Debounced::default(),
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
            window_seconds: self.window.len() as u64,
            root,
            layer_1,
            layer_2,
            layer_3,
            xdp_dropped,
            xdp_dropped_total: current.xdp_dropped,
            xdp: current.retransmit_xdp,
        });
        self.published
            .publish(publisher, TOPIC_SUMMARY, "turbine", turbine);
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
            published: Debounced::default(),
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

        let totals = windowed(
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
        self.published
            .publish(publisher, TOPIC_SUMMARY, "accounts_cache", rate);
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
            published: Debounced::default(),
        }
    }

    fn tick(&mut self, previous: &TapCounters, current: &TapCounters, publisher: &Publisher) {
        let sample = current.program_cache.since(&previous.program_cache);
        let totals = windowed(&mut self.window, sample, PROGRAM_CACHE_WINDOW);

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
        self.published
            .publish(publisher, TOPIC_SUMMARY, "program_cache", cache);
    }
}

struct TpuMeter {
    waterfall_window: VecDeque<SchedulerTotals>,
    waterfall: Debounced<Option<WaterfallWindow>>,
    waterfall_source: SchedulerSource,
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
    slot_waterfalls: Debounced<Vec<SlotWaterfall>>,
    slot_costs: Debounced<Vec<SlotCost>>,
    slot_lists_seen: Option<u64>,
    replay: Debounced<Option<ReplayWindow>>,
}

impl TpuMeter {
    fn new() -> Self {
        Self {
            waterfall_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            waterfall: Debounced::default(),
            waterfall_source: SchedulerSource::default(),
            quic_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            quic_forwards_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            quic_vote_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            quic_paths: Debounced::default(),
            vote_quiet: true,
            vote_offered_at_epoch: None,
            xdp: Debounced::default(),
            epoch_now: None,
            leader_totals: LeaderTotals::default(),
            epoch_span: Debounced::default(),
            verify: Debounced::default(),
            executed: Debounced::default(),
            bundles: Debounced::default(),
            slot_waterfalls: Debounced::default(),
            slot_costs: Debounced::default(),
            slot_lists_seen: None,
            replay: Debounced::default(),
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
        self.xdp.publish(publisher, TOPIC_SUMMARY, "xdp", tap.xdp());
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
        // A stage with an empty window is absent rather than nought. Started over when the
        // scheduler changes, since the two count `received` in different units.
        let source = tap.scheduler_source();
        if source != self.waterfall_source {
            self.waterfall_window.clear();
            self.waterfall_source = source;
        }
        let scheduler = windowed(
            &mut self.waterfall_window,
            current.scheduler.since(&previous.scheduler),
            WATERFALL_WINDOW,
        );
        self.waterfall.publish(
            publisher,
            TOPIC_SUMMARY,
            "waterfall",
            (scheduler.received > 0).then_some(WaterfallWindow {
                counts: scheduler,
                source,
            }),
        );

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
            counts: windowed(window, sample, WATERFALL_WINDOW),
            levels,
            kernel_drops: kernel_drops.get(name).copied(),
        })
        .filter(|port| port.name != "tpu vote quic" || !vote_quiet)
        .collect();
        let ever_offered = current.quic.offered > 0
            || current.quic_forwards.offered > 0
            || current.quic_vote.offered > 0;
        let window_seconds = (self.quic_window.len() as f64) * METER_INTERVAL.as_secs_f64();
        self.quic_paths.publish(
            publisher,
            TOPIC_SUMMARY,
            "quic_paths",
            ever_offered.then_some(QuicPaths {
                window_seconds,
                ports,
                tpu_offhost,
            }),
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
                TOPIC_SUMMARY,
                "epoch_span",
                (verify.received > 0 || executed.attempted > 0 || bundles.received > 0)
                    .then_some(span),
            );
            self.verify.publish(
                publisher,
                TOPIC_SUMMARY,
                "verify",
                (verify.received > 0).then_some(verify),
            );
            self.executed.publish(
                publisher,
                TOPIC_SUMMARY,
                "executed",
                (executed.attempted > 0).then_some(executed),
            );
            self.bundles.publish(
                publisher,
                TOPIC_SUMMARY,
                "bundles",
                (bundles.received > 0).then_some(bundles),
            );
        }

        // Sent as lists joined by slot in the browser, since the produced block is captured on
        // another thread. Copied only when the tap's revision says a list moved.
        let revision = tap.slot_lists_revision();
        if self.slot_lists_seen != Some(revision) {
            self.slot_lists_seen = Some(revision);
            self.slot_waterfalls.publish(
                publisher,
                TOPIC_SUMMARY,
                "slot_waterfalls",
                tap.slot_waterfalls(),
            );
            self.slot_costs
                .publish(publisher, TOPIC_SUMMARY, "slot_costs", tap.slot_costs());
        }

        self.replay.publish(
            publisher,
            TOPIC_SUMMARY,
            "replay",
            replay_window(&tap.replay_slots()),
        );
    }
}

fn windowed<T: WindowedCounters>(window: &mut VecDeque<T>, sample: T, span: usize) -> T {
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
        super::*, crate::fixture::fixture, solana_metrics::datapoint::DataPoint, std::thread::sleep,
    };

    fn tap(scheduler: SchedulerTotals) -> TapCounters {
        TapCounters {
            scheduler,
            ..TapCounters::default()
        }
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
            &harness.ctx,
            &TapCounters {
                shreds_turbine: 900,
                packets_gossip: 40,
                packets_tpu_vote: 70,
                ..TapCounters::default()
            },
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
        let ports = ingest_ports(&harness.ctx, &TapCounters::default());
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
        assert!(sent.contains(r#""xdp_dropped_total":9"#), "{sent}");
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

    #[test]
    fn test_waterfall_reports_the_window() {
        let harness = fixture();
        let mut meters = harness.meters();

        let start = SchedulerTotals {
            received: 1_000,
            buffered: 40,
            ..SchedulerTotals::default()
        };
        let next = SchedulerTotals {
            received: 1_100,
            buffered: 50,
            ..SchedulerTotals::default()
        };
        let last = SchedulerTotals {
            received: 1_250,
            buffered: 65,
            ..SchedulerTotals::default()
        };
        meters.collect_waterfall(&tap(start), &tap(next));
        meters.collect_waterfall(&tap(next), &tap(last));

        let published = harness.published_key("summary", "waterfall").unwrap();
        assert!(published.contains(r#""received":250"#), "{published}");
        assert!(published.contains(r#""buffered":25"#), "{published}");
    }

    #[test]
    fn test_idle_scheduler_reports_nothing() {
        let harness = fixture();
        let mut meters = harness.meters();
        meters.collect_waterfall(&TapCounters::default(), &TapCounters::default());

        let published = harness.published_key("summary", "waterfall").unwrap();
        assert!(published.contains(r#""value":null"#), "{published}");
    }

    #[test]
    fn test_a_changeover_restarts_the_waterfall_window() {
        // The two schedulers count `received` in different units, so a window
        // spanning a handover would add two units.
        let harness = fixture();
        let mut meters = harness.meters();

        let mut previous = SchedulerTotals::default();
        for step in 1..=3u64 {
            let current = SchedulerTotals {
                received: step.saturating_mul(10),
                ..SchedulerTotals::default()
            };
            meters.collect_waterfall(&tap(previous), &tap(current));
            previous = current;
        }
        assert_eq!(meters.tpu.waterfall_window.len(), 3);

        meters.tpu.waterfall_source = SchedulerSource::Bam;
        let current = SchedulerTotals {
            received: 145,
            ..SchedulerTotals::default()
        };
        meters.collect_waterfall(&tap(previous), &tap(current));

        assert_eq!(meters.tpu.waterfall_window.len(), 1);
        assert_eq!(meters.tpu.waterfall_source, SchedulerSource::Scheduler);
        let published = harness.published_key("summary", "waterfall").unwrap();
        assert!(published.contains(r#""source":"scheduler""#), "{published}");
        assert!(published.contains(r#""received":115"#), "{published}");
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
        BundleTotals { received, packets }
    }

    #[test]
    fn test_bundles_are_summed_over_the_epoch() {
        let mut totals = LeaderTotals::default();
        totals.add(at(842, 10), verified(100), attempted(40), bundled(6, 21));
        totals.add(at(842, 20), verified(0), attempted(0), bundled(0, 0));
        totals.add(at(842, 30), verified(70), attempted(25), bundled(4, 9));

        assert_eq!(totals.bundles, bundled(10, 30));
        assert_eq!(totals.executed.attempted, 65);
    }

    #[test]
    fn test_bundles_start_over_with_the_stage() {
        let mut totals = LeaderTotals::default();
        totals.add(
            at(842, 400_000),
            verified(900),
            attempted(300),
            bundled(80, 240),
        );
        totals.add(at(843, 3), verified(11), attempted(4), bundled(1, 2));

        assert_eq!(totals.bundles, bundled(1, 2));
        assert_eq!(totals.epoch, Some(843));
    }

    #[test]
    fn test_leader_totals_add_the_whole_epoch() {
        let mut totals = LeaderTotals::default();
        totals.add(
            at(842, 10),
            verified(100),
            attempted(40),
            BundleTotals::default(),
        );
        totals.add(
            at(842, 20),
            verified(0),
            attempted(0),
            BundleTotals::default(),
        );
        totals.add(
            at(842, 30),
            verified(70),
            attempted(25),
            BundleTotals::default(),
        );

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
            BundleTotals::default(),
        );
        totals.add(
            at(843, 3),
            verified(11),
            attempted(4),
            BundleTotals::default(),
        );

        assert_eq!(totals.epoch, Some(843));
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
    fn test_the_waterfall_window_forgets_what_falls_out_of_it() {
        let harness = fixture();
        let mut meters = harness.meters();

        let mut previous = SchedulerTotals::default();
        for step in 1..=WATERFALL_WINDOW.saturating_add(10) {
            let current = SchedulerTotals {
                received: (step as u64).saturating_mul(10),
                ..SchedulerTotals::default()
            };
            meters.collect_waterfall(&tap(previous), &tap(current));
            previous = current;
        }

        assert_eq!(meters.tpu.waterfall_window.len(), WATERFALL_WINDOW);
        let published = harness.published_key("summary", "waterfall").unwrap();
        let expected = (WATERFALL_WINDOW as u64).saturating_mul(10);
        assert!(
            published.contains(&format!(r#""received":{expected}"#)),
            "{published}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_the_threads_are_published_from_the_second_tick() {
        let harness = fixture();
        let _viewer = harness.publisher.subscribe();
        let mut meters = harness.meters();
        meters.tick();
        assert!(
            harness
                .published_key("summary", "threads_history")
                .is_none()
        );
        sleep(Duration::from_millis(20));
        meters.tick();
        let published = harness.published_key("summary", "threads_history").unwrap();
        assert!(published.contains(r#""groups":["#), "{published}");
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
    fn test_a_busy_bank_forks_costs_a_sample_and_not_the_heartbeat() {
        // The reason this thread takes bank forks with `try_read`: waiting would stop
        // the clock, which looks like a dead feed.
        let harness = fixture();
        let mut meters = harness.meters();
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
            harness.published_key("summary", "estimated_tps").is_none(),
            "the sample should have been skipped, not waited for"
        );
    }

    #[test]
    fn test_throughput_needs_two_samples_with_a_slot_between_them() {
        let harness = fixture();
        let mut meters = harness.meters();

        meters.tick();
        assert!(
            harness.published_key("summary", "estimated_tps").is_none(),
            "a rate was reported from one reading"
        );

        sleep(Duration::from_millis(250));
        harness.advance_to(1);
        meters.tick();

        assert!(
            harness.published_key("summary", "estimated_tps").is_some(),
            "two readings a slot apart should have produced a rate"
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
        let mut meters = harness.meters();

        meters.tick();
        sleep(Duration::from_millis(250));
        harness.advance_with_failures(1, 3);
        meters.tick();
        sleep(Duration::from_millis(250));
        harness.advance_with_failures(2, 1);
        meters.tick();

        let message = harness.published_key("summary", "estimated_tps").unwrap();
        let tps: serde_json::Value = serde_json::from_str(&message).unwrap();
        let failed = tps["value"]["non_vote_failed"].as_f64().unwrap();
        let non_vote = failed + tps["value"]["non_vote_success"].as_f64().unwrap();
        assert!(
            failed > 0.0,
            "one failure in the last slot was reported as none"
        );
        assert!(
            (failed - non_vote).abs() < 1e-9,
            "every non-vote transaction failed, so the two rates should agree: {message}"
        );
    }

    #[test]
    fn test_a_replayed_burst_is_not_reported_as_throughput() {
        let harness = fixture();
        let mut meters = harness.meters();

        meters.tick();
        // No sleep: two ticks in immediate succession put the rate orders of
        // magnitude above the guard.
        harness.advance_to(1);
        meters.tick();

        assert!(
            harness.published_key("summary", "estimated_tps").is_none(),
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
        sleep(Duration::from_millis(20));
        meters.tick();
        assert!(
            harness
                .published_key("summary", "threads_history")
                .is_some(),
            "a viewer attached and the thread walk still did not run"
        );
    }
}
