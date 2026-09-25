//! Samples slot state five times a second and publishes what changed. The
//! once-a-second readings run on their own thread in [`crate::meters`].

use {
    crate::{
        certs,
        context::{DashboardContext, StartProgress},
        history::SlotHistory,
        meters::QuicPort,
        metrics_tap::{
            BundleLanding, MetricsTap, ShredFill, StageTimes, TapCounters, WindowedCounters,
            WorkerSum,
        },
        produced::{Bundles, Execution, ProducedBlock, ProducedRing},
        proto::{Debounced, Publisher, TOPIC_EPOCH, TOPIC_PEERS, TOPIC_SLOT, TOPIC_SUMMARY},
        slots::{BlockDetail, ShredArrival, SlotEntry, SlotLevel, SlotRing},
        snapshot::{self, SnapshotTracker, Snapshots},
        startup::StartupPublisher,
        tips::{TipMeter, TipRates},
        turns::{LeaderTurn, TurnTracker},
        validator_info::{self, ValidatorInfoCache},
        versions,
    },
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_gossip::contact_info::ContactInfo,
    solana_leader_schedule::NUM_CONSECUTIVE_LEADER_SLOTS,
    solana_pubkey::Pubkey,
    solana_rpc::optimistically_confirmed_bank_tracker::{
        BankNotification, BankNotificationReceiver,
    },
    solana_rpc_client_types::request::DELINQUENT_VALIDATOR_SLOT_DISTANCE,
    solana_runtime::bank::{Bank, VATHealthError},
    solana_time_utils::timestamp,
    solana_vote_interface::state::VoteStateV4,
    std::{
        collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
        sync::{Arc, Mutex, RwLock},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    },
};

mod certificates;
mod skip_rate;
mod slot_clock;

pub use self::certificates::{
    MissList, MissReplies, MissRow, MissValidator, MissWriter, WrittenList, WrittenRow,
};
pub(crate) use self::slot_clock::CATCH_UP_SLOTS_PER_SECOND;
use self::{
    certificates::{CertificateWalk, Contacts, GossipEntry, LastVotes},
    skip_rate::SkipRateWalk,
    slot_clock::SlotClock,
};

const SLOW_TICK: Duration = Duration::from_secs(5);

/// Only a connecting client reads the overview, a few hundred kilobytes.
const OVERVIEW_INTERVAL: Duration = Duration::from_secs(1);

const NANOS_PER_DAY: u128 = 86_400_000_000_000;

const REPLAY_RATE_WINDOW: Duration = Duration::from_secs(30);
const REPLAY_RATE_MIN_SPAN: Duration = Duration::from_secs(5);

const TOTALS_KEPT: u64 = 64;

/// Kept so a child can be differenced after its parent is pruned.
#[derive(Debug, Clone, Copy)]
struct Totals {
    transactions: u64,
    non_vote: u64,
    tips: u64,
}

const SLOT_OVERVIEW_LEN: usize = 512;

const SLOT_HISTORY: usize = 4096;

const MAX_VERSIONS_REPORTED: usize = 5;

const NEXT_LEADER_LOOKAHEAD: u64 = 20_000;

const UPCOMING_SLOTS: u64 = 32;

const PRODUCED_BLOCKS: usize = 500;

const WORKER_REPORT_MILLIS: u64 = 20;

const EXECUTION_WAIT_SLOTS: u64 = 64;

