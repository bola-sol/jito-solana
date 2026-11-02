import { describe, expect, it } from "vitest";
import { clampEntry, describeOnly, jumpStart, meets, parseJump, readOnly, typedTime } from "./scheduleFilters";
import type { EpochInfo, SlotEntry } from "./types";

function entry(fill: Partial<SlotEntry> = {}): SlotEntry {
  return {
    slot: 400,
    level: "finalized",
    mine: false,
    block: {
      transactions: 900,
      non_vote_transactions: 500,
      failed_transactions: 0,
      entries: 0,
      block_cost: 0,
      block_cost_limit: 0,
      account_cost_limit: 0,
      total_fees: 0,
      priority_fees: 0,
      tips: 10,
      replay_micros: null,
    },
    duration_nanos: 200_000_000,
    time_millis: null,
    shreds: null,
    replayed_millis: null,
    reward: "paid",
    left_out: 0,
    ...fill,
  };
}

const NOW = new Date(2026, 10, 2, 9, 30).getTime();

describe("meets", () => {
  it("reads each condition from the slot's own figures", () => {
    const block = entry().block;
    if (!block) throw new Error("a block");
    expect(meets(400, entry({ level: "skipped", block: null }), ["skipped"], null)).toBe(true);
    expect(meets(400, entry({ reward: "unpaid" }), ["left_out"], null)).toBe(true);
    expect(meets(400, entry({ reward: "no_certificate" }), ["left_out"], null)).toBe(false);
    expect(meets(400, entry({ block: { ...block, non_vote_transactions: 99 } }), ["few_transactions"], null)).toBe(true);
    expect(meets(400, entry({ block: { ...block, tips: 0 } }), ["no_tips"], null)).toBe(true);
    expect(meets(400, entry({ block: { ...block, tips: null } }), ["no_tips"], null)).toBe(false);
    expect(meets(400, undefined, ["skipped"], null)).toBe(false);
  });

  it("holds a slow slot against the cut-off for its place in the turn", () => {
    const slow = [374, 250, 256, 251];
    expect(meets(400, entry({ duration_nanos: 300_000_000 }), ["slow"], slow)).toBe(false);
    expect(meets(401, entry({ duration_nanos: 300_000_000 }), ["slow"], slow)).toBe(true);
    expect(meets(401, entry({ duration_nanos: null }), ["slow"], slow)).toBe(false);
    expect(meets(401, entry({ duration_nanos: 300_000_000 }), ["slow"], null)).toBe(false);
  });

  it("asks every condition of the one slot", () => {
    expect(meets(400, entry({ reward: "unpaid" }), ["left_out", "skipped"], null)).toBe(false);
  });
});

describe("describeOnly", () => {
  it("states the slow cut-offs once known", () => {
    expect(describeOnly(["slow"], [374, 250, 256, 251])).toBe(
      "The slowest 5% for their place in the turn: over 374 ms for a first slot, 250–256 ms for the rest.",
    );
    expect(describeOnly(["slow"], null)).toBe("Slots in the slowest 5% for their place in the turn.");
    expect(describeOnly(["slow", "few_transactions"], [300, 200, 200, 200])).toBe(
      "Slots that are all of slow, few txs. Slow: over 300 ms for a first slot, 200 ms for the rest.",
    );
  });
});

describe("readOnly", () => {
  it("keeps known conditions in their own order", () => {
    expect(readOnly("no_tips,bogus,skipped")).toEqual(["skipped", "no_tips"]);
    expect(readOnly(null)).toEqual([]);
  });
});

