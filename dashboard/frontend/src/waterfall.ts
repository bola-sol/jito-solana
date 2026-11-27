
import type { Waterfall } from "./types";

/** Capped at one: a stage fed from the queue can exceed its total; the overflow is reported
 *  separately. */
function against(total: number, count: number): { share: number; over: boolean } {
  if (total <= 0) return { share: 0, over: false };
  const share = count / total;
  return { share: Math.min(1, share), over: share > 1 };
}

function shareOf(
  kind: RowKind,
  total: number,
  count: number,
): { share: number; over: boolean } {
  return kind === "count" ? { share: 0, over: false } : against(total, count);
}

export type RowKind =
  | "stage"
  | "loss"
  | "note"
  | "count";

export interface WaterfallRow {
  key: string;
  label: string;
  kind: RowKind;
  count: number;
  share: number;
  /** The queue makes this routine over a single slot; the row then shows no percentage. */
  over: boolean;
  explain: string;
}

/** Always all of them: a nought is a reading, and the card must not change height. */
export function waterfallRows(w: Waterfall): WaterfallRow[] {
  // On a BAM slot `received` and the first loss row are in batches, so
  // `buffered` is the denominator and those two rows show no share.
  const batches = w.source === "bam";
  const total = batches ? w.buffered : w.received;

  // Drawn against what arrived so the bars compare down the card; guarded because it draws from the
  // first sample.
  const row = (
    key: string,
    label: string,
    kind: RowKind,
    count: number,
    explain: string,
  ): WaterfallRow => ({ key, label, kind, count, ...shareOf(kind, total, count), explain });

  return [
    batches
      ? row(
          "received",
          "Batches received",
          "count",
          w.received,
          "Atomic transaction batches BAM sent for this slot. Counted in batches, so not a total the rows below are shares of.",
        )
      : row(
          "received",
          "Received",
          "stage",
          w.received,
          "Transactions handed to the banking stage after signature verification.",
        ),

    // Lost at the door: these plus `buffered` equal `received` exactly. On a
    // BAM slot the counter holds batches sent past their slot instead.
    batches
      ? row(
          "not_held",
          "batches too late to schedule",
          "count",
          w.not_held,
          "Batches BAM sent that named a slot already passed, or held no packets. Counted in batches, so not a share of the rows below.",
        )
      : row(
          "not_held",
          "forwarding, not held",
          "loss",
          w.not_held,
          "Not this validator's to execute, so forwarded to the upcoming leader.",
        ),
    row(
      "check_queue_full",
      "check queue full",
      "loss",
      w.check_queue_full,
      "Arrived faster than the checks could run, and dropped.",
    ),
    row(
      "unparsable",
      "would not parse",
      "loss",
      w.unparsable,
      "Malformed, or failed sanitization.",
    ),
    row(
      "bad_locks",
      "bad account locks",
      "loss",
      w.bad_locks,
      "Asked to lock accounts it could not: too many, or the same one twice.",
    ),
    row(
      "compute_budget",
      "compute budget",
      "loss",
      w.compute_budget,
      "Its compute budget instructions did not add up.",
    ),
    row(
      "too_old",
      "blockhash too old",
      "loss",
      w.too_old,
      "Its blockhash had aged out, or its durable nonce did not hold.",
    ),
    row(
      "already_processed",
      "already processed",
      "loss",
      w.already_processed,
      "Already in the ledger, usually a sender's retry.",
    ),
    row(
      "fee_payer",
      "fee payer could not pay",
      "loss",
      w.fee_payer,
      "The account meant to pay the fee could not cover it.",
    ),
    row(
      "filtered",
      "filtered out",
      "loss",
      w.filtered,
      "Excluded by this validator's account key filter.",
    ),
    row(
      "nonce_conflict",
      "nonce conflict",
      "loss",
      w.nonce_conflict,
      "A durable nonce transaction for the same nonce account was already queued at the same or higher priority.",
    ),

    row(
      "buffered",
      "Buffered",
      "stage",
      w.buffered,
      "Passed every check and entered the queue. This plus the losses above is the received count.",
    ),

    row(
      "queue_full",
      "queue full",
      "loss",
      w.queue_full,
      "Pushed out of a full queue by something paying more.",
    ),
    row(
      "nonce_evicted",
      "outranked by a nonce",
      "loss",
      w.nonce_evicted,
      "Removed for a durable nonce transaction on the same account that outranked it.",
    ),
    row(
      "cleared",
      "cleared",
      "loss",
      w.cleared,
      "Thrown away when the queue was cleared at the end of a stretch of leader slots.",
    ),
    row(
      "cleaned",
      "cleaned",
      "loss",
      w.cleaned,
      "Thrown away as stale while sitting in the queue.",
    ),

    row(
      "scheduled",
      "Scheduled",
      "stage",
      w.scheduled,
      "Handed to a worker thread. Not buffered less the losses above, since the queue holds work across windows.",
    ),
    row(
      "blocked_conflicts",
      "held back: account conflicts",
      "note",
      w.blocked_conflicts,
      "Wanted accounts another transaction was writing, so it waited.",
    ),
    row(
      "blocked_threads",
      "held back: all workers busy",
      "note",
      w.blocked_threads,
      "Every worker thread was occupied.",
    ),

    row(
      "finished",
      "Finished",
      "stage",
      w.finished,
      "Came back from a worker completed, failed executions included.",
    ),
    row(
      "retried",
      "sent back to retry",
      "note",
      w.retried,
      "Came back from a worker to be retried, and went back into the queue.",
    ),
  ];
}