const LEADER_TURNS: usize = 128;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StakeSummary {
    /// In lamports.
    pub activated_stake: u64,
    pub total_stake: u64,
    /// In `[0, 1]`.
    pub share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValidatorCounts {
    /// Distinct staked identities this epoch, so a validator with several vote accounts counts
    /// once.
    pub total: usize,
    pub delinquent: usize,
    pub rpc_nodes: usize,
    pub non_delinquent_stake: u64,
    pub delinquent_stake: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersionShare {
    pub version: Option<String>,
    pub validators: usize,
    pub stake: u64,
    /// The folded tail, which sorts beside a genuine no-version group.
    pub other: bool,
}

/// Only the leaders on screen, so the table is bounded by the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Peer {
    pub identity: String,
    pub version: Option<String>,
    pub client: Option<String>,
    pub stake: u64,
    pub ip: Option<String>,
    pub name: Option<String>,
    pub icon: Option<String>,
}

#[derive(Default)]
struct Heard {
    version: Option<String>,
    client: Option<String>,
    ip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpcomingSlot {
    pub slot: Slot,
    pub leader: String,
    pub leader_name: Option<String>,
    pub leader_icon: Option<String>,
    pub mine: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EpochInfo {
    pub epoch: Epoch,
    pub start_slot: Slot,
    pub end_slot: Slot,
    pub slots_in_epoch: u64,
    pub my_leader_slots: Vec<Slot>,

    /// In order of first turn.
    pub leaders: Vec<String>,
    /// One index into `leaders` per run of `NUM_CONSECUTIVE_LEADER_SLOTS` slots from `start_slot`.
    /// Empty, never partial, until the schedule is derived.
    pub turns: Vec<u16>,

    pub block_cost_limit: u64,
    pub account_cost_limit: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Health {
    pub replay: ReplayHealth,
    pub vote: VoteHealth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplayHealth {
    NotStarted,
    Running,
    Stalled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VoteHealth {
    NotVoting,
    NotStarted,
    Voting,
    Delinquent,
}

/// Alpenglow votes outside blocks, so several figures mean nothing under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Consensus {
    Tower,
    Alpenglow,
}

/// What voting costs: fees from the identity per vote under TowerBFT, the admission ticket from the
/// vote account each epoch under alpenglow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VoteCost {
    Fees {
        per_day: u64,
    },
    Ticket {
        lamports: u64,
        /// What the vote account must hold at the turn: rent exemption plus
        /// the ticket.
        minimum: u64,
    },
}

/// This validator's vote credits in the epoch, against the most any staked validator has earned.
/// Under alpenglow the field holds lamports of reward.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VoteCredits {
    pub epoch: Epoch,
    pub credits: u64,
    /// Read on the slow tier, so absent until a viewer has been attached.
    pub cluster_max: Option<u64>,
}

/// Whether this vote account holds a seat in alpenglow's admitted set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Admission {
    pub seat: bool,
    pub next_seat: Option<bool>,
    /// Lamports the vote account is short of the ticket for the epoch after
    /// the next, absent where it covers it or cannot be read.
    pub ticket_short: Option<u64>,
}

/// From the rank maps, which hold each epoch's admitted set. `None` before alpenglow.
fn read_admission(bank: &Bank, vote_account: &Pubkey) -> Option<Admission> {
    if !bank.is_alpenglow() {
        return None;
    }
    let schedule = bank.epoch_schedule();
    let seated = |epoch: Epoch| {
        bank.get_rank_map(schedule.get_first_slot_in_epoch(epoch))
            .map(|map| map.get_rank_for_vote_pubkey(vote_account).is_some())
    };
    let ticket_short = match bank.get_vat_health_for_next_epoch(vote_account) {
        Err(VATHealthError::InsufficientFundsInVoteAccount(balance, minimum)) => {
            Some(minimum.saturating_sub(balance))
        }
        Ok(()) | Err(_) => None,
    };
    Some(Admission {
        seat: seated(bank.epoch())?,
        next_seat: seated(bank.epoch().saturating_add(1)),
        ticket_short,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkipRate {
    pub epoch: Epoch,
    /// Share of this validator's leader slots that produced no block, over the part of the epoch
    /// the blockstore covers. `None` until the root has passed one.
    pub rate: Option<f64>,
}

#[derive(Default)]
struct Debounces {
    client: Debounced<String>,
    identity_key: Debounced<String>,
    identity_name: Debounced<Option<String>>,
    identity_icon: Debounced<Option<String>>,
    vote_key: Debounced<String>,
    root_slot: Debounced<Slot>,
    optimistically_confirmed_slot: Debounced<Slot>,
    finalized_slot: Debounced<Slot>,
    completed_slot: Debounced<Slot>,
    estimated_slot: Debounced<Slot>,
    vote_slot: Debounced<Option<Slot>>,
    behind_cluster: Debounced<Option<u64>>,
    replay_rate: Debounced<Option<f64>>,
    identity_balance: Debounced<u64>,
    vote_balance: Debounced<u64>,
    vote_commission: Debounced<Option<u8>>,
    stake: Debounced<StakeSummary>,
    validator_counts: Debounced<ValidatorCounts>,
    versions: Debounced<Vec<VersionShare>>,
    block_height: Debounced<u64>,
    slot_duration_nanos: Debounced<u64>,
    observed_slot_duration_nanos: Debounced<Option<u64>>,
    next_leader_slot: Debounced<Option<Slot>>,
    skip_rate: Debounced<SkipRate>,
    health: Debounced<Health>,
    epoch: Debounced<EpochInfo>,
    consensus: Debounced<Consensus>,
    epoch_remaining_nanos: Debounced<u64>,
    upcoming: Debounced<Vec<UpcomingSlot>>,
    peers: Debounced<Vec<Peer>>,
    snapshots: Debounced<Option<Snapshots>>,
    bls_key: Debounced<Option<bool>>,
    admission: Debounced<Option<Admission>>,
    vote_credits: Debounced<Option<VoteCredits>>,
    vote_participation: Debounced<certs::Participation>,
    vote_cost: Debounced<VoteCost>,
}

pub struct Collector {
    ctx: DashboardContext,
    publisher: Arc<Publisher>,
    /// From the service, since the boot thread reports before a context exists.
    startup_progress: StartProgress,

    debounces: Debounces,
    slots: SlotRing,
    info_cache: Arc<RwLock<ValidatorInfoCache>>,
    /// The boot thread's publisher, handed over so the phases it recorded survive.
    startup: Arc<Mutex<StartupPublisher>>,
    metrics_tap: Arc<MetricsTap>,

    leaders_resolved_to: Slot,
    info_scanned_to: Slot,
    /// Tip at the moment the collector started. Slots below it were never
    /// watched, so they are neither tracked nor counted as skipped.
    first_observed_slot: Option<Slot>,
    completed_window: VecDeque<(Instant, Slot)>,
    produced: ProducedRing,
    versions_pending: BTreeSet<Slot>,
    execution_pending: BTreeSet<Slot>,
    history: Arc<RwLock<SlotHistory>>,
    epochs: Arc<RwLock<Vec<EpochInfo>>>,
    epoch_published: Option<(Epoch, Pubkey, bool)>,
    skip_rate: SkipRateWalk,
    last_completed_slot: Slot,
    last_completed_at: Instant,
    certificates: CertificateWalk,
    misses: Arc<RwLock<MissReplies>>,
    clock: SlotClock,
    /// Whether a tip ahead of replay has been seen since startup, and whether replay has since
    /// drawn level with it. The first tip read after a restart is stale.
    trailed_cluster: bool,
    caught_cluster: bool,
    last_vote_advance: Instant,
    /// False on a backup identity.
    voting: bool,
    last_slow_tick: Instant,
    subscribers: usize,

    tips: Option<TipMeter>,
    /// `None` reads bank forks instead, which misses banks pruned between ticks.
    frozen_banks: Option<BankNotificationReceiver>,
    totals: BTreeMap<Slot, Totals>,
    /// Never applied to another validator's turn.
    commission_bps: Option<u16>,
    tips_residual: Option<u64>,
    turns: TurnTracker,
    turns_scanned_to: Slot,
    turn_reference: TapCounters,
    turn_drained: Option<u64>,
    leader_turns: VecDeque<LeaderTurn>,
    overview_dirty: bool,
    overview_retained_at: Instant,
    snapshots: SnapshotTracker,
}

pub struct CollectorShared {
    pub publisher: Arc<Publisher>,
    pub info_cache: Arc<RwLock<ValidatorInfoCache>>,
    pub history: Arc<RwLock<SlotHistory>>,
    pub epochs: Arc<RwLock<Vec<EpochInfo>>>,
    pub misses: Arc<RwLock<MissReplies>>,
    pub startup_progress: StartProgress,
    pub startup: Arc<Mutex<StartupPublisher>>,
    pub metrics_tap: Arc<MetricsTap>,
}

impl Collector {
    pub fn new(
        ctx: DashboardContext,
        shared: CollectorShared,
        tips: Option<TipMeter>,
        commission_bps: Option<u16>,
        frozen_banks: Option<BankNotificationReceiver>,
    ) -> Self {
        let CollectorShared {
            publisher,
            info_cache,
            history,
            epochs,
            misses,
            startup_progress,
            startup,
            metrics_tap,
        } = shared;
        let now = Instant::now();
        Self {
            slots: SlotRing::new(SLOT_HISTORY),
            ctx,
            publisher,
            startup_progress,
            debounces: Debounces::default(),
            info_cache,
            startup,
            metrics_tap,
            leaders_resolved_to: 0,
            info_scanned_to: 0,
            first_observed_slot: None,
            produced: ProducedRing::new(PRODUCED_BLOCKS),
            versions_pending: BTreeSet::new(),
            execution_pending: BTreeSet::new(),
            history,
            epochs,
            skip_rate: SkipRateWalk::default(),
            epoch_published: None,
            last_completed_slot: 0,
            last_completed_at: now,
            completed_window: VecDeque::new(),
            certificates: CertificateWalk::default(),
            misses,
            trailed_cluster: false,
            caught_cluster: false,
            clock: SlotClock::default(),
            last_vote_advance: now,
            // Nothing is known until the first bank is read, and claiming to be
            // voting before then would flash the wrong status on startup.
            voting: false,
            last_slow_tick: now.checked_sub(SLOW_TICK).unwrap_or(now),
            subscribers: 0,
            tips,
            commission_bps,
            tips_residual: None,
            turns: TurnTracker::default(),
            turns_scanned_to: 0,
            turn_reference: TapCounters::default(),
            turn_drained: None,
            leader_turns: VecDeque::new(),
            frozen_banks,
            totals: BTreeMap::new(),
            overview_dirty: false,
            overview_retained_at: now.checked_sub(OVERVIEW_INTERVAL).unwrap_or(now),
            snapshots: SnapshotTracker::default(),
        }
    }

    pub fn publish_static(&mut self) {
        let version = solana_version::Version::this_build();
        self.publisher
            .publish(TOPIC_SUMMARY, "version", &version.as_semver_string());
        self.collect_client();
        self.publisher.publish(
            TOPIC_SUMMARY,
            "commit_hash",
            &format!("{:08x}", version.commit()),
        );
        self.publisher
            .publish(TOPIC_SUMMARY, "cluster", &self.ctx.cluster_name());
        // The rates the page derives tip figures with, sent rather than applied so a corrected rate
        // repairs the whole history.
        if let Some(meter) = &self.tips {
            log::info!(
                "dashboard: reading jito tips from {} accounts, {:?}",
                meter.accounts().len(),
                meter.accounts()
            );
            self.publisher.publish(
                TOPIC_SUMMARY,
                "tip_rates",
                &TipRates {
                    jito_cut_bps: crate::tips::JITO_CUT_BPS,
                    commission_bps: self.commission_bps,
                },
            );
        }
        self.publisher.publish(
            TOPIC_SUMMARY,
            "shred_version",
            &self.ctx.cluster_info.my_shred_version(),
        );
    }

    pub fn tick(&mut self) {
        let now = Instant::now();

        // Held only to clone the handles out: replay takes this lock to advance.
        let (root_bank, working_bank, highest_slot, mut frozen) = {
            let bank_forks = self.ctx.bank_forks.read().unwrap();
            (
                bank_forks.root_bank(),
                bank_forks.working_bank(),
                bank_forks.highest_slot(),
                bank_forks.frozen_banks().collect::<Vec<_>>(),
            )
        };
        // Slot order, for the tip meter's running total. Everything else is a
        // difference against a parent and would be right in any order.
        frozen.sort_by_key(|(slot, _)| *slot);
        let completed = frozen
            .iter()
            .map(|(slot, _)| *slot)
            .max()
            .unwrap_or_default();

        self.collect_slot_positions(&root_bank, highest_slot, completed);
        // Read once: before Alpenglow it opens a blockstore iterator, and two
        // readers want it every tick.
        let cluster_tip = self.ctx.cluster_tip();
        self.mark_caught_cluster(cluster_tip);
        self.collect_leaders(&root_bank, highest_slot);
        self.collect_slot_levels(&root_bank, &frozen);
        self.collect_vote_certs(&root_bank);
        self.collect_turns(completed);
        // From the working bank: the root trails the tip by the thirty-two slots it
        // takes to root.
        self.collect_identity_and_vote(&working_bank, cluster_tip);
        self.collect_epoch(&working_bank);
        self.debounces.consensus.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "consensus",
            if working_bank.is_alpenglow() {
                Consensus::Alpenglow
            } else {
                Consensus::Tower
            },
        );
        self.collect_startup_progress();

        // The slow tier walks every vote account, so it waits for a viewer. The
        // tiers above feed the slot ring and must not skip.
        let subscribers = self.publisher.subscriber_count();
        if subscribers != self.subscribers {
            log::debug!(
                "dashboard: {subscribers} viewers attached, cluster sampling {}",
                if subscribers == 0 {
                    "paused"
                } else {
                    "running"
                }
            );
            self.subscribers = subscribers;
        }

        if subscribers > 0 && now.duration_since(self.last_slow_tick) >= SLOW_TICK {
            self.last_slow_tick = now;
            self.collect_validator_info(&frozen);
            // One snapshot for both walks below: it clones the whole table under
            // the gossip lock.
            let peers = self.ctx.cluster_info.all_peers();
            self.collect_client();
            let votes = self.collect_peers(&working_bank, &peers);
            self.collect_health();
            self.collect_skip_rate(&root_bank);
            let ahead = self.collect_upcoming(&root_bank, highest_slot);
            self.collect_peer_table(&working_bank, ahead, &peers);
            self.report_tip_residual();
            self.collect_snapshots();
            let heard: Contacts = peers
                .iter()
                .map(|(contact, at_millis)| {
                    (
                        *contact.pubkey(),
                        GossipEntry {
                            contact,
                            at_millis: *at_millis,
                        },
                    )
                })
                .collect();
            self.collect_miss_list(&working_bank, &heard, &votes);
            if self.fill_certificates(&working_bank, &heard) {
                self.publisher
                    .publish(TOPIC_SUMMARY, "produced_blocks", &self.produced.blocks());
            }
        }

        // Encoded on a timer rather than per change: live clients follow the
        // updates above, and only a connecting one reads this.
        if self.overview_dirty && now.duration_since(self.overview_retained_at) >= OVERVIEW_INTERVAL
        {
            self.retain_slot_overview();
            self.overview_dirty = false;
            self.overview_retained_at = now;
        }
    }

    /// The client this node gossips, which the version does not carry. From gossip rather than the
    /// build: jito's validator gossips `AgaveBam` while on BAM and `JitoLabs` otherwise.
    fn collect_client(&mut self) {
        let client = self
            .ctx
            .cluster_info
            .my_contact_info()
            .version()
            .client()
            .to_string();
        self.debounces
            .client
            .publish(&self.publisher, TOPIC_SUMMARY, "client", client);
    }

    fn report_tip_residual(&mut self) {
        let residual = self.tips.as_ref().and_then(TipMeter::residual);
        if residual == self.tips_residual {
            return;
        }
        self.tips_residual = residual;
        if let Some(lamports) = residual {
            log::info!(
                "dashboard: {lamports} lamports of tips were paid before the receiver changed and \
                 are counted against no turn"
            );
        }
    }

    fn collect_snapshots(&mut self) {
        let read = self.ctx.snapshot_config.as_ref().and_then(snapshot::read);
        let snapshots = self
            .snapshots
            .observe(read, self.last_completed_slot, timestamp());
        self.debounces
            .snapshots
            .publish(&self.publisher, TOPIC_SUMMARY, "snapshots", snapshots);
    }

    fn collect_slot_positions(&mut self, root_bank: &Bank, highest_slot: Slot, completed: Slot) {
        let commitment = self.ctx.block_commitment_cache.read().unwrap();
        let (root, confirmed, finalized) = (
            commitment.root(),
            commitment.highest_confirmed_slot(),
            commitment.highest_super_majority_root(),
        );
        drop(commitment);

        // `root_bank` is the authority on the root. The commitment cache can
        // briefly lag it during startup.
        let root = root.max(root_bank.slot());

        self.debounces
            .root_slot
            .publish(&self.publisher, TOPIC_SUMMARY, "root_slot", root);
        self.debounces.optimistically_confirmed_slot.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "optimistically_confirmed_slot",
            confirmed,
        );
        self.debounces.finalized_slot.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "finalized_slot",
            finalized,
        );
        self.debounces.estimated_slot.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "estimated_slot",
            highest_slot,
        );

        self.debounces.completed_slot.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "completed_slot",
            completed,
        );
        self.collect_slot_durations(completed);
        self.clock.mark_caught_up(highest_slot, completed);
        self.observe_slot_duration(root_bank, completed);
    }

    fn observe_slot_duration(&mut self, root_bank: &Bank, completed: Slot) {
        let now = Instant::now();
        if completed > self.last_completed_slot {
            self.last_completed_slot = completed;
            self.last_completed_at = now;
        }
        self.completed_window.push_back((now, completed));
        while let Some((at, _)) = self.completed_window.front() {
            if now.duration_since(*at) <= REPLAY_RATE_WINDOW {
                break;
            }
            self.completed_window.pop_front();
        }

        let ns_per_slot = root_bank.ns_per_slot_at_slot(completed) as u64;
        self.debounces.slot_duration_nanos.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "estimated_slot_duration_nanos",
            ns_per_slot,
        );

        self.debounces.observed_slot_duration_nanos.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "observed_slot_duration_nanos",
            self.clock.observed_nanos(),
        );
    }

    /// Timed from the blockstore's first-shred record rather than a 200ms poll.
    fn collect_slot_durations(&mut self, up_to: Slot) {
        let mut changed = Vec::new();
        for slot in self.clock.slots_to_time(up_to) {
            // A skipped slot has no shreds and no timestamp, so the next slot that does is
            // measured from the last that did.
            let Some(arrived) = self.first_shred_time(slot) else {
                continue;
            };

            let elapsed = self.clock.record(slot, arrived);
            let shreds = self.metrics_tap.shred_fill(slot).map(ShredArrival::from);
            if let Some(entry) = self.slots.update(slot, |entry| {
                entry.time_millis = Some(arrived);
                if let Some(elapsed) = elapsed {
                    entry.duration_nanos = Some(elapsed.saturating_mul(1_000_000));
                }
                if entry.shreds.is_none() {
                    entry.shreds = shreds;
                }
            }) {
                changed.push(entry);
            }

            self.history.write().unwrap().record_time(slot, arrived);
        }

        for entry in &changed {
            self.publish_slot(entry);
        }
    }

    fn first_shred_time(&self, slot: Slot) -> Option<u64> {
        match self.ctx.blockstore.meta(slot) {
            Ok(Some(meta)) if meta.first_shred_timestamp > 0 => Some(meta.first_shred_timestamp),
            _ => None,
        }
    }

    fn collect_leaders(&mut self, root_bank: &Bank, highest_slot: Slot) {
        let me = self.ctx.identity();
        // Slots before the tip at start would all read as skipped.
        let from = match self.first_observed_slot {
            None => {
                self.first_observed_slot = Some(highest_slot);
                highest_slot
            }
            Some(_) => self
                .leaders_resolved_to
                .max(highest_slot.saturating_sub(SLOT_HISTORY as u64)),
        };

        for slot in from..=highest_slot {
            let Some(leader) = self
                .ctx
                .leader_schedule_cache
                .slot_leader_at(slot, Some(root_bank))
            else {
                self.leaders_resolved_to = slot;
                return;
            };
            if let Some(entry) = self.slots.set_mine(slot, leader.id == me) {
                self.publish_slot(&entry);
            }
            self.leaders_resolved_to = slot.saturating_add(1);
        }

        // The cache's own lookahead skips slots we already have shreds for. A
        // plain walk of the schedule would report those as still upcoming.
        let next_mine = self.ctx.leader_schedule_cache.next_leader_slot(
            &me,
            highest_slot,
            root_bank,
            Some(self.ctx.blockstore.as_ref()),
            NEXT_LEADER_LOOKAHEAD,
        );
        self.debounces.next_leader_slot.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "next_leader_slot",
            next_mine.map(|(first, _last)| first),
        );
    }

    /// Once the cluster passes a turn, credits it with the change in the tap's totals since the
    /// previous reading.
    fn collect_turns(&mut self, completed: Slot) {
        let from = self
            .turns_scanned_to
            .max(self.first_observed_slot.unwrap_or(0));
        for slot in from..self.leaders_resolved_to {
            let mine = self.slots.get(slot).is_some_and(|entry| entry.mine);
            self.turns.observe(slot, mine);
        }
        self.turns_scanned_to = self.leaders_resolved_to.max(from);

        let ended = self.turns.ended(completed);
        if ended.is_empty() {
            return;
        }
        // Two turns ending on one tick share the reading; the second spans nothing.
        let reading = self.metrics_tap.counters();
        let drained_millis = timestamp();
        for (first, last) in ended {
            let produced = self
                .produced
                .blocks()
                .iter()
                .filter(|block| (first..=last).contains(&block.slot))
                .count() as u64;
            self.leader_turns.push_back(LeaderTurn {
                first,
                last,
                produced,
                drained_millis,
                since_millis: self.turn_drained,
                quic: QuicPort {
                    name: "tpu",
                    counts: reading.quic.since(&self.turn_reference.quic),
                    levels: reading.quic_levels,
                    kernel_drops: None,
                },
                verify: reading.verify.since(&self.turn_reference.verify),
                executed: reading.executed.since(&self.turn_reference.executed),
            });
            self.turn_reference = reading;
            self.turn_drained = Some(drained_millis);
        }
        while self.leader_turns.len() > LEADER_TURNS {
            self.leader_turns.pop_front();
        }
        self.publisher
            .publish(TOPIC_SUMMARY, "produced_turns", &self.leader_turns);
    }

    fn collect_upcoming(&mut self, root_bank: &Bank, highest_slot: Slot) -> HashSet<Pubkey> {
        let me = self.ctx.identity();
        let first = highest_slot.saturating_add(1);
        let last = highest_slot.saturating_add(UPCOMING_SLOTS);

        let mut upcoming = Vec::new();
        let mut leaders = HashSet::new();
        for slot in first..=last {
            let Some(leader) = self
                .ctx
                .leader_schedule_cache
                .slot_leader_at(slot, Some(root_bank))
            else {
                break;
            };
            let (leader_name, leader_icon) = self.peer_display(&leader.id);
            leaders.insert(leader.id);
            upcoming.push(UpcomingSlot {
                slot,
                leader: leader.id.to_string(),
                leader_name,
                leader_icon,
                mine: leader.id == me,
            });
        }

        self.debounces
            .upcoming
            .publish(&self.publisher, TOPIC_SLOT, "upcoming", upcoming);
        leaders
    }

    fn collect_peer_table(
        &mut self,
        bank: &Bank,
        mut leaders: HashSet<Pubkey>,
        peers: &[(ContactInfo, u64)],
    ) {
        let highest = self.last_completed_slot;
        let first = highest.saturating_sub(SLOT_OVERVIEW_LEN as u64);
        let stride = NUM_CONSECUTIVE_LEADER_SLOTS.get() as u64;
        let mut slot = first.saturating_sub(first.checked_rem(stride).unwrap_or(0));
        while slot <= highest {
            if let Some(leader) = self
                .ctx
                .leader_schedule_cache
                .slot_leader_at(slot, Some(bank))
            {
                leaders.insert(leader.id);
            }
            slot = slot.saturating_add(stride);
        }

        let mut stakes: HashMap<Pubkey, u64> = HashMap::new();
        for (stake, account) in bank.vote_accounts().values() {
            if *stake == 0 {
                continue;
            }
            let identity = account.node_pubkey();
            if leaders.contains(identity) {
                let total = stakes.entry(*identity).or_insert(0);
                *total = total.saturating_add(*stake);
            }
        }

        let mut gossip: HashMap<Pubkey, Heard> = HashMap::new();
        for (contact_info, _) in peers {
            let identity = contact_info.pubkey();
            if !leaders.contains(identity) {
                continue;
            }
            gossip.insert(
                *identity,
                Heard {
                    version: Some(contact_info.version().to_string()),
                    client: Some(contact_info.version().client().to_string()),
                    ip: contact_info.gossip().map(|addr| addr.ip().to_string()),
                },
            );
        }

        let mut peers: Vec<Peer> = leaders
            .into_iter()
            .map(|identity| {
                let Heard {
                    version,
                    client,
                    ip,
                } = gossip.remove(&identity).unwrap_or_default();
                let (name, icon) = self.peer_display(&identity);
                Peer {
                    stake: stakes.get(&identity).copied().unwrap_or(0),
                    version,
                    client,
                    ip,
                    name,
                    icon,
                    identity: identity.to_string(),
                }
            })
            .collect();
        peers.sort_by(|a, b| a.identity.cmp(&b.identity));

        self.debounces
            .peers
            .publish(&self.publisher, TOPIC_PEERS, "all", peers);
    }

    fn collect_slot_levels(&mut self, root_bank: &Bank, frozen: &[(Slot, Arc<Bank>)]) {
        let commitment = self.ctx.block_commitment_cache.read().unwrap();
        let (confirmed, finalized) = (
            commitment.highest_confirmed_slot(),
            commitment.highest_super_majority_root(),
        );
        drop(commitment);
        let root = root_bank.slot();

        let banks: Vec<Arc<Bank>> = match &self.frozen_banks {
            Some(receiver) => receiver
                .try_iter()
                .filter_map(|(notification, _)| match notification {
                    BankNotification::Frozen(bank) => Some(bank),
                    _ => None,
                })
                .collect(),
            None => frozen.iter().map(|(_, bank)| bank.clone()).collect(),
        };

        let mut changed = Vec::new();
        let mut captured = false;
        for bank in &banks {
            let slot = bank.slot();
            // Counts are cumulative along a fork; a block's own is the difference
            // from its parent, off the parent's totals or the parent itself.
            let before = self.totals.get(&bank.parent_slot()).copied();
            let parent = before.is_none().then(|| bank.parent()).flatten();
            let counts = before
                .map(|before| (before.transactions, before.non_vote))
                .or_else(|| {
                    let parent = parent.as_ref()?;
                    Some((
                        parent.transaction_count(),
                        parent.non_vote_transaction_count_since_restart(),
                    ))
                })
                .map(|(transactions, non_vote)| {
                    (
                        bank.transaction_count().saturating_sub(transactions),
                        bank.non_vote_transaction_count_since_restart()
                            .saturating_sub(non_vote),
                    )
                });
            self.totals.insert(
                slot,
                Totals {
                    transactions: bank.transaction_count(),
                    non_vote: bank.non_vote_transaction_count_since_restart(),
                    tips: self.tips.as_ref().map_or(0, |meter| meter.total(bank)),
                },
            );
            // Read at a bank's first sighting: the cost tracker and fees go with the bank once it
            // is rooted.
            let fresh = self
                .slots
                .get(slot)
                .is_none_or(|entry| entry.block.is_none());
            let tips = if fresh {
                self.tips.as_mut().and_then(|meter| {
                    let before_tips = before
                        .map(|before| before.tips)
                        .or_else(|| parent.as_ref().map(|parent| meter.total(parent)))?;
                    Some(meter.measure(bank, before_tips))
                })
            } else {
                None
            };
            // Replay reports nought for a bank this validator built, finding it already executed;
            // left absent rather than shown as replayed in no time.
            let mine = self.slots.get(slot).is_some_and(|entry| entry.mine);
            let replayed = (fresh && !mine)
                .then(|| self.metrics_tap.replayed(slot))
                .flatten();
            let replay = replayed.map(|times| times.serial());
            // On the blockstore's clock: from the entry once timed, from the blockstore before
            // that.
            let replayed_millis = replayed.and_then(|times| {
                let first = self
                    .slots
                    .get(slot)
                    .and_then(|entry| entry.time_millis)
                    .or_else(|| self.first_shred_time(slot))?;
                Some(times.observed_millis.saturating_sub(first))
            });
            let shreds = fresh
                .then(|| self.metrics_tap.shred_fill(slot).map(ShredArrival::from))
                .flatten();
            let detail = counts
                .filter(|_| fresh)
                .map(|(total, non_vote)| block_detail(bank, total, non_vote, tips, replay));

            if let Some(detail) = &detail
                && mine
            {
                let block = self.capture_block(slot, bank, detail);
                if self.produced.insert(block) {
                    self.versions_pending.insert(slot);
                    self.execution_pending.insert(slot);
                    captured = true;
                }
            }

            let level = classify_slot(slot, root, confirmed, finalized);
            if let Some(entry) = self.slots.update(slot, |entry| {
                entry.level = level;
                if let Some(detail) = &detail {
                    entry.block = Some(detail.clone());
                }
                if replayed_millis.is_some() {
                    entry.replayed_millis = replayed_millis;
                }
                if entry.shreds.is_none() {
                    entry.shreds = shreds;
                }
            }) {
                changed.push(entry);
            }
        }

        // The loop above no longer covers slots that have fallen out of bank
        // forks, so their levels advance from the roots directly.
        changed.extend(self.slots.promote(finalized, SlotLevel::Finalized));
        changed.extend(self.slots.promote(root, SlotLevel::Rooted));
        changed.extend(
            self.slots
                .promote(confirmed, SlotLevel::OptimisticallyConfirmed),
        );

        changed.extend(self.slots.mark_skipped_below(root));
        self.totals = self.totals.split_off(&root.saturating_sub(TOTALS_KEPT));

        for entry in &changed {
            self.publish_slot(entry);
        }
        // The bundle stage reports a slot after its bank freezes.
        let tap = &self.metrics_tap;
        let filled = self
            .produced
            .fill_bundles(|slot| tap.bundles_landed(slot).map(Bundles::from));
        let read = self.fill_versions();
        let timed = self.fill_execution();
        if captured || filled || read || timed {
            self.publisher
                .publish(TOPIC_SUMMARY, "produced_blocks", &self.produced.blocks());
        }
    }

    fn fill_versions(&mut self) -> bool {
        let blockstore = &self.ctx.blockstore;
        let floor = blockstore.lowest_slot();
        let mut changed = false;
        for slot in std::mem::take(&mut self.versions_pending) {
            if slot < floor || !self.produced.contains(slot) {
                continue;
            }
            if !blockstore.is_full(slot) {
                self.versions_pending.insert(slot);
                continue;
            }
            let Ok(entries) = blockstore.get_slot_entries(slot, 0) else {
                continue;
            };
            let tally = versions::tally(entries.iter().flat_map(|entry| &entry.transactions));
            if self.produced.set_versions(slot, tally) {
                changed = true;
            }
        }
        changed
    }

    fn fill_execution(&mut self) -> bool {
        let now = timestamp();
        let mut changed = false;
        for slot in std::mem::take(&mut self.execution_pending) {
            if !self.produced.contains(slot) {
                continue;
            }
            let window = self
                .first_shred_time(slot)
                .zip(self.metrics_tap.shred_fill(slot))
                .map(|(start, fill)| (start, fill.full_millis));
            let Some((start, full_millis)) = window else {
                if slot.saturating_add(EXECUTION_WAIT_SLOTS) > self.last_completed_slot {
                    self.execution_pending.insert(slot);
                }
                continue;
            };
            let settled = start
                .saturating_add(full_millis)
                .saturating_add(WORKER_REPORT_MILLIS.saturating_mul(2));
            if now < settled {
                self.execution_pending.insert(slot);
                continue;
            }
            let workers = self.metrics_tap.worker_time(start, settled);
            let votes = self.metrics_tap.vote_time(slot);
            let Some(execution) = build_execution(workers, votes, full_millis) else {
                continue;
            };
            if self.produced.set_execution(slot, execution) {
                changed = true;
            }
        }
        changed
    }

    fn capture_block(&self, slot: Slot, bank: &Bank, detail: &BlockDetail) -> ProducedBlock {
        ProducedBlock {
            slot,
            slot_time_millis: self.first_shred_time(slot),
            blockhash: bank.last_blockhash().to_string(),
            duration_nanos: self.slots.get(slot).and_then(|entry| entry.duration_nanos),
            transactions: detail.transactions,
            non_vote_transactions: detail.non_vote_transactions,
            failed_transactions: detail.failed_transactions,
            entries: detail.entries,
            block_cost: detail.block_cost,
            block_cost_limit: detail.block_cost_limit,
            account_cost_limit: detail.account_cost_limit,
            total_fees: detail.total_fees,
            priority_fees: detail.priority_fees,
            tips: detail.tips,
            bundles: self.metrics_tap.bundles_landed(slot).map(Bundles::from),
            versions: None,
            execution: None,
            certificate: None,
        }
    }

    /// Here because no single moment finishes an entry.
    fn publish_slot(&mut self, entry: &SlotEntry) {
        self.history.write().unwrap().record(entry);
        self.publisher
            .publish_ephemeral(TOPIC_SLOT, "update", entry);
        self.overview_dirty = true;
    }

    fn retain_slot_overview(&self) {
        self.publisher.retain_only(
            TOPIC_SLOT,
            "overview",
            &self.slots.overview(SLOT_OVERVIEW_LEN),
        );
    }

    fn collect_identity_and_vote(&mut self, bank: &Bank, cluster_tip: Option<Slot>) {
        let identity = self.ctx.identity();
        self.debounces.identity_key.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "identity_key",
            identity.to_string(),
        );
        self.debounces.vote_key.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "vote_key",
            self.ctx.vote_account.to_string(),
        );
        let (my_name, my_icon) = self.peer_display(&identity);
        self.debounces.identity_name.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "identity_name",
            my_name,
        );
        self.debounces.identity_icon.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "identity_icon",
            my_icon,
        );
        self.debounces.identity_balance.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "identity_balance",
            bank.get_balance(&identity),
        );
        self.debounces.vote_balance.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "vote_balance",
            bank.get_balance(&self.ctx.vote_account),
        );
        self.debounces.vote_cost.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "vote_cost",
            compute_vote_cost(bank),
        );

        let epoch = bank.epoch();
        let vote_accounts = bank.vote_accounts();
        let mine = vote_accounts.get(&self.ctx.vote_account);
        let total_stake: u64 = vote_accounts.values().map(|(stake, _)| *stake).sum();
        // From the same bank as our own credits, so the share never compares two moments.
        let cluster_max = vote_accounts
            .values()
            .filter(|(stake, _)| *stake > 0)
            .map(|(_, account)| count_epoch_credits(account.vote_state_view(), epoch))
            .max();

        // After a failover the vote account is voted from another machine, whose
        // last vote must not be read as this one's health.
        let voting = mine.is_some_and(|(_, account)| *account.node_pubkey() == identity);
        self.voting = voting;

        let (activated_stake, commission, voter_vote) = match mine {
            Some((stake, account)) => {
                let view = account.vote_state_view();
                (*stake, Some(view.commission()), view.last_voted_slot())
            }
            None => (0, None, None),
        };

        let bls_key =
            mine.map(|(_, account)| account.vote_state_view().bls_pubkey_compressed().is_some());
        let vote_credits = mine.map(|(_, account)| VoteCredits {
            epoch,
            credits: count_epoch_credits(account.vote_state_view(), epoch),
            cluster_max,
        });
        self.debounces
            .bls_key
            .publish(&self.publisher, TOPIC_SUMMARY, "bls_key", bls_key);
        self.debounces.admission.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "admission",
            read_admission(bank, &self.ctx.vote_account),
        );
        self.debounces.vote_credits.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "vote_credits",
            vote_credits,
        );

        let last_vote = if voting { voter_vote } else { None };

        self.debounces.vote_commission.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "vote_commission",
            commission,
        );
        self.debounces.stake.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "stake",
            StakeSummary {
                activated_stake,
                total_stake,
                share: if total_stake == 0 {
                    0.0
                } else {
                    activated_stake as f64 / total_stake as f64
                },
            },
        );

        if self.debounces.vote_slot.last() != Some(&last_vote) {
            self.last_vote_advance = Instant::now();
        }
        self.debounces
            .vote_slot
            .publish(&self.publisher, TOPIC_SUMMARY, "vote_slot", last_vote);

        // Measured against the cluster's tip, not this node's own view, which
        // lags when replay lags.
        let behind_cluster = cluster_tip.map(|tip| tip.saturating_sub(self.last_completed_slot));
        if let Some(behind) = behind_cluster {
            self.snapshots.note_behind(behind);
        }
        self.debounces.behind_cluster.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "behind_cluster",
            behind_cluster,
        );
    }

    fn collect_epoch(&mut self, bank: &Bank) {
        // Blocks, not slots: the gap between the two is how many slots the cluster skipped.
        self.debounces.block_height.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "block_height",
            bank.block_height(),
        );

        let epoch_schedule = bank.epoch_schedule();
        let slot = bank.slot();
        let epoch = epoch_schedule.get_epoch(slot);
        let start_slot = epoch_schedule.get_first_slot_in_epoch(epoch);
        let slots_in_epoch = epoch_schedule.get_slots_in_epoch(epoch);
        let end_slot = start_slot.saturating_add(slots_in_epoch.saturating_sub(1));

        let me = self.ctx.identity();
        if self.epoch_published != Some((epoch, me, true)) {
            // An unknown schedule is published as no leader slots.
            let my_leader_slots = self.leader_slots_in_epoch(bank, epoch).unwrap_or_default();
            let (leaders, turns) = self.epoch_turns(epoch, slots_in_epoch);
            let known = !turns.is_empty();

            let (block_cost_limit, account_cost_limit) = match bank.read_cost_tracker() {
                Ok(tracker) => (tracker.get_block_limit(), tracker.get_account_limit()),
                Err(_) => (0, 0),
            };

            let current = EpochInfo {
                epoch,
                start_slot,
                end_slot,
                slots_in_epoch,
                my_leader_slots,
                leaders,
                turns,
                block_cost_limit,
                account_cost_limit,
            };

            // The previous epoch, kept for the server rather than sent: half a megabyte, wanted
            // only by a page reading back across the boundary.
            let previous = epoch
                .checked_sub(1)
                .map(|before| self.epoch_record(bank, before));

            let mut archive = self.epochs.write().unwrap();
            archive.clear();
            archive.extend(previous.into_iter().flatten());
            archive.push(current.clone());
            drop(archive);

            self.debounces
                .epoch
                .publish(&self.publisher, TOPIC_EPOCH, "new", current);
            self.epoch_published = Some((epoch, me, known));
        }

        self.collect_epoch_countdown(bank, epoch, start_slot, end_slot);
    }

    /// Rounded to the second so the debounce has something to suppress.
    fn collect_epoch_countdown(
        &mut self,
        bank: &Bank,
        epoch: Epoch,
        start_slot: Slot,
        end_slot: Slot,
    ) {
        // Nothing has frozen just after startup, and a completed slot of zero would put the end
        // years out.
        let completed = self.last_completed_slot.max(bank.slot());
        let remaining_slots = end_slot.saturating_sub(completed);
        let slot_nanos = self.clock.slot_nanos(
            &bank.clock(),
            start_slot,
            completed,
            bank.ns_per_slot_at_slot(completed) as u64,
        );
        let ahead = Duration::from_nanos(remaining_slots.saturating_mul(slot_nanos));

        let now = SystemTime::now();
        let Some(estimate) = now.checked_add(ahead) else {
            return;
        };
        let end = self.clock.epoch_end(epoch, estimate, now);

        let remaining = end.duration_since(now).unwrap_or_default();
        self.debounces.epoch_remaining_nanos.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "epoch_remaining_nanos",
            remaining.as_secs().saturating_mul(1_000_000_000),
        );
    }

    fn epoch_record(&self, bank: &Bank, epoch: Epoch) -> Option<EpochInfo> {
        let schedule = bank.epoch_schedule();
        let start_slot = schedule.get_first_slot_in_epoch(epoch);
        let slots_in_epoch = schedule.get_slots_in_epoch(epoch);
        let (leaders, turns) = self.epoch_turns(epoch, slots_in_epoch);
        if turns.is_empty() {
            return None;
        }

        let (block_cost_limit, account_cost_limit) = match bank.read_cost_tracker() {
            Ok(tracker) => (tracker.get_block_limit(), tracker.get_account_limit()),
            Err(_) => (0, 0),
        };
        Some(EpochInfo {
            epoch,
            start_slot,
            end_slot: start_slot.saturating_add(slots_in_epoch.saturating_sub(1)),
            slots_in_epoch,
            my_leader_slots: Vec::new(),
            leaders,
            turns,
            block_cost_limit,
            account_cost_limit,
        })
    }

    /// Empty, never partial, if the length is not whole turns.
    fn epoch_turns(&self, epoch: Epoch, slots_in_epoch: u64) -> (Vec<String>, Vec<u16>) {
        let Some(schedule) = self
            .ctx
            .leader_schedule_cache
            .get_epoch_leader_schedule(epoch)
        else {
            return (Vec::new(), Vec::new());
        };
        let stride = NUM_CONSECUTIVE_LEADER_SLOTS.get();

        let mut leaders: Vec<String> = Vec::new();
        let mut seen: HashMap<Pubkey, u16> = HashMap::new();
        let mut turns: Vec<u16> = Vec::new();
        for leader in schedule.get_slot_leaders().step_by(stride) {
            let index = match seen.get(&leader.id) {
                Some(index) => *index,
                None => {
                    let Ok(index) = u16::try_from(leaders.len()) else {
                        return (Vec::new(), Vec::new());
                    };
                    leaders.push(leader.id.to_string());
                    seen.insert(leader.id, index);
                    index
                }
            };
            turns.push(index);
        }

        let covered = (turns.len() as u64).saturating_mul(stride as u64);
        if covered != slots_in_epoch {
            log::warn!(
                "dashboard: epoch {epoch} leader schedule read as {} turns covering {covered} \
                 slots, not {slots_in_epoch}; publishing no schedule for it",
                turns.len()
            );
            return (Vec::new(), Vec::new());
        }
        (leaders, turns)
    }

    /// `None` means the schedule is not known yet, which is not an empty list.
    fn leader_slots_in_epoch(&self, bank: &Bank, epoch: Epoch) -> Option<Vec<Slot>> {
        let epoch_schedule = bank.epoch_schedule();
        let start_slot = epoch_schedule.get_first_slot_in_epoch(epoch);
        let end_slot =
            start_slot.saturating_add(epoch_schedule.get_slots_in_epoch(epoch).saturating_sub(1));

        // `get_leader_upcoming_slots` yields an endlessly repeating schedule, so
        // the `take_while` is what bounds it to the epoch asked for.
        let me = self.ctx.identity();
        self.ctx
            .leader_schedule_cache
            .get_epoch_leader_schedule(epoch)
            .map(|leaders| {
                leaders
                    .get_leader_upcoming_slots(&me, 0)
                    .map(|index| start_slot.saturating_add(index as Slot))
                    .take_while(|slot| *slot <= end_slot)
                    .collect()
            })
    }

    /// Returns each validator's stalest vote, which the certificate lists mark delinquency by.
    fn collect_peers(&mut self, bank: &Bank, peers: &[(ContactInfo, u64)]) -> LastVotes {
        let vote_accounts = bank.vote_accounts();
        let tip = bank.slot();

        // A validator can be in gossip or the vote accounts without the other, so both are walked.
        let versions: HashMap<Pubkey, String> = peers
            .iter()
            .map(|(contact_info, _)| (*contact_info.pubkey(), contact_info.version().to_string()))
            .collect();

        let rpc_nodes = self
            .ctx
            .cluster_info
            .rpc_peers()
            .iter()
            .map(|contact_info| *contact_info.pubkey())
            .collect::<HashSet<_>>()
            .len();

        let tally = tally_stake(
            vote_accounts
                .iter()
                .map(|(_vote_pubkey, (stake, account))| {
                    (
                        *account.node_pubkey(),
                        *stake,
                        account.vote_state_view().last_voted_slot(),
                    )
                }),
            tip,
        );

        self.debounces.validator_counts.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "validator_counts",
            ValidatorCounts {
                total: tally.staked.len(),
                delinquent: tally.delinquent.len(),
                rpc_nodes,
                non_delinquent_stake: tally.non_delinquent_stake,
                delinquent_stake: tally.delinquent_stake,
            },
        );

        self.debounces.versions.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "versions",
            version_shares(&tally.staked, &versions),
        );
        tally.stalest_votes
    }

    /// The icon is a third-party URL the client fetches itself.
    fn peer_display(&self, identity: &Pubkey) -> (Option<String>, Option<String>) {
        match self.info_cache.read().unwrap().get(identity) {
            None => (None, None),
            Some(info) => (info.name.clone(), info.icon_url.clone()),
        }
    }

    fn collect_validator_info(&mut self, frozen: &[(Slot, Arc<Bank>)]) {
        let mut found = Vec::new();
        for (slot, bank) in frozen {
            if *slot <= self.info_scanned_to {
                continue;
            }
            self.info_scanned_to = self.info_scanned_to.max(*slot);
            found.extend(validator_info::scan_slot(bank));
        }
        if found.is_empty() {
            return;
        }

        let changed = self.info_cache.write().unwrap().merge(found);
        if changed > 0 {
            log::debug!("dashboard: {changed} validator info entries updated");
        }
    }

    /// On the fast path, since the health figures only run with a viewer.
    fn mark_caught_cluster(&mut self, cluster_tip: Option<Slot>) {
        if self.caught_cluster {
            return;
        }
        let Some(tip) = cluster_tip else {
            return;
        };
        if tip > self.last_completed_slot {
            self.trailed_cluster = true;
            return;
        }
        if !self.trailed_cluster {
            return;
        }
        self.caught_cluster = true;
        self.publisher.publish(
            TOPIC_SUMMARY,
            "caught_up_time_nanos",
            &system_time_nanos(SystemTime::now()),
        );
    }

    fn collect_health(&mut self) {
        let health = assess_health(
            self.last_completed_at.elapsed(),
            self.last_completed_slot,
            self.voting,
            self.debounces.vote_slot.last().copied().flatten(),
            self.debounces
                .vote_slot
                .last()
                .copied()
                .flatten()
                .map(|vote| self.last_completed_slot.saturating_sub(vote)),
            self.last_vote_advance.elapsed(),
        );
        self.debounces
            .health
            .publish(&self.publisher, TOPIC_SUMMARY, "health", health);
        let rate =
            measure_replay_rate(&self.completed_window).map(|rate| (rate * 10.0).round() / 10.0);
        self.debounces
            .replay_rate
            .publish(&self.publisher, TOPIC_SUMMARY, "replay_rate", rate);
    }

    /// On the same basis as `solana block-production`, each slot checked once as the root passes
    /// it.
    fn collect_skip_rate(&mut self, root_bank: &Bank) {
        // The root's epoch, not the working bank's: they differ for half a minute
        // after a rollover.
        let epoch = root_bank.epoch();
        // Keyed on the identity too, so a validator that boots on a dummy one and
        // swaps counts its real slots.
        let me = self.ctx.identity();
        if self.skip_rate.epoch != Some((epoch, me)) {
            // Latched only once the schedule is in hand. Taking an unknown schedule as
            // empty would record a permanent zero.
            let Some(leader_slots) = self.leader_slots_in_epoch(root_bank, epoch) else {
                return;
            };
            self.skip_rate = SkipRateWalk::new(epoch, me, leader_slots);
        }

        let blockstore = &self.ctx.blockstore;
        self.skip_rate
            .advance(root_bank.slot(), blockstore.lowest_slot(), |slot| {
                blockstore.is_full(slot)
            });
        let rate = self.skip_rate.rate();
        self.debounces.skip_rate.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "skip_rate",
            SkipRate { epoch, rate },
        );
    }

    fn collect_startup_progress(&mut self) {
        let progress = *self.startup_progress.read().unwrap();
        self.startup.lock().unwrap().publish(
            &self.publisher,
            progress,
            self.metrics_tap.stake_in_gossip(),
        );
    }
}

