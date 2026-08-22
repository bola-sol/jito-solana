/**
 * Arranging the scheduler's counters into the rows the waterfall draws.
 *
 * Kept out of the component so it can be tested without a DOM, in the same way
 * as the turn folding and the bar scale.
 */

import type { ExecutedStage, QuicStage, VerifyStage, Waterfall } from "./types";

/**
 * A count as a share of the stage's total, capped at the whole of it.
 *
 * Capped rather than allowed past a hundred percent, and the overflow reported
 * rather than hidden. A stage fed from the queue can genuinely exceed the total
 * it is drawn against, most visibly over a single slot, and a bar longer than
 * its own track or a figure above a hundred percent reads as a bug rather than
 * as the queue draining.
 */
function against(total: number, count: number): { share: number; over: boolean } {
  if (total <= 0) return { share: 0, over: false };
  const share = count / total;
  return { share: Math.min(1, share), over: share > 1 };
}

/**
 * A row's share of its section, which a `count` row does not have.
 *
 * Zeroed at the source rather than hidden at the last moment by whatever draws
 * it. A count is in a different unit from the total, so `count / total` is a
 * number with no meaning, and leaving it in the row for the component to
 * remember to ignore is how it ends up drawn somewhere else later.
 */
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
  /**
   * A figure counted in a different unit from the rest, so it has no share of
   * them and is drawn without a bar. Showing one would invite a comparison the
   * numbers do not support.
   */
  | "count";

export interface WaterfallRow {
  key: string;
  label: string;
  kind: RowKind;
  count: number;
  /** Of everything received, in `[0, 1]`. The bar's length. */
  share: number;
  /**
   * Whether the count is larger than the total it is drawn against, which makes
   * `share` a cap rather than a measurement.
   *
   * This is ordinary rather than a fault, and routine over a single slot. The
   * scheduler's queue holds transactions across slots, so a slot can dispatch
   * more than arrived in it by taking the difference from what was already
   * waiting. There is no denominator that fixes it: the work simply did not all
   * arrive in the window being measured. The row shows its count and no
   * percentage, rather than one over a hundred that reads as a broken figure.
   */
  over: boolean;
  explain: string;
}

/**
 * The rows, in the order a transaction meets them.
 *
 * Always the same rows in the same order, including the ones reading nought.
 * Two reasons. A row that appeared only when it fired would change the card's
 * height under whoever was reading it, which this dashboard has been bitten by
 * more than once. And a zero is worth reading: it is the difference between
 * "no transaction failed its fee payer check" and "nothing here counts that".
 */
export function waterfallRows(w: Waterfall): WaterfallRow[] {
  // BAM is sent atomic batches rather than packets, and counts them, so on a
  // slot it built `received` is in a different unit from every row beneath it
  // and cannot be their denominator — a batch carries however many
  // transactions it carries. What parsed out of those batches can be, and is
  // the first figure in the same unit as the rest. It sits below the door
  // losses rather than above them, so those rows can run past it; they show
  // their count and no percentage when they do, which is the same treatment a
  // slot that dispatched more than arrived in it already gets.
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

    // Lost at the door. These and `buffered` account for every one of the
    // above exactly — it is an identity the validator's own tests assert.
    row(
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

/**
 * How much of what this validator kept actually got scheduled.
 *
 * The headline the card leads with, because the received count on its own says
 * more about the cluster than about this node — it is dominated by traffic the
 * validator was never going to execute. Against what it did hold, the figure
 * says whether it is keeping up.
 *
 * Null when it held nothing at all in the window, which is the normal state of
 * a validator that has not been leader recently rather than a failure to
 * schedule.
 */
export function scheduledShare(w: Waterfall): number | null {
  if (w.buffered <= 0) return null;
  // Capped: the two counts are different populations a window apart, so a
  // queue draining faster than it fills genuinely reports more scheduled than
  // buffered, and a figure above 100% reads as a bug rather than as a drain.
  return Math.min(1, w.scheduled / w.buffered);
}

/**
 * Building the rows for a stage, against a denominator of its own.
 *
 * Every section is drawn against what *it* was given rather than against a
 * figure from the section above. That is the whole reason these are four
 * sections and not one flow: what QUIC hands on is not what verify receives, and
 * a bar drawn against the wrong stage's total would be a quiet lie.
 */
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

/** What the QUIC listener on the TPU port did with what it pulled off the wire. */
export function quicRows(q: QuicStage): WaterfallRow[] {
  // QUIC keeps no count of what arrived, only of what it got rid of and how, so
  // the total offered is the sum of the outcomes rather than a figure of its own.
  const offered = q.handed_on + q.queue_full + q.disconnected;
  return rowsOf(offered, [
    [
      "quic_offered",
      "Read from streams",
      "stage",
      offered,
      "Transactions QUIC finished assembling out of its streams on the TPU port. Not a count of packets: QUIC reassembles a transaction from however many datagrams carried it, so this figure and the datagram counts on the socket panel for the same port measure different things and will not agree. QUIC keeps no total of its own, so this is the three outcomes below added together — everything it finished reading either went on or was thrown away.",
    ],
    [
      "quic_queue_full",
      "fetch queue full",
      "loss",
      q.queue_full,
      "Read successfully and then dropped, because the queue towards signature verification had no room. This is the row that means the validator could not keep up with what was being sent to it.",
    ],
    [
      "quic_disconnected",
      "queue closed",
      "loss",
      q.disconnected,
      "Dropped because the queue onward had been closed rather than merely full. In practice this is a validator shutting down, and a figure here at any other time is worth asking about.",
    ],
    [
      "quic_handed_on",
      "Passed to verify",
      "stage",
      q.handed_on,
      "Went on to signature verification. This is the section below's input, though not exactly its received count: the two are measured either side of the fetch stage's own buffering, so they should be close rather than equal.",
    ],
  ]);
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
