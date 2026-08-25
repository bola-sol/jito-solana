//! The once-a-second readings: throughput, host network, socket ingest, clock.
//!
//! These run on their own thread, apart from the slot sampling in [`crate::collect`].
//! Nothing here touches the blockstore or the accounts database, so a validator
//! busy writing a snapshot can slow the slot work right down without taking the
//! rest of the dashboard with it. Before the split, one blocked read stalled
//! every panel at once, and because a stalled panel keeps showing its last value
//! it looked no different from a live one.
//!
//! The transaction sample needs a bank and so needs bank forks, which is the one
//! lock replay holds to advance. It is taken with `try_read`: if replay has it,
//! that second's sample is skipped rather than the thread waiting. A gap in a
//! chart is honest, a stalled heartbeat is not.

use {
    crate::{
        collect::{CATCH_UP_SLOTS_PER_SECOND, system_time_nanos},
        context::{DashboardContext, StartupProgressFn},
        metrics_tap::{
            AccountsTotals, ExecutedTotals, MetricsTap, ProgramCacheTotals, QuicTotals,
            ReplaySlotTimes, SchedulerSource, SchedulerTotals, SlotCost, SlotWaterfall,
            TapCounters, VerifyTotals, WindowedCounters,
        },
        net_stats::{self, NetCounters},
        proto::{Debounced, Publisher, TOPIC_SUMMARY},
        udp_drops::{self, PortCounters, PortWindow},
    },
    serde::Serialize,
    solana_clock::Slot,
    solana_gossip::contact_info::Protocol,
    solana_program_runtime::loaded_programs::MAX_LOADED_ENTRY_COUNT,
    solana_runtime::bank::Bank,
    std::{
        collections::{HashMap, VecDeque},
        sync::Arc,
        time::{Duration, Instant, SystemTime},
    },
};

/// How often these readings are taken.
pub const METER_INTERVAL: Duration = Duration::from_secs(1);

/// Samples retained for the transaction and network charts. At one a second
/// this is twenty-five minutes, against a chart that shows one.
const CHART_HISTORY: usize = 1500;

/// Window the reported socket drops accumulate over. Long enough that a burst
/// stays visible for a while after it stops, short enough that it clears.
const DROPS_WINDOW: Duration = Duration::from_secs(60);

/// Samples the accounts cache hit rate is taken over, a minute of them, to
/// match the program cache beside it.
const ACCOUNTS_CACHE_WINDOW: usize = 60;

/// Samples the shred figures are taken over. Longer than the caches: repair is
/// bursty by nature — a moment of packet loss and a handful of requests follow —
/// and a minute of it says more about the last burst than about the connection.
const SHREDS_WINDOW: usize = 300;

/// Samples the transaction waterfall is summed over.
///
/// Five minutes, matching the shreds and for the same reason. The interesting
/// half of the waterfall only moves while this validator is leader, which for
/// most nodes is four slots every couple of minutes; a minute of it would be
/// empty more often than it was not.
const WATERFALL_WINDOW: usize = 300;

/// Samples the program cache hit rate is taken over, a minute of them.
///
/// One sample is one slot's worth of loads and often only a handful, so a rate
/// taken from it alone swings between nothing and everything. Summed across the
/// window it is a rate over real work rather than over the last three lookups.
const PROGRAM_CACHE_WINDOW: usize = 60;

/// Where this validator's shreds came from over the window.
///
/// Turbine should deliver nearly all of them. Repair is what a validator falls
/// back to for what never arrived, so a rising share of it means the cluster is
/// not reaching this node — which is the usual state of an unstaked or badly
/// connected one, and worth seeing before the skip rate says so.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Shreds {
    /// Shreds received over the window, however they arrived.
    pub received: u64,
    /// Of those, the ones this validator had to ask another node for.
    pub repaired: u64,
    /// The share it had to ask for, in `[0, 1]`.
    pub repair_rate: f64,
}

/// How often an account replay needed was already in memory.
///
/// The accounts database reports these once a second with its own counters
/// reset as it does, so each point is a second's work and the window is the sum
/// of them — a rate over the last minute rather than since startup.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountsCache {
    /// Reads in the window, hits and misses together.
    pub read: u64,
    /// Of those, the ones already cached, in `[0, 1]`.
    pub hit_rate: f64,
    /// Accounts dropped from the cache over the window.
    pub evictions: u64,
    /// What the cache is holding right now.
    pub cache_bytes: u64,
    pub cache_entries: u64,

    /// Where reads were answered from, over the window. The third is the only
    /// one that touches a file, and is the closest thing here to a disk read
    /// rate — counted in accounts, because nothing counts the bytes.
    pub from_write_cache: u64,
    pub from_read_cache: u64,
    pub from_storage: u64,

    /// Accounts written out to storage over the window, and their size. Unlike
    /// the read side this does have a byte figure.
    pub stored_accounts: u64,
    pub stored_bytes: u64,
    /// Seconds the window actually covers, so the panel can turn the totals
    /// above into rates without assuming it is full.
    pub window_seconds: f64,

    /// How much storage exists, how much of it is still live, and how many
    /// files it is spread over.
    ///
    /// `None` until the accounts database has reported once, which it does on a
    /// clean cycle rather than a timer — so this is absent for the first while
    /// after startup rather than nought.
    pub disk: Option<AccountsDisk>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountsDisk {
    /// Bytes still referenced by a live account.
    pub used: u64,
    /// Bytes the storage files occupy.
    pub allocated: u64,
    /// The difference: dead account data still on disk, which is what shrink
    /// reclaims. Agave shrinks continuously as candidates appear rather than on
    /// a schedule, so there is no next-compaction time to count down to.
    pub fragmented: u64,
    pub storages: u64,
}

