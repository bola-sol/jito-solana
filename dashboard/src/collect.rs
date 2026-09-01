//! Samples validator state on a timer and publishes what changed.
//!
//! Everything here reads through handles the validator already holds. No code
//! in this module writes to validator state, and none of it blocks a validator
//! thread for longer than it takes to clone an `Arc` out from behind a lock.
//!
//! The collector is diff-driven. It samples often, five times a second by
//! default, but publishes a key only once its value has actually moved. An idle
//! validator therefore produces almost no websocket traffic.
//!
//! This is the slot half of the sampling, and the half that reads the
//! blockstore and the accounts database. The once-a-second readings live in
//! [`crate::meters`] and run on their own thread, so that a slow read here does
//! not take the whole dashboard quiet with it.

use {
    crate::{
        context::{DashboardContext, StartupProgressFn},
        history::SlotHistory,
        produced::{ProducedBlock, ProducedRing},
        proto::{Debounced, Publisher, TOPIC_EPOCH, TOPIC_PEERS, TOPIC_SLOT, TOPIC_SUMMARY},
        slots::{BlockDetail, SlotEntry, SlotLevel, SlotRing},
        startup::StartupPublisher,
        tips::{TipMeter, TipRates},
        validator_info::{self, ValidatorInfoCache},
    },
    serde::Serialize,
    solana_clock::{Clock, Epoch, Slot},
    solana_leader_schedule::NUM_CONSECUTIVE_LEADER_SLOTS,
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    std::{
        collections::{HashMap, HashSet, VecDeque},
        sync::{Arc, RwLock},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    },
};

/// A validator whose last vote is further behind than this is reported as
/// delinquent, matching the threshold the RPC layer uses.
const MAX_DELINQUENT_SLOT_DISTANCE: u64 = 128;

/// How often the expensive samples (the full validator set, the program cache)
/// are taken, regardless of the poll interval.
const SLOW_TICK: Duration = Duration::from_secs(5);

/// Slots to include in the strip and sidebar snapshot sent on connect.
const SLOT_OVERVIEW_LEN: usize = 512;

/// Recent slots kept in memory for the slot strip and sidebar. Larger than the
/// overview above, which is what a client is sent; the rest is what a slot
/// arriving late can still be matched against.
const SLOT_HISTORY: usize = 4096;

/// Distinct client versions reported before the tail is folded into one row.
const MAX_VERSIONS_REPORTED: usize = 5;

/// How far ahead to look for this validator's next leader slot.
const NEXT_LEADER_LOOKAHEAD: u64 = 20_000;

/// Slots of the leader schedule published ahead of the tip.
///
/// Eight leader turns, about thirteen seconds. The page shows the next two and
/// the rest is headroom: the list is published on the slow tier, so by the time
/// a client reads it several of the leading entries have already happened, and
/// a search may want a turn further out than the two on screen.
///
/// On the slow tier rather than every tick because the list shifts by a couple
/// of slots a second, and republishing it that often would spend more on the
/// wire than the seconds it describes are worth.
const UPCOMING_SLOTS: u64 = 32;

/// Produced blocks kept for the block detail panel.
///
/// A validator leads about four slots in every eight hundred, so five hundred
/// of them span roughly a hundred thousand slots, or eleven hours. Matched to
/// the own-slot retention in the slot ring: a slot the sidebar still lists and
/// the detail panel cannot open would be a link to nothing.
const PRODUCED_BLOCKS: usize = 500;

/// Slots of arrival times kept, about five minutes of them.
///
/// This is what is retained, not what is reported. Readings are taken over
/// spans of it: the strip's readout wants a figure that follows the cluster
/// now, and the epoch countdown wants one that sits still, because it is
/// multiplied by an epoch's worth of remaining slots where a millisecond of
/// wobble is seven minutes on the clock. Both come off these samples rather
/// than from two windows kept in step.
///
/// Counted in slots rather than in wall-clock time so that it does not thin out
/// during a stall, which is exactly when it gets read.
const SLOT_TIME_WINDOW_SLOTS: usize = 750;

/// Span the slot strip's readout averages over. Short enough to follow the
/// cluster, long enough that a single slow slot does not move it.
const SLOT_READOUT_SPAN_MS: u64 = 60_000;

/// How near the highest slot held replay must come before this validator is
/// following the cluster rather than replaying towards it.
const CAUGHT_UP_SLOT_DISTANCE: u64 = 4;

/// Samples the window must already hold before that distance is believed.
///
/// Distance alone says nothing on its own: a validator that has just loaded a
/// snapshot and received nothing sits at zero distance, and would mark itself
/// caught up immediately before replaying half a million slots. Requiring the
/// window to have filled first means the distance is only read once slots have
/// been arriving for a while.
const CAUGHT_UP_MIN_SAMPLES: usize = 64;

/// Slots skipped past when the marker is set, so that the interval straddling
/// the transition — part replay burst, part cluster — is not measured.
const CAUGHT_UP_MARGIN_SLOTS: u64 = 4;

/// Slots an epoch must have run before its own rate is believed.
///
/// The cluster's clock moves in whole seconds, so a rate taken from it carries
/// a second of quantisation spread across the slots elapsed so far: a
/// millisecond a slot after a thousand slots, a tenth of that after ten
/// thousand. The sliding window's own jitter is about a quarter of a
/// millisecond, so below roughly four thousand slots the window is the quieter
/// of the two, and above it the epoch is — by a margin that only grows.
const EPOCH_RATE_MIN_ELAPSED_SLOTS: u64 = 4_000;

/// The countdown follows its estimate once that estimate has moved further than
/// this fraction of the time still to run.
///
/// Proportional rather than a fixed duration, because the countdown's
/// sensitivity to the slot rate scales with the slots left: sixty seconds of
/// countdown is a seventh of a millisecond of slot time at the start of an
/// epoch and sixty milliseconds at the end, four hundred times looser. A single
/// figure cannot be right at both ends, and one that is far too tight at the
/// start lets every sample turnover through, which is a gate that does nothing.
const EPOCH_END_DRIFT_DIVISOR: u32 = 64;

/// Slots timed in one tick. Bounds the blockstore lookups after a stall, when
/// the cursor could otherwise be thousands of slots behind.
const MAX_SLOTS_TIMED_PER_TICK: u64 = 512;

/// Above this rate of slots replayed per second the validator is catching up
/// rather than following the cluster, so throughput samples are discarded. A
/// healthy cluster produces about two and a half slots a second.
pub(crate) const CATCH_UP_SLOTS_PER_SECOND: f64 = 6.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StakeSummary {
    /// Stake delegated to this validator's vote account, in lamports.
    pub activated_stake: u64,
    /// Total stake across all vote accounts, in lamports.
    pub total_stake: u64,
    /// This validator's share of total stake, in `[0, 1]`.
    pub share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValidatorCounts {
    /// Distinct node identities holding stake this epoch. Unstaked vote
    /// accounts are excluded, since the bank keeps every one ever created and
    /// there are tens of thousands of them, and identities rather than vote
    /// accounts are counted so one validator counts once.
    pub total: usize,
    /// Staked validators whose last vote is too far behind the chain tip.
    pub delinquent: usize,
    pub rpc_nodes: usize,
    pub non_delinquent_stake: u64,
    pub delinquent_stake: u64,
}

/// How the cluster's stake is spread across client versions.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersionShare {
    /// Semver as gossip reports it, or `null` for peers reporting none.
    pub version: Option<String>,
    pub validators: usize,
    pub stake: u64,
    /// True for the single row the tail is folded into. A genuine
    /// no-version-reported group also has no version but is not this, and the
    /// two sort together, so position cannot tell them apart.
    pub other: bool,
}

/// What is known about a validator beyond the name the slot rows carry.
///
/// Published only for the leaders on screen, so this table is bounded by what
/// the page shows rather than by the size of the validator set. The name and
/// icon are deliberately absent: every slot row already carries them, and
/// repeating them here would be the largest thing in the message.
///
/// The gossip address is on this list because a schedule is read to work out
/// who is producing badly and from where. It is already public — every node in
/// the cluster has it — but this publishes it to anyone who can reach the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Peer {
    pub identity: String,
    /// Client version as gossip reports it, absent for a node not being heard
    /// from.
    pub version: Option<String>,
    /// Active stake this epoch, in lamports. Zero for an unstaked node.
    pub stake: u64,
    /// Host of the gossip address, without the port.
    pub ip: Option<String>,
    /// Display name from the validator's on-chain info, when it published one.
    ///
    /// Here rather than on every slot it leads. A leader takes four slots at a
    /// time and comes round often, so on the slot it was the same string many
    /// times over; here it is one copy, in a table the schedule page already
    /// joins against for the version and stake beside it.
    pub name: Option<String>,
    /// The validator's on-chain icon URL, when it published one.
    pub icon: Option<String>,
}