fn measure_replay_rate(window: &VecDeque<(Instant, Slot)>) -> Option<f64> {
    let (oldest_at, oldest) = window.front()?;
    let (newest_at, newest) = window.back()?;
    let span = newest_at.duration_since(*oldest_at);
    if span < REPLAY_RATE_MIN_SPAN {
        return None;
    }
    Some(newest.saturating_sub(*oldest) as f64 / span.as_secs_f64())
}

fn compute_vote_cost(bank: &Bank) -> VoteCost {
    if bank.is_alpenglow() {
        let minimum = bank.minimum_vote_account_balance_for_vat();
        let rent = bank.get_minimum_balance_for_rent_exemption(VoteStateV4::size_of());
        return VoteCost::Ticket {
            lamports: minimum.saturating_sub(rent),
            minimum,
        };
    }
    let ns_per_slot = bank.ns_per_slot_at_slot(bank.slot()).max(1);
    let slots_per_day =
        u64::try_from(NANOS_PER_DAY.checked_div(ns_per_slot).unwrap_or(0)).unwrap_or(u64::MAX);
    VoteCost::Fees {
        per_day: slots_per_day.saturating_mul(bank.get_lamports_per_signature()),
    }
}

/// Reads only the newest entry, which is the bank's own epoch once the account has voted in it.
fn count_epoch_credits(view: &solana_vote::vote_state_view::VoteStateView, epoch: Epoch) -> u64 {
    view.epoch_credits_iter()
        .last()
        .filter(|item| item.epoch() == epoch)
        .map_or(0, |item| item.credits().saturating_sub(item.prev_credits()))
}

