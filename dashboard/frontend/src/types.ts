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
  /** True when this validator was the scheduled leader. The leader itself is
   *  resolved with `store.leaderOf`. */
  mine: boolean;
  /** What replay found in the block. Null for a slot with no block. */
  block: BlockDetail | null;
  duration_nanos: number | null;
  /** When the slot's first shred arrived, in milliseconds. Null for a slot never timed. */
  time_millis: number | null;
  /** How the block's shreds arrived. Null for a slot that never filled. */
  shreds: ShredArrival | null;
  /** Milliseconds from the slot's first shred to replay finishing it. Null for
   *  a bank this validator built. */
  replayed_millis: number | null;
}

/** How a block's shreds arrived. Outside `BlockDetail` because a slot fills
 *  before it freezes. */
export interface ShredArrival {
  /** Data shreds in the block. */
  count: number;
  /** Of those, the ones this validator had to ask for. Nought is the block arriving whole over turbine. */
  repaired: number;
  /** Milliseconds from the first shred to the last. */
  full_millis: number;
}

/** Where this validator's shreds came from over the last five minutes. Null
 *  while none have arrived. */
export interface Shreds {
  received: number;
  repaired: number;
  repair_rate: number;
}

/** How often an account replay needed was already in memory, over the last
 *  minute. Null while nothing has been read. */
export interface AccountsCache {
  /** The read cache's own lookups and hit rate, covering only reads past the
   *  write cache. Not the card's headline. */
  read: number;
  hit_rate: number;
  evictions: number;
  cache_bytes: number;
  cache_entries: number;
  /** Where reads were answered from, in accounts. `from_storage` is the only
   *  one that touches a file. */
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

/** How often replay found a program already compiled, over the last minute.
 *  Null while nothing has been looked up. */
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
  /** The most entries loaded at any eviction in the window. Null until one
   *  has run. */
  peak_entries: number | null;
  entry_limit: number;
}

/** What every validator that published anything calls itself: three arrays
 *  sharing an index. Fetched on demand. */
export interface Displays {
  keys: string[];
  names: (string | null)[];
  icons: (string | null)[];
}

export interface Peer {
  identity: string;
  version: string | null;
  stake: number;
  ip: string | null;
  /** Display name from the validator's on-chain info, if it published one. */
  name: string | null;
  /** Icon URL from the same place. */
  icon: string | null;
}

/** A scheduled slot that has not happened yet. Published on the slow tier;
 *  filter against the completed slot before rendering. */
export interface UpcomingSlot {
  slot: number;
  leader: string;
  leader_name: string | null;
  leader_icon: string | null;
  mine: boolean;
}

/** The rates that turn a measured tip figure into the two drawn. Absent
 *  without a tip payment program; `commission_bps` absent without the flag. */
export interface TipRates {
  jito_cut_bps: number;
  commission_bps: number | null;
}

/** What one block contained, as the collector read it off the frozen bank. */
export interface BlockDetail {
  transactions: number;
  non_vote_transactions: number;
  failed_transactions: number;
  entries: number;
  block_cost: number;
  block_cost_limit: number;
  /** The most compute any one account may be charged in a block. */
  account_cost_limit: number;
  total_fees: number;
  priority_fees: number;
  /** Lamports paid into the jito tip accounts during this slot, as measured;
   *  shares are derived in `tips.ts`. `null` where unmeasured, nought where
   *  nobody tipped. */
  tips: number | null;
  /** Wall time replay's own thread spent on this slot, in microseconds. Null
   *  for a block this validator built. */
  replay_micros: number | null;
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

  /** Every leader of this epoch, in the order they first take a turn. */
  leaders: string[];
  /** One index into `leaders` per turn of four slots:
   *  `leaders[turns[(slot - start_slot) / 4]]`. Empty where the validator
   *  could not derive the schedule. */
  turns: number[];

  /** Consensus limits every block of this epoch is measured against. */
  block_cost_limit: number;
  account_cost_limit: number;
}

export interface Network {
  received_per_second: number;
  sent_per_second: number;
}

export interface NetworkSample extends Network {
  timestamp_nanos: number;
}

/** The share of egress two senders account for, in bytes per second. Null
 *  until a sender has reported. */
export interface EgressSplit {
  gossip_per_second: number | null;
  repair_per_second: number | null;
}

