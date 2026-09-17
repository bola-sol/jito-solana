/** One produced block's figures arranged for the expanded slot row: what
 *  filled the block first, the scheduler's counters grouped and folded. */

import { count, percent } from "./format";
import type {
  Execution,
  ProducedBlock,
  SlotCost,
  SlotWaterfall,
  StageTimes,
  TxVersions,
} from "./types";
import { waterfallRows, type WaterfallRow } from "./waterfall";

/** How the block's compute limit was spent: three shares of the limit that
 *  add to one. The costliest account's share is of the limit, not the block. */
export interface Capacity {
  /** The costliest account's share of the limit, or nought where none is known. */
  top: number;
  /** Everything else that was used. */
  rest: number;
  /** Headroom the block never took. */
  free: number;
}

/** Null where the limit is unknown, which leaves nothing to draw a share of. */
export function capacity(block: ProducedBlock, cost: SlotCost | undefined): Capacity | null {
  const limit = block.block_cost_limit;
  if (limit <= 0) return null;
  // Capped at the limit. A block cannot exceed it, but the two figures are
  // captured from different places on the bank and a rounding disagreement
  // would otherwise push the bar past its own track.
  const used = Math.min(1, Math.max(0, block.block_cost) / limit);
  // Capped at what the block used, for the same reason and because the
  // costliest account cannot have spent more than the block did.
  const top = cost ? Math.min(used, Math.max(0, cost.costliest_cost) / limit) : 0;
  return { top, rest: used - top, free: 1 - used };
}

/** The scheduler rows that mark a point every transaction passes through. */
const CHAIN_KEYS = ["received", "buffered", "scheduled", "finished"] as const;

/** Which stage each counter belongs to, by key. A coverage test asserts every
 *  waterfall row is a stage or in exactly one group. */
const GROUPS: { key: string; title: string; members: string[] }[] = [
  {
    key: "intake",
    title: "Intake · dropped",
    members: [
      "not_held",
      "check_queue_full",
      "unparsable",
      "bad_locks",
      "compute_budget",
      "too_old",
      "already_processed",
      "fee_payer",
      "filtered",
      "nonce_conflict",
    ],
  },
  {
    key: "buffer",
    title: "Buffer · cleared",
    members: ["queue_full", "nonce_evicted", "cleared", "cleaned"],
  },
  {
    key: "schedule",
    title: "Schedule · held back",
    members: ["blocked_conflicts", "blocked_threads", "retried"],
  },
];

export interface CounterGroup {
  key: string;
  title: string;
  /** The group's counters: those above nought first, largest down, then the
   *  rest in pipeline order. */
  rows: WaterfallRow[];
  /** How many rows are above nought, and so where the quiet ones begin. */
  hits: number;
  /** The group's own total, in transactions. */
  total: number;
  /** Rows counted in batches, which BAM reports. Kept out of `rows` and
   *  `total`: a different unit. */
  aside: WaterfallRow[];
}

/** One link in the strip above the drawer. */
export interface ChainLink {
  key: string;
  label: string;
  count: number;
}

export interface SchedulerView {
  chain: ChainLink[];
  groups: CounterGroup[];
  /** Everything the groups lost, in transactions. */
  lost: number;
  /** The single largest counter, or null where nothing was lost. */
  worst: WaterfallRow | null;
  /** How many counters are above nought, out of how many there are. */
  nonZero: number;
  counters: number;
  /** What finished, against the first figure counted in transactions:
   *  `buffered` on a BAM slot, where `received` is batches. */
  completion: number | null;
}