/// How often replay found a program already compiled.
///
/// The counters behind this are reset for each bank, so what is reported is the
/// window's own totals rather than anything the cache holds: `looked_up` is how
/// many program loads were seen in the last minute, not since startup.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProgramCache {
    /// Loads seen in the window, hits and misses together.
    pub looked_up: u64,
    pub hits: u64,
    pub misses: u64,
    /// Of those, the ones already compiled and in the cache, in `[0, 1]`.
    pub hit_rate: f64,
    /// Compiled programs dropped from the cache over the window, which is the
    /// usual reason a hit rate falls.
    pub evictions: u64,
    /// An evicted program being compiled again: the cost of an eviction, paid
    /// on the next block that wants it.
    pub reloads: u64,
    /// Programs added, and additions thrown away because the fork they were
    /// for had gone by the time they finished compiling.
    pub insertions: u64,
    pub lost_insertions: u64,
    /// Something already cached compiled a second time by mistake.
    pub replacements: u64,
    /// Compiled, used once, and evicted — cache space spent for nothing.
    pub one_hit_wonders: u64,
    /// Dropped because their fork was abandoned, and because they were not
    /// recompiled for the incoming epoch. Neither is a fault; both are the
    /// cache keeping up with the chain.
    pub prunes_orphan: u64,
    pub prunes_environment: u64,
    /// The most entries seen loaded at any eviction in the window, and the
    /// limit that eviction is keeping them under.
    ///
    /// A high-water mark rather than a current reading: the figure behind it is
    /// only written when an eviction runs, so on any slot that evicted nothing
    /// it reads nought. `None` until an eviction has happened at all.
    pub peak_entries: Option<u64>,
    pub entry_limit: u64,
}

/// A window of `(hits, misses, evictions)` samples as `(asked, rate, evicted)`,
/// or `None` while it has been asked nothing at all.
///
/// Nothing rather than zero: a validator between blocks has looked nothing up,
/// and a hit rate of nought reads as a cache that is failing rather than one
/// that has not been asked.
///
/// The accounts read cache only, now. The program cache had this too until it
/// grew enough figures to want a shape of its own.
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

/// Host interface throughput, in bytes per second.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Network {
    pub received_per_second: u64,
    pub sent_per_second: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NetworkSample {
    pub timestamp_nanos: u64,
    #[serde(flatten)]
    pub rates: Network,
}

/// Kernel-side receive health for one of this validator's UDP ports.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IngestPath {
    /// Which service the port belongs to, used as the row's label and key.
    pub name: &'static str,
    pub port: u16,
    /// Drops over the trailing window, which is what says whether the loss is
    /// happening now. Always sent, including as zero: a figure that appeared
    /// only when something was wrong would leave a healthy row and an
    /// unmeasured one looking the same.
    pub drops_recent: u64,
    /// Drops since the validator finished starting.
    pub drops_total: u64,
    /// Bytes waiting unread at the instant of the sample.
    pub queued_bytes: u64,

    /// Packets the port handed over, across the same window and from the same
    /// instant as the two figures above.
    ///
    /// Missing rather than zero for a port with no receiver reporting one, and
    /// the difference matters: nought received alongside drops would say every
    /// packet was lost. Three of the six ports are in that position — the two
    /// QUIC ones, whose counters count transactions rather than datagrams, and
    /// serve repair, whose receiver keeps counters nothing reports.
    ///
    /// Sent so the panel can show a share of the traffic. Drops and received
    /// are disjoint — a dropped datagram never reached the receiver — so their
    /// sum is what arrived at the socket, and the loss is one over that sum.
    ///
    /// `Some(0)` is possible and is not the same as `None`. The counters behind
    /// these arrive as metrics points, and a point is only submitted when info
    /// logging is on for the crate that submits it, so an operator running the
    /// validator quieter than default leaves them at nought. That reads as a
    /// port that received nothing, which alongside any drops at all works out
    /// as total loss — so the panel shows a share only where something was
    /// actually counted.
    pub received_recent: Option<u64>,
    pub received_total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IngestSummary {
    /// What `drops_recent` actually spans, which is short until the window has
    /// filled. Sent so the panel can name the period it is showing rather than
    /// claim a minute it has not yet watched.
    pub window_seconds: f64,
    pub paths: Vec<IngestPath>,
}