describe("parseJump", () => {
  it("reads slots and epochs", () => {
    expect(parseJump("464,357,631", NOW)).toEqual({ kind: "slot", slot: 464_357_631 });
    expect(parseJump(" Epoch 1071 ", NOW)).toEqual({ kind: "epoch", epoch: 1071 });
  });

  it("takes a bare time as the latest one not after now", () => {
    expect(parseJump("08:16", NOW)).toEqual({ kind: "time", millis: new Date(2026, 10, 2, 8, 16).getTime() });
    expect(parseJump("23:00:05", NOW)).toEqual({ kind: "time", millis: new Date(2026, 10, 1, 23, 0, 5).getTime() });
  });

  it("reads dates with or without a year", () => {
    const at = new Date(2026, 10, 1, 8, 0).getTime();
    expect(parseJump("Nov 1 08:00", NOW)).toEqual({ kind: "time", millis: at });
    expect(parseJump("1 november 08:00", NOW)).toEqual({ kind: "time", millis: at });
    expect(parseJump("2026-11-01 08:00", NOW)).toEqual({ kind: "time", millis: at });
    expect(parseJump("Dec 25 08:00", NOW)).toEqual({ kind: "time", millis: new Date(2025, 11, 25, 8, 0).getTime() });
  });

  it("refuses what it cannot place", () => {
    expect(parseJump("", NOW)).toBeNull();
    expect(parseJump("08:1", NOW)).toBeNull();
    expect(parseJump("25:00", NOW)).toBeNull();
    expect(parseJump("Feb 30 08:00", NOW)).toBeNull();
    expect(parseJump("Helius", NOW)).toBeNull();
  });
});

describe("jumpStart", () => {
  const epoch = { epoch: 10, start_slot: 4_320, slots_in_epoch: 432 } as EpochInfo;

  it("lists a slot's turn first", () => {
    expect(jumpStart({ kind: "slot", slot: 4_401 }, epoch, 4_600)).toEqual({ before: 4_404, until: null });
    expect(jumpStart({ kind: "slot", slot: 9_999 }, epoch, 4_600)).toEqual({ before: 4_600, until: null });
  });

  it("starts an epoch at its last slot", () => {
    expect(jumpStart({ kind: "epoch", epoch: 9 }, epoch, 4_600)).toEqual({ before: 4_320, until: null });
    expect(jumpStart({ kind: "epoch", epoch: 10 }, epoch, 4_600)).toEqual({ before: 4_600, until: null });
    expect(jumpStart({ kind: "epoch", epoch: 9 }, undefined, 4_600)).toEqual({ before: 4_600, until: null });
  });

  it("leaves a time to the validator, which knows when each turn began", () => {
    expect(jumpStart({ kind: "time", millis: 5 }, epoch, 4_600)).toEqual({ before: 4_600, until: 5 });
  });
});

describe("clampEntry", () => {
  const held = { slot: 1_000, millis: new Date(2026, 10, 1, 10, 10).getTime() };
  const now = new Date(2026, 10, 2, 12, 0).getTime();

  it("moves an entry older than held to the oldest held slot", () => {
    expect(clampEntry("500", held, 2_000, undefined, now)).toEqual({ text: "1,000", moved: "older" });
    expect(clampEntry("Oct 30 09:00", held, 2_000, undefined, now)).toEqual({ text: "1,000", moved: "older" });
  });

  it("empties an entry newer than held, which is live", () => {
    expect(clampEntry("3,000", held, 2_000, undefined, now)).toEqual({ text: "", moved: "newer" });
    expect(clampEntry("13:00", held, 2_000, undefined, new Date(2026, 10, 2, 12, 0).getTime()).moved).toBe(null);
  });

  it("leaves what is held, and what it cannot read, as typed", () => {
    expect(clampEntry("1,500", held, 2_000, undefined, now)).toEqual({ text: "1,500", moved: null });
    expect(clampEntry("Helius", held, 2_000, undefined, now)).toEqual({ text: "Helius", moved: null });
    expect(clampEntry("500", null, null, undefined, now)).toEqual({ text: "500", moved: null });
  });
});

describe("typedTime", () => {
  it("writes a time back as the box reads it", () => {
    const at = new Date(2026, 10, 2, 8, 5).getTime();
    expect(typedTime(at)).toBe("Nov 2 08:05");
    expect(typedTime(at + 7_000)).toBe("Nov 2 08:05:07");
    expect(parseJump(typedTime(at), at + 1)).toEqual({ kind: "time", millis: at });
  });
});