/// Most settled first: the thresholds cross while the commitment cache lags the root at startup.
fn classify_slot(slot: Slot, root: Slot, confirmed: Slot, finalized: Slot) -> SlotLevel {
    if slot <= finalized {
        SlotLevel::Finalized
    } else if slot <= root {
        SlotLevel::Rooted
    } else if slot <= confirmed {
        SlotLevel::OptimisticallyConfirmed
    } else {
        SlotLevel::Completed
    }
}

/// Keyed by identity: several staked vote accounts are one validator.
#[derive(Debug, Default, PartialEq, Eq)]
struct StakeTally {
    staked: HashMap<Pubkey, u64>,
    delinquent: HashSet<Pubkey>,
    /// The oldest last vote among each validator's staked accounts, `None` where one never voted.
    stalest_votes: LastVotes,
    delinquent_stake: u64,
    non_delinquent_stake: u64,
}

/// The cluster's rule: no vote yet, or the last one too far behind the tip.
fn is_delinquent(last_vote: Option<Slot>, tip: Slot) -> bool {
    last_vote
        .map(|vote| tip.saturating_sub(vote) > DELINQUENT_VALIDATOR_SLOT_DISTANCE)
        .unwrap_or(true)
}

fn tally_stake(
    accounts: impl Iterator<Item = (Pubkey, u64, Option<Slot>)>,
    tip: Slot,
) -> StakeTally {
    let mut tally = StakeTally::default();
    for (identity, stake, last_vote) in accounts {
        // The bank holds every vote account ever created; a validator is one with stake this epoch.
        if stake == 0 {
            continue;
        }
        if is_delinquent(last_vote, tip) {
            tally.delinquent.insert(identity);
            tally.delinquent_stake = tally.delinquent_stake.saturating_add(stake);
        } else {
            tally.non_delinquent_stake = tally.non_delinquent_stake.saturating_add(stake);
        }
        let total = tally.staked.entry(identity).or_insert(0);
        *total = total.saturating_add(stake);
        // `None` orders first, so an account that never voted stays the stalest.
        let stalest = tally.stalest_votes.entry(identity).or_insert(last_vote);
        *stalest = (*stalest).min(last_vote);
    }
    tally
}

