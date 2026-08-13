//! Samples validator state on a timer and publishes what changed.
//!
//! Everything here reads through handles the validator already holds. No code
//! in this module writes to validator state, and none of it blocks a validator
//! thread for longer than it takes to clone an `Arc` out from behind a lock.
//!
//! The collector is diff-driven. It samples often, five times a second by
//! default, but publishes a key only once its value has actually moved. An idle
//! validator therefore produces almost no websocket traffic.

use {
    crate::{
        config::DashboardConfig,
        context::DashboardContext,
        proto::{Debounced, Publisher},
        slots::{SlotEntry, SlotLevel, SlotRing},
        validator_info::ValidatorInfoCache,
    },
    serde::Serialize,
    solana_clock::{Epoch, Slot},
    solana_pubkey::Pubkey,
    solana_runtime::bank::Bank,
    std::{
        collections::{HashMap, HashSet},
        sync::{Arc, RwLock, atomic::Ordering},
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    },
};

const TOPIC_SUMMARY: &str = "summary";
const TOPIC_EPOCH: &str = "epoch";
const TOPIC_SLOT: &str = "slot";

/// A validator whose last vote is further behind than this is reported as
/// delinquent, matching the threshold the RPC layer uses.
const MAX_DELINQUENT_SLOT_DISTANCE: u64 = 128;

/// How often the expensive samples (the full validator set, the program cache)
/// are taken, regardless of the poll interval.
const SLOW_TICK: Duration = Duration::from_secs(5);

/// How often per-second samples (TPS, uptime, server clock) are taken.
const SECOND_TICK: Duration = Duration::from_secs(1);

/// Slots to include in the strip and sidebar snapshot sent on connect.
const SLOT_OVERVIEW_LEN: usize = 512;

/// How far ahead to look for this validator's next leader slot.
const NEXT_LEADER_LOOKAHEAD: u64 = 20_000;

