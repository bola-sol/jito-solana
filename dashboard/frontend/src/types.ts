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
  mine: boolean;
  block: BlockDetail | null;
  duration_nanos: number | null;
  time_millis: number | null;
  shreds: ShredArrival | null;
  /** Null for a bank this validator built. */
  replayed_millis: number | null;
  /** Null until the reward certificate has been seen, and always under TowerBFT. */
  reward: Reward | null;
  left_out: number | null;
}

/** `no_certificate`: the leader eight slots on produced no block, so nobody was paid. */
export type Reward = "paid" | "unpaid" | "no_certificate";

export interface ShredArrival {
  count: number;
  /** Nought is the block arriving whole over turbine. */
  repaired: number;
  full_millis: number;
}

export interface Shreds {
  received: number;
  repaired: number;
  repair_rate: number;
}

export interface AccountsCache {
  /** Covers only reads past the write cache; not the card's headline. */
  read: number;
  hit_rate: number;
  evictions: number;
  cache_bytes: number;
  cache_entries: number;
  /** In accounts; only `from_storage` touches a file. */
  from_write_cache: number;
  from_read_cache: number;
  from_storage: number;
  stored_accounts: number;
  stored_bytes: number;
  /** What the window spans, for turning totals into rates. */
  window_seconds: number;
  disk: AccountsDisk | null;
}

export interface AccountsDisk {
  used: number;
  allocated: number;
  /** What shrink reclaims. */
  fragmented: number;
  storages: number;
}

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
  peak_entries: number | null;
  entry_limit: number;
}

/** Three arrays sharing an index, fetched on demand. */
export interface Displays {
  keys: string[];
  names: (string | null)[];
  icons: (string | null)[];
}

export interface Peer {
  identity: string;
  version: string | null;
  client: string | null;
  stake: number;
  ip: string | null;
  name: string | null;
  icon: string | null;
}

/** Published on the slow tier; filter against the completed slot before rendering. */
export interface UpcomingSlot {
  slot: number;
  leader: string;
  leader_name: string | null;
  leader_icon: string | null;
  mine: boolean;
}

/** Absent without a tip payment program; `commission_bps` absent without the flag. */
export interface TipRates {
  jito_cut_bps: number;
  commission_bps: number | null;
}

export interface BlockDetail {
  transactions: number;
  non_vote_transactions: number;
  failed_transactions: number;
  entries: number;
  block_cost: number;
  block_cost_limit: number;
  account_cost_limit: number;
  total_fees: number;
  priority_fees: number;
  /** Shares are derived in `tips.ts`; `null` where unmeasured. */
  tips: number | null;
  /** In microseconds. Null for a block this validator built. */
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
  /** In [0, 1]. */
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
  version: string | null;
  validators: number;
  stake: number;
  other: boolean;
}

export interface EpochInfo {
  epoch: number;
  start_slot: number;
  end_slot: number;
  slots_in_epoch: number;
  my_leader_slots: number[];

  leaders: string[];
  /** One index into `leaders` per turn of four slots, `leaders[turns[(slot - start_slot) / 4]]`.
   *  Empty where the schedule could not be derived. */
  turns: number[];

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

/** In bytes per second; null until a sender has reported. */
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
  received_recent: number | null;
  received_total: number | null;
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
  account_cost_limit: number;
  total_fees: number;
  priority_fees: number;
  /** `null` where unmeasured, nought where nobody tipped. */
  tips: number | null;
  bundles: { sanitized: number; executed: number } | null;
  versions: TxVersions | null;
  execution: Execution | null;
  certificate: BlockCertificate | null;
}

export interface BlockCertificate {
  rewards: number;
  leader: string | null;
  leader_name: string | null;
  /** No fewer notarize votes than skip votes. */
  notarized: boolean;
  paid: number;
  ranks: number;
  stake_paid: number;
  notar: number;
  skip: number;
  ours_in: boolean;
  usual: number | null;
  left_out: CertificateValidator[];
}

export interface CertificateValidator {
  identity: string;
  name: string | null;
  ip: string | null;
}

export interface TxVersions {
  legacy: number;
  v0: number;
  v1: number;
}

export interface StageTimes {
  cost_model: number;
  load_execute: number;
  freeze_lock: number;
  record: number;
  commit: number;
  send_votes: number;
}

export interface Execution {
  /** Thread time, not wall time. */
  non_vote: StageTimes;
  workers: number;
  longest_batch: number;
  votes: StageTimes | null;
  window_millis: number;
}

/** The TPU path's totals are differenced at its end: everything since the previous turn drained. */
export interface LeaderTurn {
  first: number;
  last: number;
  produced: number;
  drained_millis: number;
  since_millis: number | null;
  quic: QuicPort;
  verify: VerifyStage;
  executed: ExecutedStage;
}

