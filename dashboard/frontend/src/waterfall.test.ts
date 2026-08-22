import { describe, expect, it } from "vitest";
import type { ExecutedStage, VerifyStage, Waterfall } from "./types";
import { executedRows, quicRows, scheduledShare, verifyRows, waterfallRows } from "./waterfall";

/** A window in which nothing happened, to be overridden a field at a time. */
function quiet(over: Partial<Waterfall> = {}): Waterfall {
  return {
    received: 0,
    not_held: 0,
    check_queue_full: 0,
    unparsable: 0,
    bad_locks: 0,
    compute_budget: 0,
    too_old: 0,
    already_processed: 0,
    fee_payer: 0,
    filtered: 0,
    nonce_conflict: 0,
    buffered: 0,
    queue_full: 0,
    nonce_evicted: 0,
    cleared: 0,
    cleaned: 0,
    scheduled: 0,
    blocked_conflicts: 0,
    blocked_threads: 0,
    finished: 0,
    retried: 0,
    ...over,
  };
}

/** A validator mid-leader-slot, with the receive stretch balancing exactly. */
function busy(): Waterfall {
  return quiet({
    received: 986,
    not_held: 800,
    unparsable: 20,
    bad_locks: 5,
    compute_budget: 5,
    too_old: 30,
    already_processed: 40,
    fee_payer: 6,
    filtered: 0,
    buffered: 80,
    queue_full: 12,
    cleared: 7,
    cleaned: 2,
    scheduled: 60,
    blocked_conflicts: 25,
    blocked_threads: 3,
    finished: 58,
    retried: 2,
  });
}

describe("waterfallRows", () => {
  it("accounts for every received transaction across the first stretch", () => {
    // The identity the validator's own tests assert, restated here because it
    // is what makes the top section an account rather than a list of numbers
    // that happen to sit under a heading. If a counter is ever added upstream
    // and not mapped, this is what notices.
    const w = busy();
    const rows = waterfallRows(w);
    const upToBuffered = rows.slice(
      rows.findIndex((row) => row.key === "not_held"),
      rows.findIndex((row) => row.key === "buffered") + 1,
    );
    const accounted = upToBuffered.reduce((sum, row) => sum + row.count, 0);
    expect(accounted).toBe(w.received);
  });

  it("measures every bar against what arrived, not against the stage above", () => {
    // So the lengths are comparable the whole way down. Renormalising each
    // section against its own heading would draw a loss of eighty out of eighty
    // as long as the received bar itself.
    const rows = waterfallRows(busy());
    const buffered = rows.find((row) => row.key === "buffered");
    expect(buffered?.share).toBeCloseTo(80 / 986, 10);
    const notHeld = rows.find((row) => row.key === "not_held");
    expect(notHeld?.share).toBeCloseTo(800 / 986, 10);
  });

  it("draws the same rows in the same order whatever happened", () => {
    // The card must not change height under someone reading it, and a zero is
    // itself worth reading — no fee payer failed is not the same as nothing
    // counts fee payer failures.
    const busyKeys = waterfallRows(busy()).map((row) => row.key);
    const quietKeys = waterfallRows(quiet()).map((row) => row.key);
    expect(quietKeys).toEqual(busyKeys);
    // Three fewer than a newer validator draws: the counters behind the check
    // queue and both halves of the nonce dedup do not exist on this one, and
    // nor does the behaviour they count.
    expect(busyKeys.length).toBe(18);
  });

  it("divides nothing by nothing when the window is empty", () => {
    for (const row of waterfallRows(quiet())) {
      expect(Number.isFinite(row.share)).toBe(true);
      expect(row.share).toBe(0);
    }
  });

  it("marks the three stages apart from their reasons", () => {
    const rows = waterfallRows(busy());
    const stages = rows.filter((row) => row.kind === "stage").map((row) => row.key);
    expect(stages).toEqual(["received", "buffered", "scheduled", "finished"]);
  });

  it("counts held-back work as a note rather than a loss", () => {
    // Nothing is lost when the scheduler cannot place a transaction this pass;
    // it waits. Counting it as loss would make a contended slot look like a
    // failing one.
    const rows = waterfallRows(busy());
    const blocked = rows.filter((row) => row.key.startsWith("blocked_"));
    expect(blocked.map((row) => row.kind)).toEqual(["note", "note"]);
    expect(rows.find((row) => row.key === "retried")?.kind).toBe("note");
  });
});

describe("scheduledShare", () => {
  it("measures against what the validator kept, not what reached it", () => {
    // Against received it would read 6%, which is a statement about how much of
    // the cluster's traffic this node was due to execute rather than about the
    // node. Against what it held it is 75%, which is about the node.
    expect(scheduledShare(busy())).toBeCloseTo(60 / 80, 10);
  });

  it("says nothing when the validator has held nothing", () => {
    // The ordinary state of a node that has not been leader recently, not a
    // failure to schedule.
    expect(scheduledShare(quiet())).toBeNull();
    expect(scheduledShare(quiet({ received: 5000, not_held: 5000 }))).toBeNull();
  });

  it("does not report more scheduled than held", () => {
    // The two counts are different populations a window apart, so a queue
    // draining faster than it fills genuinely reports it. Over 100% reads as a
    // bug in the page rather than as a queue draining.
    expect(scheduledShare(quiet({ buffered: 10, scheduled: 40 }))).toBe(1);
  });
});

