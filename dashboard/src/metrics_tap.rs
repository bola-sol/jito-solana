//! Counters lifted from the measurements the validator submits about itself.
//!
//! Some of what an operator most wants to see is held in counters that are
//! private to the module keeping them and swapped to zero as they are reported.
//! Reading them where they live would mean both reaching into another crate and
//! racing the reporter for values only one reader can have. They are already
//! leaving the process as metrics points, so this takes a copy on the way past.
//!
//! The observer runs on whichever validator thread submitted the point, so what
//! happens here is a string comparison against a handful of names and, for the
//! few that match, a scan of their fields into atomics. A point this module does
//! not want costs one comparison, and nothing on that path allocates or locks.
//!
//! One point is the exception. The scheduler's per-slot counts are kept in a
//! queue behind a lock rather than summed into atomics, because they are not
//! summed at all — each belongs to one leader slot and is shown against it. That
//! point arrives four times in every eight hundred slots on a small validator,
//! where the rest of this reads several hundred a second.
//!
//! Totals only ever climb. The points themselves carry deltas — each one is what
//! happened since the last was sent — so accumulating them gives a figure that
//! can be differenced between readings, which is what every other rate on the
//! dashboard is built from.

use {
    serde::Serialize,
    solana_clock::Slot,
    solana_metrics::datapoint::DataPoint,
    std::{
        collections::VecDeque,
        sync::{
            Arc, Mutex,
            atomic::{AtomicU64, Ordering},
        },
    },
};

/// The point carrying the accounts read cache figures, submitted once a second
/// by the accounts database with the counters reset as it reads them.
const ACCOUNTS_DB_TIMINGS: &str = "accounts_db_store_timings";

/// The two shred receivers, one per socket. Turbine delivers to the first; the
/// second carries only what this validator had to ask another node for, which
/// is what the repair socket is.
const SHREDS_TURBINE: &str = "shred_fetch_receiver";
const SHREDS_REPAIR: &str = "shred_fetch_repair_receiver";

/// The receivers on the other two UDP ports the socket panel lists.
///
/// There is no third. The TPU and TPU forwards ports speak QUIC, where the
/// in-process counters count transactions pulled out of streams rather than
/// datagrams off the wire, and a share worked out from those against a datagram
/// drop count would be a ratio between two different things. The serve repair
/// port does keep a receiver of this kind, but nothing ever reports it: the
/// stats are built, counted into on every packet, and dropped when the service
/// ends. Reaching them would take a change to `core`, which this does not make.
const GOSSIP_RECEIVER: &str = "gossip_receiver";
const TPU_VOTE_RECEIVER: &str = "tpu_vote_receiver";

/// Packets seen, which for the shred receivers is shreds.
const PACKETS_COUNT: &str = "packets_count";

/// The banking stage scheduler's own account of what it did with everything
/// handed to it, reported once a second with its counters reset as it reports.
///
/// This is the whole of the transaction waterfall. The scheduler already counts
/// every transaction that reached it and, for the ones that got no further, the
/// reason — twenty-one figures that between them say where the traffic went.
///
/// Reported only when there is something to report, so an idle validator sends
/// nothing at all rather than a second of zeroes. That is the difference
/// between a scheduler doing nothing and one not being watched, and the panel
/// keeps it: no traffic in the window publishes nothing.
///
/// Worth knowing that this one point does not go through `datapoint_info!`. It
/// calls `solana_metrics::submit` itself, so unlike everything else read here
/// it is not behind the info-logging check and arrives whatever the operator
/// has set their log level to.
const SCHEDULER_COUNTS: &str = "banking_stage_scheduler_counts";

/// Where the accounts database served reads from, and what it wrote.
///
/// Three points rather than one, because the accounts database reports what it
/// is doing in three places: what it loaded and from where, how big its storage
/// files are, and what it flushed to them.
const ACCOUNTS_LOADS: &str = "accounts_db_load_accounts";
const ACCOUNTS_STORES: &str = "accounts_db-stores";
const ACCOUNTS_FLUSH: &str = "accounts_db-flush_accounts_cache";

/// The program cache's own account of itself, reported once per bank with its
/// counters reset as it reports — so each point is one slot's work.
///
/// Read from here rather than off the cache object the bank holds, which is
/// where this used to come from. Two reasons, and the second is the better one:
/// reaching the cache needs an accessor that upstream keeps behind
/// `dev-context-only-utils`, and polling a counter that resets every four
/// hundred milliseconds on a one-second tick reads part of one slot and misses
/// the rest. The point is emitted at every reset, so nothing is missed.
const PROGRAM_CACHE: &str = "loaded-programs-cache-stats";

/// The QUIC listener on the TPU port, the stage before verification.
///
/// Only the one port. Forwards and vote have listeners of their own reporting
/// under their own names, and neither feeds the scheduler this card follows.
const QUIC_TPU: &str = "quic_streamer_tpu";

/// Signature verification and deduplication for everything that is not a vote.
///
/// `tpu-vote-verifier` is the same point for votes and is deliberately left
/// alone: votes take a different path out of here and never reach the scheduler
/// below, so adding them would inflate the top of the card against a bottom
/// that could never account for them.
const TPU_VERIFIER: &str = "tpu-verifier";

/// The worker threads, which is where a scheduled transaction is executed.
///
/// One point per worker, all under this name and distinguished by an `id` tag.
/// Nothing here reads the tag: accumulating every one of them into the same
/// counters is what gives the figure for the stage as a whole.
///
/// Submitted at trace level, where everything else this reads is info. That
/// costs nothing, because the level is only consulted by the agent that writes
/// points onward — [`solana_metrics::submit`] calls the observer before it, so
/// a point nobody would ever collect still arrives here.
const WORKER_COUNTS: &str = "banking_stage_worker_counts";