/** BAM counts what arrived in batches. */
export type SchedulerSource = "scheduler" | "bam";

/** Where the transactions handed to the banking stage went, over the window. `received` equals
 *  `buffered` plus the losses through `nonce_conflict`; a BAM slot's first two count batches. */
export interface Waterfall {
  received: number;

  source?: SchedulerSource;

  /** On a BAM slot `not_held` counts batches sent past their deadline instead. */
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

/** `open` and `active_streams` are levels. */
export interface QuicPort {
  name: string;

  offered: number;
  shed_all: number;
  shed_address: number;
  refused_full: number;
  handshake_timeout: number;
  handshake_error: number;
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

  kernel_drops: number | null;
}

export interface QuicPaths {
  window_seconds: number;
  ports: QuicPort[];
  tpu_offhost: boolean;
}

/** `counted_slots` short of `elapsed_slots` is a restart part way through. */
export interface EpochSpan {
  epoch: number;
  elapsed_slots: number;
  counted_slots: number;
  slots_in_epoch: number;
}

/** Counted on arrival, so an upper bound on the executed share. */
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

  /** Terminal reasons only; retries and instruction errors are drawn elsewhere. */
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

export interface SlotWaterfall extends Waterfall {
  slot: number;
}

export interface CpuUse {
  busy: number;
  user: number;
  system: number;
  iowait: number;
  steal: number;
}

export interface Host {
  cores: number;
  load_one: number;
  load_five: number;
  load_fifteen: number;
  threads: number;
  running: number;
  cpu: CpuUse | null;

  memory_total: number;
  memory_available: number;
  /** Used, but handed back the moment it is wanted. */
  memory_reclaimable: number;
  memory_free: number;
  swap: { total: number; used: number } | null;
  process_resident: number | null;
  process_resident_hour_ago: number | null;
  snapshot_device: string | null;