/// Above this rate of slots replayed per second the validator is catching up
/// rather than following the cluster, so throughput samples are discarded. A
/// healthy cluster produces about two and a half slots a second.
const CATCH_UP_SLOTS_PER_SECOND: f64 = 6.0;

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
    /// Staked validators whose last vote is too far behind the root.
    pub delinquent: usize,
    pub rpc_nodes: usize,
    pub non_delinquent_stake: u64,
    pub delinquent_stake: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProgramCacheSummary {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub insertions: u64,
    pub reloads: u64,
    /// Number of cached entries counted the last time eviction ran. The cache
    /// only writes this during `evict_using_random_selection`, so it stays at
    /// zero until the cache first exceeds its eviction threshold, and is not a
    /// live measure of cache occupancy.
    pub water_level: u64,
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
pub struct Peer {
    pub identity: String,
    pub vote_account: Option<String>,
    pub stake: u64,
    pub commission: Option<u8>,
    pub last_vote: Option<Slot>,
    pub root_slot: Option<Slot>,
    pub delinquent: bool,
    pub gossip: Option<String>,
    pub shred_version: Option<u16>,
    pub version: Option<String>,
    pub has_rpc: bool,
    /// Display name only. The rest of the on-chain validator info runs to
    /// hundreds of bytes per peer and nothing renders it.
    pub name: Option<String>,
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

#[derive(Default)]
struct Debounces {
    identity_key: Debounced<String>,
    identity_name: Debounced<Option<String>>,
    identity_icon: Debounced<Option<String>>,
    vote_key: Debounced<String>,
    startup_progress: Debounced<crate::context::StartupProgress>,
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
    program_cache: Debounced<ProgramCacheSummary>,
    slot_duration_nanos: Debounced<u64>,
    next_leader_slot: Debounced<Option<Slot>>,
    skip_rate: Debounced<SkipRate>,
    health: Debounced<Health>,
    epoch: Debounced<EpochInfo>,
}

pub struct Collector {
    ctx: DashboardContext,
    publisher: Arc<Publisher>,
    config: DashboardConfig,

    debounces: Debounces,
    slots: SlotRing,
    tps_history: Vec<TpsSample>,
    peers: HashMap<String, Peer>,
    info_cache: Arc<RwLock<ValidatorInfoCache>>,

    /// Highest slot for which leaders have been resolved, so the schedule is
    /// only walked forwards.
    leaders_resolved_to: Slot,
    /// Highest slot already swept for validator-info writes.
    info_scanned_to: Slot,
    /// Tip at the moment the collector started. Slots below it were never
    /// watched, so they are neither tracked nor counted as skipped.
    first_observed_slot: Option<Slot>,
    last_counters: Option<TxnCounters>,
    /// This validator's leader slots for the current epoch, kept so the skip
    /// rate can walk them as the root passes each one.
    my_leader_slots: Vec<Slot>,
    skip_epoch: Option<Epoch>,
    skip_next_index: usize,
    skip_produced: usize,
    skip_elapsed: usize,
    last_completed_slot: Slot,
    last_completed_at: Instant,
    last_vote_advance: Instant,

    last_second_tick: Instant,
    last_slow_tick: Instant,
}

impl Collector {
    pub fn new(
        ctx: DashboardContext,
        publisher: Arc<Publisher>,
        config: DashboardConfig,
        info_cache: Arc<RwLock<ValidatorInfoCache>>,
    ) -> Self {
        let now = Instant::now();
        Self {
            slots: SlotRing::new(config.slot_history),
            tps_history: Vec::with_capacity(config.tps_history),
            ctx,
            publisher,
            config,
            debounces: Debounces::default(),
            peers: HashMap::new(),
            info_cache,
            leaders_resolved_to: 0,
            info_scanned_to: 0,
            first_observed_slot: None,
            last_counters: None,
            my_leader_slots: Vec::new(),
            skip_epoch: None,
            skip_next_index: 0,
            skip_produced: 0,
            skip_elapsed: 0,
            last_completed_slot: 0,
            last_completed_at: now,
            last_vote_advance: now,
            last_second_tick: now - SECOND_TICK,
            last_slow_tick: now - SLOW_TICK,
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
        self.publisher.publish(
            TOPIC_SUMMARY,
            "startup_time_nanos",
            &system_time_nanos(self.ctx.start_time),
        );
    }

    pub fn tick(&mut self) {
        let now = Instant::now();

        let (root_bank, working_bank, highest_slot) = {
            let bank_forks = self.ctx.bank_forks.read().unwrap();
            (
                bank_forks.root_bank(),
                bank_forks.working_bank(),
                bank_forks.highest_slot(),
            )
        };

        self.collect_slot_positions(&root_bank, highest_slot);
        self.collect_leaders(&root_bank, highest_slot);
        self.collect_slot_levels(&root_bank);
        self.collect_identity_and_vote(&root_bank);
        self.collect_epoch(&root_bank);
        self.collect_startup_progress();

        if now.duration_since(self.last_second_tick) >= SECOND_TICK {
            self.last_second_tick = now;
            self.collect_clock();
            self.collect_tps(&working_bank);
        }

        if now.duration_since(self.last_slow_tick) >= SLOW_TICK {
            self.last_slow_tick = now;
            self.collect_validator_info();
            self.backfill_leader_names();
            self.collect_peers(&root_bank);
            self.collect_program_cache(&root_bank);
            self.collect_health();
            self.collect_skip_rate(&root_bank);
        }
    }

    // ---- slot positions -------------------------------------------------

    fn collect_slot_positions(&mut self, root_bank: &Bank, highest_slot: Slot) {
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

        let completed = self.highest_frozen_slot();
        self.debounces.completed_slot.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "completed_slot",
            completed,
        );
        self.observe_slot_duration(root_bank, completed);
    }

    fn highest_frozen_slot(&self) -> Slot {
        self.ctx
            .bank_forks
            .read()
            .unwrap()
            .frozen_banks()
            .map(|(slot, _)| slot)
            .max()
            .unwrap_or_default()
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

        let ns_per_slot = root_bank.ns_per_slot_at_slot(completed) as u64;
        self.debounces.slot_duration_nanos.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "estimated_slot_duration_nanos",
            ns_per_slot,
        );
    }

    // ---- slot history ---------------------------------------------------

    /// Walks the leader schedule forwards, labelling slots as they come into
    /// view so the strip and sidebar can show who is producing each one.
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
                .max(highest_slot.saturating_sub(self.config.slot_history as u64)),
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
            self.leaders_resolved_to = slot + 1;
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

    fn collect_slot_levels(&mut self, root_bank: &Bank) {
        let commitment = self.ctx.block_commitment_cache.read().unwrap();
        let (confirmed, finalized) = (
            commitment.highest_confirmed_slot(),
            commitment.highest_super_majority_root(),
        );
        drop(commitment);
        let root = root_bank.slot();

        let frozen: Vec<(Slot, u64, u64)> = {
            let bank_forks = self.ctx.bank_forks.read().unwrap();
            bank_forks
                .frozen_banks()
                .map(|(slot, bank)| {
                    (
                        slot,
                        bank.transaction_count(),
                        bank.non_vote_transaction_count_since_restart(),
                    )
                })
                .collect()
        };

        let mut changed = Vec::new();
        for (slot, total, non_vote) in frozen {
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
                entry.transactions = Some(total);
                entry.non_vote_transactions = Some(non_vote);
            }) {
                changed.push(entry);
            }
        }

        // The loop above no longer covers slots that have fallen out of bank
        // forks, so their levels advance from the roots directly.
        changed.extend(self.slots.promote(finalized, SlotLevel::Finalized));
        changed.extend(self.slots.promote(root, SlotLevel::Rooted));
        changed.extend(self.slots.promote(confirmed, SlotLevel::OptimisticallyConfirmed));

        // Anything still unstarted below the root will never be produced.
        changed.extend(self.slots.mark_skipped_below(root));

        for entry in &changed {
            self.publish_slot(entry);
        }
        if !changed.is_empty() {
            self.retain_slot_overview();
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
            &self.slots.recent(SLOT_OVERVIEW_LEN),
        );
    }

    // ---- identity, vote account, stake ----------------------------------

    fn collect_identity_and_vote(&mut self, root_bank: &Bank) {
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
        self.debounces
            .identity_name
            .publish(&self.publisher, TOPIC_SUMMARY, "identity_name", my_name);
        self.debounces
            .identity_icon
            .publish(&self.publisher, TOPIC_SUMMARY, "identity_icon", my_icon);
        self.debounces.identity_balance.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "identity_balance",
            root_bank.get_balance(&identity),
        );
        self.debounces.vote_balance.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "vote_balance",
            root_bank.get_balance(&self.ctx.vote_account),
        );

        let vote_accounts = root_bank.vote_accounts();
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

        let distance = last_vote.map(|vote| root_bank.slot().saturating_sub(vote));
        self.debounces.vote_distance.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "vote_distance",
            distance,
        );
    }

    // ---- epoch ----------------------------------------------------------

    fn collect_epoch(&mut self, root_bank: &Bank) {
        let epoch_schedule = root_bank.epoch_schedule();
        let slot = root_bank.slot();
        let epoch = epoch_schedule.get_epoch(slot);
        let start_slot = epoch_schedule.get_first_slot_in_epoch(epoch);
        let slots_in_epoch = epoch_schedule.get_slots_in_epoch(epoch);
        let end_slot = start_slot + slots_in_epoch.saturating_sub(1);

        // No wall-clock estimate here. It would change on every tick, so the
        // debounce could never suppress it and this message, which carries every
        // leader slot in the epoch, would go out five times a second. The client
        // derives the countdown from the current slot and the slot duration.

        // `get_leader_upcoming_slots` yields an endlessly repeating schedule, so
        // the `take_while` is what bounds it to this epoch.
        let me = self.ctx.identity();
        let my_leader_slots: Vec<Slot> = self
            .ctx
            .leader_schedule_cache
            .get_epoch_leader_schedule(epoch)
            .map(|leaders| {
                leaders
                    .get_leader_upcoming_slots(&me, 0)
                    .map(|index| start_slot + index as Slot)
                    .take_while(|slot| *slot <= end_slot)
                    .collect()
            })
            .unwrap_or_default();
        self.my_leader_slots = my_leader_slots.clone();

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

    // ---- clock, TPS -----------------------------------------------------

    fn collect_clock(&self) {
        let now = SystemTime::now();
        self.publisher
            .publish(TOPIC_SUMMARY, "server_time_nanos", &system_time_nanos(now));
        let uptime = now
            .duration_since(self.ctx.start_time)
            .unwrap_or_default()
            .as_nanos() as u64;
        self.publisher.publish(TOPIC_SUMMARY, "uptime_nanos", &uptime);
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
        let seconds = current.sampled_at.duration_since(previous.sampled_at).as_secs_f64();
        if seconds <= 0.0 {
            return;
        }

        // While catching up, replay chews through slots far faster than the
        // cluster produces them, and dividing a whole backlog of transactions
        // by one second reports tens of thousands of TPS. That is replay
        // throughput, not network throughput, and one such sample pins the
        // chart's scale for as long as it stays in view.
        let slots_per_second = (current.slot - previous.slot) as f64 / seconds;
        if slots_per_second > CATCH_UP_SLOTS_PER_SECOND {
            return;
        }

        let total = (current.total - previous.total) as f64 / seconds;
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

        self.tps_history.push(sample);
        if self.tps_history.len() > self.config.tps_history {
            let excess = self.tps_history.len() - self.config.tps_history;
            self.tps_history.drain(..excess);
        }
        self.publisher
            .retain_only(TOPIC_SUMMARY, "tps_history", &self.tps_history);
    }

    // ---- peers ----------------------------------------------------------

    fn collect_peers(&mut self, root_bank: &Bank) {
        let vote_accounts = root_bank.vote_accounts();
        let root_slot = root_bank.slot();
        let info_cache = self.info_cache.read().unwrap();

        // Gossip says who is reachable and vote accounts say who has stake. A
        // validator can appear in one and not the other, so the peer list is
        // the union of both, keyed by identity.
        let mut gossip: HashMap<Pubkey, (Option<String>, Option<u16>, Option<String>)> =
            HashMap::new();
        for (contact_info, _) in self.ctx.cluster_info.all_peers() {
            gossip.insert(
                *contact_info.pubkey(),
                (
                    contact_info.gossip().map(|addr| addr.to_string()),
                    Some(contact_info.shred_version()),
                    Some(contact_info.version().to_string()),
                ),
            );
        }
        let rpc_identities: HashSet<Pubkey> = self
            .ctx
            .cluster_info
            .rpc_peers()
            .iter()
            .map(|contact_info| *contact_info.pubkey())
            .collect();
        let rpc_nodes = rpc_identities.len();

        let mut current: HashMap<String, Peer> = HashMap::new();
        let mut delinquent = 0usize;
        let mut delinquent_stake = 0u64;
        let mut non_delinquent_stake = 0u64;

        for (vote_pubkey, (stake, account)) in vote_accounts.iter() {
            // The bank holds every vote account ever created, most with no
            // stake. Counting those puts the validator total in the tens of
            // thousands; a validator is one with stake this epoch, which is
            // what every other tool reports and who the leader schedule draws
            // from.
            if *stake == 0 {
                continue;
            }
            let view = account.vote_state_view();
            let identity = *account.node_pubkey();
            let last_vote = view.last_voted_slot();
            let is_delinquent = last_vote
                .map(|vote| root_slot.saturating_sub(vote) > MAX_DELINQUENT_SLOT_DISTANCE)
                .unwrap_or(true);
            if is_delinquent {
                delinquent += 1;
                delinquent_stake += *stake;
            } else {
                non_delinquent_stake += *stake;
            }

            let (gossip_addr, shred_version, version) =
                gossip.get(&identity).cloned().unwrap_or_default();
            current.insert(
                identity.to_string(),
                Peer {
                    identity: identity.to_string(),
                    vote_account: Some(vote_pubkey.to_string()),
                    stake: *stake,
                    commission: Some(view.commission()),
                    last_vote,
                    root_slot: view.root_slot(),
                    delinquent: is_delinquent,
                    gossip: gossip_addr,
                    shred_version,
                    version,
                    has_rpc: rpc_identities.contains(&identity),
                    name: info_cache.get(&identity).and_then(|info| info.name.clone()),
                },
            );
        }

        // Counted before gossip-only nodes are folded in, and keyed by identity
        // rather than vote account, so a validator running more than one staked
        // vote account counts once.
        let staked = current.len();

        // Unstaked gossip nodes (RPC nodes, mostly) round out the list.
        for (identity, (gossip_addr, shred_version, version)) in gossip {
            current.entry(identity.to_string()).or_insert_with(|| Peer {
                identity: identity.to_string(),
                vote_account: None,
                stake: 0,
                commission: None,
                last_vote: None,
                root_slot: None,
                delinquent: false,
                gossip: gossip_addr,
                shred_version,
                version,
                has_rpc: rpc_identities.contains(&identity),
                name: info_cache.get(&identity).and_then(|info| info.name.clone()),
            });
        }
        drop(info_cache);

        self.debounces.validator_counts.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "validator_counts",
            ValidatorCounts {
                total: staked,
                delinquent,
                rpc_nodes,
                non_delinquent_stake,
                delinquent_stake,
            },
        );

        // The peer table is kept for the counts above and for leader names, but
        // it is not published. Serialized whole it runs to megabytes on a real
        // cluster, and nothing in the client renders it: names travel on the
        // slots that need them, and the counts travel in `validator_counts`.
        self.peers = current;
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
                    info.name.is_some().then(|| {
                        (slot, info.name.clone(), info.icon_url.clone())
                    })
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
    /// makes the result complete. The peer sweep that follows compares whole
    /// `Peer` values, so a changed name propagates with no extra bookkeeping.
    fn collect_validator_info(&mut self) {
        let banks: Vec<Arc<Bank>> = {
            let bank_forks = self.ctx.bank_forks.read().unwrap();
            bank_forks
                .frozen_banks()
                .filter(|(slot, _)| *slot > self.info_scanned_to)
                .map(|(_, bank)| bank)
                .collect()
        };

        let mut changed = 0;
        let mut cache = self.info_cache.write().unwrap();
        for bank in banks {
            self.info_scanned_to = self.info_scanned_to.max(bank.slot());
            changed += cache.update_from_slot(&bank).len();
        }
        drop(cache);

        if changed > 0 {
            log::debug!("dashboard: {changed} validator info entries updated");
        }
    }

    // ---- program cache, health, skip rate -------------------------------

    fn collect_program_cache(&mut self, root_bank: &Bank) {
        // The lock is held only long enough to read counters. Enumerating cache
        // entries would be far too expensive on a timer, so the summary comes
        // entirely from stats the cache already maintains.
        let summary = {
            let cache = root_bank.program_cache().read().unwrap();
            let stats = &cache.stats;
            ProgramCacheSummary {
                hits: stats.hits.load(Ordering::Relaxed),
                misses: stats.misses.load(Ordering::Relaxed),
                evictions: stats.evictions.values().sum(),
                insertions: stats.insertions.load(Ordering::Relaxed),
                reloads: stats.reloads.load(Ordering::Relaxed),
                water_level: stats.water_level.load(Ordering::Relaxed),
            }
        };
        self.debounces.program_cache.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "live_program_cache",
            summary,
        );
    }

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

        self.debounces
            .health
            .publish(&self.publisher, TOPIC_SUMMARY, "health", Health { replay, vote });
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
        let epoch = root_bank.epoch();
        if self.skip_epoch != Some(epoch) {
            self.skip_epoch = Some(epoch);
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
        let leader_slots = self.my_leader_slots.clone();
        while self.skip_next_index < leader_slots.len() {
            let slot = leader_slots[self.skip_next_index];
            if slot > root {
                break;
            }
            self.skip_next_index += 1;
            if slot < floor {
                continue;
            }
            if self.ctx.blockstore.is_full(slot) {
                self.skip_produced += 1;
            }
            self.skip_elapsed += 1;
        }

        let rate = (self.skip_elapsed > 0).then(|| {
            (self.skip_elapsed - self.skip_produced) as f64 / self.skip_elapsed as f64
        });
        self.debounces
            .skip_rate
            .publish(&self.publisher, TOPIC_SUMMARY, "skip_rate", SkipRate { epoch, rate });
    }

    fn collect_startup_progress(&mut self) {
        let progress = (self.ctx.startup_progress)();
        self.debounces.startup_progress.publish(
            &self.publisher,
            TOPIC_SUMMARY,
            "startup_progress",
            progress,
        );
    }
}

fn system_time_nanos(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}