/// The same twenty-one counters again, covering one leader slot rather than one
/// second, and carrying the slot they belong to as a field.
///
/// Submitted only while this validator is producing: the slot on it comes from
/// `decision.bank()`, which is `Some` for `Consume` and nothing else. So this
/// point exists for exactly the slots this node led and for no others, which is
/// what makes the produced block panel its home — on the schedule page, where
/// all but a handful of the turns belong to other validators, there would be
/// nothing to show against them.
const SCHEDULER_SLOT_COUNTS: &str = "banking_stage_scheduler_slot_counts";

/// The field naming the slot a point covers.
const SLOT: &str = "slot";

/// Leader slots kept. Matched to the produced block panel's own retention, so
/// every block it can show has its waterfall for as long as it is shown.
const SLOT_WATERFALLS: usize = 64;

/// What the accounts database read, wrote, and is holding.
///
/// The read side is a rate of accounts rather than of bytes. Agave counts what
/// it loaded in accounts and what it flushed in both, and there is no byte
/// counter anywhere on the load path to build a read throughput from.
///
/// Deliberately not `/proc/self/io`, which would give real bytes for both and
/// attribute the blockstore's writes to the accounts database while it was at
/// it. Process-wide disk figures are worth having; they are not this card.
#[derive(Debug, Default)]
pub struct AccountsCounters {
    /// Accounts served from each of the three places a read can be answered
    /// from. The last is the one that touches a file.
    pub loaded_from_write_cache: AtomicU64,
    pub loaded_from_read_cache: AtomicU64,
    pub loaded_from_storage: AtomicU64,

    /// Accounts written out of the cache to storage, and their size.
    pub stored_accounts: AtomicU64,
    pub stored_bytes: AtomicU64,

    /// Levels rather than counts: how much storage exists and how much of it is
    /// still live. The difference between them is the fragmentation that shrink
    /// exists to reclaim.
    pub storage_bytes: AtomicU64,
    pub storage_alive_bytes: AtomicU64,
    pub storage_count: AtomicU64,
    /// Bytes held by the read cache, and entries in it.
    pub cache_bytes: AtomicU64,
    pub cache_entries: AtomicU64,
}

/// How the program cache is faring: what replay asked of it, and what it lost.
#[derive(Debug, Default)]
pub struct ProgramCacheCounters {
    /// Programs replay wanted that were already compiled, and that were not.
    pub hits: AtomicU64,
    pub misses: AtomicU64,
    /// Compiled programs dropped to keep the cache within its entry limit,
    /// which is the usual reason a hit rate falls.
    pub evictions: AtomicU64,
    /// An entry that had been unloaded being compiled again — the cost of an
    /// eviction, paid later.
    pub reloads: AtomicU64,
    /// Programs added to the cache, and additions that were thrown away
    /// because the fork they belonged to was gone by the time they finished.
    pub insertions: AtomicU64,
    pub lost_insertions: AtomicU64,
    /// An entry already present being compiled a second time by mistake.
    pub replacements: AtomicU64,
    /// Programs used once and then evicted, which is cache space spent for
    /// nothing.
    pub one_hit_wonders: AtomicU64,
    /// Entries dropped because their fork was abandoned, and because they were
    /// not recompiled for the incoming epoch.
    pub prunes_orphan: AtomicU64,
    pub prunes_environment: AtomicU64,
    /// Keys left holding no versions at all once pruning had finished.
    pub empty_entries: AtomicU64,

    /// Entries loaded when an eviction last ran.
    ///
    /// A level rather than a count, so it is stored rather than added to — and
    /// an awkward one, because it is only written when an eviction happens and
    /// is reset with everything else at each bank. It reads nought on any slot
    /// that evicted nothing, which is most of them. The panel takes the highest
    /// reading across its window rather than the latest for that reason: what
    /// is worth knowing is how full the cache got, not whether it happened to
    /// evict in the last second.
    pub water_level: AtomicU64,
}

/// What the QUIC listener did with the transactions it pulled off the wire.
///
/// The narrowest of the four stages. QUIC keeps no count of what arrived, only
/// of what it managed to hand on and what it had to throw away, so the total
/// offered is the sum of the three rather than a figure of its own.
#[derive(Debug, Default)]
pub struct QuicCounters {
    /// Handed on towards verification.
    pub handed_on: AtomicU64,
    /// Thrown away because the queue towards verification was full. The one
    /// row here that means this validator could not keep up.
    pub queue_full: AtomicU64,
    /// Thrown away because that queue had gone.
    pub disconnected: AtomicU64,
}

/// What signature verification and deduplication did with what QUIC handed on.
#[derive(Debug, Default)]
pub struct VerifyCounters {
    /// Everything that arrived, votes excluded.
    pub received: AtomicU64,
    /// Seen before. The network sends the same transaction more than once as a
    /// matter of course, so this is ordinary rather than a fault.
    pub duplicate: AtomicU64,
    /// Dropped for paying too little, when a priority floor is configured.
    pub below_floor: AtomicU64,
    /// Passed verification.
    pub verified: AtomicU64,
    /// Batches — not transactions — dropped because the queue onward to the
    /// scheduler was full. Kept apart from everything else here for that
    /// reason: it cannot be added to or subtracted from a count of packets.
    pub evicted_batches: AtomicU64,
}

/// What the worker threads did with what the scheduler gave them.
#[derive(Debug, Default)]
pub struct ExecutedCounters {
    /// Transactions the workers took up.
    pub attempted: AtomicU64,
    /// Held back by the cost model rather than executed: the block had no room
    /// left for them.
    pub cost_throttled: AtomicU64,
    /// Handed back to be tried again.
    pub retryable: AtomicU64,
    /// Handed back because the bank they were for had gone.
    pub expired_bank: AtomicU64,
    /// Executed and committed to a block.
    pub processed: AtomicU64,
    /// Of those, the ones whose result was success. The rest landed in the
    /// block having failed, which still costs their fee.
    pub succeeded: AtomicU64,
}