/// Looser than the cluster's threshold, since a brief lag on our own node is normal.
const VOTE_BEHIND_LIMIT: u64 = 150;

const REPLAY_STALL_AFTER: Duration = Duration::from_secs(12);

const VOTE_STALL_AFTER: Duration = Duration::from_secs(60);

/// The two durations sit at either end of the argument list because swapping them compiles.
fn assess_health(
    since_completed: Duration,
    completed_slot: Slot,
    voting: bool,
    vote_slot: Option<Slot>,
    behind: Option<u64>,
    since_vote_advance: Duration,
) -> Health {
    let replay = if since_completed > REPLAY_STALL_AFTER {
        ReplayHealth::Stalled
    } else if completed_slot == 0 {
        ReplayHealth::NotStarted
    } else {
        ReplayHealth::Running
    };

    // Checked first: a node that is not the voter has no votes of its own, and the rules below
    // would read the other machine's health.
    let vote = if !voting {
        VoteHealth::NotVoting
    } else {
        match (vote_slot, behind) {
            (None, _) => VoteHealth::NotStarted,
            (Some(_), Some(behind)) if behind > VOTE_BEHIND_LIMIT => VoteHealth::Delinquent,
            _ if since_vote_advance > VOTE_STALL_AFTER => VoteHealth::Delinquent,
            _ => VoteHealth::Voting,
        }
    };

    Health { replay, vote }
}

