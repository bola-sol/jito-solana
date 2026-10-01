
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

/** Shares of the limit that add to one; the costliest account's is of the limit, not the block. */
export interface Capacity {
  top: number;
  rest: number;
  free: number;
}

export function capacity(block: ProducedBlock, cost: SlotCost | undefined): Capacity | null {
  const limit = block.block_cost_limit;
  if (limit <= 0) return null;
  // Capped at the limit: the two figures are read from different places on the bank and can
  // disagree by rounding.
  const used = Math.min(1, Math.max(0, block.block_cost) / limit);
  // Capped at what the block used, for the same reason and because the
  // costliest account cannot have spent more than the block did.
  const top = cost ? Math.min(used, Math.max(0, cost.costliest_cost) / limit) : 0;
  return { top, rest: used - top, free: 1 - used };
}

const CHAIN_KEYS = ["received", "buffered", "scheduled", "finished"] as const;

/** A coverage test asserts every waterfall row is a stage or in exactly one group. */
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
  rows: WaterfallRow[];
  hits: number;
  total: number;
  /** BAM reports these in batches, so they stay out of `rows` and `total`. */
  aside: WaterfallRow[];
}

export interface ChainLink {
  key: string;
  label: string;
  count: number;
}

export interface SchedulerView {
  chain: ChainLink[];
  groups: CounterGroup[];
  lost: number;
  worst: WaterfallRow | null;
  nonZero: number;
  counters: number;
  /** `buffered` on a BAM slot, where `received` is batches. */
  completion: number | null;
}

export function schedulerView(w: SlotWaterfall): SchedulerView {
  const rows = waterfallRows(w);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const bam = w.source === "bam";

  const chain: ChainLink[] = CHAIN_KEYS.flatMap((key) => {
    const row = byKey.get(key);
    if (!row) return [];
    // On a BAM slot the first link counts batches and the rest transactions, so it is named for its
    // unit.
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
    // Capped, since a slot can finish work queued before it; null where nothing arrived.
    completion: against > 0 ? Math.min(1, finished / against) : null,
  };
}

export function shareOfGroup(group: CounterGroup, row: WaterfallRow): number {
  return group.total > 0 ? row.count / group.total : 0;
}

export interface ExecutionSegment {
  key: string;
  label: string;
  explain?: string;
  micros: number;
  share: number;
}

export interface ExecutionView {
  total: number;
  nonVote: number;
  votes: number | null;
  segments: ExecutionSegment[];
  perSlot: number | null;
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

/** What the committer does after each batch lands, timed upstream as
 *  `find_and_send_votes_us`. */
const AFTER_COMMIT =
  "After each commit the workers scan for votes, update the fee cache and send the transaction statuses.";

export function executionView(execution: Execution): ExecutionView {
  const w = execution.non_vote;
  const nonVote = stageTotal(w);
  const votes = execution.votes ? stageTotal(execution.votes) : null;
  const total = nonVote + (votes ?? 0);
  const parts: Array<[string, string, number, string?]> = [
    ["load", "load & execute", w.load_execute],
    ["commit", "commit", w.commit],
    ["record", "record", w.record],
    ["send", "after commit", w.send_votes, AFTER_COMMIT],
    ["fixed", "cost model + freeze lock", w.cost_model + w.freeze_lock],
  ];
  if (votes !== null && votes > 0) parts.push(["votes", "vote worker", votes]);
  const segments = parts.map(([key, label, micros, explain]) => ({
    key,
    label,
    explain,
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

export function versionsValue(versions: TxVersions): string {
  const total = versions.legacy + versions.v0 + versions.v1;
  if (total === 0) return "—";
  return [versions.legacy, versions.v0, versions.v1]
    .map((n) => percent(n / total, 0))
    .join(", ");
}

export function versionsTitle(versions: TxVersions): string {
  const total = versions.legacy + versions.v0 + versions.v1;
  const { legacy, v0, v1 } = versions;
  const counts = `${count(legacy)} legacy, ${count(v0)} v0, ${count(v1)} v1`;
  return `${counts} of ${count(total)} non-vote transactions.`;
}

export function bundlesValue(bundles: { sanitized: number; executed: number }): string {
  const executed = count(bundles.executed);
  return bundles.sanitized > bundles.executed
    ? `${executed} of ${count(bundles.sanitized)}`
    : executed;
}