/// What replay did with the last few hundred slots.
///
/// Every duration is microseconds, and every one but the two peaks is a mean
/// per slot. Means rather than totals because the question is what one slot
/// costs, which is the figure that compares against the time a slot lasts.
///
/// The two peaks are the largest that any single slot in the window reached,
/// taken from the per-slot sums. Not from the largest each field reached
/// separately: those maxima land on different slots, and adding them would
/// describe a slot that never happened.
/// The live waterfall, and which scheduler produced the counts in it.
///
/// The source is carried for the same reason the per-slot waterfalls carry it:
/// it decides what `received` is counting, and therefore whether the rows below
/// can be drawn as shares of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WaterfallWindow {
    #[serde(flatten)]
    pub counts: SchedulerTotals,
    pub source: SchedulerSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ReplayWindow {
    /// Slots behind the figures, so the panel can name what it is showing
    /// rather than claim a window it has not yet filled.
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

/// Averages a window of replayed slots, and finds its worst.
///
/// `None` until a slot has been replayed, so the panel stays absent rather than
/// drawing a card of noughts on a validator whose replay has not started or
/// whose log filter is quiet enough to keep this point from arriving at all.
fn replay_window(slots: &[ReplaySlotTimes]) -> Option<ReplayWindow> {
    let count = u64::try_from(slots.len()).ok().filter(|n| *n > 0)?;
    // Checked rather than plain division. The filter above already rules the
    // divisor out of being nought, but the workspace denies bare arithmetic and
    // a guard three lines up is not something the lint can see.
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

/// One row's two identities: the port the kernel counts drops against, and the
/// validator's own count of what that port delivered where there is one.
///
/// Internal to the collection below rather than sent anywhere. It exists so the
/// join between the two sources happens once, in the table that knows both.
struct IngestPort {
    name: &'static str,
    port: u16,
    /// Running total of packets delivered, or `None` for a port whose traffic
    /// nothing counts in datagrams.
    received: Option<u64>,
}

/// Cumulative transaction counters read off a bank, used to derive per-slot
/// deltas. Bank counters are cumulative along a fork, so the difference between
/// two banks on the same fork is the work done between them.
#[derive(Clone, Copy)]
struct TxnCounters {
    slot: Slot,
    total: u64,
    non_vote: u64,
    errors: u64,
    sampled_at: Instant,
}

impl TxnCounters {
    fn read(bank: &Bank) -> Self {
        Self {
            slot: bank.slot(),
            total: bank.transaction_count(),
            non_vote: bank.non_vote_transaction_count_since_restart(),
            errors: bank.transaction_error_count(),
            sampled_at: Instant::now(),
        }
    }
}

pub struct Meters {
    ctx: DashboardContext,
    publisher: Arc<Publisher>,
    /// Read directly rather than shared with the collector, so the two threads
    /// need nothing between them.
    startup_progress: StartupProgressFn,

    last_counters: Option<TxnCounters>,
    tps_history: Vec<TpsSample>,

    last_net: Option<(NetCounters, Instant)>,
    net_history: Vec<NetworkSample>,
    /// Set once the counters prove unreadable, so the failure is logged once
    /// rather than every second.
    net_unavailable: bool,

    /// Trailing history of per-port drop totals, so a startup burst ages out.
    drops_window: PortWindow,
    /// Per-port drops as of the moment the validator finished starting.
    ///
    /// Reported totals are counted from here. Most of a validator's drops
    /// happen during startup, when gossip's first view of the cluster arrives
    /// faster than it can be read, and carrying that burst for the life of the
    /// process left a figure that said nothing about how the validator is
    /// running now.
    drops_baseline: Option<HashMap<u16, u64>>,
    /// The same window and the same baseline for what each port delivered,
    /// which is the other term in the share of traffic a row lost.
    ///
    /// Kept apart from the drop figures rather than folded in beside them
    /// because they come from a different source and cover a different set of
    /// ports: three of the six have no count at all, and a single structure
    /// would have to carry a hole for them.
    received_window: PortWindow,
    received_baseline: Option<HashMap<u16, u64>>,
    /// Last counters seen for each reported port.
    ///
    /// `/proc/net/udp` is not read atomically. The kernel formats it lazily as
    /// it is read, and a validator opens and closes UDP sockets constantly, so
    /// a table that shifts between one buffer fill and the next can leave a
    /// socket out of the snapshot even though it is still bound. Reading only
    /// the current snapshot made rows vanish for a tick and the panel jump.
    known_sockets: HashMap<u16, PortCounters>,
    /// As `net_unavailable`, for `/proc/net/udp`. The two files fail
    /// independently: a container can expose one and not the other.
    drops_unavailable: bool,
    ingest_paths: Debounced<IngestSummary>,

    /// One interval's worth of the program cache's counters per sample, and
    /// beside it the level readings, which are peaked rather than summed.
    program_cache_window: VecDeque<ProgramCacheTotals>,
    program_cache_levels: VecDeque<u64>,
    program_cache: Debounced<Option<ProgramCache>>,

    /// Running totals as of the last reading, so each sample is the difference.
    metrics_tap: Arc<MetricsTap>,
    last_tap: Option<TapCounters>,
    accounts_cache_window: VecDeque<(u64, u64, u64)>,
    /// One interval's worth of the accounts database's own counters per sample.
    accounts_window: VecDeque<AccountsTotals>,
    accounts_cache: Debounced<Option<AccountsCache>>,
    /// `(turbine, repair)` shreds per sample.
    shreds_window: VecDeque<(u64, u64)>,
    shreds: Debounced<Option<Shreds>>,
    /// One interval's worth of each stage's counters per sample.
    ///
    /// Four windows rather than one, published under four keys, because the
    /// four stages do not reconcile into a single flow: each is instrumented on
    /// its own terms, reports on its own cadence, and hands on a population the
    /// next does not quite receive. Drawn as four sections, each internally
    /// consistent; run together as one chain they would imply an arithmetic
    /// that does not hold.
    waterfall_window: VecDeque<SchedulerTotals>,
    waterfall: Debounced<Option<WaterfallWindow>>,
    /// Which scheduler the samples in that window came from, so that a
    /// changeover can be noticed rather than summed through.
    waterfall_source: SchedulerSource,
    quic_window: VecDeque<QuicTotals>,
    quic: Debounced<Option<QuicTotals>>,
    verify_window: VecDeque<VerifyTotals>,
    verify: Debounced<Option<VerifyTotals>>,
    executed_window: VecDeque<ExecutedTotals>,
    executed: Debounced<Option<ExecutedTotals>>,
    slot_waterfalls: Debounced<Vec<SlotWaterfall>>,
    slot_costs: Debounced<Vec<SlotCost>>,
    replay: Debounced<Option<ReplayWindow>>,
}

impl Meters {
    pub fn new(
        ctx: DashboardContext,
        publisher: Arc<Publisher>,
        startup_progress: StartupProgressFn,
        metrics_tap: Arc<MetricsTap>,
    ) -> Self {
        Self {
            ctx,
            publisher,
            startup_progress,
            last_counters: None,
            tps_history: Vec::with_capacity(CHART_HISTORY),
            last_net: None,
            net_history: Vec::new(),
            net_unavailable: false,
            drops_window: PortWindow::new(DROPS_WINDOW),
            drops_baseline: None,
            received_window: PortWindow::new(DROPS_WINDOW),
            received_baseline: None,
            known_sockets: HashMap::new(),
            drops_unavailable: false,
            ingest_paths: Debounced::default(),
            program_cache_window: VecDeque::with_capacity(PROGRAM_CACHE_WINDOW),
            program_cache_levels: VecDeque::with_capacity(PROGRAM_CACHE_WINDOW),
            program_cache: Debounced::default(),
            metrics_tap,
            last_tap: None,
            accounts_cache_window: VecDeque::with_capacity(ACCOUNTS_CACHE_WINDOW),
            accounts_window: VecDeque::with_capacity(ACCOUNTS_CACHE_WINDOW),
            accounts_cache: Debounced::default(),
            shreds_window: VecDeque::with_capacity(SHREDS_WINDOW),
            shreds: Debounced::default(),
            waterfall_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            waterfall: Debounced::default(),
            waterfall_source: SchedulerSource::default(),
            quic_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            quic: Debounced::default(),
            verify_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            verify: Debounced::default(),
            executed_window: VecDeque::with_capacity(WATERFALL_WINDOW),
            executed: Debounced::default(),
            slot_waterfalls: Debounced::default(),
            slot_costs: Debounced::default(),
            replay: Debounced::default(),
        }
    }

    pub fn tick(&mut self) {
        self.collect_clock();

        // Taken without waiting. Replay holds bank forks to advance, and this
        // thread exists so that the readings below survive a validator too busy
        // to answer: blocking here would give that up for one sample.
        let working_bank = self
            .ctx
            .bank_forks
            .try_read()
            .ok()
            .map(|bank_forks| bank_forks.working_bank());
        if let Some(working_bank) = working_bank {
            self.collect_tps(&working_bank);
        }

        self.collect_network();
        self.collect_ingest_paths();
        self.collect_from_metrics();
    }

    /// Publishes how often an account replay needed was already in memory.
    ///
    /// The totals behind this only climb, so a sample is the difference against
    /// the last reading. The first reading has nothing to difference against and
    /// establishes the baseline instead: counted from zero it would report every
    /// account read since the validator started as though it happened in one
    /// second.
    fn collect_from_metrics(&mut self) {
        let current = self.metrics_tap.counters();
        let Some(previous) = self.last_tap.replace(current) else {
            return;
        };
        self.collect_shreds(&previous, &current);
        self.collect_waterfall(&previous, &current);
        self.collect_program_cache(&previous, &current);

        self.accounts_cache_window.push_back((
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
        while self.accounts_cache_window.len() > ACCOUNTS_CACHE_WINDOW {
            self.accounts_cache_window.pop_front();
        }

        let totals = windowed(
            &mut self.accounts_window,
            current.accounts.since(&previous.accounts),
            ACCOUNTS_CACHE_WINDOW,
        );
        // What the window actually spans, not what it will span once full. A
        // rate taken against the full minute would read low for the first one.
        let window_seconds = self.accounts_cache_window.len() as f64 * METER_INTERVAL.as_secs_f64();

        // Absent rather than zeroed until the accounts database has reported
        // its storage once, which happens on a clean cycle rather than a timer.
        // Nought allocated would read as a validator holding no accounts.
        let disk = (current.accounts_storage_bytes > 0).then(|| AccountsDisk {
            used: current.accounts_storage_alive_bytes,
            allocated: current.accounts_storage_bytes,
            fragmented: current
                .accounts_storage_bytes
                .saturating_sub(current.accounts_storage_alive_bytes),
            storages: current.accounts_storage_count,
        });

        let rate = cache_rate(&self.accounts_cache_window).map(|(read, hit_rate, evictions)| {
            AccountsCache {
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
            }
        });
        self.accounts_cache
            .publish(&self.publisher, TOPIC_SUMMARY, "accounts_cache", rate);
    }

    /// Publishes how much of what arrived had to be asked for.
    fn collect_shreds(&mut self, previous: &TapCounters, current: &TapCounters) {
        self.shreds_window.push_back((
            current
                .shreds_turbine
                .saturating_sub(previous.shreds_turbine),
            current.shreds_repair.saturating_sub(previous.shreds_repair),
        ));
        while self.shreds_window.len() > SHREDS_WINDOW {
            self.shreds_window.pop_front();
        }

        let mut turbine = 0u64;
        let mut repaired = 0u64;
        for (sample_turbine, sample_repair) in &self.shreds_window {
            turbine = turbine.saturating_add(*sample_turbine);
            repaired = repaired.saturating_add(*sample_repair);
        }

        let received = turbine.saturating_add(repaired);
        // Nothing rather than nought while no shreds have arrived at all, which
        // is a validator that is not receiving rather than one receiving
        // perfectly.
        let shreds = (received > 0).then(|| Shreds {
            received,
            repaired,
            repair_rate: repaired as f64 / received as f64,
        });
        self.shreds
            .publish(&self.publisher, TOPIC_SUMMARY, "shreds", shreds);
    }

    /// Publishes where the transactions handed to the banking stage went.
    ///
    /// The scheduler counts all of this already and reports it once a second
    /// with its counters reset as it does, so a sample is one second of work
    /// and the window is their sum. That makes the published figures counts
    /// over the window rather than anything the scheduler is holding — a
    /// standing queue depth is not in here, and could not be got from these.
    fn collect_waterfall(&mut self, previous: &TapCounters, current: &TapCounters) {
        // Nothing rather than a column of noughts, for each of the four. Every
        // one of these points is submitted only when its stage had something to
        // say, so an empty window is a stage nothing has been sent — which is
        // not the same as one throwing everything away, and a panel of zeroes
        // reads as the second.
        // Started over when the scheduler behind these changes, which on a
        // build running two of them means one handed the block production over
        // to the other. Their `received` is not the same measurement — one
        // counts packets, the other the batches it was sent — so a window
        // spanning the changeover would add two units and label the total as
        // whichever reported last. Five minutes of that is worse than five
        // minutes of refilling.
        let source = self.metrics_tap.scheduler_source();
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
            &self.publisher,
            TOPIC_SUMMARY,
            "waterfall",
            (scheduler.received > 0).then_some(WaterfallWindow {
                counts: scheduler,
                source,
            }),
        );

        let quic = windowed(
            &mut self.quic_window,
            current.quic.since(&previous.quic),
            WATERFALL_WINDOW,
        );
        self.quic.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "quic",
            (quic.handed_on > 0 || quic.queue_full > 0).then_some(quic),
        );

        let verify = windowed(
            &mut self.verify_window,
            current.verify.since(&previous.verify),
            WATERFALL_WINDOW,
        );
        self.verify.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "verify",
            (verify.received > 0).then_some(verify),
        );

        let executed = windowed(
            &mut self.executed_window,
            current.executed.since(&previous.executed),
            WATERFALL_WINDOW,
        );
        self.executed.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "executed",
            (executed.attempted > 0).then_some(executed),
        );

        // The per-slot points ride along here rather than being joined onto the
        // produced blocks before sending. Those are built on the other thread
        // and published only when one is captured, and these arrive from the
        // scheduler moments after the bank freezes — close enough that either
        // could be first. Sent as their own list and joined by slot in the
        // browser, neither has to wait for the other, and a point that arrives
        // late is picked up on the next tick rather than missed for good.
        //
        // Debounced, so the usual tick between leader slots sends nothing: the
        // list only changes when this validator has produced.
        self.slot_waterfalls.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "slot_waterfalls",
            self.metrics_tap.slot_waterfalls(),
        );

        // Sent as its own list and joined by slot in the browser, the same way
        // the waterfalls are, and for the same reason: the cost tracker reports
        // as the bank freezes while the produced block is captured on another
        // thread, so either can arrive first.
        self.slot_costs.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "slot_costs",
            self.metrics_tap.slot_costs(),
        );

        // Averaged over the slots held rather than over a period of seconds.
        // Slots are the unit the work arrives in, and a window counted in them
        // holds the same number of samples whatever the cluster's pace.
        self.replay.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "replay",
            replay_window(&self.metrics_tap.replay_slots()),
        );
    }

    fn collect_clock(&self) {
        let now = SystemTime::now();
        self.publisher
            .publish(TOPIC_SUMMARY, "server_time_nanos", &system_time_nanos(now));
        let uptime = now
            .duration_since(self.ctx.start_time)
            .unwrap_or_default()
            .as_nanos() as u64;
        self.publisher
            .publish(TOPIC_SUMMARY, "uptime_nanos", &uptime);
    }

    /// Publishes how often replay found a program already compiled.
    ///
    /// The cache is shared across banks and its counters are reset whenever a
    /// bank is made from a parent, so a reading is what has been looked up since
    /// the current slot began rather than a running total. That makes the counts
    /// themselves useless on their own — they fall back to nothing several times
    /// a second — and the rate the only figure worth reporting. Summing a
    /// minute of samples gives it enough work to be steady; at a sample a second
    /// against slots of four hundred milliseconds, each one lands in a different
    /// slot, so nothing is counted twice.
    ///
    /// The cache sits behind a lock the runtime writes to. Taken with `try_read`
    /// for the same reason bank forks is: a dropped sample is cheaper than
    /// holding up replay to draw a number.
    fn collect_program_cache(&mut self, previous: &TapCounters, current: &TapCounters) {
        let sample = current.program_cache.since(&previous.program_cache);
        let totals = windowed(&mut self.program_cache_window, sample, PROGRAM_CACHE_WINDOW);

        // The level is not differenced — it is where the cache stood, not what
        // happened — so it is kept as its own window and read as a peak.
        self.program_cache_levels
            .push_back(current.program_cache_water_level);
        while self.program_cache_levels.len() > PROGRAM_CACHE_WINDOW {
            self.program_cache_levels.pop_front();
        }
        let peak_entries = self
            .program_cache_levels
            .iter()
            .copied()
            .max()
            .filter(|peak| *peak > 0);

        let looked_up = totals.hits.saturating_add(totals.misses);
        // Nothing rather than nought: a validator between blocks has looked
        // nothing up, and a hit rate of zero reads as a cache that is failing
        // rather than one that has not been asked.
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
        self.program_cache
            .publish(&self.publisher, TOPIC_SUMMARY, "program_cache", cache);
    }

    fn collect_tps(&mut self, working_bank: &Bank) {
        let current = TxnCounters::read(working_bank);
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

        // While catching up, replay chews through slots far faster than the
        // cluster produces them, and dividing a whole backlog of transactions
        // by one second reports tens of thousands of TPS. That is replay
        // throughput, not network throughput, and one such sample pins the
        // chart's scale for as long as it stays in view.
        let slots_per_second = current.slot.saturating_sub(previous.slot) as f64 / seconds;
        if slots_per_second > CATCH_UP_SLOTS_PER_SECOND {
            return;
        }

        let total = current.total.saturating_sub(previous.total) as f64 / seconds;
        let non_vote = current.non_vote.saturating_sub(previous.non_vote) as f64 / seconds;
        // Bank counters do not split errors by vote/non-vote. Votes that fail
        // are rare enough that attributing all failures to non-vote traffic is
        // the honest approximation.
        let failed = current.errors.saturating_sub(previous.errors) as f64 / seconds;
        let tps = Tps {
            total,
            vote: (total - non_vote).max(0.0),
            non_vote_success: (non_vote - failed).max(0.0),
            non_vote_failed: failed.min(non_vote),
        };

        self.publisher.publish(TOPIC_SUMMARY, "estimated_tps", &tps);

        let sample = TpsSample {
            slot: current.slot,
            timestamp_nanos: system_time_nanos(SystemTime::now()),
            tps,
        };
        self.publisher
            .publish_ephemeral(TOPIC_SUMMARY, "tps_sample", &sample);

        push_history(
            &mut self.tps_history,
            sample,
            &self.publisher,
            "tps_history",
        );
    }

    /// Host interface throughput, derived from cumulative counters.
    ///
    /// Publishes nothing when the counters cannot be read, so the panel is
    /// absent rather than showing zeros that look like an idle network.
    fn collect_network(&mut self) {
        if self.net_unavailable {
            return;
        }
        let current = match net_stats::read() {
            Ok(counters) => counters,
            Err(err) => {
                self.net_unavailable = true;
                log::info!("dashboard: network counters unavailable, panel disabled: {err}");
                return;
            }
        };
        let now = Instant::now();
        let Some((previous, sampled_at)) = self.last_net.replace((current, now)) else {
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
        self.publisher.publish(TOPIC_SUMMARY, "network", &rates);

        let sample = NetworkSample {
            timestamp_nanos: system_time_nanos(SystemTime::now()),
            rates,
        };
        self.publisher
            .publish_ephemeral(TOPIC_SUMMARY, "network_sample", &sample);

        push_history(
            &mut self.net_history,
            sample,
            &self.publisher,
            "network_history",
        );
    }

    /// This validator's own UDP ports, in the order the panel lists them.
    ///
    /// Taken from what the node advertises in gossip, which is the only place
    /// the dashboard can see them from without the validator handing it the
    /// socket set. That has a consequence worth knowing: an operator running
    /// behind a port forward advertises a port it is not bound to, and the
    /// match below simply finds nothing.
    ///
    /// A fixed order rather than sorting by traffic or by drops, so a row does
    /// not move to a different line between samples.
    ///
    /// Each port is paired here with the running count of what it delivered,
    /// where anything counts it. Paired at this point rather than looked up
    /// later because this is the one place that knows which socket is which:
    /// the kernel's table is keyed by port and the validator's counters by the
    /// name of the thread reading it, and nothing but this list joins them.
    fn ingest_ports(&self, tap: &TapCounters) -> Vec<IngestPort> {
        let info = self.ctx.cluster_info.my_contact_info();
        [
            // Everything arriving on the TVU port is a shred, so the count the
            // shred receiver keeps is the count of what the port delivered.
            ("turbine", info.tvu(Protocol::UDP), Some(tap.shreds_turbine)),
            // QUIC. The stream layer counts transactions it managed to pull out
            // of a connection, which is neither one datagram nor a whole number
            // of them, and adding that to a datagram drop count would produce a
            // ratio between two different things.
            ("tpu", info.tpu(Protocol::QUIC), None),
            ("tpu forwards", info.tpu_forwards(Protocol::QUIC), None),
            (
                "tpu vote",
                info.tpu_vote(Protocol::UDP),
                Some(tap.packets_tpu_vote),
            ),
            ("gossip", info.gossip(), Some(tap.packets_gossip)),
            // The one port that could have a count and does not. Its receiver
            // keeps the same counters as the others and nothing ever reports
            // them, so they are accumulated on every packet and thrown away
            // when the service ends. Reaching them means a change to `core`.
            ("serve repair", info.serve_repair(Protocol::UDP), None),
        ]
        .into_iter()
        .filter_map(|(name, addr, received)| {
            Some(IngestPort {
                name,
                port: addr?.port(),
                received,
            })
        })
        .collect()
    }

    /// Packets lost in the kernel before the validator could read them.
    ///
    /// Distinct from the drop counters inside the validator, which count
    /// packets discarded once already in userspace. These are the ones that
    /// never got that far, and they are the usual way shreds go missing.
    fn collect_ingest_paths(&mut self) {
        if self.drops_unavailable {
            return;
        }
        let current = match udp_drops::read() {
            Ok(ports) => ports,
            Err(err) => {
                self.drops_unavailable = true;
                log::info!("dashboard: socket counters unavailable, panel disabled: {err}");
                return;
            }
        };
        let now = Instant::now();
        let ports = self.ingest_ports(&self.metrics_tap.counters());

        // A port absent from this snapshot keeps the counters it had. The read
        // is not atomic, so a socket can drop out of one sample and return in
        // the next while staying bound the whole time; taking the snapshot at
        // its word deleted the row and shrank the panel for a tick. The figures
        // are then a sample stale, which is the cheaper of the two errors.
        //
        // Only the reported ports are remembered. Keeping every UDP socket on
        // the host would hold a minute of history to answer six rows.
        for port in &ports {
            if let Some(counters) = current.get(&port.port) {
                self.known_sockets.insert(port.port, *counters);
            }
        }

        let drops: HashMap<u16, u64> = ports
            .iter()
            .filter_map(|port| Some((port.port, self.known_sockets.get(&port.port)?.drops)))
            .collect();
        // Only the ports that have a count. A port left out here is left out of
        // both windows and of both baselines, so it never acquires a received
        // figure by accident.
        let received: HashMap<u16, u64> = ports
            .iter()
            .filter_map(|port| Some((port.port, port.received?)))
            .collect();

        // Taken the first tick the validator reports itself running, which is
        // where the startup burst ends. Before that the raw counters stand, so
        // the burst is visible while it is happening rather than hidden.
        //
        // Both baselines are taken at that same instant, which is what lets the
        // two totals be divided by each other. Counted from where each source
        // happened to start — the kernel from when the socket opened, the tap
        // from when the dashboard began watching — the spans would differ by
        // however long the validator took to start, and the share would come
        // out too low by exactly the amount nobody could see.
        if self.drops_baseline.is_none() && (self.startup_progress)().running {
            self.drops_baseline = Some(drops.clone());
            self.received_baseline = Some(received.clone());
        }
        self.drops_window.push(now, drops);
        self.received_window.push(now, received);

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
                })
            })
            .collect();

        // Empty means none of the advertised ports is bound here, which happens
        // behind a port forward. Publishing zeroed rows would report a validator
        // as healthy on the strength of a lookup that failed, so publish nothing
        // and let the panel stay absent.
        if paths.is_empty() {
            return;
        }
        let summary = IngestSummary {
            // Capped at the span. Coverage runs a tick over it by design, and
            // letting that show would leave the figure alternating between two
            // values every second for no reader's benefit.
            window_seconds: self
                .drops_window
                .covers(now)
                .min(DROPS_WINDOW)
                .as_secs_f64(),
            paths,
        };
        self.ingest_paths
            .publish(&self.publisher, TOPIC_SUMMARY, "ingest_paths", summary);
    }
}