/// Counted over staked identities so the two cards add up.
fn version_shares(
    staked: &HashMap<Pubkey, u64>,
    versions: &HashMap<Pubkey, String>,
) -> Vec<VersionShare> {
    let mut totals: HashMap<Option<&str>, (usize, u64)> = HashMap::new();
    for (identity, stake) in staked {
        let release = versions
            .get(identity)
            .map(|version| strip_prerelease(version));
        let entry = totals.entry(release).or_insert((0, 0));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = entry.1.saturating_add(*stake);
    }

    let mut shares: Vec<VersionShare> = totals
        .into_iter()
        .map(|(version, (validators, stake))| VersionShare {
            version: version.map(str::to_string),
            validators,
            stake,
            other: false,
        })
        .collect();
    shares.sort_by(|a, b| {
        b.stake
            .cmp(&a.stake)
            .then_with(|| b.validators.cmp(&a.validators))
    });

    // Folded to keep the message a fixed size.
    if shares.len() > MAX_VERSIONS_REPORTED {
        let tail = shares.split_off(MAX_VERSIONS_REPORTED);
        shares.push(VersionShare {
            version: None,
            validators: tail.iter().map(|share| share.validators).sum(),
            stake: tail.iter().map(|share| share.stake).sum(),
            other: true,
        });
    }
    shares
}

/// The error and entry counters are per bank, so only `transactions` and `non_vote` come
/// differenced.
fn block_detail(
    bank: &Bank,
    transactions: u64,
    non_vote: u64,
    tips: Option<u64>,
    replay_micros: Option<u64>,
) -> BlockDetail {
    let (block_cost, block_cost_limit, account_cost_limit) = match bank.read_cost_tracker() {
        Ok(tracker) => (
            tracker.block_cost(),
            tracker.get_block_limit(),
            tracker.get_account_limit(),
        ),
        Err(_) => (0, 0, 0),
    };
    let fees = bank.get_collector_fee_details();

    BlockDetail {
        transactions,
        non_vote_transactions: non_vote,
        failed_transactions: bank.transaction_error_count(),
        entries: bank.transaction_entries_count(),
        block_cost,
        block_cost_limit,
        account_cost_limit,
        total_fees: fees.total_transaction_fee(),
        priority_fees: fees.total_priority_fee(),
        tips,
        replay_micros,
    }
}

impl From<BundleLanding> for Bundles {
    fn from(bundles: BundleLanding) -> Self {
        Self {
            sanitized: bundles.sanitized,
            executed: bundles.executed,
        }
    }
}

fn build_execution(
    workers: Option<WorkerSum>,
    votes: Option<StageTimes>,
    window_millis: u64,
) -> Option<Execution> {
    if workers.is_none() && votes.is_none() {
        return None;
    }
    let workers = workers.unwrap_or_default();
    Some(Execution {
        non_vote: workers.times,
        workers: workers.workers,
        longest_batch: workers.longest_batch,
        votes,
        window_millis,
    })
}

impl From<ShredFill> for ShredArrival {
    fn from(fill: ShredFill) -> Self {
        Self {
            count: fill.shreds,
            repaired: fill.repaired,
            full_millis: fill.full_millis,
        }
    }
}

/// A cluster mid-upgrade reports `4.2.0`, `4.2.0-rc.0` and `4.2.0-rc.1`, which are one release.
fn strip_prerelease(version: &str) -> &str {
    match version.find(['-', '+']) {
        Some(at) => &version[..at],
        None => version,
    }
}

