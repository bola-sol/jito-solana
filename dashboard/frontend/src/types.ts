/** Mirrors the payloads published by `dashboard/src/collect.rs`. */

export type SlotLevel =
  | "incomplete"
  | "completed"
  | "optimistically_confirmed"
  | "rooted"
  | "finalized"
  | "skipped";

export interface SlotEntry {
  slot: number;
  level: SlotLevel;
  leader: string | null;
  leader_name: string | null;
  leader_icon: string | null;
  mine: boolean;
  /** What replay found in the block. Null for a slot with no block. */
  block: BlockDetail | null;
  duration_nanos: number | null;
}

/**
 * Where this validator's shreds came from over the last five minutes.
 *
 * Turbine should deliver nearly all of them; repair is the fallback for what
 * never arrived. Null while none have arrived at all.
 */
export interface Shreds {
  received: number;
  repaired: number;
  repair_rate: number;
}

/**
 * How often an account replay needed was already in memory, over the last
 * minute.
 *
 * Lifted from the measurements the accounts database submits about itself,
 * which carry a second's work each. Null while nothing has been read.
 */
export interface AccountsCache {
  /**
   * The read cache's own lookups and hit rate, which are narrower than they
   * look and are deliberately not the card's headline.
   *
   * The write cache is consulted first, so these cover only the reads that got
   * past it. Led with, the rate cannot be squared with the three-way split that
   * counts every load. The card derives its headline from that split instead
   * and leaves these to whoever is reading the feed directly.
   */
  read: number;
  hit_rate: number;
  evictions: number;
  cache_bytes: number;
  cache_entries: number;
  /**
   * Where reads were answered from. `from_storage` is the only one that touches
   * a file, and is the nearest thing here to a disk read rate — counted in
   * accounts rather than bytes, because nothing counts the bytes on that path.
   */
  from_write_cache: number;
  from_read_cache: number;
  from_storage: number;
  /** The write side, which does have a byte figure. */
  stored_accounts: number;
  stored_bytes: number;
  /** What the window actually spans, for turning totals into rates. */
  window_seconds: number;
  disk: AccountsDisk | null;
}

export interface AccountsDisk {
  used: number;
  allocated: number;
  /** Dead account data still on disk, which is what shrink reclaims. */
  fragmented: number;
  storages: number;
}

/**
 * How often replay found a program already compiled, over the last minute.
 *
 * The counters behind this are reset for each bank, so `looked_up` is what was
 * seen in the window rather than since startup. Null while nothing has been
 * looked up at all.
 */
export interface ProgramCache {
  looked_up: number;
  hits: number;
  misses: number;
  hit_rate: number;
  evictions: number;
  reloads: number;
  insertions: number;
  lost_insertions: number;
  replacements: number;
  one_hit_wonders: number;
  prunes_orphan: number;
  prunes_environment: number;
  /**
   * The most entries seen loaded at any eviction in the window, against the
   * limit eviction keeps them under. Null until an eviction has happened at
   * all: the figure behind it is only written when one runs.
   */
  peak_entries: number | null;
  entry_limit: number;
}

/**
 * What is known about a leader beyond the name its slot rows carry.
 *
 * Published only for the leaders on screen, so a leader may be missing from
 * this table briefly after a reconnection, before the next slow tick.
 */
export interface Peer {
  identity: string;
  version: string | null;
  stake: number;
  ip: string | null;
}

/**
 * A slot the leader schedule has assigned that has not happened yet.
 *
 * Published on the slow tier, so the front of the list has usually happened by
 * the time it is read. Filter against the completed slot before rendering.
 */
export interface UpcomingSlot {
  slot: number;
  leader: string;
  leader_name: string | null;
  leader_icon: string | null;
  mine: boolean;
}

/** What one block contained, as the collector read it off the frozen bank. */
export interface BlockDetail {
  transactions: number;
  non_vote_transactions: number;
  failed_transactions: number;
  entries: number;
  block_cost: number;
  block_cost_limit: number;
  total_fees: number;
  priority_fees: number;
}

export interface Tps {
  total: number;
  vote: number;
  non_vote_success: number;
  non_vote_failed: number;
}

export interface TpsSample extends Tps {
  slot: number;
  timestamp_nanos: number;
}

export interface StakeSummary {
  activated_stake: number;
  total_stake: number;
  /** This validator's share of total stake, in [0, 1]. */
  share: number;
}