/// Running totals of the counters worth watching.
#[derive(Debug, Default)]
pub struct MetricsTap {
    /// Reads of an account that were already cached, and those that were not.
    pub accounts_cache_hits: AtomicU64,
    pub accounts_cache_misses: AtomicU64,
    /// Accounts dropped from the cache, which is the usual reason a hit rate
    /// falls.
    pub accounts_cache_evicts: AtomicU64,

    /// Shreds that arrived on their own, and shreds this validator had to ask
    /// for. A node the cluster is not reaching gets the second where it should
    /// have had the first.
    ///
    /// The first doubles as the turbine port's received count. That is the same
    /// figure read for a second purpose rather than a second reading of it:
    /// everything arriving on the TVU port is a shred, so what that receiver
    /// counted is what the port delivered.
    pub shreds_turbine: AtomicU64,
    pub shreds_repair: AtomicU64,

    /// Packets delivered on the gossip and TPU vote ports.
    ///
    /// Wanted for the denominator the kernel will not give. `/proc/net/udp`
    /// counts the datagrams a socket discarded but not the ones it handed over,
    /// so a drop count on its own cannot be turned into a share of the traffic —
    /// and a number of drops that cannot be judged against anything is the
    /// weakest thing the socket panel shows. These are the other half of that
    /// sum, and they count datagrams too, one per packet, which is what makes
    /// them addable to a drop count in the first place.
    pub packets_gossip: AtomicU64,
    pub packets_tpu_vote: AtomicU64,

    /// What the accounts database read, wrote, and is holding.
    pub accounts: AccountsCounters,

    /// How the program cache is faring.
    pub program_cache: ProgramCacheCounters,

    /// The three stages either side of the scheduler, which together with it
    /// make the whole path a transaction takes through this validator.
    ///
    /// Four separate sets rather than one, and the panel draws them as four
    /// sections rather than one flow, because they do not reconcile: each is
    /// instrumented on its own terms, reports on its own cadence, and counts a
    /// population the next one does not quite receive. Summed into a single
    /// chain they would look authoritative and be quietly wrong.
    pub quic: QuicCounters,
    pub verify: VerifyCounters,
    pub executed: ExecutedCounters,

    /// Where the transactions handed to the banking stage ended up.
    pub scheduler: SchedulerCounters,

    /// The same, per leader slot, for the slots this validator produced.
    ///
    /// The one thing here behind a lock rather than an atomic. It is taken once
    /// per slot this node leads — four times in every eight hundred slots on a
    /// small validator, against the several hundred points a second the rest of
    /// this reads without locking anything — and held only long enough to push
    /// a struct of counts or to copy the queue out.
    slot_waterfalls: Mutex<VecDeque<SlotWaterfall>>,
}

/// One leader slot's waterfall.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SlotWaterfall {
    pub slot: Slot,
    #[serde(flatten)]
    pub counts: SchedulerTotals,
}

/// The banking stage scheduler's counters, in the order a transaction meets
/// them.
///
/// Three stages with losses between them. Everything sigverify passes on is
/// `received`; what survives the checks at the door is `buffered`; what the
/// scheduler then hands a worker is `scheduled`; what comes back done is
/// `finished`. The rest of these are the reasons the count falls between one
/// stage and the next.
///
/// The first stretch is an identity, and one the validator's own tests assert:
/// received equals buffered plus every drop from `not_held` down to
/// `nonce_conflict`, plus `check_queue_full`. The later stretches are not, and
/// cannot be — the container holds a standing population, so a transaction
/// buffered in one second is scheduled in another, and over any window the
/// three stages are three different populations that merely resemble each
/// other. Reading it as a strict funnel would be wrong.
#[derive(Debug, Default)]
pub struct SchedulerCounters {
    /// Everything sigverify handed the scheduler.
    pub received: AtomicU64,

    // Lost at the door, before ever being buffered.
    /// Not held, because the validator was forwarding rather than buffering.
    /// The ordinary state of a validator that is not near its leader slot, and
    /// on most nodes most of the time this is nearly all of the traffic.
    pub not_held: AtomicU64,
    /// The queue feeding the checks was full.
    pub check_queue_full: AtomicU64,
    /// Would not parse, or would not sanitize.
    pub unparsable: AtomicU64,
    /// Asked for locks it could not have.
    pub bad_locks: AtomicU64,
    /// Its compute budget instructions did not add up.
    pub compute_budget: AtomicU64,
    /// Its blockhash was too old, or its nonce did not hold.
    pub too_old: AtomicU64,
    /// Already in the ledger.
    pub already_processed: AtomicU64,
    /// The fee payer could not pay.
    pub fee_payer: AtomicU64,
    /// Excluded by the account key filter.
    pub filtered: AtomicU64,
    /// A nonce transaction already queued at the same or higher priority.
    pub nonce_conflict: AtomicU64,

    /// Made it into the container.
    pub buffered: AtomicU64,

    // Lost from the container, after being buffered.
    /// Pushed out by something of higher priority when the queue was full.
    pub queue_full: AtomicU64,
    /// Evicted by a validated nonce transaction that outranked it.
    pub nonce_evicted: AtomicU64,
    /// Thrown away when the container was cleared.
    pub cleared: AtomicU64,
    /// Thrown away as stale when the container was cleaned.
    pub cleaned: AtomicU64,

    /// Handed to a worker.
    pub scheduled: AtomicU64,
    /// Held back this pass because it wanted accounts already being written,
    /// or because every worker was busy. Not losses — pressure. These say the
    /// scheduler had work it could not place.
    pub blocked_conflicts: AtomicU64,
    pub blocked_threads: AtomicU64,

    /// Came back from a worker done, and came back to be tried again.
    pub finished: AtomicU64,
    pub retried: AtomicU64,
}

