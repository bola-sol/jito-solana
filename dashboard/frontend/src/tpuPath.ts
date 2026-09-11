import { count, percent } from "./format";
import type {
  BundleStage,
  EpochSpan,
  ExecutedStage,
  QuicPort,
  VerifyStage,
} from "./types";
import { executedRows, verifyRows, type WaterfallRow } from "./waterfall";

/**
 * What happened to transactions on their way in, before the scheduler. The
 * first two sections describe the QUIC listener's connections, where most of
 * the loss happens. Each section is one bar cut into outcomes.
 */

/** A loss, and what it was a loss out of. */
export interface PathLoss {
  key: string;
  label: string;
  count: number;
  /** Of the section's total, in `[0, 1]`. */
  share: number;
  /** Whether this loss means the validator could not keep up, as against a
   *  refusal working as designed. */
  warn: boolean;
  explain: string;
}

/** A figure in a different unit from the bar, drawn beside the heading with
 *  no segment and no share. */
export interface PathAside {
  label: string;
  count: number;
  unit: string;
  warn: boolean;
  explain: string;
}

export interface PathSection {
  key: string;
  /** What the section counts, named for the quantity rather than its place
   *  in the pipeline. */
  title: string;
  /** What the total is scoped to. No section is drawn against the one
   *  above it. */
  note: string;
  explain: string;
  /** What the bar is drawn against. */
  total: number;
  /** What came out of the section, and what to call it. */
  through: { label: string; count: number };
  /** Losses, largest first, with the ones at nought left out. */
  losses: PathLoss[];
  /** Reasons behind one of the losses above. Shown when expanded, never in
   *  the bar, where they would count twice. */
  detail: PathLoss[];
  /** How many of the section's counters stayed at nought, as a figure rather
   *  than rows. */
  zeros: number;
  aside: PathAside | null;
}

/** How many losses a section lists before the rest go behind a control. */
export const LOSSES_SHOWN = 6;
export const LOSSES_SHOWN_NARROW = 3;

/** How many names the listener refuses a connection under. */
const REFUSAL_NAMES = 4;

/**
 * Connections refused a place in the table, under four overlapping counters
 * that must not be summed. The larger of `add_failed` and the other three
 * together is the tighter lower bound; any shortfall lands in the unaccounted
 * row.
 */
export function refusedTable(q: QuicPort): number {
  return Math.max(
    q.add_failed,
    q.add_failed_staked + q.add_failed_unstaked + q.add_failed_banned,
  );
}

function shareOf(total: number, count: number): number {
  if (total <= 0) return 0;
  return Math.min(1, count / total);
}

/** The losses largest first, and a count of the ones that did not fire. */
function sorted(
  total: number,
  rows: Array<
    [key: string, label: string, count: number, warn: boolean, explain: string]
  >,
): { losses: PathLoss[]; zeros: number } {
  const losses = rows
    .filter(([, , count]) => count > 0)
    .map(([key, label, count, warn, explain]) => ({
      key,
      label,
      count,
      share: shareOf(total, count),
      warn,
      explain,
    }))
    .sort((a, b) => b.count - a.count);
  return { losses, zeros: rows.length - losses.length };
}

/**
 * The connection funnel, drawn against the offer and clipped: a connection
 * can be rate-limited again after its handshake. The listener drops uncounted
 * on either side of the handshake, and those gaps are rows here, split by
 * the handshake count.
 */