export interface ValidatorCounts {
  total: number;
  delinquent: number;
  rpc_nodes: number;
  non_delinquent_stake: number;
  delinquent_stake: number;
}

export interface VersionShare {
  /** Null for peers reporting no version, and for the folded tail. */
  version: string | null;
  validators: number;
  stake: number;
  /** True only for the row the tail was folded into. */
  other: boolean;
}

export interface EpochInfo {
  epoch: number;
  start_slot: number;
  end_slot: number;
  slots_in_epoch: number;
  my_leader_slots: number[];
}

export interface Network {
  received_per_second: number;
  sent_per_second: number;
}

export interface NetworkSample extends Network {
  timestamp_nanos: number;
}

export interface IngestPath {
  name: string;
  port: number;
  drops_recent: number;
  drops_total: number;
  queued_bytes: number;
  /**
   * Packets the port delivered, over the same window and from the same instant
   * as the drops beside them, so that one can be divided by their sum.
   *
   * Null for a port whose traffic nothing counts in datagrams: the two QUIC
   * ports, whose counters count transactions pulled out of streams, and serve
   * repair, whose receiver keeps counters that nothing reports.
   */
  received_recent: number | null;
  received_total: number | null;
}

export interface ProducedBlock {
  slot: number;
  slot_time_millis: number | null;
  blockhash: string;
  duration_nanos: number | null;
  transactions: number;
  non_vote_transactions: number;
  failed_transactions: number;
  entries: number;
  block_cost: number;
  block_cost_limit: number;
  total_fees: number;
  priority_fees: number;
}

/**
 * Which of the process's schedulers built a slot.
 *
 * A stock validator runs one and always reports `scheduler`. jito runs a second
 * beside it for BAM, which builds the block itself whenever it is connected,
 * and counts what arrived in a different unit.
 */
export type SchedulerSource = "scheduler" | "bam";

/**
 * Where the transactions handed to the banking stage went, over the window.
 *
 * Counts of what happened inside the window, not a queue depth: the scheduler
 * reports these once a second with its own counters reset as it does, and the
 * server sums a window of them.
 *
 * The first stretch is an identity: `received` is exactly `buffered` plus every
 * loss the scheduler reports at the door. The later stretches are not, and
 * cannot be, because the queue holds a standing population, so what was
 * scheduled in this window was largely buffered in an earlier one.
 *
 * Three of those losses are carried in this type and never drawn. The counters
 * behind them arrived with a newer validator than this branch tracks, along
 * with the behaviour they count, so on this one they stay at nought and the
 * identity holds without them.
 *
 * None of that first stretch holds on a slot BAM built. It counts what it
 * rejected before parsing in batches and everything it rejected after parsing
 * in transactions, so `received` and `not_held` are in a unit of their own and
 * add up to nothing alongside the rest.
 */
export interface Waterfall {
  received: number;

  /**
   * Which scheduler these counts came from. Sent per slot and absent on the
   * live card, which covers both without distinguishing them.
   */
  source?: SchedulerSource;

  /**
   * Lost at the door, before ever being queued. These plus `buffered` are
   * `received` — on a slot the validator's own scheduler built.
   *
   * On a BAM slot none of that holds. `not_held` is fed by a different check
   * there and counts batches BAM sent past their own deadline, so it is neither
   * in the same unit as the rest nor part of any identity with them.
   */
  not_held: number;
  check_queue_full: number;
  unparsable: number;
  bad_locks: number;
  compute_budget: number;
  too_old: number;
  already_processed: number;
  fee_payer: number;
  filtered: number;
  nonce_conflict: number;

  buffered: number;

  /** Lost from the queue, having already been buffered. */
  queue_full: number;
  nonce_evicted: number;
  cleared: number;
  cleaned: number;

  scheduled: number;
  /** Not losses: work the scheduler had but could not place this pass. */
  blocked_conflicts: number;
  blocked_threads: number;

  finished: number;
  retried: number;
}

/**
 * The three stages either side of the scheduler.
 *
 * Sent under keys of their own and drawn as separate sections rather than as one
 * flow with the scheduler. They are instrumented independently, report on
 * different cadences, and each hands on a population the next does not quite
 * receive, so a single chain across them would imply an arithmetic that does not
 * hold. Each section balances against itself and nothing else.
 */