  filesystems: FilesystemUsage[];
  devices: DeviceLoad[];
}

export interface ThreadGroup {
  name: string;
  count: number;
  cores: string | null;
  on_cpu: number;
  waiting: number;
  other: boolean;
}

export interface ThreadsSample {
  timestamp_nanos: number;
  threads: number;
  groups: ThreadGroup[];
}

export interface FilesystemUsage {
  name: string;
  path: string;
  total: number;
  available: number;
}

export interface DeviceLoad {
  device: string;
  roles: string[];
  /** Not a fill: a device can sit at 1 with the filesystem nearly empty. */
  busy: number;
  wait_ms: number | null;
  operations_per_second: number;
  read_per_second: number;
  write_per_second: number;
}

/** Means per slot bar the two peaks. `fetch`, `confirming` and `completing` are disjoint; the
 *  verify figures overlap. */
export interface ReplayWindow {
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

export interface SlotCost {
  slot: number;
  costliest_account: string;
  costliest_cost: number;
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

export interface XdpConfig {
  /** The bind fails rather than falls back, so true is trustworthy. */
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
  fraction: number | null;
  /** A whole percent. Null outside the supermajority wait. */
  stake_percent: number | null;
  stake_in_gossip: StakeInGossip | null;
  phase_elapsed_nanos: number;
  phases_taken: PhaseTiming[];
}

export interface PhaseTiming {
  phase: string;
  elapsed_nanos: number;
}

export interface StakeInGossip {
  online: number;
  offline: number;
  total: number;
}

export interface GossipStake {
  slot: number;
  shred_version: number;
  total: number;
  seen: number;
  validators: GossipValidator[];
}

export interface GossipValidator {
  identity: string;
  name: string | null;
  icon: string | null;
  version: string | null;
  stake: number;
  seen: boolean;
}

export interface Health {
  replay: "not_started" | "running" | "stalled";
  vote: "not_voting" | "not_started" | "voting" | "delinquent";
}

/** Under alpenglow votes are not transactions. */
export type Consensus = "tower" | "alpenglow";

export interface SkipRate {
  epoch: number;
  rate: number | null;
}

export interface SnapshotArchive {
  slot: number;
  written_millis: number | null;
}

/** A null interval is disabled. */
export interface Snapshots {
  full: SnapshotArchive | null;
  incremental: SnapshotArchive | null;
  full_interval: number | null;
  incremental_interval: number | null;
  writing: SnapshotWriting | null;
  last_written: SnapshotWritten | null;
}

export interface SnapshotWriting {
  slot: number;
  since_millis: number;
}

export interface SnapshotWritten {
  slot: number;
  took_millis: number;
  fell_behind_slots: number;
}

export interface Turbine {
  window_seconds: number;
  root: number;
  layer_1: number;
  layer_2: number;
  layer_3: number;
  xdp_dropped: number;
  xdp_dropped_total: number;
  xdp: boolean | null;
}

export type VoteCost =
  | { kind: "fees"; per_day: number }
  | { kind: "ticket"; lamports: number; minimum: number };

/** Under alpenglow the field holds lamports of reward. */
export interface VoteCredits {
  epoch: number;
  credits: number;
  /** Read on the slow tier, so null until a viewer has been attached. */
  cluster_max: number | null;
}

export interface VoteParticipation {
  epoch: number;
  since_slot: number;
  paid: number;
  rewarded: number;
  cluster_max: number;
  misses: Misses;
  miss_bins: number[];
  lost_leaders: LostLeader[];
  ranks: number;
  /** A tenth under the epoch's median certificate; null until a hundred are in. */
  thin_below: number | null;
}

export interface LostLeader {
  identity: string;
  name: string | null;
  count: number;
}

export interface Admission {
  seat: boolean;
  next_seat: boolean | null;
  ticket_short: number | null;
}

export type MissPlace = "boundary" | "leader" | "snapshot" | "thin" | "late" | "lost";

/** Microseconds from votor's start on the slot; the first shred is reported only for a leader
 *  window's first slot. */
export interface VoteSent {
  first_shred_us: number | null;
  parent_ready_us: number | null;
  notarize_us: number | null;
  skip_us: number | null;
}

export interface MissWriter {
  identity: string;
  name: string | null;
  client: string | null;
  version: string | null;
  ip: string | null;
  certificates: number;
  misses: number;
}

export interface MissValidator {
  identity: string;
  name: string | null;
  ip: string | null;
}

export interface MissRow {
  slot: number;
  time_millis: number | null;
  place: MissPlace;
  paid_ranks: number;
  others: number[];
  writer: number | null;
  vote: VoteSent | null;
}

export interface MissList {
  epoch: number;
  since_slot: number;
  rewarded: number;
  ranks: number;
  writers: MissWriter[];
  validators: MissValidator[];
  rows: MissRow[];
  written: WrittenList;
}

export interface WrittenList {
  rewarded: number;
  certificates: number;
  carried_all: number;
  rows: WrittenRow[];
}

export interface WrittenRow {
  identity: string;
  name: string | null;
  client: string | null;
  version: string | null;
  ip: string | null;
  left_out_of_ours: number;
  left_out_everywhere: number;
}

/** A slot in more than one place counts in the first. */
export interface Misses {
  boundary: number;
  leader: number;
  snapshot: number;
  thin: number;
  late: number;
  lost: number;
}

export interface Envelope {
  topic: string;
  key: string;
  id?: number;
  value: unknown;
}

/** `Store.get` is typed by it; a key missing here cannot be read. */
export interface Published {
  summary: {
    version: string;
    client: string;
    cluster: string;
    shred_version: number;
    identity_key: string;
    identity_name: string | null;
    identity_icon: string | null;
    vote_key: string;
    uptime_nanos: number;
    server_time_nanos: number;
    caught_up_time_nanos: number;
    startup_progress: StartupProgress;
    gossip_stake: GossipStake | null;
    root_slot: number;
    optimistically_confirmed_slot: number;
    finalized_slot: number;
    completed_slot: number;
    estimated_slot: number;
    block_height: number;
    next_leader_slot: number | null;
    vote_slot: number | null;
    behind_cluster: number | null;
    replay_rate: number | null;
    identity_balance: number;
    vote_balance: number;
    vote_cost: VoteCost;
    vote_commission: number | null;
    stake: StakeSummary;
    validator_counts: ValidatorCounts;
    versions: VersionShare[];
    estimated_slot_duration_nanos: number;
    observed_slot_duration_nanos: number | null;
    epoch_remaining_nanos: number;
    skip_rate: SkipRate;
    health: Health;
    consensus: Consensus;
    program_cache: ProgramCache | null;
    accounts_cache: AccountsCache | null;
    shreds: Shreds | null;
    quic_paths: QuicPaths | null;
    verify: VerifyStage | null;
    executed: ExecutedStage | null;
    bundles: BundleStage | null;
    epoch_span: EpochSpan | null;
    produced_blocks: ProducedBlock[];
    slot_waterfalls: SlotWaterfall[];
    slot_costs: SlotCost[];
    produced_turns: LeaderTurn[];
    tip_rates: TipRates;
    replay: ReplayWindow | null;
    host: Host | null;
    network: Network;
    network_egress: EgressSplit;
    xdp: XdpConfig | null;
    ingest_paths: IngestSummary;
    snapshots: Snapshots | null;
    bls_key: boolean | null;
    admission: Admission | null;
    vote_credits: VoteCredits | null;
    vote_participation: VoteParticipation | null;
    turbine: Turbine | null;
  };
  epoch: { new: EpochInfo };
  peers: { all: Peer[] };
}