export function doorSection(
  q: QuicPort,
  kernelDrops: number | null,
): PathSection {
  const admitted = q.admitted_staked + q.admitted_unstaked;
  const refused = refusedTable(q);
  // Everything the listener counts, off the offer. The rate limits fire on
  // either side of the handshake, and the split cancels here.
  const beforeHandshake = Math.max(
    0,
    q.offered -
      (q.shed_all +
        q.shed_address +
        q.refused_full +
        q.handshake_timeout +
        q.handshake_error +
        q.handshook),
  );
  const afterHandshake = Math.max(0, q.handshook - refused - admitted);
  const derivedAtZero =
    (beforeHandshake > 0 ? 0 : 1) + (afterHandshake > 0 ? 0 : 1);
  const { losses, zeros } = sorted(q.offered, [
    [
      "door_shed_address",
      "over one address's rate",
      q.shed_address,
      false,
      "Turned away before a handshake because that address was opening connections too quickly.",
    ],
    [
      "door_shed_all",
      "over the port's rate",
      q.shed_all,
      false,
      "Turned away before a handshake because the port as a whole was over its connection rate.",
    ],
    [
      "door_handshake_timeout",
      "handshake timed out",
      q.handshake_timeout,
      false,
      "Accepted for a handshake that did not finish in time.",
    ],
    [
      "door_refused_full",
      "no room in the table",
      q.refused_full,
      true,
      "Refused because the endpoint already held every connection it is configured to hold.",
    ],
    [
      "door_handshake_error",
      "handshake failed",
      q.handshake_error,
      false,
      "Accepted for a handshake that ended in an error: a transport fault, a rejected certificate, or the peer closing it.",
    ],
    [
      "door_add_failed",
      "refused after handshake",
      refused,
      false,
      "Handshook and then refused a place in the connection table. Counted under four overlapping names, so this is the largest of them rather than their sum.",
    ],
    [
      "door_unaccounted_pre",
      "unaccounted, before handshake",
      beforeHandshake,
      false,
      "Offered and neither shed at a gate nor handshook. Derived: one branch of the listener counts nothing, so this is what remains after everything it does count.",
    ],
    [
      "door_unaccounted_post",
      "unaccounted, after handshake",
      afterHandshake,
      false,
      "Handshook and then neither refused nor admitted. Derived by subtraction; one such path is an unstaked peer at the vote port, which is by design.",
    ],
  ]);

  const names: Array<[key: string, label: string, count: number]> = [
    ["door_add_failed_unstaked", "unstaked table full", q.add_failed_unstaked],
    ["door_add_failed_staked", "staked table full", q.add_failed_staked],
    ["door_add_failed_banned", "peer banned", q.add_failed_banned],
    ["door_add_failed_insert", "table insert failed", q.add_failed],
  ];
  const detail = names
    .map(([key, label, count]) => ({
      key,
      label,
      count,
      share: shareOf(refused, count),
      warn: false,
      explain:
        "One of the names the listener refuses under, as a share of the refusals above. They overlap, so they are not added up.",
    }))
    .filter((reason) => reason.count > 0);

  return {
    key: "door",
    title: "Connections offered",
    note: "to this port",
    explain:
      "Connections, not transactions, each counted at the first gate that closed. The table refusal carries four overlapping names and two branches count nothing, which the unaccounted rows show.",
    total: q.offered,
    through: { label: "admitted", count: admitted },
    losses,
    detail,
    // The unaccounted rows are derived, not counters, so they come out of
    // this tally and the four refusal names go in.
    zeros: zeros - derivedAtZero + (REFUSAL_NAMES - detail.length),
    aside:
      kernelDrops === null
        ? null
        : {
            label: "kernel dropped",
            count: kernelDrops,
            unit: "datagrams",
            warn: false,
            explain:
              "Datagrams the kernel discarded on this port before the listener read them. Counted in datagrams, not connections, so it sits beside the bar rather than in it.",
          },
  };
}

/** What was opened on the connections that got in, and what became of it. */
export function streamSection(q: QuicPort): PathSection {
  const { losses, zeros } = sorted(q.streams, [
    [
      "stream_throttled_unstaked",
      "throttled, unstaked",
      q.throttled_unstaked,
      false,
      "Streams from unstaked peers held back at the lower limit they share.",
    ],
    [
      "stream_throttled_staked",
      "throttled, staked",
      q.throttled_staked,
      true,
      "Streams from staked peers held back because the peer was over the capacity its stake earns.",
    ],
    [
      "stream_read_timeout",
      "stopped arriving",
      q.read_timeouts,
      false,
      "Opened and left unfinished long enough to be abandoned.",
    ],
    [
      "stream_read_error",
      "read error",
      q.read_errors,
      false,
      "Failed while being read, rather than merely stalling.",
    ],
    [
      "stream_invalid_size",
      "impossible size",
      q.invalid_size,
      false,
      "Refused for declaring a length that could not be a transaction.",
    ],
  ]);
  const lost = losses.reduce((sum, loss) => sum + loss.count, 0);

  return {
    key: "streams",
    title: "Streams opened",
    note: "on admitted connections",
    explain:
      "What the admitted connections sent, and what the stream limits did with it. One stream carries one transaction.",
    total: q.streams,
    through: { label: "carried", count: Math.max(0, q.streams - lost) },
    losses,
    detail: [],
    zeros,
    aside: null,
  };
}