/// Pushes one interval onto a window, forgets what fell out, and sums the rest.
///
/// Generic over the stage because all four want exactly this and nothing else,
/// and four copies of a loop that drops the oldest sample is four chances to
/// drop it from the wrong end.
fn windowed<T: WindowedCounters>(window: &mut VecDeque<T>, sample: T, span: usize) -> T {
    window.push_back(sample);
    while window.len() > span {
        window.pop_front();
    }
    window
        .iter()
        .fold(T::default(), |total, sample| total.plus(sample))
}

/// What a port's counter read when the baseline was taken.
///
/// Nought before there is one, which makes the first minute of a validator's
/// life report totals counted from when each counter itself started. That is
/// the honest reading while the startup burst is still happening: hiding it
/// until the baseline lands would leave the panel blank over the one stretch
/// where it has the most to say.
fn at_baseline(baseline: Option<&HashMap<u16, u64>>, port: u16) -> u64 {
    baseline
        .and_then(|baseline| baseline.get(&port))
        .copied()
        .unwrap_or(0)
}

/// Appends a chart sample and republishes the retained series.
///
/// Retained rather than broadcast: a connecting client needs the whole series,
/// and everyone already watching has been given each sample as it happened.
fn push_history<T: Serialize>(history: &mut Vec<T>, sample: T, publisher: &Publisher, key: &str) {
    history.push(sample);
    if history.len() > CHART_HISTORY {
        let excess = history.len().saturating_sub(CHART_HISTORY);
        history.drain(..excess);
    }
    publisher.retain_only(TOPIC_SUMMARY, key, history);
}

