/** The scheduler's counters arranged into the rows the waterfall draws. */

import type { ExecutedStage, VerifyStage, Waterfall } from "./types";

/** A count as a share of the stage's total, capped at one. A stage fed from
 *  the queue can exceed its total; the overflow is reported separately. */
function against(total: number, count: number): { share: number; over: boolean } {
  if (total <= 0) return { share: 0, over: false };
  const share = count / total;
  return { share: Math.min(1, share), over: share > 1 };
}

/** A row's share of its section; nought for a `count` row, which is in
 *  another unit. */
function shareOf(
  kind: RowKind,
  total: number,
  count: number,
): { share: number; over: boolean } {
  return kind === "count" ? { share: 0, over: false } : against(total, count);
}

/** What a row is doing in the list, which is what decides how it is drawn. */
export type RowKind =
  /** A point every transaction passes through: received, buffered, scheduled. */
  | "stage"
  /** A transaction that got no further, and the reason. */
  | "loss"
  /** Neither: something that happened without anything being lost. */
  | "note"
  /** A figure in a different unit from the rest, drawn without a bar. */
  | "count";

export interface WaterfallRow {
  key: string;
  label: string;
  kind: RowKind;
  count: number;
  /** Of everything received, in `[0, 1]`. The bar's length. */
  share: number;
  /** Whether the count exceeds the total it is drawn against, which the queue
   *  makes routine over a single slot. The row then shows no percentage. */
  over: boolean;
  explain: string;
}

/** The rows in the order a transaction meets them, always all of them: a
 *  nought is a reading, and the card must not change height. */
export function waterfallRows(w: Waterfall): WaterfallRow[] {
  // On a BAM slot `received` and the first loss row are in batches, so
  // `buffered` is the denominator and those two rows show no share.
  const batches = w.source === "bam";
  const total = batches ? w.buffered : w.received;

  // Everything is drawn against what arrived, so the bars are comparable down
  // the whole card rather than each stage being renormalised against the one
  // above it. Guarded because the card is drawn from the first sample.
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
          "Atomic transaction batches BAM sent for this slot. Batches, not transactions: a batch holds as many as it holds, so this is not a total the rows below are shares of. Buffered is, and is the first figure here counted in transactions.",
        )
      : row(
          "received",
          "Received",
          "stage",
          w.received,
          "Transactions handed to the banking stage after signature verification. Everything below is what became of them.",
        ),

    // Lost at the door: these plus `buffered` equal `received` exactly. On a
    // BAM slot the counter holds batches sent past their slot instead.
    batches
      ? row(
          "not_held",
          "batches too late to schedule",
          "count",
          w.not_held,
          "Batches BAM sent that this validator could not use: they named a slot that had already passed by the time they arrived, or they came with no packets in them. Counted in batches, like the figure above it and unlike every row below it, so it is not a share of them. This is the number to watch on a BAM slot — it is work that was offered and missed.",
        )
      : row(
          "not_held",
          "forwarding, not held",
          "loss",
          w.not_held,
          "Not this validator's to execute. A node that is not near its leader slot forwards transactions to the one that is rather than buffering them, so on most validators most of the time this is nearly the whole of the traffic. It is the ordinary state of a healthy node, not a fault.",
        ),
    row(
      "check_queue_full",
      "check queue full",
      "loss",
      w.check_queue_full,
      "Arrived faster than the checks could be run. Unlike the row above this one is real loss under load: the transaction was this validator's to take and it was dropped for want of capacity.",
    ),
    row(
      "unparsable",
      "would not parse",
      "loss",
      w.unparsable,
      "Malformed, or failed sanitization. Nothing a validator can do about these and nothing to tune — they are what the network sends.",
    ),
    row(
      "bad_locks",
      "bad account locks",
      "loss",
      w.bad_locks,
      "Asked to lock accounts it could not have — too many, or the same one twice.",
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
      "Its blockhash had aged out, or its durable nonce did not hold. Usually a sender whose transaction sat somewhere too long before reaching here.",
    ),
    row(
      "already_processed",
      "already processed",
      "loss",
      w.already_processed,
      "Already in the ledger. Common and harmless: senders retry, and every retry after the first lands here.",
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
      "Excluded by this validator's own account key filter, if one is configured.",
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
      "Passed every check at the door and went into the queue to be scheduled. This plus the losses above is exactly the received count.",
    ),

    // Lost from the queue, having already been buffered.
    row(
      "queue_full",
      "queue full",
      "loss",
      w.queue_full,
      "Pushed out of a full queue by something paying more. The signal that this validator is being offered more work than it has room to hold.",
    ),
    row(
      "nonce_evicted",
      "outranked by a nonce",
      "loss",
      w.nonce_evicted,
      "Removed to make way for a durable nonce transaction on the same account that outranked it.",
    ),
    row(
      "cleared",
      "cleared",
      "loss",
      w.cleared,
      "Thrown away when the queue was cleared, which is what happens at the end of a stretch of leader slots to whatever did not make it into a block.",
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
      "Handed to a worker thread to execute. This is not buffered minus the losses above it: the queue holds a standing population, so what is scheduled in this window was largely buffered in an earlier one.",
    ),
    row(
      "blocked_conflicts",
      "held back: account conflicts",
      "note",
      w.blocked_conflicts,
      "Wanted accounts another transaction was already writing, so it waited rather than being lost. High figures mean contention — many transactions after the same accounts at once.",
    ),
    row(
      "blocked_threads",
      "held back: all workers busy",
      "note",
      w.blocked_threads,
      "Nothing wrong with the transaction; every worker thread was occupied. This is the scheduler saying it had work it could not place.",
    ),

    row(
      "finished",
      "Finished",
      "stage",
      w.finished,
      "Came back from a worker completed. Includes transactions that executed and failed — landing in a block having failed is still finishing.",
    ),
    row(
      "retried",
      "sent back to retry",
      "note",
      w.retried,
      "Came back from a worker to be tried again rather than completed, and went back into the queue.",
    ),
  ];
}