/// A slot the leader schedule has assigned that has not happened yet.
///
/// Leaner than [`SlotEntry`]: an unstarted slot has no level, no block and no
/// duration, and saying so with nulls would cost more than leaving them out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpcomingSlot {
    pub slot: Slot,
    pub leader: String,
    pub leader_name: Option<String>,
    pub leader_icon: Option<String>,
    /// True when this validator is the scheduled leader.
    pub mine: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EpochInfo {
    pub epoch: Epoch,
    pub start_slot: Slot,
    pub end_slot: Slot,
    pub slots_in_epoch: u64,
    /// Slots in this epoch where this validator is the leader.
    pub my_leader_slots: Vec<Slot>,

    /// Every leader of this epoch, in the order they first take a turn.
    ///
    /// Sent once rather than on every slot. A slot entry used to carry its
    /// leader's key, name and icon, which across a window of them is the same
    /// forty-four characters repeated thousands of times.
    pub leaders: Vec<String>,
    /// One index into `leaders` for each run of consecutive slots the schedule
    /// hands to a single leader, so the leader of a slot is
    /// `leaders[turns[(slot - start_slot) / NUM_CONSECUTIVE_LEADER_SLOTS]]`.
    ///
    /// Empty where the schedule for this epoch is not derived yet, and empty
    /// rather than partial where it could not be read as whole turns. A short
    /// array here is indistinguishable from a short epoch, so there is no safe
    /// way to send half of one.
    pub turns: Vec<u16>,

    /// Consensus limits every block of this epoch is measured against.
    ///
    /// Here rather than on each slot because they only move with feature
    /// activation, which lands on an epoch boundary. Per slot they were the
    /// same two numbers repeated for the life of the epoch.
    pub block_cost_limit: u64,
    pub account_cost_limit: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Health {
    pub replay: &'static str,
    pub vote: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkipRate {
    pub epoch: Epoch,
    /// Fraction of this validator's leader slots that produced no block, over
    /// the part of the epoch the blockstore covers, in `[0, 1]`. `None` until
    /// the root has passed at least one such slot.
    pub rate: Option<f64>,
}

#[derive(Default)]
struct Debounces {
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
    epoch_remaining_nanos: Debounced<u64>,
    upcoming: Debounced<Vec<UpcomingSlot>>,
    peers: Debounced<Vec<Peer>>,
}

pub struct Collector {
    ctx: DashboardContext,
    publisher: Arc<Publisher>,
    /// Supplied by the service rather than the context, since the boot
    /// thread reports progress long before a context can be built.
    startup_progress: StartupProgressFn,

    debounces: Debounces,
    slots: SlotRing,
    info_cache: Arc<RwLock<ValidatorInfoCache>>,
    /// Shared with the boot thread's implementation so the handover from it
    /// to the collector is invisible to a connected client.
    startup: StartupPublisher,

    /// Highest slot for which leaders have been resolved, so the schedule is
    /// only walked forwards.
    leaders_resolved_to: Slot,
    /// Highest slot already swept for validator-info writes.
    info_scanned_to: Slot,
    /// Tip at the moment the collector started. Slots below it were never
    /// watched, so they are neither tracked nor counted as skipped.
    first_observed_slot: Option<Slot>,
    /// Detail for blocks this validator produced, captured as they froze.
    produced: ProducedRing,
    /// The same slots as the ring above, packed to the columns a schedule row
    /// draws and kept far deeper.
    ///
    /// Shared with the server, which answers range queries out of it. Written
    /// here on every slot change and read there on demand, so a read lock is
    /// held for the length of one range and a write for the length of one row.
    history: Arc<RwLock<SlotHistory>>,
    /// This epoch and the one before it, for the page to ask about.
    ///
    /// Shared with the server, which answers a query out of it. Only the
    /// current one is published; the previous is kept because a client reading
    /// back through the packed history crosses into it a quarter of the time
    /// and cannot name a leader there without it.
    epochs: Arc<RwLock<Vec<EpochInfo>>>,
    /// The epoch, and whether its schedule was known, the last time the epoch
    /// message was built.
    ///
    /// Everything in that message is fixed for the epoch's whole life, and the
    /// turn array is a hundred and eight thousand entries on mainnet. Built at
    /// every poll it would be two hundred kilobytes of arrays assembled five
    /// times a second for `Debounced` to find unchanged and throw away.
    ///
    /// The second half of the pair is what lets a schedule that arrives late
    /// still be published. Until it is derived the arrays are empty, and on
    /// the epoch alone the next tick would match and never try again.
    epoch_published: Option<(Epoch, bool)>,
    /// This validator's leader slots for the epoch the *root* is in, kept so
    /// the skip rate can walk them as the root passes each one.
    ///
    /// Rebuilt only when the root crosses an epoch boundary, which is what ties
    /// it to `skip_next_index`: the two must describe the same epoch, or the
    /// index points into the wrong schedule.
    skip_leader_slots: Vec<Slot>,
    skip_epoch: Option<Epoch>,
    skip_next_index: usize,
    skip_produced: usize,
    skip_elapsed: usize,
    last_completed_slot: Slot,
    last_completed_at: Instant,
    /// Highest slot examined for a shred timestamp, whether or not it had one.
    /// Skipped slots never do, so this advances past them independently.
    slot_timed_to: Option<Slot>,
    /// The last slot that did carry a timestamp, and that timestamp in
    /// milliseconds. The next slot's duration is measured from here.
    last_shred_time: Option<(Slot, u64)>,
    /// `(slot, arrival)` pairs spanning the averaging window, oldest first.
    /// Bounded by [`SLOT_TIME_WINDOW_SLOTS`].
    slot_time_window: VecDeque<(Slot, u64)>,
    /// First slot whose timing describes the cluster rather than a replay
    /// burst. Set once, never cleared. See [`Collector::mark_caught_up`].
    caught_up_at: Option<Slot>,
    /// Whether replay was ever seen trailing the highest slot held, before the
    /// marker above was set. Decides whether there is anything to throw away
    /// when it is: a validator that started level never measured a burst.
    replayed_behind: bool,
    /// The epoch end currently being counted down to, and the epoch it belongs
    /// to. Held rather than recomputed so the readout does not chase its own
    /// estimate. See [`EPOCH_END_DRIFT_DIVISOR`].
    epoch_end: Option<(Epoch, SystemTime)>,
    last_vote_advance: Instant,
    /// Whether this process is the identity allowed to vote with the configured
    /// vote account. False on a validator running its backup identity, and on
    /// one started without a vote account at all.
    voting: bool,
    last_slow_tick: Instant,
    /// Viewers attached as of the last tick, kept only so that pausing and
    /// resuming are logged once rather than on every tick.
    subscribers: usize,

    /// Reads what each slot paid in jito tips. `None` where no tip payment
    /// program is configured, which is every plain agave validator.
    tips: Option<TipMeter>,
    /// Our own commission on tips, sent to the page so it can work out what our
    /// blocks earned. Never applied to another validator's turn.
    commission_bps: Option<u16>,
    /// The meter's last reported residual, so a change is logged once rather
    /// than every slow tick.
    tips_residual: Option<u64>,
}

impl Collector {
    pub fn new(
        ctx: DashboardContext,
        publisher: Arc<Publisher>,
        info_cache: Arc<RwLock<ValidatorInfoCache>>,
        history: Arc<RwLock<SlotHistory>>,
        epochs: Arc<RwLock<Vec<EpochInfo>>>,
        startup_progress: StartupProgressFn,
        tips: Option<TipMeter>,
        commission_bps: Option<u16>,
    ) -> Self {
        let now = Instant::now();
        Self {
            slots: SlotRing::new(SLOT_HISTORY),
            ctx,
            publisher,
            startup_progress,
            debounces: Debounces::default(),
            info_cache,
            startup: StartupPublisher::default(),
            leaders_resolved_to: 0,
            info_scanned_to: 0,
            first_observed_slot: None,
            produced: ProducedRing::new(PRODUCED_BLOCKS),
            history,
            epochs,
            skip_leader_slots: Vec::new(),
            epoch_published: None,
            skip_epoch: None,
            skip_next_index: 0,
            skip_produced: 0,
            skip_elapsed: 0,
            last_completed_slot: 0,
            last_completed_at: now,
            slot_timed_to: None,
            last_shred_time: None,
            slot_time_window: VecDeque::new(),
            caught_up_at: None,
            replayed_behind: false,
            epoch_end: None,
            last_vote_advance: now,
            // Nothing is known until the first bank is read, and claiming to be
            // voting before then would flash the wrong status on startup.
            voting: false,
            last_slow_tick: now.checked_sub(SLOW_TICK).unwrap_or(now),
            subscribers: 0,
            tips,
            commission_bps,
            tips_residual: None,
        }
    }

    /// Publishes the values that never change for the lifetime of the process.
    pub fn publish_static(&self) {
        let version = solana_version::Version::this_build();
        self.publisher
            .publish(TOPIC_SUMMARY, "version", &version.as_semver_string());
        // Published apart from the version because the semver string does not
        // carry it: `Display` for a version prints the numbers and leaves the
        // client out. Forks ship the version number of the release they follow,
        // so `4.2.1` alone does not say whether this is stock Agave, Jito, or
        // any of the dozen others gossip knows about, and the header read the
        // same on all of them. This is the name the validator's own startup
        // line reports as `client:`.
        self.publisher
            .publish(TOPIC_SUMMARY, "client", &version.client().to_string());
        self.publisher.publish(
            TOPIC_SUMMARY,
            "commit_hash",
            &format!("{:08x}", version.commit()),
        );
        self.publisher
            .publish(TOPIC_SUMMARY, "cluster", &self.ctx.cluster_name());
        // The rates the page derives its two tip figures with. Sent rather than
        // applied here so the stored figure stays the measured one: a rate
        // corrected later then repairs the whole history rather than only what
        // arrives after it. Absent where no tip program is configured, which is
        // how the page knows to draw no column at all.
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
        // Fixed once the node has joined, and the first thing to check when a
        // validator will not gossip.
        self.publisher.publish(
            TOPIC_SUMMARY,
            "shred_version",
            &self.ctx.cluster_info.my_shred_version(),
        );
        self.publisher.publish(
            TOPIC_SUMMARY,
            "startup_time_nanos",
            &system_time_nanos(self.ctx.start_time),
        );
    }

    pub fn tick(&mut self) {
        let now = Instant::now();

        // One acquisition for the whole tick. Bank forks is the lock replay
        // holds to advance, so a reader that takes it three times a tick is
        // three chances to be in the way rather than one. Nothing is computed
        // under it: the guard lives only long enough to clone the handles out.
        let (root_bank, working_bank, highest_slot, mut frozen) = {
            let bank_forks = self.ctx.bank_forks.read().unwrap();
            (
                bank_forks.root_bank(),
                bank_forks.working_bank(),
                bank_forks.highest_slot(),
                bank_forks.frozen_banks().collect::<Vec<_>>(),
            )
        };
        // Slot order, for the tip meter alone. Every other reading below is a
        // difference against a bank's own parent and would be right in any
        // order; the meter's sweep check is a running total and would not.
        frozen.sort_by_key(|(slot, _)| *slot);
        // The highest slot this validator has replayed, as opposed to the
        // highest it holds a bank for.
        let completed = frozen
            .iter()
            .map(|(slot, _)| *slot)
            .max()
            .unwrap_or_default();

        self.collect_slot_positions(&root_bank, highest_slot, completed);
        self.collect_leaders(&root_bank, highest_slot);
        self.collect_slot_levels(&root_bank, &frozen);
        // Balances, vote state and the epoch index come from the working bank.
        // The root trails the tip by the 32 slots it takes to root, so reading
        // them from the root bank showed everything about thirteen seconds late.
        self.collect_identity_and_vote(&working_bank);
        self.collect_epoch(&working_bank);
        self.collect_startup_progress();

        // The five-second tier is where the cost is: it walks every vote account
        // in the cluster and reads the write set of each slot frozen since the
        // last sweep. None of that is worth doing while nobody is connected to
        // see the result.
        //
        // Only this tier is gated. The tiers above feed the slot ring, the
        // duration cursor and the chart histories, and a gap in those would
        // leave the collector walking forward over slots it never watched —
        // which is how skipped slots were once invented out of nothing.
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

        // `last_slow_tick` only moves when the tier actually runs, so while it
        // is paused the interval keeps growing and the first tick after someone
        // connects is already due. That is the immediate refresh — no separate
        // trigger — while a brief disconnection still waits out the remainder
        // of its interval instead of resampling for nothing.
        if subscribers > 0 && now.duration_since(self.last_slow_tick) >= SLOW_TICK {
            self.last_slow_tick = now;
            self.collect_validator_info(&frozen);
            self.collect_peers(&working_bank);
            self.collect_health();
            self.collect_skip_rate(&root_bank);
            // Ahead of the peer table, which covers the leaders of both the
            // slots already sent and the ones about to be.
            let ahead = self.collect_upcoming(&root_bank, highest_slot);
            self.collect_peer_table(&working_bank, ahead);
            self.report_tip_residual();
        }
    }

    /// Logs what the last sweep says the tip readings missed, once per change.
    ///
    /// The only check this measurement gets. A figure near nought says the
    /// turn's readings were complete; a large one says they were not, and is
    /// worth a look before the numbers on the page are believed. Logged rather
    /// than published: it is a statement about our arithmetic, not about the
    /// cluster, and nothing on the page can honestly show it.
    fn report_tip_residual(&mut self) {
        let residual = self.tips.as_ref().and_then(TipMeter::residual);
        if residual == self.tips_residual {
            return;
        }
        self.tips_residual = residual;
        if let Some(lamports) = residual {
            log::info!(
                "dashboard: {lamports} lamports of tips were paid before the receiver changed and are counted against no turn"
            );
        }
    }

    // ---- slot positions -------------------------------------------------

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
        self.mark_caught_up(highest_slot, completed);
        self.observe_slot_duration(root_bank, completed);
    }

    /// Records replay progress and publishes both slot durations: what the
    /// cluster is configured for, and what it is doing.
    ///
    /// The configured one is what the slot strip draws its bars against, where
    /// a fixed reference is the point — bars that rescale themselves show no
    /// change when everything slows down together. The measured one is the
    /// strip's readout. Neither feeds the epoch countdown any more; that reads
    /// the wider window directly, in `collect_epoch_countdown`.
    fn observe_slot_duration(&mut self, root_bank: &Bank, completed: Slot) {
        if completed > self.last_completed_slot {
            self.last_completed_slot = completed;
            self.last_completed_at = Instant::now();
        }

        // Constant between epoch boundaries, which is what makes it usable as
        // the scale the bars are drawn against.
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
            self.windowed_slot_nanos(),
        );
    }

    /// Times each newly arrived slot from the blockstore's own record of when
    /// its first shred landed.
    ///
    /// That timestamp is written at receive time in milliseconds, so this
    /// measures what the node actually saw rather than what the collector
    /// happened to catch on a 200ms poll, which could be half a slot out.
    fn collect_slot_durations(&mut self, up_to: Slot) {
        // Nothing before the collector started was watched, so the first tick
        // establishes a baseline rather than walking the whole ledger.
        let from = match self.slot_timed_to {
            None => up_to,
            Some(timed_to) => timed_to.saturating_add(1),
        };
        let from = from.max(up_to.saturating_sub(MAX_SLOTS_TIMED_PER_TICK));

        let mut changed = Vec::new();
        for slot in from..=up_to {
            self.slot_timed_to = Some(slot);
            // A skipped slot has no shreds and so no timestamp. The next slot
            // that does is then measured from the last one that did, which is
            // why the gap shows up as one long interval rather than vanishing.
            let Some(arrived) = self.first_shred_time(slot) else {
                continue;
            };

            if let Some((previous_slot, previous_arrival)) = self.last_shred_time
                && slot > previous_slot
            {
                let elapsed = arrived.saturating_sub(previous_arrival);
                if let Some(entry) = self.slots.update(slot, |entry| {
                    entry.duration_nanos = Some(elapsed.saturating_mul(1_000_000));
                }) {
                    changed.push(entry);
                }
            }

            // The one reading in this walk that was taken and thrown away.
            // It is the slot's own wall clock, and the packed history is what
            // keeps it; the entries above carry only the difference between one
            // slot and the last.
            self.history.write().unwrap().record_time(slot, arrived);
            self.last_shred_time = Some((slot, arrived));
            self.slot_time_window.push_back((slot, arrived));
            // Skipped slots carry no timestamp and so never enter the window.
            // The mean divides by the slot span rather than by the sample
            // count, so they are still accounted for; the window just reaches
            // back a little further than its length in slot numbers.
            while self.slot_time_window.len() > SLOT_TIME_WINDOW_SLOTS {
                self.slot_time_window.pop_front();
            }
        }

        for entry in &changed {
            self.publish_slot(entry);
        }
    }

    /// Records, once, the point from which slot timings describe the cluster.
    ///
    /// A validator replaying towards the tip runs through slots far faster than
    /// they were produced. Those intervals are a record of the download, not of
    /// the cluster, and averaged in they drag the epoch countdown down for as
    /// long as they stay in the window.
    ///
    /// The fix is a one-shot marker, set when the highest slot held comes
    /// within a few slots of what has been replayed, after which the average is
    /// truncated to the slots that follow it. An earlier attempt here tested the
    /// replay rate continuously and cleared the window whenever it looked like
    /// a burst, which fed back on itself: clearing the window shortened it,
    /// a shorter window is more easily tripped, and the reading never settled.
    ///
    /// Set once and never cleared, so there is no loop to close. A validator
    /// that later falls behind is a validator whose slot timings are genuinely
    /// slow, which is a thing worth reporting rather than hiding.
    fn mark_caught_up(&mut self, highest_slot: Slot, completed: Slot) {
        if self.caught_up_at.is_some() {
            return;
        }
        if highest_slot.saturating_sub(completed) > CAUGHT_UP_SLOT_DISTANCE {
            self.replayed_behind = true;
            return;
        }
        if self.slot_time_window.len() < CAUGHT_UP_MIN_SAMPLES {
            return;
        }

        let from = completed.saturating_add(CAUGHT_UP_MARGIN_SLOTS);
        self.caught_up_at = Some(from);
        if self.replayed_behind {
            // Everything held was measured while trailing the tip, so all of it
            // goes and the readout is blank until the window refills. That is
            // the honest answer: none of it describes the cluster. A validator
            // that started level has nothing to throw away and keeps its
            // samples, rather than blanking a working readout for a minute.
            self.slot_time_window.retain(|(slot, _)| *slot >= from);
        }
        log::info!("dashboard: caught up with the cluster, timing slots from {from}");
    }

    fn first_shred_time(&self, slot: Slot) -> Option<u64> {
        match self.ctx.blockstore.meta(slot) {
            Ok(Some(meta)) if meta.first_shred_timestamp > 0 => Some(meta.first_shred_timestamp),
            _ => None,
        }
    }

    /// Mean milliseconds per slot over the last minute, in nanoseconds.
    ///
    /// A true mean between the ends of the span rather than a decaying
    /// average, so it does not drift and does not need to be seeded.
    fn windowed_slot_nanos(&self) -> Option<u64> {
        windowed_mean_nanos(&self.slot_time_window, SLOT_READOUT_SPAN_MS)
    }

    fn collect_leaders(&mut self, root_bank: &Bank, highest_slot: Slot) {
        let me = self.ctx.identity();
        // On the first tick the ring starts at the current tip. Filling it with
        // the schedule for earlier slots would add slots this validator never
        // watched, and every one of them would then be reported as skipped
        // because no bank for them will ever appear.
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
                // The schedule for this epoch is not known yet; stop here and
                // pick up where we left off next tick.
                self.leaders_resolved_to = slot;
                return;
            };
            // Only whether it is ours. Who the leader is comes off the epoch's
            // turn array in the browser, and what they are called off the peer
            // table, each of which holds one copy per leader.
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

    /// Publishes who leads the slots that have not happened yet.
    ///
    /// The schedule is known an epoch ahead, so this is a lookup rather than a
    /// prediction. It stops where the schedule stops: near an epoch boundary
    /// the next epoch's leaders may not be derived yet, and a short list is a
    /// better answer than none.
    ///
    /// Anchored on the highest slot bank forks holds rather than on the last
    /// one replayed, so that the list starts past the slot being worked on
    /// instead of repeating it.
    /// Returns the leaders it published, for the peer table to describe.
    fn collect_upcoming(&mut self, root_bank: &Bank, highest_slot: Slot) -> HashSet<String> {
        let me = self.ctx.identity();
        let first = highest_slot.saturating_add(1);
        let last = highest_slot.saturating_add(UPCOMING_SLOTS);

        let mut upcoming = Vec::new();
        for slot in first..=last {
            let Some(leader) = self
                .ctx
                .leader_schedule_cache
                .slot_leader_at(slot, Some(root_bank))
            else {
                break;
            };
            let (leader_name, leader_icon) = self.peer_display(&leader.id);
            upcoming.push(UpcomingSlot {
                slot,
                leader: leader.id.to_string(),
                leader_name,
                leader_icon,
                mine: leader.id == me,
            });
        }

        let leaders = upcoming
            .iter()
            .map(|slot| slot.leader.clone())
            .collect::<HashSet<_>>();
        self.debounces
            .upcoming
            .publish(&self.publisher, TOPIC_SLOT, "upcoming", upcoming);
        leaders
    }

    /// Publishes stake, client version and address for the leaders on screen.
    ///
    /// Restricted to those leaders rather than the whole validator set: the
    /// schedule only ever shows the slots a client is holding, and a table of
    /// every node in the cluster would be the largest message the dashboard
    /// sends, on a page that has no authentication in front of it.
    ///
    /// Sorted by identity so that the debounce has a stable value to compare.
    /// Collected through a set, whose iteration order is not stable, and an
    /// unsorted list would look different on every tick and republish itself
    /// for no reason.
    fn collect_peer_table(&mut self, bank: &Bank, mut leaders: HashSet<String>) {
        // The leaders of the window a client holds, taken from the schedule
        // rather than from the slots. The slots no longer carry a leader, and
        // walking the schedule is cheaper anyway: a leader takes four slots at
        // a time, so this is a quarter as many lookups as there are slots.
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
                leaders.insert(leader.id.to_string());
            }
            slot = slot.saturating_add(stride);
        }

        let mut stakes: HashMap<String, u64> = HashMap::new();
        for (stake, account) in bank.vote_accounts().values() {
            if *stake == 0 {
                continue;
            }
            let identity = account.node_pubkey().to_string();
            if leaders.contains(&identity) {
                let total = stakes.entry(identity).or_insert(0);
                *total = total.saturating_add(*stake);
            }
        }

        let mut gossip: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
        for (contact_info, _) in self.ctx.cluster_info.all_peers() {
            let identity = contact_info.pubkey().to_string();
            if !leaders.contains(&identity) {
                continue;
            }
            gossip.insert(
                identity,
                (
                    Some(contact_info.version().to_string()),
                    contact_info.gossip().map(|addr| addr.ip().to_string()),
                ),
            );
        }

        let mut peers: Vec<Peer> = leaders
            .into_iter()
            .map(|identity| {
                let (version, ip) = gossip.get(&identity).cloned().unwrap_or_default();
                let (name, icon) = identity
                    .parse()
                    .map(|key| self.peer_display(&key))
                    .unwrap_or_default();
                Peer {
                    stake: stakes.get(&identity).copied().unwrap_or(0),
                    version,
                    ip,
                    name,
                    icon,
                    identity,
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

        let mut changed = Vec::new();
        let mut captured = false;
        for (slot, bank) in frozen {
            let slot = *slot;
            // Bank transaction counters are cumulative along a fork, so a
            // block's own work is its difference from its parent. Taking the
            // raw counter reported the whole chain's history against every
            // slot.
            //
            // Differenced here rather than through
            // `Bank::executed_transaction_count` because that treats a missing
            // parent as a count of zero, which yields the running total again —
            // the very thing being fixed — and because the non-vote counter has
            // no equivalent helper. A bank whose parent has been pruned reports
            // `None` and leaves the figure alone: by the time a bank is rooted
            // it was frozen many ticks earlier and already carries a correct
            // count.
            let parent = bank.parent();
            let counts = parent.as_ref().map(|parent| {
                (
                    bank.transaction_count()
                        .saturating_sub(parent.transaction_count()),
                    bank.non_vote_transaction_count_since_restart()
                        .saturating_sub(parent.non_vote_transaction_count_since_restart()),
                )
            });
            // Read once, at the first sighting of a frozen bank, and for every
            // block rather than only our own. The cost tracker and the
            // collected fees live on the bank, so they go with it when it is
            // dropped after rooting; a bank stays frozen for many ticks, and
            // reading it again would only spend work on the same answer.
            let fresh = self
                .slots
                .get(slot)
                .is_none_or(|entry| entry.block.is_none());
            // Once per slot, at a bank's first sighting, and only where there
            // is a parent to difference against. A pruned parent leaves the
            // figure unknown rather than nought.
            let tips = if fresh {
                parent
                    .as_ref()
                    .zip(self.tips.as_mut())
                    .map(|(parent, meter)| meter.measure(bank, parent))
            } else {
                None
            };
            let detail = counts
                .filter(|_| fresh)
                .map(|(total, non_vote)| block_detail(bank, total, non_vote, tips));

            // Our own blocks carry a blockhash and a start time on top of that,
            // which the block panel shows and nothing else needs.
            if let Some(detail) = &detail
                && self.slots.get(slot).is_some_and(|entry| entry.mine)
            {
                let block = self.capture_block(slot, bank, detail);
                if self.produced.insert(block) {
                    captured = true;
                }
            }

            let level = level_for(slot, root, confirmed, finalized);
            if let Some(entry) = self.slots.update(slot, |entry| {
                entry.level = level;
                if let Some(detail) = &detail {
                    entry.block = Some(detail.clone());
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

        // Anything still unstarted below the root will never be produced.
        changed.extend(self.slots.mark_skipped_below(root));

        for entry in &changed {
            self.publish_slot(entry);
        }
        if !changed.is_empty() {
            self.retain_slot_overview();
        }
        if captured {
            self.publisher
                .publish(TOPIC_SUMMARY, "produced_blocks", &self.produced.blocks());
        }
    }

    /// Adds what only our own blocks report to what every block reports.
    ///
    /// The blockhash and the start time are here rather than on every slot
    /// because five hundred slots are sent to each client at once and a
    /// blockhash is forty-four characters that only the block panel reads.
    ///
    /// Historical note on the rest, which now lives in [`block_detail`]:
    /// `transactions` and `non_vote` are already differenced against the
    /// parent by the caller. Everything taken there is the bank's own: the
    /// error and entry counters are reset for each bank rather than inherited
    /// from the parent, so differencing them would subtract the wrong thing.
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
        }
    }

    /// Sends one changed slot to the clients following live updates, and keeps
    /// it in the packed history.
    ///
    /// Both here rather than at the four places that change a slot. A level
    /// climbs through several values and a block arrives on freeze, so there is
    /// no moment at which an entry is finished and no other single point every
    /// change already passes through.
    fn publish_slot(&mut self, entry: &SlotEntry) {
        self.history.write().unwrap().record(entry);
        self.publisher
            .publish_ephemeral(TOPIC_SLOT, "update", entry);
    }

    /// Refreshes the snapshot a newly connected client receives, without
    /// broadcasting it to clients that are already following the live updates.
    fn retain_slot_overview(&self) {
        self.publisher.retain_only(
            TOPIC_SLOT,
            "overview",
            &self.slots.overview(SLOT_OVERVIEW_LEN),
        );
    }

    // ---- identity, vote account, stake ----------------------------------

    fn collect_identity_and_vote(&mut self, bank: &Bank) {
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

        let vote_accounts = bank.vote_accounts();
        let mine = vote_accounts.get(&self.ctx.vote_account);
        let total_stake: u64 = vote_accounts.values().map(|(stake, _)| *stake).sum();

        // Whether this process is the one allowed to vote with that account.
        //
        // The two do not move together. The identity is the running one and
        // changes under `set-identity`; the vote account is fixed at startup
        // from `--vote-account`. After a failover the account carries on being
        // voted from wherever the voting identity now runs, so reading its last
        // vote and calling it ours reports the health of a different machine.
        let identity = self.ctx.identity();
        let voting = mine.is_some_and(|(_, account)| *account.node_pubkey() == identity);
        self.voting = voting;

        let (activated_stake, commission, voter_vote) = match mine {
            Some((stake, account)) => {
                let view = account.vote_state_view();
                (*stake, Some(view.commission()), view.last_voted_slot())
            }
            None => (0, None, None),
        };

        // Published only while this process is the voter. Otherwise it is
        // another node's progress, and the distance below would be measured
        // from a vote this one never cast.
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

        // How far this node's replay trails the cluster.
        //
        // The only figure here not taken from this validator's own view of the
        // chain. Everything else — the vote distance this replaced, the
        // delinquency counts, the slot deltas on the strip — is measured
        // against banks this node has replayed, and that view lags when replay
        // lags. A node hundreds of slots back sees a chain whose tip is stale,
        // votes promptly on it, and passes every one of those checks while the
        // rest of the cluster counts it delinquent.
        //
        // `collect_slot_positions` runs earlier in the same tick, so the
        // completed slot is already current.
        let behind_cluster =
            (self.ctx.cluster_tip)().map(|tip| tip.saturating_sub(self.last_completed_slot));
        self.debounces.behind_cluster.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "behind_cluster",
            behind_cluster,
        );
    }

    // ---- epoch ----------------------------------------------------------

    fn collect_epoch(&mut self, bank: &Bank) {
        // Blocks, not slots. A skipped slot advances one and not the other, so
        // the gap between the two is how much the cluster has dropped.
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

        // The countdown is published separately, below. It changes constantly,
        // and this message carries every leader slot in the epoch, so folding
        // the two together would send the whole schedule out once a second.

        // Built when the epoch turns, not at every poll. See `epoch_published`
        // for why, and for why the schedule being known is half of the key.
        if self.epoch_published != Some((epoch, true)) {
            // An unknown schedule is published as no leader slots. The panel
            // counts them, and a count is better absent-as-zero than withheld.
            let my_leader_slots = self.leader_slots_in_epoch(bank, epoch).unwrap_or_default();
            let (leaders, turns) = self.epoch_turns(epoch, slots_in_epoch);
            let known = !turns.is_empty();

            // Poisoned only if a replay thread panicked while holding it, in
            // which case the validator has more pressing problems than a
            // missing limit.
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

            // The epoch before this one, built alongside and kept rather than
            // sent. A client reading back through the packed history crosses
            // into it whenever the tip is within a hundred thousand slots of
            // this epoch's start, which is about a quarter of every epoch, and
            // without its arrays every slot on the far side of the boundary has
            // no leader the page can name. It is half a megabyte, so it is
            // asked for by the pages that reach that far rather than sent to
            // every client that connects.
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
            self.epoch_published = Some((epoch, known));
        }

        self.collect_epoch_countdown(bank, epoch, start_slot, end_slot);
    }

    /// Publishes how much of the epoch is left, as a duration rather than as an
    /// end time.
    ///
    /// A duration needs no agreement about the clock. An absolute end time
    /// would be read against the viewer's own, which is not this validator's,
    /// and the countdown would be wrong by the difference. `uptime_nanos` is
    /// reported the same way for the same reason.
    ///
    /// Rounded to the second so that the debounce has something to suppress:
    /// the collector ticks five times a second and the value would otherwise
    /// differ every time.
    fn collect_epoch_countdown(
        &mut self,
        bank: &Bank,
        epoch: Epoch,
        start_slot: Slot,
        end_slot: Slot,
    ) {
        // The slot the panel's own progress bar is drawn from, so the two
        // halves of the card cannot disagree about where the epoch has got to.
        // Taken with the working bank's slot because nothing has frozen yet in
        // the first moments after startup, and a completed slot of zero would
        // put the end of the epoch several years out.
        let completed = self.last_completed_slot.max(bank.slot());
        let remaining_slots = end_slot.saturating_sub(completed);
        let ahead = Duration::from_nanos(
            remaining_slots.saturating_mul(self.cluster_slot_nanos(bank, start_slot, completed)),
        );

        let now = SystemTime::now();
        let Some(estimate) = now.checked_add(ahead) else {
            return;
        };
        let held = self
            .epoch_end
            .filter(|(held_epoch, _)| *held_epoch == epoch)
            .map(|(_, end)| end);
        // Measured against what is left, so the countdown is as steady an hour
        // from the boundary as it is six hours out.
        let allowance = held
            .and_then(|end| end.duration_since(now).ok())
            .unwrap_or_default()
            .checked_div(EPOCH_END_DRIFT_DIVISOR)
            .unwrap_or_default();
        let end = steady_epoch_end(held, estimate, allowance);
        self.epoch_end = Some((epoch, end));

        let remaining = end.duration_since(now).unwrap_or_default();
        self.debounces.epoch_remaining_nanos.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "epoch_remaining_nanos",
            remaining.as_secs().saturating_mul(1_000_000_000),
        );
    }

    /// How long a slot is taking, on the best evidence available.
    ///
    /// The epoch's own rate first. It is measured over every slot since the
    /// epoch began — hours of them by the middle of one — so each new slot
    /// moves it by one part in hundreds of thousands, where the sliding window
    /// turns a quarter of its samples over every minute and never settles. It
    /// also comes from the cluster's clock rather than this host's, needs no
    /// history, and is available immediately after a restart for an epoch this
    /// validator never saw begin.
    ///
    /// The sliding window stands in for the first few thousand slots of an
    /// epoch, where too little has elapsed for the epoch's own rate to mean
    /// anything, and the configured duration stands in behind that — before
    /// this validator has caught up there is nothing honest to measure at all,
    /// because replayed slots record the download rather than the cluster.
    fn cluster_slot_nanos(&self, bank: &Bank, start_slot: Slot, completed: Slot) -> u64 {
        epoch_anchored_nanos(&bank.clock(), start_slot, completed)
            .or_else(|| {
                self.caught_up_at
                    .and_then(|_| windowed_mean_nanos(&self.slot_time_window, u64::MAX))
            })
            .unwrap_or_else(|| bank.ns_per_slot_at_slot(completed) as u64)
    }

    /// This validator's leader slots in `epoch`, ascending.
    ///
    /// The epoch is passed in rather than taken from the bank, because the two
    /// callers want different ones: the panel shows the epoch the cluster is
    /// in, and the skip rate counts the epoch the root has reached. Between a
    /// rollover and the root catching up those differ, and conflating them is
    /// what made the skip rate wrong at every epoch boundary.
    ///
    /// `None` means the schedule for that epoch is not known yet, which is not
    /// the same as an empty list. An unstaked validator has no leader slots and
    /// the answer is genuinely empty; a schedule that has not been computed
    /// says nothing at all, and a caller that caches the result needs to ask
    /// again rather than record a zero.
    ///
    /// The bank is only read for its epoch schedule, which comes from genesis
    /// and so is the same on any bank.
    /// Everything the page needs to name the leaders of an epoch that is not
    /// the current one.
    ///
    /// `my_leader_slots` is left empty. It feeds the countdown and the leader
    /// list for the epoch being led now, neither of which asks about a past
    /// one, and filling it would be twenty kilobytes of slot numbers nothing
    /// reads. `None` where the schedule for that epoch is no longer cached,
    /// which for a validator that started inside this epoch is every time.
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

    /// The epoch's leader schedule, as a table of leaders and one index per
    /// turn.
    ///
    /// The compact form is not something built here so much as recovered.
    /// `LeaderSchedule` already stores one entry per turn and expands it on the
    /// way out by repeating each, so stepping back over `get_slot_leaders` by
    /// the same stride returns what it holds: on mainnet a hundred and eight
    /// thousand entries rather than four hundred and thirty-two thousand.
    ///
    /// Empty, never partial, on anything unexpected. That stride is only right
    /// while the schedule's own repeat matches `NUM_CONSECUTIVE_LEADER_SLOTS`,
    /// and the two are set independently: the field is private, so there is
    /// nothing to compare against but the length that comes out. A schedule
    /// silently off by a factor would name the wrong leader for every slot on
    /// the page, which is worse in every way than naming none.
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
                    // A cluster with more than sixty-five thousand distinct
                    // leaders in one epoch cannot be indexed by this array.
                    // Mainnet runs around thirteen hundred.
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
                "dashboard: epoch {epoch} leader schedule read as {} turns covering {covered} slots, not {slots_in_epoch}; publishing no schedule for it",
                turns.len()
            );
            return (Vec::new(), Vec::new());
        }
        (leaders, turns)
    }

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

    // ---- clock, TPS -----------------------------------------------------

    // ---- peers ----------------------------------------------------------

    /// Counts the cluster: who holds stake, who is behind, and what they run.
    ///
    /// Nothing per-peer is retained. Only five counters and a version histogram
    /// leave this function, so it accumulates straight into those rather than
    /// building a record per validator first. On a real cluster that record was
    /// five thousand structs and five heap allocations apiece, every five
    /// seconds, to answer six numbers.
    fn collect_peers(&mut self, bank: &Bank) {
        let vote_accounts = bank.vote_accounts();
        let tip = bank.slot();

        // Gossip reports a client version; vote accounts report stake. A
        // validator can appear in one and not the other, so both are walked.
        let versions: HashMap<Pubkey, String> = self
            .ctx
            .cluster_info
            .all_peers()
            .into_iter()
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
    }

    /// Display name and icon URL for an identity, from its on-chain validator
    /// info. The icon is an arbitrary third-party URL the operator published,
    /// so the client fetches it directly and treats a failure as no icon.
    fn peer_display(&self, identity: &Pubkey) -> (Option<String>, Option<String>) {
        match self.info_cache.read().unwrap().get(identity) {
            None => (None, None),
            Some(info) => (info.name.clone(), info.icon_url.clone()),
        }
    }

    /// Picks up validator names published since the last sweep.
    ///
    /// Each bank is asked only for the config accounts written in its own slot,
    /// which is cheap. Sweeping every bank frozen since the last tick is what
    /// makes the result complete: bank forks drops banks once they are rooted,
    /// so a sweep that skipped a tick would miss those slots for good.
    ///
    /// What the cache feeds is `peer_display`, and through it the peer table.
    /// A name is looked up there once per leader when that table is rebuilt, so
    /// one arriving late needs no backfill: the next rebuild has it. A name that
    /// changes after a slot already carries one does not
    /// propagate to that slot, which is the right trade for a strip covering
    /// the last few minutes.
    ///
    /// Nothing here holds the cache lock. The scans run first and the lock is
    /// taken only to merge, and only when a scan actually found something,
    /// which on most sweeps it does not.
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

    // ---- health, skip rate ----------------------------------------------

    fn collect_health(&mut self) {
        let health = health_of(
            self.last_completed_at.elapsed(),
            self.last_completed_slot,
            self.voting,
            self.debounces.vote_slot.last().copied().flatten(),
            // Still the vote's own distance, which is what the delinquency
            // rules are about. The cluster distance is a different question and
            // is reported on its own.
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
    }

    /// Skip rate across this validator's leader slots for the whole epoch.
    ///
    /// Taken from the blockstore rather than the in-memory slot ring, which
    /// only covers slots seen since the collector started and so reported
    /// nothing for most of an epoch. This is the same basis `solana
    /// block-production` uses, so the two agree.
    ///
    /// Each leader slot is checked once, as the root passes it, which comes to
    /// a few hundred point lookups spread over the epoch.
    fn collect_skip_rate(&mut self, root_bank: &Bank) {
        // The root's epoch, not the working bank's. They differ for the half a
        // minute after a rollover during which the root is still finishing the
        // old epoch, and the schedule has to match the slots being counted.
        let epoch = root_bank.epoch();
        if self.skip_epoch != Some(epoch) {
            // The epoch is latched only once its schedule is in hand. Taking an
            // unknown schedule as an empty one would record a permanent zero:
            // the list is built once per epoch, so there would be no second
            // attempt until the next boundary.
            let Some(leader_slots) = self.leader_slots_in_epoch(root_bank, epoch) else {
                return;
            };
            self.skip_epoch = Some(epoch);
            self.skip_leader_slots = leader_slots;
            self.skip_next_index = 0;
            self.skip_produced = 0;
            self.skip_elapsed = 0;
        }

        // Only slots the root has passed have a settled outcome, and only
        // slots the blockstore actually covers say anything about production.
        // After a restart from a snapshot the ledger begins partway through the
        // epoch, and counting the earlier leader slots as skipped reported a
        // rate of seventy percent against an actual zero.
        let root = root_bank.slot();
        let floor = self.ctx.blockstore.lowest_slot();
        while let Some(slot) = self.skip_leader_slots.get(self.skip_next_index).copied() {
            if slot > root {
                break;
            }
            self.skip_next_index = self.skip_next_index.saturating_add(1);
            if slot < floor {
                continue;
            }
            if self.ctx.blockstore.is_full(slot) {
                self.skip_produced = self.skip_produced.saturating_add(1);
            }
            self.skip_elapsed = self.skip_elapsed.saturating_add(1);
        }

        let rate = (self.skip_elapsed > 0).then(|| {
            self.skip_elapsed.saturating_sub(self.skip_produced) as f64 / self.skip_elapsed as f64
        });
        self.debounces.skip_rate.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "skip_rate",
            SkipRate { epoch, rate },
        );
    }

    fn collect_startup_progress(&mut self) {
        let progress = (self.startup_progress)();
        self.startup.publish(&self.publisher, progress);
    }
}