export interface IngestPath {
  name: string;
  port: number;
  drops_recent: number;
  drops_total: number;
  queued_bytes: number;
  /** Packets the port delivered over the same window as the drops. Null for
   *  a port nothing counts in datagrams. */
  received_recent: number | null;
  received_total: number | null;
  /** Whether the port speaks QUIC, which decides which card draws it. */
  quic: boolean;
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
  /** The most compute any one account may be charged in a block. */
  account_cost_limit: number;
  total_fees: number;
  priority_fees: number;
  /** Lamports paid into the jito tip accounts during this slot, as measured.
   *  `null` where unmeasured, nought where nobody tipped. */
  tips: number | null;
  /** Bundles the stage sanitised and executed into the block. `null` where no
   *  bundle stage reported the slot. */
  bundles: { sanitized: number; executed: number } | null;
}

/** Which of the process's schedulers built a slot. BAM counts what arrived
 *  in batches. */
export type SchedulerSource = "scheduler" | "bam";

/**
 * Where the transactions handed to the banking stage went, over the window.
 * `received` equals `buffered` plus the losses through `nonce_conflict`; the
 * later stretches are not identities. On a BAM slot `received` and `not_held`
 * are in batches.
 */
export interface Waterfall {
  received: number;

  /** Which scheduler these counts came from. Sent per slot, absent on the
   *  live card. */
  source?: SchedulerSource;

  /** Lost at the door, before being queued. On a BAM slot `not_held` counts
   *  batches sent past their deadline instead. */
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
 * One QUIC listener's account of the traffic offered to it: the connection
 * funnel, then streams on admitted connections, then what came out towards
 * verification. `open` and `active_streams` are levels.
 */
export interface QuicPort {
  /** Matches the socket row of the same name on the ingest list. */
  name: string;

  offered: number;
  shed_all: number;
  shed_address: number;
  refused_full: number;
  handshake_timeout: number;
  handshake_error: number;
  /** Cleared the handshake and the rate limiters' second look. A checkpoint. */
  handshook: number;
  /** Refused a place in the connection table, under four overlapping
   *  counters. Never summed; `refusedTable` in `tpuPath.ts` reconciles them. */
  add_failed: number;
  add_failed_staked: number;
  add_failed_unstaked: number;
  add_failed_banned: number;
  admitted_staked: number;
  admitted_unstaked: number;

  streams: number;
  throttled_staked: number;
  throttled_unstaked: number;
  read_timeouts: number;
  read_errors: number;
  invalid_size: number;

  handed_on: number;
  bytes_handed_on: number;
  queue_full: number;
  disconnected: number;

  open: number;
  active_streams: number;

  /** Datagrams the kernel discarded on this port over the same span. Null
   *  where the port was not found among the bound sockets. */
  kernel_drops: number | null;
}

export interface QuicPaths {
  /** What the counts above actually span, which is short until it has filled. */
  window_seconds: number;
  ports: QuicPort[];
  /** Whether the advertised TPU address is a socket on this host. False
   *  behind a relayer or block-assembly proxy, which the validator cannot
   *  tell apart. */
  tpu_offhost: boolean;
}

/** What the two per-epoch sections of the TPU path card cover, in slots.
 *  `counted_slots` short of `elapsed_slots` is a restart part way through. */
export interface EpochSpan {
  epoch: number;
  /** Slots of this epoch that have happened. */
  elapsed_slots: number;
  /** Slots of this epoch the totals were actually summed over. */
  counted_slots: number;
  slots_in_epoch: number;
}

/** Bundles the block engine sent this epoch, counted where they arrive, so
 *  an upper bound on the executed share. Absent without a block engine and
 *  under BAM. */
export interface BundleStage {
  received: number;
  packets: number;
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

  /** Why a transaction the workers took up never reached the block. Only the
   *  terminal reasons; retries and instruction errors are drawn elsewhere. */
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

/** One leader slot's waterfall, sent as its own list and joined to the
 *  produced block by slot, since either can arrive first. Only for slots
 *  this validator led. */
export interface SlotWaterfall extends Waterfall {
  slot: number;
}

/**
 * What replay did with the last few hundred slots, in microseconds, as means
 * per slot bar the two peaks. `fetch`, `confirming` and `completing` are
 * disjoint spans; the verify figures are overlapping jobs, relative only;
 * everything from `execute` down is worker thread time.
 */
/** The machine the validator runs on, sampled once a second from /proc. */
/** Where every core's time went over the last second, as shares of it. */
export interface CpuUse {
  /** Everything but idle and iowait. */
  busy: number;
  user: number;
  /** The kernel, including interrupt handling. */
  system: number;
  /** Idle with a disk request outstanding. */
  iowait: number;
  /** Taken by a hypervisor. Nought on bare metal. */
  steal: number;
}

export interface Host {
  cores: number;
  load_one: number;
  load_five: number;
  load_fifteen: number;
  threads: number;
  running: number;
  /** Absent where the validator could not read `/proc/stat`. */
  cpu: CpuUse | null;