/// A snapshot of [`SchedulerCounters`], for differencing between readings.
///
/// Sent to the browser as it stands, once a window of these has been summed.
/// Deliberately not copied into a separate wire type on the way: the field
/// names here are already the panel's own vocabulary rather than the
/// scheduler's, and twenty-one lines of assigning one to the other would be
/// twenty-one chances to cross a pair over silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct AccountsTotals {
    pub loaded_from_write_cache: u64,
    pub loaded_from_read_cache: u64,
    pub loaded_from_storage: u64,
    pub stored_accounts: u64,
    pub stored_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct QuicTotals {
    pub handed_on: u64,
    pub queue_full: u64,
    pub disconnected: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct VerifyTotals {
    pub received: u64,
    pub duplicate: u64,
    pub below_floor: u64,
    pub verified: u64,
    pub evicted_batches: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ExecutedTotals {
    pub attempted: u64,
    pub cost_throttled: u64,
    pub retryable: u64,
    pub expired_bank: u64,
    pub processed: u64,
    pub succeeded: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct SchedulerTotals {
    pub received: u64,
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
    pub queue_full: u64,
    pub nonce_evicted: u64,
    pub cleared: u64,
    pub cleaned: u64,
    pub scheduled: u64,
    pub blocked_conflicts: u64,
    pub blocked_threads: u64,
    pub finished: u64,
    pub retried: u64,
}

/// A snapshot of the totals, for differencing between readings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TapCounters {
    pub accounts_cache_hits: u64,
    pub accounts_cache_misses: u64,
    pub accounts_cache_evicts: u64,
    pub shreds_turbine: u64,
    pub shreds_repair: u64,
    pub packets_gossip: u64,
    pub packets_tpu_vote: u64,
    pub scheduler: SchedulerTotals,
    pub accounts: AccountsTotals,
    /// Levels, read as they stand rather than differenced.
    pub accounts_storage_bytes: u64,
    pub accounts_storage_alive_bytes: u64,
    pub accounts_storage_count: u64,
    pub accounts_cache_bytes: u64,
    pub accounts_cache_entries: u64,
    pub program_cache: ProgramCacheTotals,
    /// Entries loaded when an eviction last ran. A level, so it is read as it
    /// stands rather than differenced.
    pub program_cache_water_level: u64,
    pub quic: QuicTotals,
    pub verify: VerifyTotals,
    pub executed: ExecutedTotals,
}

impl MetricsTap {
    /// Starts watching, if nothing else already is.
    ///
    /// There is one observer for the process and the first to ask keeps it, so
    /// a second dashboard in the same binary — which does not happen, but the
    /// interface allows it — gets a tap that stays at zero rather than one that
    /// quietly steals the first's.
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

    /// Adds what one point carries, if it is one of the few worth reading.
    ///
    /// A point this module does not want leaves after the match below, which is
    /// a comparison against fourteen names. Everything the validator measures about
    /// itself arrives here, so that is the cost paid on every one of them.
    fn observe(&self, point: &DataPoint) {
        match point.name {
            ACCOUNTS_DB_TIMINGS => {
                for (name, value) in &point.fields {
                    // The same point carries the cache's size and entry
                    // count, which are levels rather than counts.
                    self.accounts.add_point(point);
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
            SCHEDULER_COUNTS => self.scheduler.add_point(point),
            SCHEDULER_SLOT_COUNTS => self.remember_slot(point),
            ACCOUNTS_LOADS | ACCOUNTS_STORES | ACCOUNTS_FLUSH => self.accounts.add_point(point),
            PROGRAM_CACHE => self.program_cache.add_point(point),
            QUIC_TPU => self.quic.add_point(point),
            TPU_VERIFIER => self.verify.add_point(point),
            WORKER_COUNTS => self.executed.add_point(point),
            _ => (),
        }
    }

    /// Adds a socket receiver's packet count, the whole of what is wanted from
    /// any of those four points.
    fn add_packets(&self, counter: &AtomicU64, point: &DataPoint) {
        for (name, value) in &point.fields {
            if *name == PACKETS_COUNT {
                add_field(counter, value);
                return;
            }
        }
    }

    /// Records one leader slot's waterfall.
    ///
    /// These counts are already one slot's own — the scheduler resets them as
    /// it reports, and reports when the slot it is producing changes — so
    /// unlike everything else here they are kept as they arrive rather than
    /// accumulated and differenced later.
    ///
    /// A point without a readable slot is dropped. It has nowhere to be shown:
    /// the panel joins these to blocks by slot number, and a waterfall that
    /// cannot say which slot it describes belongs to none of them.
    fn remember_slot(&self, point: &DataPoint) {
        let Some(slot) = point
            .fields
            .iter()
            .find(|(name, _)| *name == SLOT)
            .and_then(|(_, value)| field_u64(value))
        else {
            return;
        };

        let counters = SchedulerCounters::default();
        counters.add_point(point);
        let waterfall = SlotWaterfall {
            slot,
            counts: counters.totals(),
        };

        let Ok(mut slots) = self.slot_waterfalls.lock() else {
            // A panicking observer would have poisoned this. The dashboard
            // losing a panel is not worth taking the validator down over.
            return;
        };
        // Replaced rather than appended if the slot is already held, which
        // needs the scheduler to report the same slot twice. Appending would
        // leave two rows for one slot and push a real one off the end.
        if let Some(held) = slots.iter_mut().find(|held| held.slot == slot) {
            *held = waterfall;
            return;
        }
        slots.push_back(waterfall);
        while slots.len() > SLOT_WATERFALLS {
            slots.pop_front();
        }
    }

    /// The leader slots held, oldest first.
    pub fn slot_waterfalls(&self) -> Vec<SlotWaterfall> {
        self.slot_waterfalls
            .lock()
            .map(|slots| slots.iter().copied().collect())
            .unwrap_or_default()
    }

    /// The totals as they stand, read together so a reading is coherent enough
    /// to difference.
    pub fn counters(&self) -> TapCounters {
        TapCounters {
            accounts_cache_hits: self.accounts_cache_hits.load(Ordering::Relaxed),
            accounts_cache_misses: self.accounts_cache_misses.load(Ordering::Relaxed),
            accounts_cache_evicts: self.accounts_cache_evicts.load(Ordering::Relaxed),
            shreds_turbine: self.shreds_turbine.load(Ordering::Relaxed),
            shreds_repair: self.shreds_repair.load(Ordering::Relaxed),
            packets_gossip: self.packets_gossip.load(Ordering::Relaxed),
            packets_tpu_vote: self.packets_tpu_vote.load(Ordering::Relaxed),
            scheduler: self.scheduler.totals(),
            accounts: self.accounts.totals(),
            accounts_storage_bytes: self.accounts.storage_bytes.load(Ordering::Relaxed),
            accounts_storage_alive_bytes: self.accounts.storage_alive_bytes.load(Ordering::Relaxed),
            accounts_storage_count: self.accounts.storage_count.load(Ordering::Relaxed),
            accounts_cache_bytes: self.accounts.cache_bytes.load(Ordering::Relaxed),
            accounts_cache_entries: self.accounts.cache_entries.load(Ordering::Relaxed),
            program_cache: self.program_cache.totals(),
            program_cache_water_level: self.program_cache.water_level.load(Ordering::Relaxed),
            quic: self.quic.totals(),
            verify: self.verify.totals(),
            executed: self.executed.totals(),
        }
    }
}

impl AccountsCounters {
    /// Adds one of the three accounts points.
    ///
    /// Matched on field name across all three rather than one method each: the
    /// names do not collide, and a single mapping is one place to look for
    /// where a figure on the card comes from.
    fn add_point(&self, point: &DataPoint) {
        for (name, value) in &point.fields {
            // Levels first. These say how things stand rather than what has
            // happened since the last point, so they are replaced, not summed.
            let gauge = match *name {
                "total_bytes" => Some(&self.storage_bytes),
                "total_alive_bytes" => Some(&self.storage_alive_bytes),
                "total_count" => Some(&self.storage_count),
                "read_only_accounts_cache_data_size" => Some(&self.cache_bytes),
                "read_only_accounts_cache_entries" => Some(&self.cache_entries),
                _ => None,
            };
            if let Some(gauge) = gauge {
                set_field(gauge, value);
                continue;
            }

            let counter = match *name {
                "num_loaded_from_write_cache" => &self.loaded_from_write_cache,
                "num_loaded_from_read_cache" => &self.loaded_from_read_cache,
                "num_loaded_from_index_storage" => &self.loaded_from_storage,
                // Two spellings each, because this point renamed its fields
                // between validator versions: what 4.3 calls stored, 4.2 calls
                // flushed. Both are matched so this file is the same on either
                // branch, and the name that does not exist simply never
                // arrives. Only the flush point is read for these, so the
                // identically named field on the shrink stats is not picked up
                // by accident.
                "num_accounts_stored" | "num_accounts_flushed" => &self.stored_accounts,
                "account_bytes_stored" | "account_bytes_flushed" => &self.stored_bytes,
                _ => continue,
            };
            add_field(counter, value);
        }
    }

    fn totals(&self) -> AccountsTotals {
        let read = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        AccountsTotals {
            loaded_from_write_cache: read(&self.loaded_from_write_cache),
            loaded_from_read_cache: read(&self.loaded_from_read_cache),
            loaded_from_storage: read(&self.loaded_from_storage),
            stored_accounts: read(&self.stored_accounts),
            stored_bytes: read(&self.stored_bytes),
        }
    }
}

impl ProgramCacheCounters {
    fn add_point(&self, point: &DataPoint) {
        for (name, value) in &point.fields {
            // `water_level` is a level and `slot` names the point; neither is
            // something to add to a running total.
            if *name == "water_level" {
                set_field(&self.water_level, value);
                continue;
            }
            let counter = match *name {
                "hits" => &self.hits,
                "misses" => &self.misses,
                "evictions" => &self.evictions,
                "reloads" => &self.reloads,
                "insertions" => &self.insertions,
                "lost_insertions" => &self.lost_insertions,
                // The field is not named after the counter behind it.
                "replace_entry" => &self.replacements,
                "one_hit_wonders" => &self.one_hit_wonders,
                "prunes_orphan" => &self.prunes_orphan,
                "prunes_environment" => &self.prunes_environment,
                "empty_entries" => &self.empty_entries,
                _ => continue,
            };
            add_field(counter, value);
        }
    }

    fn totals(&self) -> ProgramCacheTotals {
        let read = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        ProgramCacheTotals {
            hits: read(&self.hits),
            misses: read(&self.misses),
            evictions: read(&self.evictions),
            reloads: read(&self.reloads),
            insertions: read(&self.insertions),
            lost_insertions: read(&self.lost_insertions),
            replacements: read(&self.replacements),
            one_hit_wonders: read(&self.one_hit_wonders),
            prunes_orphan: read(&self.prunes_orphan),
            prunes_environment: read(&self.prunes_environment),
            empty_entries: read(&self.empty_entries),
        }
    }
}

impl QuicCounters {
    fn add_point(&self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                // Named for the counter, not for the field it is reported
                // under: the struct calls this `total_packets_sent_to_consumer`
                // and the point calls it this. Matching the struct's name reads
                // nought for ever and takes the whole section with it.
                "packets_sent_to_consumer" => &self.handed_on,
                "total_handle_chunk_to_packet_send_full_err" => &self.queue_full,
                "total_handle_chunk_to_packet_send_disconnected_err" => &self.disconnected,
                // The rest of that point is connections, streams and stream
                // throttling: gauges and connection-level counts that say
                // nothing about how many transactions got through.
                _ => continue,
            };
            add_field(counter, value);
        }
    }

    fn totals(&self) -> QuicTotals {
        QuicTotals {
            handed_on: self.handed_on.load(Ordering::Relaxed),
            queue_full: self.queue_full.load(Ordering::Relaxed),
            disconnected: self.disconnected.load(Ordering::Relaxed),
        }
    }
}

impl VerifyCounters {
    fn add_point(&self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                "total_packets" => &self.received,
                "total_dedup" => &self.duplicate,
                "total_dropped_below_priority_floor" => &self.below_floor,
                "total_valid_packets" => &self.verified,
                "eviction_drops" => &self.evicted_batches,
                // Timings, batch counts, and the deduper's saturation flag.
                _ => continue,
            };
            add_field(counter, value);
        }
    }

    fn totals(&self) -> VerifyTotals {
        VerifyTotals {
            received: self.received.load(Ordering::Relaxed),
            duplicate: self.duplicate.load(Ordering::Relaxed),
            below_floor: self.below_floor.load(Ordering::Relaxed),
            verified: self.verified.load(Ordering::Relaxed),
            evicted_batches: self.evicted_batches.load(Ordering::Relaxed),
        }
    }
}