#[cfg(test)]
mod tests {
    use {super::*, crate::fixture::fixture, std::thread::sleep};

    /// A tap reading carrying only the scheduler, which is the stage most of
    /// these tests are about. The other three ride in the same struct and are
    /// left at nought so that each test moves one thing.
    fn tap(scheduler: SchedulerTotals) -> TapCounters {
        TapCounters {
            scheduler,
            ..TapCounters::default()
        }
    }

    /// A window of `(hits, misses, evictions)` samples.
    fn window(samples: &[(u64, u64, u64)]) -> VecDeque<(u64, u64, u64)> {
        samples.iter().copied().collect()
    }

    /// A replayed slot with only the fields a test cares about set.
    fn replayed(set: impl Fn(&mut ReplaySlotTimes)) -> ReplaySlotTimes {
        let mut slot = ReplaySlotTimes::default();
        set(&mut slot);
        slot
    }

    #[test]
    fn test_a_replay_window_reports_the_mean_slot() {
        // What one slot costs, which is the figure that compares against how
        // long a slot lasts. A total over the window would not.
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
        // The maxima land on different slots. Adding them would describe a slot
        // that never happened and overstate the worst case by whatever the
        // other fields happened to be doing at the time.
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
        // Compilation arrives in bursts — better than fifty times the ordinary
        // slot on this validator — so the mean alone hides the thing worth
        // seeing.
        let mut slots = vec![replayed(|s| s.program_cache = 1_000); 9];
        slots.push(replayed(|s| s.program_cache = 45_000));
        let window = replay_window(&slots).unwrap();

        assert_eq!(window.program_cache, 5_400);
        assert_eq!(window.program_cache_peak, 45_000);
    }

