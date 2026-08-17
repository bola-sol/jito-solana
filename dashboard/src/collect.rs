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
        produced::{ProducedBlock, ProducedRing},
        proto::{Debounced, Publisher, TOPIC_EPOCH, TOPIC_SLOT, TOPIC_SUMMARY},
        slots::{SlotEntry, SlotLevel, SlotRing},
        startup::StartupPublisher,
        validator_info::{self, ValidatorInfoCache},
    },
    serde::Serialize,
    solana_clock::{Epoch, Slot},
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

/// Produced blocks kept for the block detail panel. A validator leads about
/// four slots in every eight hundred, so this is hours of them.
const PRODUCED_BLOCKS: usize = 64;

/// Window the reported slot time averages over. Short enough to follow the
/// cluster, long enough that a single slow slot does not move the reading.
const SLOT_TIME_WINDOW_MS: u64 = 60_000;

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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EpochInfo {
    pub epoch: Epoch,
    pub start_slot: Slot,
    pub end_slot: Slot,
    pub slots_in_epoch: u64,
    /// Slots in this epoch where this validator is the leader.
    pub my_leader_slots: Vec<Slot>,
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
    vote_distance: Debounced<Option<u64>>,
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
    slot_time_window: VecDeque<(Slot, u64)>,
    last_vote_advance: Instant,
    last_slow_tick: Instant,
    /// Viewers attached as of the last tick, kept only so that pausing and
    /// resuming are logged once rather than on every tick.
    subscribers: usize,
}