  memory_total: number;
  memory_available: number;
  /** Page cache and buffers: used, but handed back the moment it is wanted. */
  memory_reclaimable: number;
  memory_free: number;
  /** Absent where the machine has no swap configured at all. */
  swap: { total: number; used: number } | null;

  filesystems: FilesystemUsage[];
  devices: DeviceLoad[];
}

/** One group of the validator's threads over one second, mean per thread.
 *  `count` says how many stand behind the row. */
export interface ThreadGroup {
  /** Empty on the folded row. */
  name: string;
  count: number;
  /** The cores the threads may run on, where every thread is held to fewer than the machine has. */
  cores: string | null;
  /** Share of the second on a core, and runnable but waiting for one. */
  on_cpu: number;
  waiting: number;
  /** True for the one row every group not shown is folded into. */
  other: boolean;
}

/** Where the threads spent one second: the busiest groups by their minute's mean, and the rest. */
export interface ThreadsSample {
  timestamp_nanos: number;
  /** Threads in the process, every group included. */
  threads: number;
  groups: ThreadGroup[];
}

/** How full one filesystem is. A level, so nothing here is a rate. */
export interface FilesystemUsage {
  name: string;
  path: string;
  total: number;
  available: number;
}

/** How hard one block device was worked over the last second. */
export interface DeviceLoad {
  device: string;
  /** Every role whose path is on this device. Two mounts on one disk share a
   *  queue, so they share a row. */
  roles: string[];
  /** Share of the sample the device had a request in flight, in `[0, 1]`. Not
   *  a fill: a device can sit at 1 with the filesystem nearly empty. */
  busy: number;
  /** Mean milliseconds a request waited, null where none did. */
  wait_ms: number | null;
  operations_per_second: number;
  read_per_second: number;
  write_per_second: number;
}

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

/** What one block this validator produced cost and which account took the
 *  most of it. Sent as its own list and joined by slot. */
export interface SlotCost {
  slot: number;
  /** Pubkey of the account that consumed the most compute in this block. */
  costliest_account: string;
  costliest_cost: number;
  /** The block's total as the cost tracker counted it. */
  block_cost: number;
  accounts: number;
  /** Accounts within five percent of the per-account ceiling. */
  contended: number;
  new_account_data: number;
  in_flight: number;
}

export interface IngestSummary {
  window_seconds: number;
  paths: IngestPath[];
}

/** How the XDP transmit path is set up, absent where the validator was given
 *  no config. A configuration, not a measurement. */
export interface XdpConfig {
  /** Whether the socket bound with zero-copy. The bind fails rather than
   *  falls back, so true is trustworthy. */
  zero_copy: boolean;
  driver: string;
  /** Both of these read "unknown" where the PCI database could not be read. */
  vendor: string;
  model: string;
  kernel_version: string;
}

export interface StartupProgress {
  phase: string;
  detail: string | null;
  running: boolean;
  /** Ledger replay progress from 0 to 1, on the phases that can measure it. */
  fraction: number | null;
  /** Share of stake visible in gossip during the supermajority wait, as a
   *  whole percent. Null in every other phase. */
  stake_percent: number | null;
  /** The same wait in lamports, from the point the validator submits every
   *  tenth check. Null until the first point, and outside the wait. */
  stake_in_gossip: StakeInGossip | null;
  /** How long the current phase has run, and what each finished phase took. */
  phase_elapsed_nanos: number;
  phases_taken: PhaseTiming[];
}

export interface PhaseTiming {
  phase: string;
  elapsed_nanos: number;
}

/** Stake the validator could see in gossip when it last counted, in lamports. */
export interface StakeInGossip {
  online: number;
  offline: number;
  total: number;
}

export interface Health {
  replay: "not_started" | "running" | "stalled";
  vote: "not_voting" | "not_started" | "voting" | "delinquent";
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
