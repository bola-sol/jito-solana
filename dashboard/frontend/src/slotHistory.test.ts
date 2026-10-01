import { describe, expect, it } from "vitest";
import { leaderAt } from "./schedule";
import {
  entriesOf,
  HAS_BLOCK,
  HAS_CLOCK,
  HAS_REPLAY,
  HAS_REPLAYED,
  HAS_SHREDS,
  HAS_TIPS,
  REWARD_SHIFT,
  type SlotRange,
  type WireRow,
} from "./slotHistory";
import type { EpochInfo } from "./types";

const ALICE = "A1ice1111111111111111111111111111111111111";
const BOB = "B0b22222222222222222222222222222222222222222";

function epochOf(over: Partial<EpochInfo> = {}): EpochInfo {
  return {
    epoch: 842,
    start_slot: 1000,
    end_slot: 1015,
    slots_in_epoch: 16,
    my_leader_slots: [],
    leaders: [ALICE, BOB],
    // Four turns of four slots: Alice, Bob, Alice, Bob.
    turns: [0, 1, 0, 1],
    block_cost_limit: 60_000_000,
    account_cost_limit: 12_000_000,
    ...over,
  };
}

function row(over: Partial<Record<number, number>> = {}): WireRow {
  const base: WireRow = [
    3,
    HAS_BLOCK | HAS_CLOCK | HAS_TIPS | HAS_REPLAY | HAS_SHREDS | HAS_REPLAYED,
    66,
    8_752,
    11_877_602,
    44_100_000,
    12_480,
    7_400_000,
    1_000_000,
    47_200,
    1_203,
    63,
    341,
    393,
    0,
  ];
  return base.map((value, index) => over[index] ?? value) as WireRow;
}

describe("leaderAt", () => {
  it("finds the leader through one index rather than a search", () => {
    expect(leaderAt(epochOf(), 1000)).toBe(ALICE);
    expect(leaderAt(epochOf(), 1003)).toBe(ALICE);
    expect(leaderAt(epochOf(), 1004)).toBe(BOB);
    expect(leaderAt(epochOf(), 1015)).toBe(BOB);
  });

  it("names nobody outside the epoch the arrays describe", () => {
    expect(leaderAt(epochOf(), 999)).toBeNull();
    expect(leaderAt(epochOf(), 1016)).toBeNull();
  });

  it("names nobody where the validator could not derive the schedule", () => {
    expect(leaderAt(epochOf({ turns: [] }), 1000)).toBeNull();
    expect(leaderAt(undefined, 1000)).toBeNull();
  });
});