export function schedulerView(w: SlotWaterfall): SchedulerView {
  const rows = waterfallRows(w);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const bam = w.source === "bam";

  const chain: ChainLink[] = CHAIN_KEYS.flatMap((key) => {
    const row = byKey.get(key);
    if (!row) return [];
    // Named for its unit where the unit changes. On a BAM slot the first link
    // is batches and the three after it are transactions, and a reader given
    // four bare numbers in a row would take them for one measurement narrowing.
    const label = key === "received" && bam ? "batches" : key;
    return [{ key, label, count: row.count }];
  });

  const groups: CounterGroup[] = GROUPS.map((group) => {
    const members = group.members.flatMap((key) => byKey.get(key) ?? []);
    const aside = members.filter((row) => row.kind === "count");
    const counted = members.filter((row) => row.kind !== "count");
    const hits = counted.filter((row) => row.count > 0);
    const quiet = counted.filter((row) => row.count === 0);
    // Stable across ticks: two counters on the same figure keep the order the
    // pipeline lists them in rather than swapping under whoever is reading.
    hits.sort((a, b) => b.count - a.count);
    return {
      key: group.key,
      title: group.title,
      rows: [...hits, ...quiet],
      hits: hits.length,
      total: counted.reduce((sum, row) => sum + row.count, 0),
      aside,
    };
  });

  const counted = groups.flatMap((group) => group.rows);
  const lost = groups.reduce((sum, group) => sum + group.total, 0);
  const worst = counted.reduce<WaterfallRow | null>(
    (top, row) => (row.count > 0 && (top === null || row.count > top.count) ? row : top),
    null,
  );

  const buffered = byKey.get("buffered")?.count ?? 0;
  const received = byKey.get("received")?.count ?? 0;
  const against = bam ? buffered : received;
  const finished = byKey.get("finished")?.count ?? 0;

  return {
    chain,
    groups,
    lost,
    worst,
    nonZero: counted.filter((row) => row.count > 0).length,
    counters: counted.length,
    // Capped, because the queue holds transactions across slots and a slot can
    // finish more than arrived in it. Null rather than nought where nothing
    // arrived, so an idle slot does not read as one that finished nothing.
    completion: against > 0 ? Math.min(1, finished / against) : null,
  };
}

/** A counter's share of its own group, for the bar beside it. */
export function shareOfGroup(group: CounterGroup, row: WaterfallRow): number {
  return group.total > 0 ? row.count / group.total : 0;
}

export interface ExecutionSegment {
  key: string;
  label: string;
  /** Microseconds. */
  micros: number;
  /** Of the thread time. */
  share: number;
}

export interface ExecutionView {
  /** Thread time across the workers and the vote worker, in microseconds. */
  total: number;
  nonVote: number;
  votes: number | null;
  segments: ExecutionSegment[];
  /** Thread time over the slot's window; `null` without a window. */
  perSlot: number | null;
  /** Non-vote thread time over the workers; `null` without workers. */
  perWorker: number | null;
}

function stageTotal(times: StageTimes): number {
  return (
    times.cost_model +
    times.load_execute +
    times.freeze_lock +
    times.record +
    times.commit +
    times.send_votes
  );
}

/** The stacked bar: the workers' stages largest first, the two fixed costs
 *  folded together, and the vote worker as one segment where it reported. */
export function executionView(execution: Execution): ExecutionView {
  const w = execution.non_vote;
  const nonVote = stageTotal(w);
  const votes = execution.votes ? stageTotal(execution.votes) : null;
  const total = nonVote + (votes ?? 0);
  const parts: Array<[string, string, number]> = [
    ["load", "load & execute", w.load_execute],
    ["commit", "commit", w.commit],
    ["record", "record", w.record],
    ["send", "votes to send", w.send_votes],
    ["fixed", "cost model + freeze lock", w.cost_model + w.freeze_lock],
  ];
  if (votes !== null) parts.push(["votes", "vote worker", votes]);
  const segments = parts.map(([key, label, micros]) => ({
    key,
    label,
    micros,
    share: total > 0 ? micros / total : 0,
  }));
  return {
    total,
    nonVote,
    votes,
    segments,
    perSlot: execution.window_millis > 0 ? total / (execution.window_millis * 1000) : null,
    perWorker: execution.workers > 0 ? nonVote / execution.workers : null,
  };
}

/** Each version's share of the non-vote transactions, legacy first. A
 *  block of votes alone has no share to give. */
export function versionsValue(versions: TxVersions): string {
  const total = versions.legacy + versions.v0 + versions.v1;
  if (total === 0) return "—";
  return [versions.legacy, versions.v0, versions.v1]
    .map((n) => percent(n / total, 0))
    .join(" · ");
}

/** The counts behind the shares, for the hover. */
export function versionsTitle(versions: TxVersions): string {
  const total = versions.legacy + versions.v0 + versions.v1;
  const { legacy, v0, v1 } = versions;
  const counts = `${count(legacy)} legacy, ${count(v0)} v0, ${count(v1)} v1`;
  return `${counts} of ${count(total)} non-vote transactions.`;
}

/** Executed, and out of how many sanitised where the two differ. */
export function bundlesValue(bundles: { sanitized: number; executed: number }): string {
  const executed = count(bundles.executed);
  return bundles.sanitized > bundles.executed
    ? `${executed} of ${count(bundles.sanitized)}`
    : executed;
}