/** What came out of the listener towards verification, drawn against the
 *  three outcomes summed. */
export function listenerSection(q: QuicPort): PathSection {
  const read = q.handed_on + q.queue_full + q.disconnected;
  const { losses, zeros } = sorted(read, [
    [
      "handed_queue_full",
      "fetch queue full",
      q.queue_full,
      true,
      "Read and then dropped because the queue towards signature verification was full.",
    ],
    [
      "handed_disconnected",
      "queue closed",
      q.disconnected,
      true,
      "Dropped because the queue onward had been closed, which is a validator shutting down.",
    ],
  ]);

  return {
    key: "listener",
    title: "Transactions read",
    note: "out of those streams",
    explain:
      "Transactions assembled from streams, and what became of them. Not packets, so not comparable with the socket card.",
    total: read,
    through: { label: "passed to verify", count: q.handed_on },
    losses,
    detail: [],
    zeros,
    aside: null,
  };
}

/** One row out of a built list, for the two sections adapted from them. */
function pick(rows: WaterfallRow[], key: string): number {
  return rows.find((row) => row.key === key)?.count ?? 0;
}

/** Signature verification, built through `verifyRows`, which derives the
 *  unreported bad-signature count. */
export function verifySection(v: VerifyStage): PathSection {
  const rows = verifyRows(v);
  const { losses, zeros } = sorted(v.received, [
    [
      "verify_duplicate",
      "duplicate",
      pick(rows, "verify_duplicate"),
      false,
      "Seen before. The network resends transactions as a matter of course.",
    ],
    [
      "verify_bad",
      "bad signature",
      pick(rows, "verify_bad"),
      false,
      "Failed verification. Derived: received less duplicates, underpaying and verified.",
    ],
    [
      "verify_below_floor",
      "below priority floor",
      pick(rows, "verify_below_floor"),
      false,
      "Dropped for paying under the priority floor, where one is configured.",
    ],
  ]);

  return {
    key: "verify",
    title: "Verify",
    note: "signatures and duplicates",
    explain:
      "Signature verification and deduplication for everything but votes, counted over the epoch.",
    total: v.received,
    through: { label: "verified", count: v.verified },
    losses,
    detail: [],
    zeros,
    aside:
      v.evicted_batches > 0
        ? {
            label: "dropped",
            count: v.evicted_batches,
            unit: "batches, not transactions",
            warn: true,
            explain:
              "Batches dropped because the queue to the banking stage was full. A batch's transaction count is not reported, so this cannot be added to the counts here.",
          }
        : null,
  };
}

/** Reasons a transaction failed to load, which sit behind the row above them. */
const LOAD_REASONS: Array<[key: string, label: string]> = [
  ["exec_blockhash_missing", "blockhash not found"],
  ["exec_blockhash_old", "blockhash too old"],
  ["exec_already_processed", "already processed"],
  ["exec_fee_payer_broke", "fee payer could not pay"],
  ["exec_fee_payer_invalid", "fee payer not usable"],
  ["exec_account_missing", "account not found"],
  ["exec_too_many_locks", "too many account locks"],
  ["exec_bad_compute_budget", "compute budget"],
  ["exec_account_data_too_large", "account data too large"],
  ["exec_program_not_executable", "program not executable"],
  ["exec_program_restricted", "program restricted"],
  ["exec_other_reasons", "other reasons"],
];

/** The worker threads: what became of each transaction, with the load
 *  failure reasons nested under one row and out of the bar. */