impl Collector {
    pub fn new(
        ctx: DashboardContext,
        publisher: Arc<Publisher>,
        info_cache: Arc<RwLock<ValidatorInfoCache>>,
        startup_progress: StartupProgressFn,
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
            skip_leader_slots: Vec::new(),
            skip_epoch: None,
            skip_next_index: 0,
            skip_produced: 0,
            skip_elapsed: 0,
            last_completed_slot: 0,
            last_completed_at: now,
            slot_timed_to: None,
            last_shred_time: None,
            slot_time_window: VecDeque::new(),
            last_vote_advance: now,
            last_slow_tick: now.checked_sub(SLOW_TICK).unwrap_or(now),
            subscribers: 0,
        }
    }

    /// Publishes the values that never change for the lifetime of the process.
    pub fn publish_static(&self) {
        let version = solana_version::Version::this_build();
        self.publisher
            .publish(TOPIC_SUMMARY, "version", &version.as_semver_string());
        self.publisher.publish(
            TOPIC_SUMMARY,
            "commit_hash",
            &format!("{:08x}", version.commit()),
        );
        self.publisher
            .publish(TOPIC_SUMMARY, "cluster", &self.ctx.cluster_name());
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
        let (root_bank, working_bank, highest_slot, frozen) = {
            let bank_forks = self.ctx.bank_forks.read().unwrap();
            (
                bank_forks.root_bank(),
                bank_forks.working_bank(),
                bank_forks.highest_slot(),
                bank_forks.frozen_banks().collect::<Vec<_>>(),
            )
        };
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
            self.backfill_leader_names();
            self.collect_peers(&working_bank);
            self.collect_health();
            self.collect_skip_rate(&root_bank);
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
        self.observe_slot_duration(root_bank, completed);
    }

    /// Maintains a smoothed estimate of how long a slot is taking, which the
    /// epoch countdown is derived from.
    /// Records replay progress and publishes the cluster's slot duration.
    ///
    /// The duration is the bank's configured `ns_per_slot`, not a measurement.
    /// Measuring it was unstable: the sample window gets anchored during a
    /// catch-up burst, when slots arrive far faster than the cluster produces
    /// them, and then drifts for minutes as real time accumulates. That moved
    /// the epoch countdown by ten minutes between refreshes. The configured
    /// value only changes at an epoch boundary, so the countdown is steady.
    fn observe_slot_duration(&mut self, root_bank: &Bank, completed: Slot) {
        if completed > self.last_completed_slot {
            self.last_completed_slot = completed;
            self.last_completed_at = Instant::now();
        }

        // What the cluster is configured for. Constant, and what the client's
        // countdowns run on: multiplied by an epoch's worth of slots, a moving
        // average never lets them settle.
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

            self.last_shred_time = Some((slot, arrived));
            self.slot_time_window.push_back((slot, arrived));
            while let Some((_, oldest)) = self.slot_time_window.front() {
                if arrived.saturating_sub(*oldest) > SLOT_TIME_WINDOW_MS {
                    self.slot_time_window.pop_front();
                } else {
                    break;
                }
            }
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

    /// Mean milliseconds per slot across the window, in nanoseconds.
    ///
    /// A true mean between the ends of the window rather than a decaying
    /// average, so it does not drift and does not need to be seeded.
    fn windowed_slot_nanos(&self) -> Option<u64> {
        let (first_slot, first_arrival) = self.slot_time_window.front().copied()?;
        let (last_slot, last_arrival) = self.slot_time_window.back().copied()?;
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
            let (name, icon) = self.peer_display(&leader.id);
            if let Some(entry) =
                self.slots
                    .set_leader(slot, &leader.id, name, icon, leader.id == me)
            {
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
            let counts = bank.parent().map(|parent| {
                (
                    bank.transaction_count()
                        .saturating_sub(parent.transaction_count()),
                    bank.non_vote_transaction_count_since_restart()
                        .saturating_sub(parent.non_vote_transaction_count_since_restart()),
                )
            });
            // Our own blocks are read here and nowhere else. The cost tracker
            // and the collected fees live on the bank, so they go with it when
            // it is dropped after rooting. A bank stays frozen for many ticks,
            // and the ring keeps the first sighting only.
            if let Some((total, non_vote)) = counts
                && !self.produced.contains(slot)
                && self.slots.get(slot).is_some_and(|entry| entry.mine)
            {
                let block = self.capture_block(slot, bank, total, non_vote);
                if self.produced.insert(block) {
                    captured = true;
                }
            }

            let level = if slot <= finalized {
                SlotLevel::Finalized
            } else if slot <= root {
                SlotLevel::Rooted
            } else if slot <= confirmed {
                SlotLevel::OptimisticallyConfirmed
            } else {
                SlotLevel::Completed
            };
            if let Some(entry) = self.slots.update(slot, |entry| {
                entry.level = level;
                if let Some((total, non_vote)) = counts {
                    entry.transactions = Some(total);
                    entry.non_vote_transactions = Some(non_vote);
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

    /// Reads a frozen bank's own figures for the block detail panel.
    ///
    /// `transactions` and `non_vote` are already differenced against the
    /// parent by the caller. Everything taken here is the bank's own: the
    /// error and entry counters are reset for each bank rather than inherited
    /// from the parent, so differencing them would subtract the wrong thing.
    fn capture_block(
        &self,
        slot: Slot,
        bank: &Bank,
        transactions: u64,
        non_vote: u64,
    ) -> ProducedBlock {
        // Poisoned only if a replay thread panicked while holding it, in which
        // case the validator has more pressing problems than a missing bar.
        let (block_cost, block_cost_limit) = match bank.read_cost_tracker() {
            Ok(tracker) => (tracker.block_cost(), tracker.get_block_limit()),
            Err(_) => (0, 0),
        };
        let fees = bank.get_collector_fee_details();

        ProducedBlock {
            slot,
            slot_time_millis: self.first_shred_time(slot),
            blockhash: bank.last_blockhash().to_string(),
            duration_nanos: self.slots.get(slot).and_then(|entry| entry.duration_nanos),
            transactions,
            non_vote_transactions: non_vote,
            failed_transactions: bank.transaction_error_count(),
            entries: bank.transaction_entries_count(),
            block_cost,
            block_cost_limit,
            total_fees: fees.total_transaction_fee(),
            priority_fees: fees.total_priority_fee(),
        }
    }

    fn publish_slot(&self, entry: &SlotEntry) {
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

        let (activated_stake, commission, last_vote) = match mine {
            Some((stake, account)) => {
                let view = account.vote_state_view();
                (*stake, Some(view.commission()), view.last_voted_slot())
            }
            None => (0, None, None),
        };

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

        // Measured against the completed slot, which is the same value the
        // strip's Voted delta is taken from, so the two figures always agree.
        //
        // Deliberately not the working bank, which sits a slot ahead: a
        // validator votes on frozen banks, so counting a slot it could not yet
        // have voted on made a caught-up validator read as one behind.
        // `collect_slot_positions` runs earlier in the same tick, so this is
        // already current.
        let distance = last_vote.map(|vote| self.last_completed_slot.saturating_sub(vote));
        self.debounces.vote_distance.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "vote_distance",
            distance,
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

        // No wall-clock estimate here. It would change on every tick, so the
        // debounce could never suppress it and this message, which carries every
        // leader slot in the epoch, would go out five times a second. The client
        // derives the countdown from the current slot and the slot duration.

        // An unknown schedule is published as no leader slots. The panel counts
        // them, and a count is better absent-as-zero than withheld.
        let my_leader_slots = self.leader_slots_in_epoch(bank, epoch).unwrap_or_default();

        self.debounces.epoch.publish(
            &self.publisher,
            TOPIC_EPOCH,
            "new",
            EpochInfo {
                epoch,
                start_slot,
                end_slot,
                slots_in_epoch,
                my_leader_slots,
            },
        );
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

        // Keyed by identity, not by vote account: a validator running more than
        // one staked vote account is one validator, and its stake is the sum.
        let mut staked: HashMap<Pubkey, u64> = HashMap::new();
        let mut delinquent: HashSet<Pubkey> = HashSet::new();
        let mut delinquent_stake = 0u64;
        let mut non_delinquent_stake = 0u64;

        for (_vote_pubkey, (stake, account)) in vote_accounts.iter() {
            // The bank holds every vote account ever created, most with no
            // stake. Counting those puts the validator total in the tens of
            // thousands; a validator is one with stake this epoch, which is
            // what every other tool reports and who the leader schedule draws
            // from.
            if *stake == 0 {
                continue;
            }
            let identity = *account.node_pubkey();
            let is_delinquent = account
                .vote_state_view()
                .last_voted_slot()
                .map(|vote| tip.saturating_sub(vote) > MAX_DELINQUENT_SLOT_DISTANCE)
                .unwrap_or(true);
            if is_delinquent {
                delinquent.insert(identity);
                delinquent_stake = delinquent_stake.saturating_add(*stake);
            } else {
                non_delinquent_stake = non_delinquent_stake.saturating_add(*stake);
            }
            let total = staked.entry(identity).or_insert(0);
            *total = total.saturating_add(*stake);
        }

        self.debounces.validator_counts.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "validator_counts",
            ValidatorCounts {
                // Both by identity, so that `total - delinquent` — which the
                // page renders as active validators — cannot go negative for a
                // validator whose several vote accounts are all behind.
                total: staked.len(),
                delinquent: delinquent.len(),
                rpc_nodes,
                non_delinquent_stake,
                delinquent_stake,
            },
        );

        self.publish_versions(&staked, &versions);
    }

    /// Publishes how the cluster's stake divides across client versions.
    ///
    /// Every identity counts once, staked or not: unstaked nodes are most of
    /// the cluster by number and say something about how far an upgrade has
    /// spread, even though they carry none of the vote. During an upgrade this
    /// answers the question operators actually ask — how much stake has moved,
    /// and is this validator in the minority.
    ///
    /// Releases are borrowed from the gossip strings rather than copied. There
    /// are a few thousand peers and at most six rows, so only the rows that
    /// survive the fold are allocated.
    fn publish_versions(
        &mut self,
        staked: &HashMap<Pubkey, u64>,
        versions: &HashMap<Pubkey, String>,
    ) {
        let mut totals: HashMap<Option<&str>, (usize, u64)> = HashMap::new();
        for (identity, version) in versions {
            let stake = staked.get(identity).copied().unwrap_or(0);
            let entry = totals.entry(Some(release_of(version))).or_insert((0, 0));
            entry.0 = entry.0.saturating_add(1);
            entry.1 = entry.1.saturating_add(stake);
        }
        // Staked validators gossip is not currently hearing from. They report
        // no version, which is not the same as the folded tail below.
        for (identity, stake) in staked {
            if versions.contains_key(identity) {
                continue;
            }
            let entry = totals.entry(None).or_insert((0, 0));
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
        // Stake first: a version running on a crowd of unstaked nodes matters
        // far less than one carrying a slice of the vote.
        shares.sort_by(|a, b| {
            b.stake
                .cmp(&a.stake)
                .then_with(|| b.validators.cmp(&a.validators))
        });

        // Version strings arrive over gossip, so how many distinct values show
        // up is not ours to bound. Keeping the leaders and folding the tail
        // into one row keeps this message a fixed size whatever turns up.
        if shares.len() > MAX_VERSIONS_REPORTED {
            let tail = shares.split_off(MAX_VERSIONS_REPORTED);
            shares.push(VersionShare {
                version: None,
                validators: tail.iter().map(|share| share.validators).sum(),
                stake: tail.iter().map(|share| share.stake).sum(),
                other: true,
            });
        }

        self.debounces
            .versions
            .publish(&self.publisher, TOPIC_SUMMARY, "versions", shares);
    }

    /// Fills in leader names that were unknown when the slot was first labelled.
    ///
    /// The name scan takes minutes, so every slot seen before it finishes has no
    /// name, and a slot is only labelled once. Without this they would stay as
    /// raw pubkeys for as long as they remain in the ring.
    fn backfill_leader_names(&mut self) {
        let missing = self.slots.leaders_without_names();
        if missing.is_empty() {
            return;
        }
        let resolved: Vec<(Slot, Option<String>, Option<String>)> = {
            let cache = self.info_cache.read().unwrap();
            missing
                .into_iter()
                .filter_map(|(slot, leader)| {
                    let identity = leader.parse().ok()?;
                    let info = cache.get(&identity)?;
                    // Only worth republishing the slot if something resolved.
                    info.name
                        .is_some()
                        .then(|| (slot, info.name.clone(), info.icon_url.clone()))
                })
                .collect()
        };
        for (slot, name, icon) in resolved {
            if let Some(entry) = self.slots.set_leader_display(slot, name, icon) {
                self.publish_slot(&entry);
            }
        }
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
    /// What the cache feeds is `peer_display`, for slots labelled from here on,
    /// and `backfill_leader_names`, for slots that were labelled before a name
    /// was known. A name that changes after a slot already carries one does not
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
        let replay = if self.last_completed_at.elapsed() > Duration::from_secs(12) {
            "stalled"
        } else if self.last_completed_slot == 0 {
            "not_started"
        } else {
            "running"
        };

        let vote_slot = self.debounces.vote_slot.last().copied().flatten();
        let distance = self.debounces.vote_distance.last().copied().flatten();
        let vote = match (vote_slot, distance) {
            (None, _) => "not_started",
            (Some(_), Some(distance)) if distance > 150 => "delinquent",
            _ if self.last_vote_advance.elapsed() > Duration::from_secs(60) => "delinquent",
            _ => "voting",
        };

        self.debounces.health.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "health",
            Health { replay, vote },
        );
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
    use super::*;

    /// The window mean and its catch-up guard, without a validator behind it.
    fn window_nanos(samples: &[(Slot, u64)]) -> Option<u64> {
        let (first_slot, first_arrival) = *samples.first()?;
        let (last_slot, last_arrival) = *samples.last()?;
        let slots = last_slot.checked_sub(first_slot).filter(|s| *s > 0)?;
        let millis = last_arrival.checked_sub(first_arrival)?;
        let per_second = slots as f64 / (millis as f64 / 1_000.0).max(f64::MIN_POSITIVE);
        if per_second > CATCH_UP_SLOTS_PER_SECOND {
            return None;
        }
        Some(((millis as f64 / slots as f64) * 1_000_000.0) as u64)
    }

    #[test]
    fn the_mean_spans_the_ends_of_the_window() {
        // Ten slots over four seconds is 400ms each, however the middle fell.
        let samples = [(100, 1_000_u64), (105, 3_100), (110, 5_000)];
        assert_eq!(window_nanos(&samples), Some(400_000_000));
    }

    #[test]
    fn one_slow_slot_barely_moves_the_mean() {
        // 150 slots at 400ms with a single two-second slot among them.
        let steady = 150_u64 * 400;
        assert_eq!(
            window_nanos(&[(0, 0), (150, steady + 1_600)]),
            Some(410_666_666)
        );
    }

    #[test]
    fn a_repair_burst_is_not_reported_as_the_cluster_rate() {
        // A thousand slots arriving in two seconds is a download, not a cluster.
        assert_eq!(window_nanos(&[(0, 0), (1_000, 2_000)]), None);
    }

    #[test]
    fn a_window_that_cannot_span_two_slots_reports_nothing() {
        assert_eq!(window_nanos(&[]), None);
        assert_eq!(window_nanos(&[(100, 1_000)]), None);
    }

    #[test]
    fn releases_fold_their_prerelease_tags() {
        assert_eq!(release_of("4.2.0-rc.1"), "4.2.0");
        assert_eq!(release_of("0.1102.0-beta.40201"), "0.1102.0");
        assert_eq!(release_of("4.2.0"), "4.2.0");
        assert_eq!(release_of("1.18.23+build7"), "1.18.23");
    }

    #[test]
    fn folding_leaves_strings_that_are_not_semver_alone() {
        // Gossip is not obliged to send semver, and a version that cannot be
        // parsed is better reported verbatim than dropped.
        assert_eq!(release_of(""), "");
        assert_eq!(release_of("unknown"), "unknown");
        assert_eq!(release_of("-leading"), "");
    }
}
