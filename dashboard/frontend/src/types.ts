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
}

export interface ProducedBlock {
  slot: number;
  captured_at_nanos: number;
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