export function executedSection(
  e: ExecutedStage,
  bundles: BundleStage | null,
): PathSection {
  const rows = executedRows(e);
  const attempted = pick(rows, "exec_attempted");
  const { losses, zeros } = sorted(attempted, [
    [
      "exec_failed",
      "failed, but still in the block",
      pick(rows, "exec_failed"),
      false,
      "Executed, failed, and committed anyway. A failed transaction still pays its fee and takes room in the block.",
    ],
    [
      "exec_dropped",
      "failed to load",
      pick(rows, "exec_dropped"),
      false,
      "Never executed because its accounts or blockhash could not be loaded. The reasons are behind the control below.",
    ],
    [
      "exec_cost_throttled",
      "no room in the block",
      pick(rows, "exec_cost_throttled"),
      true,
      "Held back by the cost model because the block had no room left.",
    ],
    [
      "exec_retryable",
      "sent back to retry",
      pick(rows, "exec_retryable"),
      false,
      "Handed back to be tried again, usually because its accounts were locked by another transaction in flight.",
    ],
    [
      "exec_expired_bank",
      "bank had gone",
      pick(rows, "exec_expired_bank"),
      false,
      "Handed back because the slot they were meant for had already been frozen.",
    ],
  ]);

  const failedToLoad = pick(rows, "exec_dropped");
  const detail = LOAD_REASONS.map(([key, label]) => ({
    key,
    label,
    count: pick(rows, key),
    share: shareOf(failedToLoad, pick(rows, key)),
    warn: false,
    explain:
      "One reason a transaction could not be loaded, as a share of those that failed to load.",
  })).filter((reason) => reason.count > 0);

  return {
    key: "executed",
    title: "Executed",
    note: "taken up by workers",
    explain:
      "The worker threads added together, counted over the epoch. Absent until the first leader slot of the epoch.",
    total: attempted,
    through: { label: "succeeded", count: pick(rows, "exec_succeeded") },
    losses,
    detail,
    zeros: zeros + (LOAD_REASONS.length - detail.length),
    // A note on the section's composition, not a stage of it: bundle
    // transactions are already inside the figures above.
    aside:
      bundles === null
        ? null
        : {
            label: `${count(bundles.received)} bundles arrived, carrying`,
            count: bundles.packets,
            unit: "transactions",
            warn: false,
            explain:
              "Bundles the block engine sent this epoch, with their transactions. They skip the sections above and are already counted in the figures beside this line, so this carries no percentage.",
          },
  };
}

/** The share of connection attempts let in. Null before anything was
 *  offered. */
/** Slots of an epoch that may go uncounted before the gap is worth saying:
 *  the totals start over a tick after the epoch turns. */
const EPOCH_START_SLACK = 32;

/** What the per-epoch sections are counted over, as a line of text, with a
 *  second clause where counting began after the epoch did. */
export function epochSpanLabel(span: EpochSpan): string {
  if (span.slots_in_epoch <= 0) return `Epoch ${span.epoch}`;
  const elapsed = percent(span.elapsed_slots / span.slots_in_epoch, 0);
  const missed = span.elapsed_slots - span.counted_slots;
  if (missed <= EPOCH_START_SLACK)
    return `Epoch ${span.epoch}, ${elapsed} elapsed`;
  const from = percent(missed / span.slots_in_epoch, 0);
  return `Epoch ${span.epoch}, ${elapsed} elapsed · counted from ${from}`;
}

export function admittedShare(q: QuicPort): number | null {
  if (q.offered <= 0) return null;
  return Math.min(1, (q.admitted_staked + q.admitted_unstaked) / q.offered);
}

/** The staked share of what was admitted, or null where nothing was. */
export function stakedShare(q: QuicPort): number | null {
  const admitted = q.admitted_staked + q.admitted_unstaked;
  if (admitted <= 0) return null;
  return q.admitted_staked / admitted;
}

/** The port a section is about, or null where the validator has no such port. */
export function portNamed(ports: QuicPort[], name: string): QuicPort | null {
  return ports.find((port) => port.name === name) ?? null;
}

/** The ports busiest first over the window, used where the TPU address is
 *  answered off this host. Ties keep the order sent. */
export function portsBusiestFirst(ports: QuicPort[]): QuicPort[] {
  return [...ports].sort((a, b) => b.offered - a.offered);
}

/** Which of the quieter ports the reader last left unfolded. */
export const TPU_PATH_STORAGE_KEY = "agave-dashboard-tpu-path-open";

export function readOpenPorts(): string[] {
  try {
    const stored = window.localStorage.getItem(TPU_PATH_STORAGE_KEY);
    return stored ? stored.split(",").filter(Boolean) : [];
  } catch {
    // Private browsing and some embedded webviews refuse storage outright.
    return [];
  }
}

export function writeOpenPorts(open: string[]): void {
  try {
    window.localStorage.setItem(TPU_PATH_STORAGE_KEY, open.join(","));
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}
