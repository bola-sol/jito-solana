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
        collect::{CATCH_UP_SLOTS_PER_SECOND, TOPIC_SUMMARY, system_time_nanos},
        context::{DashboardContext, StartupProgressFn},
        net_stats::{self, NetCounters},
        proto::{Debounced, Publisher},
        udp_drops::{self, DropWindow, PortCounters},
    },
    serde::Serialize,
    solana_clock::Slot,
    solana_gossip::contact_info::Protocol,
    solana_runtime::bank::Bank,
    std::{
        collections::HashMap,
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
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IngestSummary {
    /// What `drops_recent` actually spans, which is short until the window has
    /// filled. Sent so the panel can name the period it is showing rather than
    /// claim a minute it has not yet watched.
    pub window_seconds: f64,
    pub paths: Vec<IngestPath>,
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
    drops_window: DropWindow,
    /// Per-port drops as of the moment the validator finished starting.
    ///
    /// Reported totals are counted from here. Most of a validator's drops
    /// happen during startup, when gossip's first view of the cluster arrives
    /// faster than it can be read, and carrying that burst for the life of the
    /// process left a figure that said nothing about how the validator is
    /// running now.
    drops_baseline: Option<HashMap<u16, u64>>,
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
}

impl Meters {
    pub fn new(
        ctx: DashboardContext,
        publisher: Arc<Publisher>,
        startup_progress: StartupProgressFn,
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
            drops_window: DropWindow::new(DROPS_WINDOW),
            drops_baseline: None,
            known_sockets: HashMap::new(),
            drops_unavailable: false,
            ingest_paths: Debounced::default(),
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
    fn ingest_ports(&self) -> Vec<(&'static str, u16)> {
        let info = self.ctx.cluster_info.my_contact_info();
        [
            ("turbine", info.tvu(Protocol::UDP)),
            ("tpu", info.tpu(Protocol::QUIC)),
            ("tpu forwards", info.tpu_forwards(Protocol::QUIC)),
            ("tpu vote", info.tpu_vote(Protocol::UDP)),
            ("gossip", info.gossip()),
            ("serve repair", info.serve_repair(Protocol::UDP)),
        ]
        .into_iter()
        .filter_map(|(name, addr)| addr.map(|addr| (name, addr.port())))
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
        let ports = self.ingest_ports();

        // A port absent from this snapshot keeps the counters it had. The read
        // is not atomic, so a socket can drop out of one sample and return in
        // the next while staying bound the whole time; taking the snapshot at
        // its word deleted the row and shrank the panel for a tick. The figures
        // are then a sample stale, which is the cheaper of the two errors.
        //
        // Only the reported ports are remembered. Keeping every UDP socket on
        // the host would hold a minute of history to answer six rows.
        for &(_, port) in &ports {
            if let Some(counters) = current.get(&port) {
                self.known_sockets.insert(port, *counters);
            }
        }

        let totals: HashMap<u16, u64> = ports
            .iter()
            .filter_map(|&(_, port)| Some((port, self.known_sockets.get(&port)?.drops)))
            .collect();

        // Taken the first tick the validator reports itself running, which is
        // where the startup burst ends. Before that the raw counters stand, so
        // the burst is visible while it is happening rather than hidden.
        if self.drops_baseline.is_none() && (self.startup_progress)().running {
            self.drops_baseline = Some(totals.clone());
        }
        self.drops_window.push(now, totals);

        let paths: Vec<IngestPath> = ports
            .iter()
            .filter_map(|&(name, port)| {
                let counters = self.known_sockets.get(&port)?;
                let baseline = self
                    .drops_baseline
                    .as_ref()
                    .and_then(|baseline| baseline.get(&port))
                    .copied()
                    .unwrap_or(0);
                Some(IngestPath {
                    name,
                    port,
                    drops_recent: self.drops_window.since(port, counters.drops),
                    // Saturating rather than wrapping: a socket rebound after
                    // the baseline was taken restarts below it.
                    drops_total: counters.drops.saturating_sub(baseline),
                    queued_bytes: counters.queued,
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