describe("entriesOf", () => {
  const range = (rows: (WireRow | null)[]): SlotRange => ({ first_slot: 1000, rows });

  it("reads the columns in the order the validator writes them", () => {
    // The wire order is positional and pinned here, so a reordering fails rather than moving fees
    // into compute.
    const [entry] = entriesOf(range([row()]), epochOf(), undefined);
    expect(entry.level).toBe("rooted");
    expect(entry.block?.non_vote_transactions).toBe(8_752);
    expect(entry.block?.transactions).toBe(66 + 8_752);
    expect(entry.block?.block_cost).toBe(11_877_602);
    expect(entry.block?.total_fees).toBe(44_100_000);
    expect(entry.block?.priority_fees).toBe(12_480);
    expect(entry.block?.tips).toBe(7_400_000);
    expect(entry.block?.replay_micros).toBe(47_200);
    expect(entry.shreds).toEqual({ count: 1_203, repaired: 63, full_millis: 341 });
    expect(entry.replayed_millis).toBe(393);
  });

  it("leaves the arrival and the replay end absent where neither was seen", () => {
    const [entry] = entriesOf(
      range([row({ 1: HAS_BLOCK | HAS_CLOCK, 10: 1_203, 13: 393 })]),
      epochOf(),
      undefined,
    );
    expect(entry.shreds).toBeNull();
    expect(entry.replayed_millis).toBeNull();
  });

  it("carries an arrival for a slot that filled and never froze", () => {
    const [entry] = entriesOf(range([row({ 1: HAS_CLOCK | HAS_SHREDS })]), epochOf(), undefined);
    expect(entry.block).toBeNull();
    expect(entry.shreds?.count).toBe(1_203);
  });

  it("leaves replay time absent for a block replay never timed", () => {
    const [entry] = entriesOf(
      range([row({ 1: HAS_BLOCK | HAS_CLOCK, 9: 47_200 })]),
      epochOf(),
      undefined,
    );
    expect(entry.block?.replay_micros).toBeNull();
  });

  it("keeps a tip figure that was never measured apart from one that was nought", () => {
    // A turn measured with no tips differs from one never measured, which must not draw as nought.
    const measured = entriesOf(range([row({ 7: 0 })]), epochOf(), undefined);
    expect(measured[0].block?.tips).toBe(0);

    const unmeasured = entriesOf(
      range([row({ 1: HAS_BLOCK | HAS_CLOCK, 7: 7_400_000 })]),
      epochOf(),
      undefined,
    );
    expect(unmeasured[0].block?.tips).toBeNull();
  });

  it("carries the two kinds of fee apart, so the split survives the trip back", () => {
    const [entry] = entriesOf(range([row()]), epochOf(), undefined);
    const base = (entry.block?.total_fees ?? 0) - (entry.block?.priority_fees ?? 0);
    expect(base).toBe(44_087_520);
  });

  it("takes the cost limits from the epoch rather than from the row", () => {
    const [entry] = entriesOf(range([row()]), epochOf(), undefined);
    expect(entry.block?.block_cost_limit).toBe(60_000_000);
  });

  it("works the duration out as the gap to the last slot that had a clock", () => {
    const entries = entriesOf(
      range([row({ 8: 1_000_000 }), row({ 8: 1_000_400 })]),
      epochOf(),
      undefined,
    );
    expect(entries[0].duration_nanos).toBeNull();
    expect(entries[1].duration_nanos).toBe(400_000_000);
    expect(entries[0].time_millis).toBe(1_000_000);
    expect(entries[1].time_millis).toBe(1_000_400);
  });

  it("carries the gap across a slot it has no row for", () => {
    const entries = entriesOf(
      range([row({ 8: 1_000_000 }), null, row({ 8: 1_000_800 })]),
      epochOf(),
      undefined,
    );
    expect(entries).toHaveLength(2);
    expect(entries[1].slot).toBe(1002);
    expect(entries[1].duration_nanos).toBe(800_000_000);
  });

  it("leaves a block out where none was recorded, rather than drawing an empty one", () => {
    const [entry] = entriesOf(range([row({ 1: HAS_CLOCK })]), epochOf(), undefined);
    expect(entry.block).toBeNull();
  });

  it("marks the slots we led", () => {
    const entries = entriesOf(range([row(), null, null, null, row()]), epochOf(), ALICE);
    expect(entries[0].mine).toBe(true);
    expect(entries[1].mine).toBe(false);
  });

  it("says nothing about who led, only whether we did", () => {
    const [entry] = entriesOf(range([row()]), epochOf(), ALICE);
    expect(entry.mine).toBe(true);
    expect("leader" in entry).toBe(false);
    expect("leader_name" in entry).toBe(false);
  });
});

describe("the left-out count", () => {
  it("comes with a paid or unpaid mark and not otherwise", () => {
    const leftOut = (bits: number) =>
      entriesOf({ first_slot: 1000, rows: [row({ 1: bits << REWARD_SHIFT, 14: 3 })] }, epochOf(), undefined)[0]
        .left_out;
    expect(leftOut(0)).toBeNull();
    expect(leftOut(1)).toBe(3);
    expect(leftOut(2)).toBe(3);
    expect(leftOut(3)).toBeNull();
  });
});

describe("reward flags", () => {
  it("reads the two bits as the four verdicts", () => {
    const rewardOf = (bits: number) =>
      entriesOf({ first_slot: 1000, rows: [row({ 1: bits << REWARD_SHIFT })] }, epochOf(), undefined)[0]
        .reward;
    expect(rewardOf(0)).toBeNull();
    expect(rewardOf(1)).toBe("paid");
    expect(rewardOf(2)).toBe("unpaid");
    expect(rewardOf(3)).toBe("no_certificate");
  });
});