/** The rows for a stage, against the stage's own total rather than the one
 *  before it. */
function rowsOf(
  total: number,
  rows: Array<[key: string, label: string, kind: RowKind, count: number, explain: string]>,
): WaterfallRow[] {
  return rows.map(([key, label, kind, count, explain]) => ({
    key,
    label,
    kind,
    count,
    ...shareOf(kind, total, count),
    explain,
  }));
}

/** What signature verification and deduplication did with it. */
export function verifyRows(v: VerifyStage): WaterfallRow[] {
  // No counter exists for a failed signature. Sigverify discards at one step
  // and returns, so a packet is deduplicated, or dropped below the floor, or
  // verified, or bad — never two — and what is left over is exactly the bad.
  const bad = Math.max(0, v.received - v.duplicate - v.below_floor - v.verified);
  return rowsOf(v.received, [
    [
      "verify_received",
      "Received",
      "stage",
      v.received,
      "Transactions arriving at signature verification, votes excluded. Votes are verified separately and never reach the scheduler below, so they are left out here rather than inflating a total the rest of the card could not account for.",
    ],
    [
      "verify_duplicate",
      "duplicate",
      "loss",
      v.duplicate,
      "Seen already. Senders and forwarding validators both retry, so a substantial share here is ordinary rather than a fault.",
    ],
    [
      "verify_below_floor",
      "below priority floor",
      "loss",
      v.below_floor,
      "Dropped for offering too little, when a priority floor is configured. Nought on a validator that has not set one.",
    ],
    [
      "verify_bad",
      "bad signature",
      "loss",
      bad,
      "Failed signature verification. There is no counter for this: it is what is left of the received count once the duplicates, the underpaying and the verified are taken off. Sigverify stops at the first thing that discards a packet, so nothing is counted twice and the remainder is exact.",
    ],
    [
      "verify_verified",
      "Verified",
      "stage",
      v.verified,
      "Passed, and went on towards the scheduler.",
    ],
    [
      "verify_evicted",
      "batches dropped, queue full",
      "count",
      v.evicted_batches,
      "Counted in batches rather than transactions, which is why it sits apart from the figures above and is not subtracted from them. Verified work thrown away because the queue onward to the scheduler was full — real loss, in a unit that cannot be added to the rest.",
    ],
  ]);
}