impl ExecutedCounters {
    fn add_point(&self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                "transactions_attempted_processing_count" => &self.attempted,
                "cost_model_throttled_transactions_count" => &self.cost_throttled,
                "retryable_transaction_count" => &self.retryable,
                "retryable_expired_bank_count" => &self.expired_bank,
                "processed_transactions_count" => &self.processed,
                "processed_with_successful_result_count" => &self.succeeded,
                // `max_queue_len` is a gauge and `num_messages_processed`
                // counts batches rather than transactions.
                _ => continue,
            };
            add_field(counter, value);
        }
    }

    fn totals(&self) -> ExecutedTotals {
        ExecutedTotals {
            attempted: self.attempted.load(Ordering::Relaxed),
            cost_throttled: self.cost_throttled.load(Ordering::Relaxed),
            retryable: self.retryable.load(Ordering::Relaxed),
            expired_bank: self.expired_bank.load(Ordering::Relaxed),
            processed: self.processed.load(Ordering::Relaxed),
            succeeded: self.succeeded.load(Ordering::Relaxed),
        }
    }
}

impl SchedulerCounters {
    /// Adds the counts one scheduler point carries.
    ///
    /// Both of the scheduler's points — the one covering an interval and the
    /// one covering a single leader slot — carry the same twenty-one fields
    /// under the same names, so the mapping between the scheduler's vocabulary
    /// and the panel's lives here once. Two copies of it would be two places
    /// for a pair to be crossed over, and a crossed pair is invisible: the
    /// numbers would still add up, against the wrong labels.
    fn add_point(&self, point: &DataPoint) {
        for (name, value) in &point.fields {
            let counter = match *name {
                "num_received" => &self.received,
                "num_dropped_on_receive" => &self.not_held,
                "num_dropped_on_check_work_queue_full" => &self.check_queue_full,
                "num_dropped_on_parsing_and_sanitization" => &self.unparsable,
                "num_dropped_on_validate_locks" => &self.bad_locks,
                "num_dropped_on_receive_compute_budget" => &self.compute_budget,
                "num_dropped_on_receive_age" => &self.too_old,
                "num_dropped_on_receive_already_processed" => &self.already_processed,
                "num_dropped_on_receive_fee_payer" => &self.fee_payer,
                "num_dropped_on_filter_key" => &self.filtered,
                "num_dropped_on_nonce_dedup" => &self.nonce_conflict,
                "num_buffered" => &self.buffered,
                "num_dropped_on_capacity" => &self.queue_full,
                "num_evicted_on_nonce_dedup" => &self.nonce_evicted,
                "num_dropped_on_clear" => &self.cleared,
                "num_dropped_on_clean" => &self.cleaned,
                "num_scheduled" => &self.scheduled,
                "num_unschedulable_conflicts" => &self.blocked_conflicts,
                "num_unschedulable_threads" => &self.blocked_threads,
                "num_finished" => &self.finished,
                "num_retryable" => &self.retried,
                // `min_priority` and `max_priority` are gauges rather than
                // counts, and `slot` names the point rather than measuring
                // anything. None of the three belongs in a total.
                _ => continue,
            };
            add_field(counter, value);
        }
    }

