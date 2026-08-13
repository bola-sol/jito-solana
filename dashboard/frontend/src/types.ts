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
  mine: boolean;
  transactions: number | null;
  non_vote_transactions: number | null;
  duration_nanos: number | null;
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

export interface ProgramCacheSummary {
  hits: number;
  misses: number;
  evictions: number;
  insertions: number;
  reloads: number;
  water_level: number;
}

export interface EpochInfo {
  epoch: number;
  start_slot: number;
  end_slot: number;
  slots_in_epoch: number;
  start_time_nanos: number;
  end_time_nanos: number;
  my_leader_slots: number[];
}

export interface Peer {
  identity: string;
  vote_account: string | null;
  stake: number;
  commission: number | null;
  last_vote: number | null;
  root_slot: number | null;
  delinquent: boolean;
  gossip: string | null;
  shred_version: number | null;
  version: string | null;
  has_rpc: boolean;
  name: string | null;
}

export interface PeerDelta {
  add: Peer[];
  update: Peer[];
  remove: string[];
}

export interface StartupProgress {
  phase: string;
  detail: string | null;
  running: boolean;
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