pub(crate) fn system_time_nanos(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{
            fixture::{Fixture, fixture},
            snapshot::Writing,
            startup::StartupPublisher,
        },
        solana_core::validator::ValidatorStartProgress,
        solana_keypair::Keypair,
    };

    #[test]
    fn test_level_reads_the_thresholds_most_settled_first() {
        assert_eq!(classify_slot(80, 100, 110, 90), SlotLevel::Finalized);
        assert_eq!(classify_slot(95, 100, 110, 90), SlotLevel::Rooted);
        assert_eq!(
            classify_slot(105, 100, 110, 90),
            SlotLevel::OptimisticallyConfirmed
        );
        assert_eq!(classify_slot(120, 100, 110, 90), SlotLevel::Completed);
    }

    #[test]
    fn test_rooted_slot_not_demoted_by_lagging_confirmed() {
        // During startup the commitment cache trails the root bank, so `confirmed`
        // can sit below a rooted slot.
        assert_eq!(classify_slot(100, 100, 50, 0), SlotLevel::Rooted);
    }

    #[test]
    fn test_the_boundaries_are_inclusive() {
        assert_eq!(classify_slot(90, 100, 110, 90), SlotLevel::Finalized);
        assert_eq!(classify_slot(100, 100, 110, 90), SlotLevel::Rooted);
        assert_eq!(
            classify_slot(110, 100, 110, 90),
            SlotLevel::OptimisticallyConfirmed
        );
    }

    fn identity(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    const TIP: Slot = 1_000;

    #[test]
    fn test_unstaked_vote_accounts_are_not_counted() {
        let tally = tally_stake(
            [(identity(1), 0, Some(TIP)), (identity(2), 100, Some(TIP))].into_iter(),
            TIP,
        );
        assert_eq!(tally.staked.len(), 1);
        assert_eq!(tally.non_delinquent_stake, 100);
    }

    #[test]
    fn test_two_vote_accounts_on_one_identity_are_one_validator() {
        let tally = tally_stake(
            [(identity(1), 100, Some(TIP)), (identity(1), 250, Some(TIP))].into_iter(),
            TIP,
        );
        assert_eq!(tally.staked.len(), 1, "one identity is one validator");
        assert_eq!(tally.staked[&identity(1)], 350, "its stake is the sum");
    }

    #[test]
    fn test_active_validators_cannot_go_negative() {
        // Counted per vote account, an identity with two delinquent accounts read total 1,
        // delinquent 2.
        let tally = tally_stake(
            [(identity(1), 100, Some(0)), (identity(1), 100, Some(0))].into_iter(),
            TIP,
        );
        assert_eq!(tally.staked.len(), 1);
        assert_eq!(tally.delinquent.len(), 1);
        assert_eq!(tally.staked.len() - tally.delinquent.len(), 0);
    }

    #[test]
    fn test_a_vote_account_that_never_voted_is_delinquent() {
        let tally = tally_stake([(identity(1), 100, None)].into_iter(), TIP);
        assert_eq!(tally.delinquent.len(), 1);
        assert_eq!(tally.delinquent_stake, 100);
        assert_eq!(tally.non_delinquent_stake, 0);
    }

    #[test]
    fn test_delinquency_is_decided_at_the_threshold() {
        let at = TIP - DELINQUENT_VALIDATOR_SLOT_DISTANCE;
        assert!(
            tally_stake([(identity(1), 1, Some(at))].into_iter(), TIP)
                .delinquent
                .is_empty(),
            "exactly at the limit is still voting"
        );
        assert_eq!(
            tally_stake([(identity(1), 1, Some(at - 1))].into_iter(), TIP)
                .delinquent
                .len(),
            1,
            "one slot past it is not"
        );
    }

    #[test]
    fn test_a_validator_is_as_stale_as_its_stalest_account() {
        let tally = tally_stake(
            [
                (identity(1), 100, Some(TIP)),
                (identity(1), 100, Some(40)),
                (identity(2), 100, Some(TIP)),
                (identity(2), 100, None),
                (identity(3), 100, Some(TIP)),
            ]
            .into_iter(),
            TIP,
        );
        assert_eq!(tally.stalest_votes[&identity(1)], Some(40));
        assert_eq!(
            tally.stalest_votes[&identity(2)],
            None,
            "never voting is the stalest"
        );
        assert_eq!(tally.stalest_votes[&identity(3)], Some(TIP));
        for (identity, last_vote) in &tally.stalest_votes {
            assert_eq!(
                is_delinquent(*last_vote, TIP),
                tally.delinquent.contains(identity),
                "the stalest vote decides as the tally does"
            );
        }
    }

    #[test]
    fn test_stake_splits_by_delinquency() {
        let tally = tally_stake(
            [
                (identity(1), 100, Some(TIP)),
                (identity(2), 30, Some(0)),
                (identity(3), 7, Some(TIP)),
            ]
            .into_iter(),
            TIP,
        );
        assert_eq!(tally.non_delinquent_stake, 107);
        assert_eq!(tally.delinquent_stake, 30);
    }

    #[test]
    fn test_the_turn_array_names_the_leader_the_schedule_names() {
        // An off-by-one in the stride would name the wrong validator throughout.
        let harness = fixture();
        let collector = harness.collector();
        let bank = harness.working_bank();
        let schedule = bank.epoch_schedule();
        let epoch = schedule.get_epoch(bank.slot());
        let start = schedule.get_first_slot_in_epoch(epoch);
        let slots_in_epoch = schedule.get_slots_in_epoch(epoch);

        let (leaders, turns) = collector.epoch_turns(epoch, slots_in_epoch);
        assert!(!turns.is_empty(), "the fixture's own schedule is derivable");

        let stride = NUM_CONSECUTIVE_LEADER_SLOTS.get() as u64;
        assert_eq!((turns.len() as u64).saturating_mul(stride), slots_in_epoch);

        for (turn, index) in turns.iter().enumerate().take(16) {
            let slot = start.saturating_add((turn as u64).saturating_mul(stride));
            let expected = harness
                .ctx
                .leader_schedule_cache
                .slot_leader_at(slot, Some(&bank))
                .expect("the fixture leads its own schedule");
            assert_eq!(
                leaders[*index as usize],
                expected.id.to_string(),
                "slot {slot}"
            );
        }
    }

    #[test]
    fn test_an_epoch_with_no_derived_schedule_carries_no_turns() {
        // A short array is indistinguishable from a short epoch.
        let harness = fixture();
        let collector = harness.collector();
        let bank = harness.working_bank();
        let epoch = bank.epoch_schedule().get_epoch(bank.slot());

        let (leaders, turns) = collector.epoch_turns(epoch.saturating_add(500), 432_000);
        assert!(leaders.is_empty());
        assert!(turns.is_empty());
    }

    #[test]
    fn test_mismatched_stride_publishes_no_schedule() {
        let harness = fixture();
        let collector = harness.collector();
        let bank = harness.working_bank();
        let epoch = bank.epoch_schedule().get_epoch(bank.slot());
        let slots_in_epoch = bank.epoch_schedule().get_slots_in_epoch(epoch);

        let (_, turns) = collector.epoch_turns(epoch, slots_in_epoch.saturating_add(4));
        assert!(turns.is_empty());
    }

    #[test]
    fn test_the_epoch_before_this_one_is_kept_rather_than_sent() {
        let harness = fixture();
        let mut collector = harness.collector();
        collector.tick();

        let held = harness.epochs.read().unwrap();
        let bank = harness.working_bank();
        let epoch = bank.epoch_schedule().get_epoch(bank.slot());
        assert!(
            held.iter().any(|record| record.epoch == epoch),
            "the current epoch is always among them"
        );
        assert!(held.iter().all(|record| record.epoch <= epoch));
    }

    #[test]
    fn test_a_kept_past_epoch_carries_no_leader_slots_of_ours() {
        let harness = fixture();
        let collector = harness.collector();
        let bank = harness.working_bank();
        let epoch = bank.epoch_schedule().get_epoch(bank.slot());

        if let Some(record) = collector.epoch_record(&bank, epoch) {
            assert!(record.my_leader_slots.is_empty());
            assert!(!record.turns.is_empty(), "and it is otherwise whole");
        }
    }

    #[test]
    fn test_the_epoch_message_is_built_once_and_not_at_every_poll() {
        let harness = fixture();
        let mut collector = harness.collector();
        collector.tick();
        let first = collector.epoch_published;
        assert!(first.is_some());

        harness.advance_to(8);
        collector.tick();
        assert_eq!(collector.epoch_published, first);
    }

    #[test]
    fn test_swapped_identity_rebuilds_the_epoch() {
        let harness = fixture();
        let mut collector = harness.collector();
        collector.tick();
        let first = collector.epoch_published;
        assert!(first.is_some());

        harness
            .ctx
            .cluster_info
            .set_keypair(Arc::new(Keypair::new()));
        harness.advance_to(8);
        collector.tick();

        assert_ne!(
            collector.epoch_published, first,
            "the epoch must be rebuilt for whoever this validator is now"
        );
    }

    #[test]
    fn test_the_skip_rate_starts_again_for_a_swapped_identity() {
        let harness = fixture();
        let mut collector = harness.collector();
        collector.tick();

        let stranger = Pubkey::new_unique();
        collector.skip_rate.epoch = Some((0, stranger));
        collector.skip_rate.next_index = 99;
        collector.collect_skip_rate(&harness.working_bank());

        assert_ne!(
            collector.skip_rate.epoch,
            Some((0, stranger)),
            "the latch must not still belong to the identity that has gone"
        );
        // Not nought: the reset is followed by a walk over every passed leader slot.
        let restarted = {
            let mut control = harness.collector();
            control.collect_skip_rate(&harness.working_bank());
            control.skip_rate.next_index
        };
        assert_eq!(
            collector.skip_rate.next_index, restarted,
            "the walk restarts rather than carrying an index into another schedule"
        );
    }

    #[test]
    fn test_epoch_credits_count_only_the_asked_epoch() {
        let state = solana_vote_interface::state::VoteStateV3 {
            epoch_credits: vec![(5, 100, 0), (6, 250, 100), (7, 400, 250)],
            ..Default::default()
        };
        let view = solana_vote::vote_state_view::VoteStateView::from(state);
        assert_eq!(count_epoch_credits(&view, 7), 150);
        assert_eq!(count_epoch_credits(&view, 8), 0, "not voted in yet");
    }

    #[test]
    fn test_the_vote_account_reports_its_bls_key_and_credits() {
        let harness = fixture();
        harness.advance_to(8);
        harness.collector().tick();

        let bls = harness.published_key("summary", "bls_key").unwrap();
        assert!(
            bls.contains(r#""value":true"#) || bls.contains(r#""value":false"#),
            "{bls}"
        );
        let credits = harness.published_key("summary", "vote_credits").unwrap();
        assert!(credits.contains(r#""credits":0"#), "{credits}");
        assert!(credits.contains(r#""cluster_max":0"#), "{credits}");
        let admission = harness.published_key("summary", "admission").unwrap();
        assert!(admission.contains(r#""value":null"#), "{admission}");
    }

    #[test]
    fn test_the_vote_pass_counts_how_far_a_snapshot_write_fell_behind() {
        let harness = fixture();
        let mut collector = harness.collector();
        let staged = |writing| {
            Some(Snapshots {
                full: None,
                incremental: None,
                full_interval: None,
                incremental_interval: None,
                writing,
                last_written: None,
            })
        };
        let writing = Writing {
            slot: 300,
            since_millis: 0,
        };
        collector.snapshots.observe(staged(Some(writing)), 10, 0);
        harness.advance_to(64);
        harness.set_cluster_tip(100);
        collector.tick();
        let completed = published_number(&harness, "completed_slot").unwrap();

        let shown = collector
            .snapshots
            .observe(staged(None), completed, 0)
            .unwrap();
        assert_eq!(
            shown.last_written.map(|written| written.fell_behind_slots),
            Some(100 - completed)
        );
    }

    #[test]
    fn test_the_node_reports_the_client_it_gossips_beside_its_version() {
        let harness = fixture();
        harness.collector().publish_static();
        let client = harness
            .ctx
            .cluster_info
            .my_contact_info()
            .version()
            .client()
            .to_string();

        // Asserting a name would only assert which fork ran the tests.
        let published = harness.published_key("summary", "client").unwrap();
        assert!(
            published.contains(&format!(r#""value":"{client}""#)),
            "published {published}, which does not carry the client {client}"
        );

        let version = harness.published_key("summary", "version").unwrap();
        assert!(
            !version.contains(&client),
            "{version} already names the client, so publishing it apart is dead weight"
        );
    }

    fn staked(entries: &[(u8, u64)]) -> HashMap<Pubkey, u64> {
        entries
            .iter()
            .map(|&(seed, stake)| (identity(seed), stake))
            .collect()
    }

    fn gossiped(entries: &[(u8, &str)]) -> HashMap<Pubkey, String> {
        entries
            .iter()
            .map(|&(seed, version)| (identity(seed), version.to_string()))
            .collect()
    }

    #[test]
    fn test_prerelease_tags_fold_into_one_release_row() {
        let shares = version_shares(
            &staked(&[(1, 10), (2, 10), (3, 10)]),
            &gossiped(&[(1, "4.2.0"), (2, "4.2.0-rc.0"), (3, "4.2.0-rc.1")]),
        );
        assert_eq!(shares.len(), 1);
        assert_eq!(shares[0].version.as_deref(), Some("4.2.0"));
        assert_eq!(shares[0].validators, 3);
        assert_eq!(shares[0].stake, 30);
    }

    #[test]
    fn test_rows_are_ordered_by_stake_not_by_node_count() {
        let shares = version_shares(
            &staked(&[(1, 1_000), (2, 1), (3, 1), (4, 1)]),
            &gossiped(&[(1, "4.2.0"), (2, "4.1.0"), (3, "4.1.0"), (4, "4.1.0")]),
        );
        assert_eq!(shares[0].version.as_deref(), Some("4.2.0"));
        assert_eq!(shares[0].stake, 1_000);
        assert_eq!(shares[1].validators, 3, "more nodes, less stake, second");
    }

    #[test]
    fn test_an_unstaked_gossip_node_is_not_counted() {
        let shares = version_shares(&staked(&[]), &gossiped(&[(1, "4.2.0")]));
        assert!(shares.is_empty());
    }

    #[test]
    fn test_the_counts_sum_to_the_staked_validator_total() {
        let staked = staked(&[(1, 10), (2, 10), (3, 10)]);
        let shares = version_shares(
            &staked,
            &gossiped(&[(1, "4.2.0"), (2, "4.3.0"), (7, "4.3.0"), (8, "4.3.0")]),
        );
        let counted: usize = shares.iter().map(|share| share.validators).sum();
        assert_eq!(counted, staked.len());
    }

    #[test]
    fn test_a_staked_validator_gossip_cannot_see_reports_no_version() {
        let shares = version_shares(&staked(&[(9, 500)]), &gossiped(&[]));
        assert_eq!(shares.len(), 1);
        assert_eq!(shares[0].version, None);
        assert_eq!(shares[0].stake, 500);
        assert!(
            !shares[0].other,
            "no version reported is not the folded tail"
        );
    }

    #[test]
    fn test_the_tail_folds_into_one_flagged_row() {
        let peers: Vec<(u8, String)> = (1..=9).map(|seed| (seed, format!("4.{seed}.0"))).collect();
        let versions = gossiped(
            &peers
                .iter()
                .map(|(seed, version)| (*seed, version.as_str()))
                .collect::<Vec<_>>(),
        );
        let stakes: Vec<(u8, u64)> = (1..=9).map(|seed| (seed, u64::from(seed))).collect();
        let shares = version_shares(&staked(&stakes), &versions);

        assert_eq!(shares.len(), MAX_VERSIONS_REPORTED + 1);
        let last = shares.last().unwrap();
        assert!(last.other, "the fold is flagged rather than inferred");
        assert_eq!(last.validators, 9 - MAX_VERSIONS_REPORTED);
        assert!(
            shares[..MAX_VERSIONS_REPORTED].iter().all(|s| !s.other),
            "only the tail row is flagged"
        );
    }

    const FRESH: Duration = Duration::from_secs(1);

    #[test]
    fn test_replay_is_stalled_when_no_slot_completes() {
        assert_eq!(
            assess_health(Duration::from_secs(13), 100, true, Some(99), Some(1), FRESH).replay,
            ReplayHealth::Stalled
        );
        assert_eq!(
            assess_health(FRESH, 100, true, Some(99), Some(1), FRESH).replay,
            ReplayHealth::Running
        );
    }

    #[test]
    fn test_replay_has_not_started_before_the_first_slot() {
        assert_eq!(
            assess_health(FRESH, 0, true, None, None, FRESH).replay,
            ReplayHealth::NotStarted
        );
    }

    fn published_number(harness: &Fixture, key: &str) -> Option<u64> {
        let message = harness.published_key("summary", key)?;
        let after = message.rsplit_once(r#""value":"#)?.1;
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    }

    #[test]
    fn test_the_cluster_distance_is_measured_against_the_cluster() {
        // Replay against our own vote reads nought however far back the node is.
        let harness = fixture();
        harness.advance_to(64);
        harness.set_cluster_tip(10_000);
        harness.collector().tick();

        let completed = published_number(&harness, "completed_slot").unwrap();
        assert_eq!(
            published_number(&harness, "behind_cluster"),
            Some(10_000 - completed),
            "the distance is the cluster's tip less what this node has replayed"
        );
    }

    #[test]
    fn test_a_node_the_cluster_has_not_outrun_is_not_behind() {
        // Being ahead of the last certificate seen is ordinary, not a distance.
        let harness = fixture();
        harness.advance_to(64);
        harness.set_cluster_tip(1);
        harness.collector().tick();

        assert_eq!(published_number(&harness, "behind_cluster"), Some(0));
    }

    #[test]
    fn test_the_replay_rate_is_read_across_the_window() {
        let now = Instant::now();
        let at = |secs_ago: u64| now.checked_sub(Duration::from_secs(secs_ago)).unwrap();
        let window: VecDeque<(Instant, Slot)> =
            [(at(20), 1_000), (at(10), 1_400), (at(0), 1_800)].into();
        assert_eq!(measure_replay_rate(&window), Some(40.0));
    }

    #[test]
    fn test_the_replay_rate_waits_for_a_span_worth_reading() {
        let now = Instant::now();
        let at = |secs_ago: u64| now.checked_sub(Duration::from_secs(secs_ago)).unwrap();
        let window: VecDeque<(Instant, Slot)> = [(at(2), 1_000), (at(0), 1_010)].into();
        assert_eq!(measure_replay_rate(&window), None);
        assert_eq!(measure_replay_rate(&VecDeque::new()), None);
    }

    #[test]
    fn test_under_tower_the_vote_cost_is_a_day_of_fees() {
        let harness = fixture();
        harness.collector().tick();
        let bank = harness.working_bank();
        let slots_per_day = NANOS_PER_DAY
            .checked_div(bank.ns_per_slot_at_slot(bank.slot()))
            .unwrap();
        let per_day = u64::try_from(slots_per_day)
            .unwrap()
            .checked_mul(bank.get_lamports_per_signature())
            .unwrap();

        let cost = harness.published_key("summary", "vote_cost").unwrap();
        assert!(cost.contains(r#""kind":"fees""#), "{cost}");
        assert!(cost.contains(&format!(r#""per_day":{per_day}"#)), "{cost}");
    }

    #[test]
    fn test_nothing_is_claimed_before_a_certificate_arrives() {
        // On a fresh start nought would say this node was in step with a cluster it
        // has not heard from.
        let harness = fixture();
        harness.advance_to(64);
        harness.collector().tick();

        let published = harness.published_key("summary", "behind_cluster").unwrap();
        assert!(published.contains(r#""value":null"#), "got {published}");
    }

    #[test]
    fn test_a_validator_on_its_backup_identity_is_not_voting() {
        assert_eq!(
            assess_health(FRESH, 100, false, Some(99), Some(1), FRESH).vote,
            VoteHealth::NotVoting
        );
    }

    #[test]
    fn test_not_voting_outranks_every_other_reading() {
        assert_eq!(
            assess_health(
                FRESH,
                100,
                false,
                Some(50),
                Some(VOTE_BEHIND_LIMIT + 1),
                FRESH
            )
            .vote,
            VoteHealth::NotVoting
        );
        assert_eq!(
            assess_health(FRESH, 100, false, None, None, Duration::from_secs(3_600)).vote,
            VoteHealth::NotVoting
        );
    }

    #[test]
    fn test_replay_is_reported_whether_or_not_this_node_votes() {
        assert_eq!(
            assess_health(FRESH, 100, false, None, None, FRESH).replay,
            ReplayHealth::Running
        );
    }

    #[test]
    fn test_a_vote_far_behind_the_tip_is_delinquent() {
        assert_eq!(
            assess_health(
                FRESH,
                100,
                true,
                Some(50),
                Some(VOTE_BEHIND_LIMIT + 1),
                FRESH
            )
            .vote,
            VoteHealth::Delinquent
        );
        assert_eq!(
            assess_health(FRESH, 100, true, Some(50), Some(VOTE_BEHIND_LIMIT), FRESH).vote,
            VoteHealth::Voting
        );
    }

    #[test]
    fn test_a_vote_that_is_close_but_frozen_is_delinquent() {
        // The case the distance alone misses: near the tip and not moving.
        assert_eq!(
            assess_health(FRESH, 100, true, Some(99), Some(1), Duration::from_secs(61)).vote,
            VoteHealth::Delinquent
        );
    }

    #[test]
    fn test_a_node_that_has_never_voted_is_not_delinquent() {
        // An unstaked node is not a failing one, however long it sits there.
        assert_eq!(
            assess_health(FRESH, 100, true, None, None, Duration::from_secs(3_600)).vote,
            VoteHealth::NotStarted
        );
    }

    fn upcoming_slots(harness: &crate::fixture::Fixture) -> Vec<u64> {
        let published = harness
            .published_key("slot", "upcoming")
            .expect("upcoming is published");
        let envelope: serde_json::Value = serde_json::from_str(&published).unwrap();
        envelope["value"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["slot"].as_u64().unwrap())
            .collect()
    }

    #[test]
    fn test_upcoming_starts_past_the_tip_and_runs_contiguously() {
        let harness = fixture();
        harness.advance_to(64);
        let mut collector = harness.collector();
        let root_bank = harness.bank_forks.read().unwrap().root_bank();

        collector.collect_upcoming(&root_bank, 64);
        let slots = upcoming_slots(&harness);

        assert!(!slots.is_empty(), "the schedule for this epoch is known");
        assert_eq!(slots[0], 65, "starts past the slot being worked on");
        let contiguous: Vec<u64> = (0..slots.len() as u64)
            .map(|index| index.saturating_add(65))
            .collect();
        assert_eq!(slots, contiguous, "no gaps");
        assert!(
            slots.len() as u64 <= UPCOMING_SLOTS,
            "bounded at {UPCOMING_SLOTS}"
        );
    }

    #[test]
    fn test_upcoming_marks_our_own_slots() {
        let harness = fixture();
        harness.advance_to(8);
        let mut collector = harness.collector();
        let root_bank = harness.bank_forks.read().unwrap().root_bank();

        collector.collect_upcoming(&root_bank, 8);
        let published = harness.published_key("slot", "upcoming").unwrap();
        assert!(
            published.contains(r#""mine":true"#),
            "the only staked leader should be marked as ours"
        );
    }

    #[test]
    fn test_the_collector_keeps_the_phases_the_boot_thread_timed() {
        let harness = fixture();
        let shared = Arc::new(Mutex::new(StartupPublisher::default()));
        shared.lock().unwrap().publish(
            &harness.publisher,
            ValidatorStartProgress::CleaningAccounts,
            None,
        );
        shared
            .lock()
            .unwrap()
            .publish(&harness.publisher, ValidatorStartProgress::Running, None);

        let mut collector = harness.collector_with_startup(shared);
        collector.tick();

        let last = harness
            .published()
            .into_iter()
            .rfind(|message| message.contains(r#""key":"startup_progress""#))
            .expect("the collector publishes startup progress");
        assert!(
            last.contains(r#""phase":"cleaning_accounts""#),
            "the collector's own message must carry what the boot thread timed: {last}"
        );
    }

    #[test]
    fn test_stale_tip_is_not_caught_up() {
        // The blockstore keeps optimistic slots from before a restart, so the first tip read is
        // stale.
        let harness = fixture();
        harness.advance_to(64);
        let mut collector = harness.collector();

        harness.set_cluster_tip(1);
        collector.tick();
        assert!(
            harness
                .published_key("summary", "caught_up_time_nanos")
                .is_none()
        );
    }

    #[test]
    fn test_catching_up_is_stamped_once_a_tip_seen_ahead_is_reached() {
        let harness = fixture();
        harness.advance_to(64);
        let mut collector = harness.collector();

        harness.set_cluster_tip(100);
        collector.tick();
        assert!(
            harness
                .published_key("summary", "caught_up_time_nanos")
                .is_none()
        );

        harness.advance_to(101);
        collector.tick();
        assert!(
            harness
                .published_key("summary", "caught_up_time_nanos")
                .is_some()
        );
    }

    #[test]
    fn test_releases_fold_their_prerelease_tags() {
        assert_eq!(strip_prerelease("4.2.0-rc.1"), "4.2.0");
        assert_eq!(strip_prerelease("0.1102.0-beta.40201"), "0.1102.0");
        assert_eq!(strip_prerelease("4.2.0"), "4.2.0");
        assert_eq!(strip_prerelease("1.18.23+build7"), "1.18.23");
    }

    #[test]
    fn test_folding_leaves_strings_that_are_not_semver_alone() {
        assert_eq!(strip_prerelease(""), "");
        assert_eq!(strip_prerelease("unknown"), "unknown");
        assert_eq!(strip_prerelease("-leading"), "");
    }

    #[test]
    fn test_a_frozen_bank_arrives_by_notification() {
        let harness = fixture();
        let bank = harness.advance_to(8);
        let mut collector = harness.collector();
        let (sender, receiver) = crossbeam_channel::unbounded();
        collector.frozen_banks = Some(receiver);

        collector.tick();
        assert!(
            !harness
                .published()
                .iter()
                .any(|message| message.contains(r#""slot":8,"level":"completed""#))
        );

        sender.send((BankNotification::Frozen(bank), None)).unwrap();
        collector.overview_retained_at = Instant::now().checked_sub(OVERVIEW_INTERVAL).unwrap();
        collector.tick();
        let overview = harness.published_key("slot", "overview").unwrap();
        assert!(overview.contains(r#""slot":8"#), "{overview}");
        assert!(overview.contains(r#""transactions":"#), "{overview}");
        assert!(collector.totals.contains_key(&8));
    }

    #[test]
    fn test_the_consensus_is_published() {
        let harness = fixture();
        harness.advance_to(8);
        harness.collector().tick();
        let message = harness.published_key("summary", "consensus").unwrap();
        assert!(message.contains(r#""value":"tower""#), "{message}");
    }

    #[test]
    fn test_the_overview_is_encoded_once_a_second() {
        let harness = fixture();
        let mut collector = harness.collector();
        harness.advance_to(8);
        collector.tick();
        let first = harness.published_key("slot", "overview").unwrap();
        assert!(first.contains(r#""slot":8"#), "{first}");

        harness.advance_to(9);
        collector.tick();
        let held = harness.published_key("slot", "overview").unwrap();
        assert!(!held.contains(r#""slot":9"#), "encoded inside the interval");
        assert!(collector.overview_dirty);

        collector.overview_retained_at = Instant::now().checked_sub(OVERVIEW_INTERVAL).unwrap();
        collector.tick();
        let refreshed = harness.published_key("slot", "overview").unwrap();
        assert!(refreshed.contains(r#""slot":9"#), "{refreshed}");
        assert!(!collector.overview_dirty);
    }
}