export interface QuicStage {
  handed_on: number;
  queue_full: number;
  disconnected: number;
}

export interface VerifyStage {
  received: number;
  duplicate: number;
  below_floor: number;
  verified: number;
  /** Batches, not transactions. Never added to the counts beside it. */
  evicted_batches: number;
}

export interface ExecutedStage {
  attempted: number;
  cost_throttled: number;
  retryable: number;
  expired_bank: number;
  processed: number;
  succeeded: number;

  /**
   * Why a transaction the workers took up never reached the block, from the
   * error counters the same worker reports beside the counts above.
   *
   * Only the reasons that end a transaction are here. The ones that hand it
   * back — account in use, and the four cost-limit errors — are already drawn
   * as retries, and an instruction error is a transaction that did reach the
   * block having failed, which is drawn as that. Counting any of them again
   * here would be counting the same transaction twice.
   *
   * These do not sum to the whole of the loss: the long tail of rarer errors is
   * gathered into a derived row rather than given one each.
   */
  too_many_locks: number;
  account_missing: number;
  fee_payer_broke: number;
  fee_payer_invalid: number;
  blockhash_missing: number;
  blockhash_old: number;
  already_processed: number;
  bad_compute_budget: number;
  account_data_too_large: number;
  program_not_executable: number;
  program_restricted: number;
}

/**
 * One leader slot's waterfall, sent as its own list rather than nested on the
 * produced block it belongs to.
 *
 * The two are built on different threads and arrive moments apart in either
 * order — the block when its bank freezes, this when the scheduler notices the
 * leader slot has changed — so they are joined here by slot number instead of
 * one waiting on the other.
 *
 * Only ever present for slots this validator led: the counters behind it are
 * tagged with the bank being produced, and there is no bank unless we are the
 * one producing.
 */
export interface SlotWaterfall extends Waterfall {
  slot: number;
}

/**
 * What replay did with the last few hundred slots.
 *
 * Every figure is microseconds. All but the two peaks are means for one slot,
 * because what one slot costs is what compares against how long a slot lasts.
 *
 * The three groups are measured in three different ways and cannot be mixed.
 * `fetch`, `confirming` and `completing` are disjoint spans of replay's own
 * thread and add up. `poh_verify`, `tx_verify` and `dispatch` are sums of
 * overlapping asynchronous jobs and are worth only relative to each other.
 * Everything from `execute` down is thread time summed across the workers, so
 * it partitions cleanly and routinely exceeds the slot it describes.
 */
export interface ReplayWindow {
  /** Slots behind the figures, which is short until the window has filled. */
  slots: number;
  transactions: number;

  fetch: number;
  confirming: number;
  completing: number;
  /** The worst single slot's total, not the largest each field reached. */
  serial_peak: number;

  poh_verify: number;
  tx_verify: number;
  dispatch: number;

  execute: number;
  bytecode: number;
  serialising: number;
  deserialising: number;
  load: number;
  store: number;
  program_cache: number;
  compiling: number;
  program_cache_peak: number;
  checking: number;
  other: number;
  cpu_peak: number;
}

export interface IngestSummary {
  window_seconds: number;
  paths: IngestPath[];
}

export interface StartupProgress {
  phase: string;
  detail: string | null;
  running: boolean;
  /** Ledger replay progress from 0 to 1, on the phases that can measure it. */
  fraction: number | null;
  /**
   * Share of the cluster's stake visible in gossip, while waiting for a
   * supermajority. Null in every other phase, and on the many validators that
   * never wait at all.
   */
  stake_percent: number | null;
  /**
   * How long the current phase has been running, and what each finished phase
   * took.
   *
   * Most of the boot sequence cannot say how far through it is — nothing counts
   * the accounts left to index or the archive left to unpack — so how long it
   * has been going stands in. On a boot that has stopped somewhere that is the
   * figure actually being looked for.
   */
  phase_elapsed_nanos: number;
  phases_taken: PhaseTiming[];
}

export interface PhaseTiming {
  phase: string;
  elapsed_nanos: number;
}

export interface Health {
  replay: string;
  vote: string;
}

export interface SkipRate {
  epoch: number;
  rate: number | null;
}

/** The envelope every message arrives in. */
export interface Envelope {
  topic: string;
  key: string;
  id?: number;
  value: unknown;
}