/** Finds one row by key, so a test names what it is asserting on. */
function rowOf(rows: ReturnType<typeof waterfallRows>, key: string) {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe("verifyRows", () => {
  const stage = (over: Partial<VerifyStage> = {}): VerifyStage => ({
    received: 0,
    duplicate: 0,
    below_floor: 0,
    verified: 0,
    evicted_batches: 0,
    ...over,
  });

  it("derives bad signatures from what the other outcomes leave over", () => {
    // There is no counter for it. Sigverify stops at the first thing that
    // discards a packet, so each one is deduplicated, or below the floor, or
    // verified, or bad, and the remainder is exactly the bad ones.
    const rows = verifyRows(
      stage({ received: 1000, duplicate: 300, below_floor: 50, verified: 620 }),
    );
    expect(rowOf(rows, "verify_bad").count).toBe(30);
  });

  it("never reports a negative count when the parts do not line up", () => {
    // The four figures are swapped to zero as they are reported and the tap
    // accumulates whatever it is given, so a point arriving mid-reset can put
    // the parts above the total. A negative row would be nonsense on screen.
    const rows = verifyRows(stage({ received: 100, duplicate: 90, verified: 40 }));
    expect(rowOf(rows, "verify_bad").count).toBe(0);
  });

  it("keeps the batch figure out of the transaction arithmetic", () => {
    // It counts batches. Subtracting it from a packet count, or adding it in,
    // would be mixing two units.
    const rows = verifyRows(
      stage({ received: 100, duplicate: 0, verified: 100, evicted_batches: 7 }),
    );
    expect(rowOf(rows, "verify_bad").count).toBe(0);
    expect(rowOf(rows, "verify_evicted").count).toBe(7);
    expect(rowOf(rows, "verify_evicted").kind).toBe("note");
  });
});

describe("quicRows", () => {
  it("makes the total from the outcomes, having no count of its own", () => {
    const rows = quicRows({ handed_on: 900, queue_full: 80, disconnected: 20 });
    expect(rowOf(rows, "quic_offered").count).toBe(1000);
    expect(rowOf(rows, "quic_offered").share).toBe(1);
    expect(rowOf(rows, "quic_queue_full").share).toBeCloseTo(0.08, 10);
  });
});

describe("executedRows", () => {
  const stage = (over: Partial<ExecutedStage> = {}): ExecutedStage => ({
    attempted: 0,
    cost_throttled: 0,
    retryable: 0,
    expired_bank: 0,
    processed: 0,
    succeeded: 0,
    ...over,
  });

  it("derives the failures from committed less succeeded", () => {
    // A transaction that returns an error still lands in the block and still
    // pays, so this is a real row rather than a loss to be hidden.
    const rows = executedRows(stage({ attempted: 100, processed: 90, succeeded: 80 }));
    expect(rowOf(rows, "exec_failed").count).toBe(10);
  });

  it("does not go negative if succeeded outruns committed across a reset", () => {
    const rows = executedRows(stage({ attempted: 10, processed: 5, succeeded: 9 }));
    expect(rowOf(rows, "exec_failed").count).toBe(0);
  });
});

describe("each section is drawn against its own total", () => {
  it("does not measure one stage against another's denominator", () => {
    // The whole reason these are four sections. QUIC handing on nine hundred
    // and verify receiving a thousand is ordinary — they are measured either
    // side of the fetch stage's buffering — and the bars must not imply that
    // verify received more than everything.
    const quic = quicRows({ handed_on: 900, queue_full: 0, disconnected: 0 });
    const verify = verifyRows({
      received: 1000,
      duplicate: 0,
      below_floor: 0,
      verified: 1000,
      evicted_batches: 0,
    });
    expect(rowOf(quic, "quic_handed_on").share).toBe(1);
    expect(rowOf(verify, "verify_received").share).toBe(1);
  });
});

describe("a stage fed from the queue", () => {
  it("caps its bar and reports the overflow rather than exceeding the total", () => {
    // Routine over a single slot. The scheduler's queue holds transactions
    // across slots, so a slot can dispatch more than arrived in it by taking
    // the difference from what was already waiting. Twelve received and
    // thirteen scheduled is the case that was reported as a broken figure.
    const rows = waterfallRows(quiet({ received: 12, buffered: 12, scheduled: 13, finished: 13 }));

    const scheduled = rowOf(rows, "scheduled");
    expect(scheduled.count).toBe(13);
    expect(scheduled.share).toBe(1);
    expect(scheduled.over).toBe(true);
  });

  it("leaves a stage inside its total alone", () => {
    const rows = waterfallRows(quiet({ received: 100, buffered: 40 }));
    const buffered = rowOf(rows, "buffered");
    expect(buffered.share).toBeCloseTo(0.4, 10);
    expect(buffered.over).toBe(false);
  });

  it("reports nothing rather than dividing when the stage saw no traffic", () => {
    const rows = waterfallRows(quiet());
    expect(rowOf(rows, "received").share).toBe(0);
    expect(rowOf(rows, "received").over).toBe(false);
  });
});