    #[test]
    fn test_no_replayed_slots_is_no_panel() {
        // Absent rather than a card of noughts, which is what a validator whose
        // replay has not started would otherwise show, and what one whose log
        // filter keeps this point away would show for ever.
        assert!(replay_window(&[]).is_none());
    }

    #[test]
    fn test_the_rate_is_taken_over_the_whole_window() {
        // Three samples of a handful of lookups each. Taken one at a time the
        // rate is 100%, then 50%, then 0; over the window it is the six in nine
        // that it actually was.
        let (asked, rate, _) = cache_rate(&window(&[(4, 0, 0), (1, 1, 0), (1, 2, 0)])).unwrap();
        assert_eq!(asked, 9);
        assert!((rate - 6.0 / 9.0).abs() < f64::EPSILON, "{rate}");
    }

    #[test]
    fn test_evictions_are_summed_alongside() {
        // The usual reason a hit rate falls, so it is reported beside it rather
        // than left to be inferred from the rate dropping.
        let (_, _, evictions) = cache_rate(&window(&[(10, 1, 2), (10, 1, 3)])).unwrap();
        assert_eq!(evictions, 5);
    }

    #[test]
    fn test_nothing_asked_reports_nothing() {
        // Not zero. A validator between blocks has asked the cache for nothing,
        // and a hit rate of nought reads as a cache that is failing rather than
        // one that has not been asked.
        assert!(cache_rate(&window(&[])).is_none());
        assert!(cache_rate(&window(&[(0, 0, 0), (0, 0, 4)])).is_none());
    }