/** What the worker threads did with what the scheduler gave them. */
export function executedRows(e: ExecutedStage): WaterfallRow[] {
  const failed = Math.max(0, e.processed - e.succeeded);

  // Taken up and neither committed nor handed back. Derived: no counter
  // holds it, and without it the section does not close.
  const dropped = Math.max(0, e.attempted - e.processed - e.retryable);
  const named =
    e.too_many_locks +
    e.account_missing +
    e.fee_payer_broke +
    e.fee_payer_invalid +
    e.blockhash_missing +
    e.blockhash_old +
    e.already_processed +
    e.bad_compute_budget +
    e.account_data_too_large +
    e.program_not_executable +
    e.program_restricted;
  // The rarer errors gathered into one row. Floored: the two counters are
  // reported separately.
  const otherReasons = Math.max(0, dropped - named);

  return rowsOf(e.attempted, [
    [
      "exec_attempted",
      "Attempted",
      "stage",
      e.attempted,
      "Transactions the worker threads took up. Summed across every worker: each reports separately, and the stage is all of them together.",
    ],
    [
      "exec_cost_throttled",
      "no room in the block",
      "loss",
      e.cost_throttled,
      "Held back by the cost model rather than executed, because the block had no capacity left for them. On a full block this is expected; it means the validator filled the space it had.",
    ],
    [
      "exec_retryable",
      "sent back to retry",
      "note",
      e.retryable,
      "Returned to be tried again rather than committed. Not lost — it goes back to the queue.",
    ],
    [
      "exec_expired_bank",
      "bank had gone",
      "note",
      e.expired_bank,
      "Returned because the slot they were meant for had ended. Ordinary at the end of a stretch of leader slots.",
    ],
    [
      "exec_dropped",
      "Failed to load",
      "stage",
      dropped,
      "Taken up by a worker and neither committed nor handed back: the transaction could not be loaded, so it was discarded. The rows under this one are why. Derived as attempted minus committed minus retried, because the outcomes and the reasons are counted in two separate places and nothing reports the difference.",
    ],
    [
      "exec_blockhash_missing",
      "blockhash not found",
      "loss",
      e.blockhash_missing,
      "The blockhash was not one this validator recognises, which usually means it had already aged out by the time the transaction reached a worker.",
    ],
    [
      "exec_blockhash_old",
      "blockhash too old",
      "loss",
      e.blockhash_old,
      "Older than the processing age the bank allows.",
    ],
    [
      "exec_already_processed",
      "already processed",
      "loss",
      e.already_processed,
      "This exact transaction is already in the ledger. Unlike the duplicate row in the verify section, which is a copy caught before any work was done, this one got as far as a worker.",
    ],
    [
      "exec_fee_payer_broke",
      "fee payer could not pay",
      "loss",
      e.fee_payer_broke,
      "The fee payer did not hold enough to cover the fee. The same check as the scheduler's row of this name, run again against the bank the worker is building on.",
    ],
    [
      "exec_fee_payer_invalid",
      "fee payer not usable",
      "loss",
      e.fee_payer_invalid,
      "The fee payer account cannot pay fees at all — the wrong kind of account rather than one short of funds.",
    ],
    [
      "exec_account_missing",
      "account not found",
      "loss",
      e.account_missing,
      "An account the transaction names does not exist. Often a program or token account the sender assumed was there.",
    ],
    [
      "exec_too_many_locks",
      "too many account locks",
      "loss",
      e.too_many_locks,
      "The transaction asked to lock more accounts than a single transaction is allowed. Unlike the other lock failure it is not retried, because trying again would fail the same way.",
    ],
    [
      "exec_bad_compute_budget",
      "compute budget",
      "loss",
      e.bad_compute_budget,
      "The compute budget instructions could not be read, or asked for something outside the limits.",
    ],
    [
      "exec_account_data_too_large",
      "account data too large",
      "loss",
      e.account_data_too_large,
      "Loading the accounts would have exceeded the size limit the transaction set for itself.",
    ],
    [
      "exec_program_not_executable",
      "program not executable",
      "loss",
      e.program_not_executable,
      "A program the transaction called is not a program, or is not deployed in a state that can run.",
    ],
    [
      "exec_program_restricted",
      "program restricted",
      "loss",
      e.program_restricted,
      "The program was redeployed in this slot, so it cannot run until the next one. Ordinary right after a deploy.",
    ],
    [
      "exec_other_reasons",
      "other reasons",
      "loss",
      otherReasons,
      "Everything else that stopped a transaction loading, gathered into one row: the rarer errors — a duplicate account, a call chain too deep, an invalid index or writable account, a rent-paying account left below the threshold, cluster maintenance. Derived, as the rows above it subtracted from the loss, so nothing in that loss goes unshown.",
    ],
    [
      "exec_processed",
      "Committed",
      "stage",
      e.processed,
      "Executed and written into a block.",
    ],
    [
      "exec_failed",
      "failed, but still in the block",
      "loss",
      failed,
      "Executed, returned an error, and landed in the block anyway — which is how Solana works, and the sender still pays the fee. Derived as committed minus succeeded.",
    ],
    [
      "exec_succeeded",
      "Succeeded",
      "stage",
      e.succeeded,
      "Executed and returned success.",
    ],
  ]);
}