/// How settled a frozen slot is, given the three thresholds.
///
/// Tested in order most-settled first, which is what makes the three
/// thresholds independent: they cross each other during startup, when the
/// commitment cache briefly lags the root bank, and a rooted slot must not
/// report as merely confirmed because `confirmed` had not caught up.
fn level_for(slot: Slot, root: Slot, confirmed: Slot, finalized: Slot) -> SlotLevel {
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

/// What the vote accounts say about who holds stake and who is behind.
///
/// Everything is keyed by identity rather than by vote account: a validator
/// running more than one staked vote account is one validator, its stake is
/// the sum, and it counts once as delinquent. Counted per vote account,
/// `total - delinquent` — which the page renders as active validators — went
/// negative.
#[derive(Debug, Default, PartialEq, Eq)]
struct StakeTally {
    /// Stake per identity, summed across that identity's vote accounts.
    staked: HashMap<Pubkey, u64>,
    delinquent: HashSet<Pubkey>,
    delinquent_stake: u64,
    non_delinquent_stake: u64,
}

/// Folds vote accounts into [`StakeTally`], as `(identity, stake, last_vote)`.
///
/// Takes the fields rather than the accounts so that it can be tested: reading
/// a `VoteAccount` needs a bank behind it, and the counting is the part that
/// has been wrong.
fn tally_stake(
    accounts: impl Iterator<Item = (Pubkey, u64, Option<Slot>)>,
    tip: Slot,
) -> StakeTally {
    let mut tally = StakeTally::default();
    for (identity, stake, last_vote) in accounts {
        // The bank holds every vote account ever created, most with no stake.
        // Counting those puts the validator total in the tens of thousands; a
        // validator is one with stake this epoch, which is what every other
        // tool reports and who the leader schedule draws from.
        if stake == 0 {
            continue;
        }
        let is_delinquent = last_vote
            .map(|vote| tip.saturating_sub(vote) > MAX_DELINQUENT_SLOT_DISTANCE)
            .unwrap_or(true);
        if is_delinquent {
            tally.delinquent.insert(identity);
            tally.delinquent_stake = tally.delinquent_stake.saturating_add(stake);
        } else {
            tally.non_delinquent_stake = tally.non_delinquent_stake.saturating_add(stake);
        }
        let total = tally.staked.entry(identity).or_insert(0);
        *total = total.saturating_add(stake);
    }
    tally
}

/// A validator whose last vote is further behind than this is reported as
/// delinquent on the status card. Deliberately looser than the threshold used
/// for the cluster-wide count: this one is about our own node, where a brief
/// lag is normal and a red badge for it would be noise.
const VOTE_BEHIND_LIMIT: u64 = 150;

/// How long replay may go without completing a slot before it reads as stalled.
const REPLAY_STALL_AFTER: Duration = Duration::from_secs(12);

/// How long the last vote may stand still before the node reads as delinquent
/// however close to the tip that vote was.
const VOTE_STALL_AFTER: Duration = Duration::from_secs(60);

/// This validator's own replay and vote health.
///
/// The two durations sit at either end of the argument list rather than
/// together: they are the same type, and swapping them compiles.
fn health_of(
    since_completed: Duration,
    completed_slot: Slot,
    voting: bool,
    vote_slot: Option<Slot>,
    behind: Option<u64>,
    since_vote_advance: Duration,
) -> Health {
    let replay = if since_completed > REPLAY_STALL_AFTER {
        "stalled"
    } else if completed_slot == 0 {
        "not_started"
    } else {
        "running"
    };

    // Checked before anything about how the votes are going, because a node
    // that is not the voter has none of its own. Its vote account keeps being
    // voted from wherever the voting identity now runs, so every rule below
    // would read that other machine's health and report it as this one's.
    //
    // Not a fault. A validator on its backup identity is meant to be here, and
    // an operator who has just failed over wants to see that it took.
    let vote = if !voting {
        "not_voting"
    } else {
        // A vote can be delinquent two ways: far behind the tip, or not moving
        // at all. The second catches a node whose vote is close but frozen,
        // which the distance alone reports as healthy right up until it drifts.
        match (vote_slot, behind) {
            (None, _) => "not_started",
            (Some(_), Some(behind)) if behind > VOTE_BEHIND_LIMIT => "delinquent",
            _ if since_vote_advance > VOTE_STALL_AFTER => "delinquent",
            _ => "voting",
        }
    };

    Health { replay, vote }
}

/// How the cluster's stake divides across client versions, ready to publish.
///
/// Counted over staked identities only, the same population the validator
/// counts are drawn from, so the two cards on the page add up to each other.
/// Counting every gossip peer instead described a wider cluster than the one
/// the bars measure: the bars have always been stake-weighted, so an unstaked
/// node moved the count beside a row without moving the row, and the counts
/// summed past the validator total by however many unstaked peers gossip
/// happened to know about.
///
/// A staked identity gossip is not currently hearing from has no version and
/// falls in the `None` bucket, which is not the same as the folded tail below.
///
/// Releases are borrowed from the gossip strings rather than copied. There are
/// a few thousand peers and at most six rows, so only the rows that survive the
/// fold are allocated.
fn version_shares(
    staked: &HashMap<Pubkey, u64>,
    versions: &HashMap<Pubkey, String>,
) -> Vec<VersionShare> {
    let mut totals: HashMap<Option<&str>, (usize, u64)> = HashMap::new();
    for (identity, stake) in staked {
        let release = versions.get(identity).map(|version| release_of(version));
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
    // Stake first: a version running on a crowd of unstaked nodes matters far
    // less than one carrying a slice of the vote.
    shares.sort_by(|a, b| {
        b.stake
            .cmp(&a.stake)
            .then_with(|| b.validators.cmp(&a.validators))
    });

    // Version strings arrive over gossip, so how many distinct values show up
    // is not ours to bound. Keeping the leaders and folding the tail into one
    // row keeps this message a fixed size whatever turns up.
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

/// Mean milliseconds per slot across a window of arrival times, in nanoseconds.
///
/// A true mean between the ends of the span rather than a decaying average, so
/// it does not drift and does not need to be seeded. Only the two ends are
/// read; what the samples between them did does not change the answer.
///
/// `span_ms` bounds how far back from the newest sample to reach, so that one
/// window can answer both of the questions asked of it. `u64::MAX` reads the
/// whole of it.
///
/// A free function rather than a method so that the tests exercise this rather
/// than a copy of it. As a method reading `self.slot_time_window` it needed a
/// whole collector to call, so the tests had grown their own reimplementation
/// and would have kept passing while this drifted.
fn windowed_mean_nanos(window: &VecDeque<(Slot, u64)>, span_ms: u64) -> Option<u64> {
    let (last_slot, last_arrival) = window.back().copied()?;
    // The oldest sample still inside the span. The newest is always inside it,
    // so this yields something whenever the window holds anything; a span
    // holding only that one sample is then rejected below for spanning no
    // slots, which is the same answer a window of one gives.
    let (first_slot, first_arrival) = window
        .iter()
        .rev()
        .take_while(|(_, arrival)| last_arrival.saturating_sub(*arrival) <= span_ms)
        .last()
        .copied()?;
    let slots = last_slot
        .checked_sub(first_slot)
        .filter(|slots| *slots > 0)?;
    let millis = last_arrival.checked_sub(first_arrival)?;

    // Repair delivers shreds for many old slots at once, so their arrival
    // times bunch up and the mean collapses. That is a record of the
    // download, not of the cluster, so it is not reported.
    let per_second = slots as f64 / (millis as f64 / 1_000.0).max(f64::MIN_POSITIVE);
    if per_second > CATCH_UP_SLOTS_PER_SECOND {
        return None;
    }

    let nanos = (millis as f64 / slots as f64) * 1_000_000.0;
    Some(nanos as u64)
}

/// Reads a frozen bank's own figures for one block.
///
/// `transactions` and `non_vote` are already differenced against the parent by
/// the caller. Everything taken here is the bank's own: the error and entry
/// counters are reset for each bank rather than inherited from the parent, so
/// differencing them would subtract the wrong thing.
fn block_detail(bank: &Bank, transactions: u64, non_vote: u64, tips: Option<u64>) -> BlockDetail {
    // Poisoned only if a replay thread panicked while holding it, in which case
    // the validator has more pressing problems than a missing bar.
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
    }
}

/// The rate this epoch has actually run at, from the cluster's own clock.
///
/// `epoch_start_timestamp` is fixed for the epoch and `unix_timestamp` is the
/// cluster's view of now, both stake-weighted medians agreed on chain rather
/// than readings from this host. Dividing one span by the other gives the rate
/// that has genuinely applied, over a base that grows all epoch — which is what
/// makes it settle where a sliding window cannot.
///
/// `None` until enough of the epoch has run for the clock's whole-second
/// granularity to matter less than the answer does.
fn epoch_anchored_nanos(clock: &Clock, start_slot: Slot, completed: Slot) -> Option<u64> {
    let slots = completed.saturating_sub(start_slot);
    if slots < EPOCH_RATE_MIN_ELAPSED_SLOTS {
        return None;
    }
    // A cluster whose clock has not advanced past the epoch's first slot says
    // nothing about the rate, and a negative span says the two disagree.
    let elapsed = clock
        .unix_timestamp
        .checked_sub(clock.epoch_start_timestamp)?;
    let elapsed = u64::try_from(elapsed).ok().filter(|secs| *secs > 0)?;
    elapsed.checked_mul(1_000_000_000)?.checked_div(slots)
}

/// The epoch end to count down to, given the one already being counted down to.
///
/// Holding the previous answer unless the new one has moved further than
/// `allowance` is what keeps the readout still. The estimate underneath it
/// moves constantly, by amounts that say nothing: it is a slot duration
/// multiplied by hundreds of thousands of slots, so it swings by minutes on
/// changes far too small to mean anything.
///
/// The allowance is supplied rather than fixed here because it has to scale
/// with the time left; see [`EPOCH_END_DRIFT_DIVISOR`].
///
/// Drift beyond the allowance is real and is followed in one step. The step is
/// visible, which is the point — the estimate genuinely changed.
fn steady_epoch_end(
    held: Option<SystemTime>,
    estimate: SystemTime,
    allowance: Duration,
) -> SystemTime {
    let Some(held) = held else {
        return estimate;
    };
    // Either order, whichever way the estimate moved.
    let drift = held
        .duration_since(estimate)
        .or_else(|_| estimate.duration_since(held))
        .unwrap_or_default();
    if drift > allowance { estimate } else { held }
}

/// Folds a gossip version string to its release, dropping any pre-release or
/// build metadata.
///
/// A cluster mid-upgrade reports `4.2.0`, `4.2.0-rc.0` and `4.2.0-rc.1` as
/// three separate strings. They are one release, and counting them apart
/// understates how much stake has actually moved to it, which is the only
/// reason to read this panel.
fn release_of(version: &str) -> &str {
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
        crate::fixture::{Fixture, fixture},
    };

    /// The arrival window as the collector holds it.
    fn window(samples: &[(Slot, u64)]) -> VecDeque<(Slot, u64)> {
        samples.iter().copied().collect()
    }

    // ---- slot levels ----------------------------------------------------

    #[test]
    fn test_level_reads_the_thresholds_most_settled_first() {
        // root 100, confirmed 110, finalized 90 — the ordinary arrangement.
        assert_eq!(level_for(80, 100, 110, 90), SlotLevel::Finalized);
        assert_eq!(level_for(95, 100, 110, 90), SlotLevel::Rooted);
        assert_eq!(
            level_for(105, 100, 110, 90),
            SlotLevel::OptimisticallyConfirmed
        );
        assert_eq!(level_for(120, 100, 110, 90), SlotLevel::Completed);
    }

    #[test]
    fn test_a_rooted_slot_is_not_demoted_when_confirmed_lags_the_root() {
        // During startup the commitment cache trails the root bank, so
        // `confirmed` can sit below a slot the root has already passed. Tested
        // least-settled first, that slot would come back Completed.
        assert_eq!(level_for(100, 100, 50, 0), SlotLevel::Rooted);
    }

    #[test]
    fn test_the_boundaries_are_inclusive() {
        // A slot exactly at a threshold has reached it.
        assert_eq!(level_for(90, 100, 110, 90), SlotLevel::Finalized);
        assert_eq!(level_for(100, 100, 110, 90), SlotLevel::Rooted);
        assert_eq!(
            level_for(110, 100, 110, 90),
            SlotLevel::OptimisticallyConfirmed
        );
    }

    // ---- stake tally ----------------------------------------------------

    fn identity(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    const TIP: Slot = 1_000;

    #[test]
    fn test_unstaked_vote_accounts_are_not_counted() {
        // The bank keeps every vote account ever created, tens of thousands of
        // them with no stake. Counting those put the validator total an order
        // of magnitude above what every other tool reports.
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
        // Counted per vote account, an identity with two delinquent accounts
        // gave total 1 and delinquent 2, and the page renders the difference.
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
        let at = TIP - MAX_DELINQUENT_SLOT_DISTANCE;
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

    // ---- epoch schedule ---------------------------------------------------

    #[test]
    fn test_the_turn_array_names_the_leader_the_schedule_names() {
        // The whole point of the compact form: every slot must resolve through
        // the two arrays to the same key the leader schedule would give it. An
        // off-by-one in the stride would still produce a plausible-looking
        // array of the right length naming the wrong validator throughout.
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

        // Walked by turn rather than by slot, which also keeps the division
        // that would map one to the other out of it: the workspace denies
        // `arithmetic_side_effects`, and a runtime divisor trips it however
        // impossible a zero is.
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
        // Empty, never partial. A short array is indistinguishable from a short
        // epoch, so a schedule that cannot be read has to say nothing at all.
        let harness = fixture();
        let collector = harness.collector();
        let bank = harness.working_bank();
        let epoch = bank.epoch_schedule().get_epoch(bank.slot());

        let (leaders, turns) = collector.epoch_turns(epoch.saturating_add(500), 432_000);
        assert!(leaders.is_empty());
        assert!(turns.is_empty());
    }

    #[test]
    fn test_a_mismatched_stride_publishes_nothing_rather_than_a_wrong_schedule() {
        // `slots_in_epoch` is what the walk is checked against, so asking for
        // the real epoch against the wrong length is the same shape of failure
        // as the schedule's private repeat drifting from the constant.
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
        // Half a megabyte of arrays, wanted only by a page that has read back
        // past a boundary, which is why it is held for asking rather than put
        // in front of every client that connects.
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
        // The previous one only where its schedule is still cached, which for a
        // fixture starting at slot nought it is not. Absent, not wrong.
        assert!(held.iter().all(|record| record.epoch <= epoch));
    }

    #[test]
    fn test_a_kept_past_epoch_carries_no_leader_slots_of_ours() {
        // They feed the countdown and the list for the epoch being led now.
        // Twenty kilobytes of slot numbers nothing asks a past epoch for.
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
        // It carries a hundred and eight thousand turns on mainnet. Rebuilt at
        // the poll rate that is two hundred kilobytes of arrays assembled five
        // times a second for the debounce to discard.
        let harness = fixture();
        let mut collector = harness.collector();
        collector.tick();
        let first = collector.epoch_published;
        assert!(first.is_some());

        harness.advance_to(8);
        collector.tick();
        assert_eq!(collector.epoch_published, first);
    }

    // ---- what this build is ---------------------------------------------

    #[test]
    fn test_the_build_reports_its_client_beside_its_version() {
        let harness = fixture();
        harness.collector().publish_static();
        let client = solana_version::Version::this_build().client().to_string();

        // Asserting a name here would only assert which fork the tests were
        // run from, and this file is shared by all of them. What can actually
        // break is the header disagreeing with the line the validator logs
        // about itself, or the client going missing altogether.
        let published = harness.published_key("summary", "client").unwrap();
        assert!(
            published.contains(&format!(r#""value":"{client}""#)),
            "published {published}, which does not carry the client {client}"
        );
        assert!(
            solana_version::Version::this_build()
                .as_detailed_string()
                .contains(&format!("client:{client}")),
            "the header and the startup log would name the client differently"
        );

        // And the reason it is published at all: the version it sits beside
        // does not carry it, which is why every fork's header read the same.
        let version = harness.published_key("summary", "version").unwrap();
        assert!(
            !version.contains(&client),
            "{version} already names the client, so publishing it apart is dead weight"
        );
    }

    // ---- version shares -------------------------------------------------

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
        // A cluster mid-upgrade reports 4.2.0, 4.2.0-rc.0 and 4.2.0-rc.1.
        // Counted apart they understate how much stake has actually moved.
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
        // The whole point of the panel: a version on a crowd of lightly staked
        // nodes matters less than one carrying a slice of the vote.
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
        // The counts are read beside the validator card, which counts staked
        // identities. Counting gossip peers here summed past that total.
        let shares = version_shares(&staked(&[]), &gossiped(&[(1, "4.2.0")]));
        assert!(shares.is_empty());
    }

    #[test]
    fn test_the_counts_sum_to_the_staked_validator_total() {
        let staked = staked(&[(1, 10), (2, 10), (3, 10)]);
        // Two unstaked peers gossip a version alongside them.
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
        // Version strings arrive over gossip, so the number of distinct values
        // is not ours to bound; the message has to stay a fixed size.
        let peers: Vec<(u8, String)> = (1..=9).map(|seed| (seed, format!("4.{seed}.0"))).collect();
        let versions = gossiped(
            &peers
                .iter()
                .map(|(seed, version)| (*seed, version.as_str()))
                .collect::<Vec<_>>(),
        );
        // Distinct stakes, so which rows survive the fold does not come down to
        // the order a hash map happened to iterate in.
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

    // ---- health ---------------------------------------------------------

    const FRESH: Duration = Duration::from_secs(1);

    #[test]
    fn test_replay_is_stalled_when_no_slot_completes() {
        assert_eq!(
            health_of(Duration::from_secs(13), 100, true, Some(99), Some(1), FRESH).replay,
            "stalled"
        );
        assert_eq!(
            health_of(FRESH, 100, true, Some(99), Some(1), FRESH).replay,
            "running"
        );
    }

    #[test]
    fn test_replay_has_not_started_before_the_first_slot() {
        // Slot zero means nothing has completed yet, which is not a stall.
        assert_eq!(
            health_of(FRESH, 0, true, None, None, FRESH).replay,
            "not_started"
        );
    }

    /// The integer a summary key was published with, if it carried one.
    fn published_number(harness: &Fixture, key: &str) -> Option<u64> {
        let message = harness.published_key("summary", key)?;
        let after = message.rsplit_once(r#""value":"#)?.1;
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    }

    #[test]
    fn test_the_cluster_distance_is_measured_against_the_cluster() {
        // The figure this replaced was our replay against our own vote, and a
        // node that has fallen behind votes promptly on what it has replayed,
        // so it read nought however far back the node was.
        let harness = fixture();
        harness.advance_to(64);
        harness.set_cluster_tip(Some(10_000));
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
        // Saturating rather than negative. Being ahead of the last certificate
        // seen is ordinary, and is not a distance.
        let harness = fixture();
        harness.advance_to(64);
        harness.set_cluster_tip(Some(1));
        harness.collector().tick();

        assert_eq!(published_number(&harness, "behind_cluster"), Some(0));
    }

    #[test]
    fn test_nothing_is_claimed_before_a_certificate_arrives() {
        // On a fresh start there is nothing to measure against, and nought
        // would say this node was in step with a cluster it has not yet heard
        // from.
        let harness = fixture();
        harness.advance_to(64);
        harness.collector().tick();

        let published = harness.published_key("summary", "behind_cluster").unwrap();
        assert!(published.contains(r#""value":null"#), "got {published}");
    }

    #[test]
    fn test_a_validator_on_its_backup_identity_is_not_voting() {
        // The vote account carries on being voted from wherever the voting
        // identity now runs, so its last vote looks healthy and can even sit
        // ahead of this node's replay. Every rule below would read that other
        // machine and call it this one.
        assert_eq!(
            health_of(FRESH, 100, false, Some(99), Some(1), FRESH).vote,
            "not_voting"
        );
    }

    #[test]
    fn test_not_voting_outranks_every_other_reading() {
        // Including the two that would otherwise call it delinquent: a node
        // that is not the voter has no votes of its own to be late with, and
        // reporting a fault would send an operator looking for one.
        assert_eq!(
            health_of(
                FRESH,
                100,
                false,
                Some(50),
                Some(VOTE_BEHIND_LIMIT + 1),
                FRESH
            )
            .vote,
            "not_voting"
        );
        assert_eq!(
            health_of(FRESH, 100, false, None, None, Duration::from_secs(3_600)).vote,
            "not_voting"
        );
    }

    #[test]
    fn test_replay_is_reported_whether_or_not_this_node_votes() {
        // A backup still replays, and an operator watching a failover wants to
        // know it is keeping up before handing the identity back.
        assert_eq!(
            health_of(FRESH, 100, false, None, None, FRESH).replay,
            "running"
        );
    }

    #[test]
    fn test_a_vote_far_behind_the_tip_is_delinquent() {
        assert_eq!(
            health_of(
                FRESH,
                100,
                true,
                Some(50),
                Some(VOTE_BEHIND_LIMIT + 1),
                FRESH
            )
            .vote,
            "delinquent"
        );
        assert_eq!(
            health_of(FRESH, 100, true, Some(50), Some(VOTE_BEHIND_LIMIT), FRESH).vote,
            "voting"
        );
    }

    #[test]
    fn test_a_vote_that_is_close_but_frozen_is_delinquent() {
        // The case the distance alone misses: the last vote is near the tip and
        // has not moved in a minute, which reads as healthy right up until it
        // drifts far enough to trip the other arm.
        assert_eq!(
            health_of(FRESH, 100, true, Some(99), Some(1), Duration::from_secs(61)).vote,
            "delinquent"
        );
    }

    #[test]
    fn test_a_node_that_has_never_voted_is_not_delinquent() {
        // An unstaked node is not a failing one, however long it sits there.
        assert_eq!(
            health_of(FRESH, 100, true, None, None, Duration::from_secs(3_600)).vote,
            "not_started"
        );
    }

    /// `count` samples `slot_ms` apart, starting at `from`, newest last.
    ///
    /// Saturating throughout because the crate denies bare arithmetic, tests
    /// included, and an index-driven `+` is exactly what that lint is for.
    fn steady_window(from: (Slot, u64), count: u64, slot_ms: u64) -> VecDeque<(Slot, u64)> {
        let (slot, arrival) = from;
        (0..count)
            .map(|index| {
                (
                    slot.saturating_add(index),
                    arrival.saturating_add(index.saturating_mul(slot_ms)),
                )
            })
            .collect()
    }

    #[test]
    fn test_a_full_window_averages_the_whole_of_it() {
        // Five minutes of slots at 420ms, read whole, as the epoch countdown
        // will read them.
        let samples = steady_window((100, 1_000), SLOT_TIME_WINDOW_SLOTS as u64, 420);
        assert_eq!(windowed_mean_nanos(&samples, u64::MAX), Some(420_000_000));
    }

    #[test]
    fn test_a_full_window_of_replay_is_still_rejected() {
        // Widening the window made the catch-up guard less twitchy, which is
        // the point, but it must not have made it blind.
        let samples = steady_window((100, 1_000), SLOT_TIME_WINDOW_SLOTS as u64, 10);
        assert_eq!(windowed_mean_nanos(&samples, u64::MAX), None);
    }

    #[test]
    fn test_the_readout_span_ignores_samples_older_than_itself() {
        // Five minutes at 400ms, then the last minute at 500ms. Read whole,
        // the recent slowdown is diluted; read over the readout's span, it is
        // the whole answer. Both readings come off this one window.
        let mut samples = steady_window((100, 1_000), SLOT_TIME_WINDOW_SLOTS as u64, 400);
        let (last_slot, last_arrival) = *samples.back().unwrap();
        samples.extend(steady_window(
            (
                last_slot.saturating_add(1),
                last_arrival.saturating_add(500),
            ),
            120,
            500,
        ));
        assert_eq!(
            windowed_mean_nanos(&samples, SLOT_READOUT_SPAN_MS),
            Some(500_000_000)
        );
        assert!(windowed_mean_nanos(&samples, u64::MAX).unwrap() < 420_000_000);
    }

    // ---- upcoming leaders -----------------------------------------------

    /// The slot numbers of the published upcoming list, in order.
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
        // The fixture stakes this validator alone, so it leads every slot.
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

    // ---- epoch countdown ------------------------------------------------

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH
            .checked_add(Duration::from_secs(seconds))
            .unwrap()
    }

    const ALLOWANCE: Duration = Duration::from_secs(60);

    /// A clock `elapsed` seconds into its epoch.
    fn clock_at(elapsed: i64) -> Clock {
        Clock {
            epoch_start_timestamp: 1_700_000_000,
            unix_timestamp: 1_700_000_000_i64.saturating_add(elapsed),
            ..Clock::default()
        }
    }

    #[test]
    fn test_the_epoch_rate_is_its_own_elapsed_time_over_its_own_slots() {
        // Six hours across sixty thousand slots is 360ms a slot.
        let nanos = epoch_anchored_nanos(&clock_at(21_600), 100, 60_100);
        assert_eq!(nanos, Some(360_000_000));
    }

    #[test]
    fn test_the_epoch_rate_waits_for_the_epoch_to_get_going() {
        // The cluster clock moves in whole seconds, so early on the error in
        // that second is worth more than the answer.
        assert_eq!(epoch_anchored_nanos(&clock_at(400), 100, 1_100), None);
    }

    #[test]
    fn test_a_clock_that_has_not_moved_yields_no_rate() {
        // Nothing to divide, and a negative span means the two disagree.
        assert_eq!(epoch_anchored_nanos(&clock_at(0), 100, 60_100), None);
        assert_eq!(epoch_anchored_nanos(&clock_at(-10), 100, 60_100), None);
    }

    #[test]
    fn test_the_first_estimate_is_adopted_as_it_stands() {
        assert_eq!(steady_epoch_end(None, at(10_000), ALLOWANCE), at(10_000));
    }

    #[test]
    fn test_an_estimate_that_barely_moved_does_not_move_the_countdown() {
        // Half a minute either way, on a figure hours out. Following this is
        // what made the readout restless while telling nobody anything.
        let held = at(10_000);
        for estimate in [at(10_030), at(9_970)] {
            assert_eq!(steady_epoch_end(Some(held), estimate, ALLOWANCE), held);
        }
    }

    #[test]
    fn test_real_drift_is_followed_in_one_step() {
        let held = at(10_000);
        assert_eq!(
            steady_epoch_end(Some(held), at(10_600), ALLOWANCE),
            at(10_600),
            "ten minutes is the estimate genuinely changing, not noise"
        );
    }

    #[test]
    fn test_drift_exactly_at_the_allowance_is_still_held() {
        // The boundary belongs to the quiet side: a countdown that steps for a
        // difference this small is a countdown that steps constantly.
        let held = at(10_000);
        assert_eq!(steady_epoch_end(Some(held), at(10_060), ALLOWANCE), held);
    }

    #[test]
    fn test_the_allowance_scales_with_what_is_left() {
        // The bug this replaces: sixty seconds fixed is a seventh of a
        // millisecond of slot time across a fresh epoch, which every sample
        // turnover clears, so the gate never held anything. Six hours out the
        // same relative move has to be tolerated that an hour out is not.
        let six_hours = Duration::from_secs(21_600);
        let allowance = six_hours.checked_div(EPOCH_END_DRIFT_DIVISOR).unwrap();
        assert!(allowance > Duration::from_secs(300), "{allowance:?}");

        let one_hour = Duration::from_secs(3_600);
        let allowance = one_hour.checked_div(EPOCH_END_DRIFT_DIVISOR).unwrap();
        assert!(allowance < Duration::from_secs(60), "{allowance:?}");
    }

    // ---- catching up ----------------------------------------------------

    /// A collector holding `count` samples ending at `last`, 400ms apart.
    fn collector_following(last: Slot, count: u64) -> Collector {
        let mut collector = fixture().collector();
        let first = last.saturating_sub(count.saturating_sub(1));
        collector.slot_time_window = steady_window((first, 1_000), count, 400);
        collector
    }

    #[test]
    fn test_the_marker_waits_for_the_window_to_fill() {
        // A validator that has loaded a snapshot and received nothing sits at
        // zero distance without having caught up with anything. Marking here
        // would bless the half-million slot replay that follows.
        let mut collector = collector_following(300_000_000, 4);
        collector.mark_caught_up(300_000_000, 300_000_000);
        assert_eq!(collector.caught_up_at, None);
        assert_eq!(collector.slot_time_window.len(), 4, "nothing discarded");
    }

    #[test]
    fn test_the_marker_waits_for_replay_to_reach_the_tip() {
        let mut collector = collector_following(300_000_000, CAUGHT_UP_MIN_SAMPLES as u64);
        // Replaying, and still a thousand slots behind what it holds.
        collector.mark_caught_up(300_001_000, 300_000_000);
        assert_eq!(collector.caught_up_at, None);
    }

    #[test]
    fn test_catching_up_discards_everything_measured_while_behind() {
        let mut collector = collector_following(300_000_000, CAUGHT_UP_MIN_SAMPLES as u64);
        // Trailing the tip by a thousand slots, then level.
        collector.mark_caught_up(300_001_000, 300_000_000);
        collector.mark_caught_up(300_000_002, 300_000_000);

        assert_eq!(
            collector.caught_up_at,
            Some(300_000_000_u64.saturating_add(CAUGHT_UP_MARGIN_SLOTS))
        );
        assert!(
            collector.slot_time_window.is_empty(),
            "every sample was taken while behind, so none of it describes the cluster"
        );
    }

    #[test]
    fn test_starting_level_keeps_the_samples_it_already_has() {
        // A restart that never trails the tip has measured nothing but the
        // cluster. Discarding here would blank a working readout for a minute
        // to protect against a burst that never happened.
        let mut collector = collector_following(300_000_000, CAUGHT_UP_MIN_SAMPLES as u64);
        collector.mark_caught_up(300_000_000, 300_000_000);

        assert!(collector.caught_up_at.is_some());
        assert_eq!(
            collector.slot_time_window.len(),
            CAUGHT_UP_MIN_SAMPLES,
            "nothing was measured while behind, so nothing is thrown away"
        );
    }

    #[test]
    fn test_the_marker_is_set_once_and_falling_behind_does_not_move_it() {
        // The failure this replaces re-tested the rate continuously and cleared
        // the window whenever it looked like a burst. Clearing shortened the
        // window, a shorter window trips more easily, and it never settled.
        let mut collector = collector_following(300_000_000, CAUGHT_UP_MIN_SAMPLES as u64);
        collector.mark_caught_up(300_000_000, 300_000_000);
        let marked = collector.caught_up_at;

        collector.slot_time_window = steady_window((300_001_000, 1_000), 200, 400);
        collector.mark_caught_up(300_099_000, 300_001_000);

        assert_eq!(collector.caught_up_at, marked, "the marker never moves");
        assert_eq!(
            collector.slot_time_window.len(),
            200,
            "and nothing is discarded a second time"
        );
    }

    #[test]
    fn test_mean_spans_the_ends_of_the_window() {
        // Ten slots over four seconds is 400ms each, however the middle fell.
        let samples = window(&[(100, 1_000), (105, 3_100), (110, 5_000)]);
        assert_eq!(windowed_mean_nanos(&samples, u64::MAX), Some(400_000_000));
    }

    #[test]
    fn test_one_slow_slot_barely_moves_the_mean() {
        // 150 slots at 400ms with a single two-second slot among them.
        let steady = 150_u64 * 400;
        assert_eq!(
            windowed_mean_nanos(&window(&[(0, 0), (150, steady + 1_600)]), u64::MAX),
            Some(410_666_666)
        );
    }

    #[test]
    fn test_repair_burst_is_not_reported_as_the_cluster_rate() {
        // A thousand slots arriving in two seconds is a download, not a cluster.
        assert_eq!(
            windowed_mean_nanos(&window(&[(0, 0), (1_000, 2_000)]), u64::MAX),
            None
        );
    }

    #[test]
    fn test_window_that_cannot_span_two_slots_reports_nothing() {
        assert_eq!(windowed_mean_nanos(&window(&[]), u64::MAX), None);
        assert_eq!(
            windowed_mean_nanos(&window(&[(100, 1_000)]), u64::MAX),
            None
        );
    }

    #[test]
    fn test_releases_fold_their_prerelease_tags() {
        assert_eq!(release_of("4.2.0-rc.1"), "4.2.0");
        assert_eq!(release_of("0.1102.0-beta.40201"), "0.1102.0");
        assert_eq!(release_of("4.2.0"), "4.2.0");
        assert_eq!(release_of("1.18.23+build7"), "1.18.23");
    }

    #[test]
    fn test_folding_leaves_strings_that_are_not_semver_alone() {
        // Gossip is not obliged to send semver, and a version that cannot be
        // parsed is better reported verbatim than dropped.
        assert_eq!(release_of(""), "");
        assert_eq!(release_of("unknown"), "unknown");
        assert_eq!(release_of("-leading"), "");
    }
}