    /// The counters as they stand.
    fn totals(&self) -> SchedulerTotals {
        let read = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        SchedulerTotals {
            received: read(&self.received),
            not_held: read(&self.not_held),
            check_queue_full: read(&self.check_queue_full),
            unparsable: read(&self.unparsable),
            bad_locks: read(&self.bad_locks),
            compute_budget: read(&self.compute_budget),
            too_old: read(&self.too_old),
            already_processed: read(&self.already_processed),
            fee_payer: read(&self.fee_payer),
            filtered: read(&self.filtered),
            nonce_conflict: read(&self.nonce_conflict),
            buffered: read(&self.buffered),
            queue_full: read(&self.queue_full),
            nonce_evicted: read(&self.nonce_evicted),
            cleared: read(&self.cleared),
            cleaned: read(&self.cleaned),
            scheduled: read(&self.scheduled),
            blocked_conflicts: read(&self.blocked_conflicts),
            blocked_threads: read(&self.blocked_threads),
            finished: read(&self.finished),
            retried: read(&self.retried),
        }
    }
}

/// Counters that only ever climb, so a window of them is a difference summed.
///
/// A trait rather than four sets of inherent methods so the windowing itself
/// can be written once, in the collector, instead of once per stage.
pub trait WindowedCounters: Copy + Default {
    /// This reading less the one before it, which is one interval's work.
    fn since(&self, previous: &Self) -> Self;
    /// This reading added to another, for summing a window of them.
    fn plus(&self, other: &Self) -> Self;
}