    #[test]
    fn test_only_the_ports_counted_in_datagrams_carry_a_received_figure() {
        // The whole of the denominator's correctness is this join. The kernel
        // keys drops by port and the validator keys packets by the name of the
        // thread that read them, and nothing else in the dashboard knows that
        // `shred_fetch_receiver` is the socket gossip advertises as `tvu`.
        let harness = fixture();
        let meters = harness.meters();
        let counted = meters.ingest_ports(&TapCounters {
            shreds_turbine: 900,
            packets_gossip: 40,
            packets_tpu_vote: 70,
            ..TapCounters::default()
        });
        let by_name: HashMap<&str, Option<u64>> = counted
            .iter()
            .map(|port| (port.name, port.received))
            .collect();

        assert_eq!(by_name["turbine"], Some(900));
        assert_eq!(by_name["gossip"], Some(40));
        assert_eq!(by_name["tpu vote"], Some(70));

        // Nothing rather than nought, and the distinction is the point: a row
        // reporting no packets received alongside any drops at all works out to
        // every packet lost, which is a false alarm on a healthy validator.
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
    fn test_a_port_with_no_baseline_yet_counts_from_its_own_start() {
        // Which is what the panel shows over the startup burst, before the
        // validator reports itself running and the baselines are taken. The
        // alternative is a blank column across the one stretch where the drop
        // figures have the most to say.
        assert_eq!(at_baseline(None, 8001), 0);
        assert_eq!(at_baseline(Some(&HashMap::new()), 8001), 0);
        assert_eq!(at_baseline(Some(&HashMap::from([(8001, 42)])), 8001), 42);
    }

    #[test]
    fn test_the_waterfall_reports_the_window_and_not_the_running_total() {
        // The tap's counters only ever climb. Publishing them as they stand
        // would present every transaction since the validator started as
        // though it had arrived in the last five minutes.
        let harness = fixture();
        let mut meters = harness.meters();

        // A counter already well into its life, as it is by the time anyone
        // opens the page.
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
        // A hundred then a hundred and fifty, against a counter reading 1,250.
        assert!(published.contains(r#""received":250"#), "{published}");
        assert!(published.contains(r#""buffered":25"#), "{published}");
    }

    #[test]
    fn test_a_scheduler_with_no_traffic_reports_nothing_rather_than_noughts() {
        // The scheduler submits its point only when it has something to say, so
        // an empty window is a validator nothing was sent. A waterfall of zeroes
        // would read as one throwing everything away, which is the opposite.
        let harness = fixture();
        let mut meters = harness.meters();
        meters.collect_waterfall(&TapCounters::default(), &TapCounters::default());

        let published = harness.published_key("summary", "waterfall").unwrap();
        assert!(published.contains(r#""value":null"#), "{published}");
    }

    #[test]
    fn test_a_changeover_restarts_the_waterfall_window() {
        // The two schedulers do not measure `received` the same way — one
        // counts packets off the wire, the other the batches it was sent — so a
        // window spanning a handover would add two units together and label the
        // total as whichever reported last.
        let harness = fixture();
        let mut meters = harness.meters();

        // Three samples under the scheduler the fixture's tap reports.
        let mut previous = SchedulerTotals::default();
        for step in 1..=3u64 {
            let current = SchedulerTotals {
                received: step.saturating_mul(10),
                ..SchedulerTotals::default()
            };
            meters.collect_waterfall(&tap(previous), &tap(current));
            previous = current;
        }
        assert_eq!(meters.waterfall_window.len(), 3);

        // Now say those three were BAM's. The tap still reports the validator's
        // own scheduler, so the next tick is a handover and the window starts
        // again from the sample taken after it.
        meters.waterfall_source = SchedulerSource::Bam;
        let current = SchedulerTotals {
            received: 145,
            ..SchedulerTotals::default()
        };
        meters.collect_waterfall(&tap(previous), &tap(current));

        assert_eq!(meters.waterfall_window.len(), 1);
        assert_eq!(meters.waterfall_source, SchedulerSource::Scheduler);
        let published = harness.published_key("summary", "waterfall").unwrap();
        assert!(published.contains(r#""source":"scheduler""#), "{published}");
        // 145 against a previous reading of 30: the one sample, not the four.
        assert!(published.contains(r#""received":115"#), "{published}");
    }

    #[test]
    fn test_the_waterfall_window_forgets_what_falls_out_of_it() {
        // Otherwise the busiest five minutes the validator ever had would stay
        // on the page for the life of the process.
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

        assert_eq!(meters.waterfall_window.len(), WATERFALL_WINDOW);
        let published = harness.published_key("summary", "waterfall").unwrap();
        // Ten a sample across the window, not across every sample ever taken.
        let expected = (WATERFALL_WINDOW as u64).saturating_mul(10);
        assert!(
            published.contains(&format!(r#""received":{expected}"#)),
            "{published}"
        );
    }

    #[test]
    fn test_a_tick_always_publishes_the_clock() {
        // The heartbeat. Everything else here can legitimately report nothing —
        // the counters may be unreadable, the sample may be skipped — but the
        // clock is what tells a viewer the feed is alive at all.
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
        // The reason this thread takes bank forks with try_read. Replay holds
        // that lock to advance, and waiting for it would stop the clock — which
        // looks identical to a dead feed, because a stalled panel keeps showing
        // its last value.
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
        // Rates are differences, so the first tick can only establish a
        // baseline. Publishing one from a single reading would divide the
        // chain's whole history by a second.
        let harness = fixture();
        let mut meters = harness.meters();

        meters.tick();
        assert!(
            harness.published_key("summary", "estimated_tps").is_none(),
            "a rate was reported from one reading"
        );

        // Slow enough that one slot does not look like a catch-up burst: the
        // guard discards anything above six slots a second, and two ticks in
        // immediate succession are far above it. Sleeping longer only lowers
        // the measured rate, so a loaded machine cannot flake this.
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
    fn test_a_replayed_burst_is_not_reported_as_throughput() {
        // Catching up chews through slots far faster than the cluster produces
        // them. One such sample pins the chart's scale for as long as it stays
        // in view, so it is discarded rather than drawn.
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
}
