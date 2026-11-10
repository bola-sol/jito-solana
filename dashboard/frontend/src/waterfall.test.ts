import { describe, expect, it } from "vitest";
import type { Waterfall } from "./types";
import { waterfallRows } from "./waterfall";

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

function busy(): Waterfall {
  return quiet({
    received: 1000,
    not_held: 800,
    check_queue_full: 10,
    unparsable: 20,
    bad_locks: 5,
    compute_budget: 5,
    too_old: 30,
    already_processed: 40,
    fee_payer: 6,
    filtered: 0,
    nonce_conflict: 4,
    buffered: 80,
    queue_full: 12,
    nonce_evicted: 1,
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
    // The identity the validator's own tests assert; an unmapped upstream counter breaks it here.
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
    const rows = waterfallRows(busy());
    const buffered = rows.find((row) => row.key === "buffered");
    expect(buffered?.share).toBeCloseTo(0.08, 10);
    const notHeld = rows.find((row) => row.key === "not_held");
    expect(notHeld?.share).toBeCloseTo(0.8, 10);
  });

  it("draws the same rows in the same order whatever happened", () => {
    const busyKeys = waterfallRows(busy()).map((row) => row.key);
    const quietKeys = waterfallRows(quiet()).map((row) => row.key);
    expect(quietKeys).toEqual(busyKeys);
    expect(busyKeys.length).toBe(21);
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
    const rows = waterfallRows(busy());
    const blocked = rows.filter((row) => row.key.startsWith("blocked_"));
    expect(blocked.map((row) => row.kind)).toEqual(["note", "note"]);
    expect(rows.find((row) => row.key === "retried")?.kind).toBe("note");
  });
});

describe("a slot BAM built", () => {
  /** What BAM reports: batches in, transactions from there down. */
  function bamSlot(): Waterfall {
    return quiet({
      source: "bam",
      received: 40,
      not_held: 5,
      unparsable: 3,
      buffered: 700,
      scheduled: 738,
      finished: 735,
    });
  }

  it("does not draw the rows against a count of batches", () => {
    // BAM counts received batches, so rows are drawn against what parsed, or every one passes a
    // hundred percent.
    const rows = waterfallRows(bamSlot());
    const parsed = rows.find((r) => r.key === "unparsable")!;
    expect(parsed.share).toBeCloseTo(3 / 700, 5);

    const finished = rows.find((r) => r.key === "finished")!;
    expect(finished.over).toBe(true);
    expect(finished.share).toBe(1);
  });

  it("shows the batch count without a share of the transactions", () => {
    const received = waterfallRows(bamSlot()).find((r) => r.key === "received")!;
    expect(received.label).toBe("Batches received");
    expect(received.kind).toBe("count");
    expect(received.count).toBe(40);
    expect(received.share).toBe(0);
    expect(received.over).toBe(false);
  });

  it("does not call a late batch a forwarded transaction", () => {
    // On BAM `not_held` is batches that had already missed their slot, the figure worth acting on.
    const notHeld = waterfallRows(bamSlot()).find((r) => r.key === "not_held")!;
    expect(notHeld.label).toBe("batches too late to schedule");
    expect(notHeld.kind).toBe("count");
    expect(notHeld.count).toBe(5);
    expect(notHeld.share).toBe(0);
  });

  it("changes nothing at all for a validator not running BAM", () => {
    const numbers = { received: 1000, not_held: 5, buffered: 700, finished: 500 };
    const absent = waterfallRows(quiet(numbers));
    const named = waterfallRows(quiet({ ...numbers, source: "scheduler" }));
    expect(named).toEqual(absent);

    expect(absent.find((r) => r.key === "received")!.label).toBe("Received");
    expect(absent.find((r) => r.key === "not_held")!.label).toBe("forwarding, not held");
    expect(absent.every((r) => r.kind !== "count" || r.key === "verify_evicted")).toBe(true);
    expect(absent.find((r) => r.key === "buffered")!.share).toBeCloseTo(0.7, 5);
  });

  it("leaves a slot the validator built alone", () => {
    const rows = waterfallRows(
      quiet({ received: 1000, not_held: 5, buffered: 700, finished: 500 }),
    );
    const received = rows.find((r) => r.key === "received")!;
    expect(received.label).toBe("Received");
    expect(received.kind).toBe("stage");
    const notHeld = rows.find((r) => r.key === "not_held")!;
    expect(notHeld.label).toBe("forwarding, not held");
    expect(notHeld.kind).toBe("loss");
    expect(notHeld.share).toBeCloseTo(5 / 1000, 5);
    expect(rows.find((r) => r.key === "finished")!.share).toBeCloseTo(0.5, 5);
  });
});

function rowOf(rows: ReturnType<typeof waterfallRows>, key: string) {
  const row = rows.find((r) => r.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row;
}

describe("a stage fed from the queue", () => {
  it("caps its bar and reports the overflow rather than exceeding the total", () => {
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