/// Differencing and summing for a set of counters that only ever climb.
///
/// Written once rather than once per stage. Every one of these types needs the
/// same two operations across every one of its fields, and a field left out of
/// either is silently wrong in the worst way available: it reads as nought for
/// ever rather than failing, so the row it feeds looks measured and says
/// nothing. Listing the fields once removes the chance.
macro_rules! counter_arithmetic {
    ($totals:ident { $($field:ident),* $(,)? }) => {
        impl WindowedCounters for $totals {
            /// Saturating throughout. The totals only climb, so a lower reading
            /// than the last means the tap was installed mid-flight or a counter
            /// was reset under it, and nought is the right answer to that rather
            /// than a number near `u64::MAX`.
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

counter_arithmetic!(AccountsTotals {
    loaded_from_write_cache,
    loaded_from_read_cache,
    loaded_from_storage,
    stored_accounts,
    stored_bytes,
});

counter_arithmetic!(ProgramCacheTotals {
    hits,
    misses,
    evictions,
    reloads,
    insertions,
    lost_insertions,
    replacements,
    one_hit_wonders,
    prunes_orphan,
    prunes_environment,
    empty_entries,
});

counter_arithmetic!(QuicTotals {
    handed_on,
    queue_full,
    disconnected,
});

counter_arithmetic!(VerifyTotals {
    received,
    duplicate,
    below_floor,
    verified,
    evicted_batches,
});

counter_arithmetic!(ExecutedTotals {
    attempted,
    cost_throttled,
    retryable,
    expired_bank,
    processed,
    succeeded,
});

counter_arithmetic!(SchedulerTotals {
    received,
    not_held,
    check_queue_full,
    unparsable,
    bad_locks,
    compute_budget,
    too_old,
    already_processed,
    fee_payer,
    filtered,
    nonce_conflict,
    buffered,
    queue_full,
    nonce_evicted,
    cleared,
    cleaned,
    scheduled,
    blocked_conflicts,
    blocked_threads,
    finished,
    retried,
});

/// Adds a field's value to a counter, if it reads as an integer.
fn add_field(counter: &AtomicU64, value: &str) {
    if let Some(delta) = field_u64(value) {
        counter.fetch_add(delta, Ordering::Relaxed);
    }
}

/// Replaces a gauge with the reading a point carries.
///
/// Stored rather than added, which is the whole difference between the two
/// kinds of figure here: a counter says how much happened since the last point
/// and only means anything summed, a gauge says how things stand and only means
/// anything as the latest value.
fn set_field(gauge: &AtomicU64, value: &str) {
    if let Some(latest) = field_u64(value) {
        gauge.store(latest, Ordering::Relaxed);
    }
}

/// Reads a field value that was written as an integer.
///
/// Values arrive formatted for the line protocol the metrics writer speaks
/// rather than as numbers: an integer field carries a trailing `i`, which is
/// InfluxDB's way of saying it is not a float. A value without one is a float,
/// a boolean or a quoted string, and none of those are counters.
fn field_u64(value: &str) -> Option<u64> {
    value.strip_suffix('i')?.parse().ok()
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
        // A float, a boolean and a quoted string all appear in the same points.
        assert_eq!(field_u64("42"), None);
        assert_eq!(field_u64("1.5"), None);
        assert_eq!(field_u64("true"), None);
        assert_eq!(field_u64("\"words\"i"), None);
    }

    #[test]
    fn test_the_totals_accumulate_across_points() {
        // Each point carries what happened since the last, the counters behind
        // them being reset as they are read, so the totals are the sum.
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
                // Every other counter left at nought, which is half of what
                // this test is for: a point from one source must not move
                // another source's figures. Defaulted rather than written out,
                // because the comparison is against the whole struct either way
                // and a hand-written list of them only has to be maintained.
                ..TapCounters::default()
            }
        );
    }

    #[test]
    fn test_other_points_are_ignored() {
        // The observer sees everything the process submits, most of which is
        // nothing to do with this.
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
        // The whole of the repair signal: one receiver per socket, and the
        // repair one carries only what this validator had to ask for.
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
        // The socket panel's denominator. Four receivers report packets under
        // the same field name, and a row's share of traffic lost is only right
        // if each one lands against the port it was read from.
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

    /// The waterfall point as the scheduler sends it, one field per counter.
    fn scheduler(fields: &[(&'static str, &str)]) -> DataPoint {
        named(SCHEDULER_COUNTS, fields)
    }

    #[test]
    fn test_the_waterfall_counters_land_where_they_belong() {
        // Twenty-one fields under names that do not resemble the ones the panel
        // uses, several of which differ from each other only in their tail. A
        // pair transposed here would put the fee payer failures under "too old"
        // and nothing downstream could tell.
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
        // The identity the validator's own tests assert, restated against the
        // names this module gives them: everything received either got in or
        // has a reason it did not. Checking it here is what makes the panel's
        // first section a genuine account rather than a list that happens to
        // sit under a heading.
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
        // How the panel is built: totals that only climb, differenced against
        // the last reading to give one interval's work, then added across the
        // window. Both halves saturate, so a counter that went backwards under
        // the tap reads as no work rather than as eighteen quintillion.
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

    /// The per-slot point: the same counters, plus the slot they belong to.
    ///
    /// The slot carries the same trailing `i` as every other integer field,
    /// because `add_field_i64` is what puts it there. Formatted here rather
    /// than written out by each caller: a fixture that left the suffix off
    /// would be describing a point the validator never sends, and the tap
    /// would rightly drop it.
    fn slot_point(slot: u64, fields: &[(&'static str, &str)]) -> DataPoint {
        let slot = format!("{slot}i");
        let mut all = vec![("slot", slot.as_str())];
        all.extend_from_slice(fields);
        named(SCHEDULER_SLOT_COUNTS, &all)
    }

    #[test]
    fn test_a_leader_slot_is_kept_whole_rather_than_accumulated() {
        // These are already one slot's own counts — the scheduler resets them
        // as it reports — so they are held as they arrived. Adding them to the
        // running totals the way every other point here is handled would give
        // each led slot's work twice.
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
        // And the interval totals are untouched: this point is not one of them.
        assert_eq!(tap.counters().scheduler.received, 0);
    }

    #[test]
    fn test_the_slot_is_read_by_the_same_rule_as_every_other_integer() {
        // Strict, and worth pinning because it is easy to get wrong from the
        // outside: `add_field_i64` writes "430789128i", not "430789128". If
        // upstream ever writes the slot another way this test fails, which is
        // better than the panel quietly emptying — the counters would still be
        // read, they would just have no slot to be shown against.
        let tap = MetricsTap::default();
        let mut bare = DataPoint::new(SCHEDULER_SLOT_COUNTS);
        bare.fields.push(("slot", "430789128".to_string()));
        bare.fields.push(("num_received", "500i".to_string()));
        tap.observe(&bare);
        assert!(tap.slot_waterfalls().is_empty());

        // The same point written as the validator writes it.
        tap.observe(&slot_point(430_789_128, &[("num_received", "500i")]));
        assert_eq!(tap.slot_waterfalls().len(), 1);
    }

    #[test]
    fn test_a_waterfall_with_no_slot_is_dropped() {
        // It has nowhere to go. The panel joins these to blocks by slot number,
        // so one that cannot say which slot it describes belongs to none.
        let tap = MetricsTap::default();
        tap.observe(&named(SCHEDULER_SLOT_COUNTS, &[("num_received", "500i")]));
        assert!(tap.slot_waterfalls().is_empty());
    }

    #[test]
    fn test_a_slot_reported_twice_is_replaced_rather_than_repeated() {
        // Appending would leave two rows describing one slot and push a real
        // one off the end of the queue.
        let tap = MetricsTap::default();
        tap.observe(&slot_point(100, &[("num_received", "5i")]));
        tap.observe(&slot_point(100, &[("num_received", "9i")]));

        let held = tap.slot_waterfalls();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].counts.received, 9);
    }

    #[test]
    fn test_only_the_newest_leader_slots_are_kept() {
        // Matched to what the produced block panel retains, so every block it
        // can show still has its waterfall, and nothing is held for a block
        // that has already scrolled out of reach.
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
        // The field was renamed between validator versions and this crate is
        // carried across both, so a single spelling would leave the whole
        // written-to-storage section reading nought on one of them.
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

    #[test]
    fn test_the_quic_fields_are_the_ones_the_point_carries() {
        // Two of these are named after the counter behind them and one is not,
        // which is not guessable and was wrong once. A field name taken from
        // the struct rather than from the wire matches nothing, reads nought
        // for ever, and takes its whole section down with it.
        let tap = MetricsTap::default();
        tap.observe(&named(
            QUIC_TPU,
            &[
                ("packets_sent_to_consumer", "900i"),
                ("total_handle_chunk_to_packet_send_full_err", "8i"),
                ("total_handle_chunk_to_packet_send_disconnected_err", "1i"),
            ],
        ));

        let quic = tap.counters().quic;
        assert_eq!(quic.handed_on, 900);
        assert_eq!(quic.queue_full, 8);
        assert_eq!(quic.disconnected, 1);
    }

    #[test]
    fn test_the_accounts_points_add_into_one_set_of_figures() {
        // Three points from three parts of the accounts database, matched on
        // field name in one place. Loads come from one, the flush figures from
        // another, and the storage levels from a third.
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
        // How much storage exists, not how much appeared since the last point.
        // Summed, a validator holding a steady hundred gigabytes would report
        // tens of terabytes within a minute.
        let tap = MetricsTap::default();
        tap.observe(&named(ACCOUNTS_STORES, &[("total_bytes", "100i")]));
        tap.observe(&named(ACCOUNTS_STORES, &[("total_bytes", "104i")]));
        assert_eq!(tap.counters().accounts_storage_bytes, 104);
    }

    #[test]
    fn test_a_level_is_replaced_rather_than_accumulated() {
        // `water_level` says where the cache stood, not what happened since the
        // last point. Added up the way every counter beside it is, a cache that
        // held four hundred entries all minute would report having held tens of
        // thousands.
        let tap = MetricsTap::default();
        tap.observe(&named(PROGRAM_CACHE, &[("water_level", "400i")]));
        tap.observe(&named(PROGRAM_CACHE, &[("water_level", "412i")]));
        assert_eq!(tap.counters().program_cache_water_level, 412);
    }

    #[test]
    fn test_the_cache_counter_named_differently_from_its_field_still_lands() {
        // The point calls it `replace_entry` where the counter behind it is
        // `replacements`. A mapping taken from the struct rather than from the
        // wire would silently read nought for ever.
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
        // There is no counter for a failed signature. It is what is left once
        // the duplicates, the underpaying and the verified are taken off, and
        // that subtraction is only exact because sigverify discards at one step
        // and returns — a packet is deduplicated, or dropped below the floor,
        // or verified, or bad, and never two of them.
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
    fn test_every_worker_adds_into_the_same_execution_totals() {
        // One point per worker thread, told apart only by a tag nothing here
        // reads. Summing them is what gives the figure for the stage, so a tap
        // that kept them apart or took the last would report one worker's share
        // of the work as all of it.
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
    fn test_the_vote_verifier_is_not_counted_with_the_rest() {
        // Votes leave sigverify by a different door and never reach the
        // scheduler, so counting them at the top would inflate a total the
        // stages below could never account for.
        let tap = MetricsTap::default();
        tap.observe(&named("tpu-vote-verifier", &[("total_packets", "5000i")]));
        assert_eq!(tap.counters().verify.received, 0);
    }

    #[test]
    fn test_the_priority_gauges_are_left_out_of_the_waterfall() {
        // They ride the same point and are the only two fields on it that are
        // not counts. Summing a window of "the highest fee in the queue right
        // now" would produce a number with no meaning at all.
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
        // Those points carry timings and channel depths as well, and adding
        // those to a shred count would be nonsense rather than merely wrong.
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
}
