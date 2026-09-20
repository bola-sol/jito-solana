import { describe, expect, it } from "vitest";
import { leaderTurns, MAX_TURN_MARKS, missMarks, missTotal, turnMarks } from "./misses";

describe("leaderTurns", () => {
  it("starts a turn where the slots stop running on", () => {
    expect(leaderTurns([8, 9, 10, 11, 40, 41, 42, 43, 44])).toEqual([8, 40]);
    expect(leaderTurns([])).toEqual([]);
  });
});

describe("turnMarks", () => {
  it("places each turn along the epoch", () => {
    expect(turnMarks([100, 101, 102, 103, 300], 100, 400)).toEqual([0, 0.5]);
  });

  it("gives up once the turns would be a band", () => {
    const slots = Array.from({ length: (MAX_TURN_MARKS + 1) * 4 }, (_, index) => index * 2);
    expect(turnMarks(slots, 0, 10_000)).toBeNull();
  });
});

describe("missMarks", () => {
  it("weights each bin against the busiest", () => {
    expect(missMarks([0, 4, 0, 1])).toEqual([
      { at: 0.375, weight: 1 },
      { at: 0.875, weight: 0.25 },
    ]);
  });

  it("is empty with no misses", () => {
    expect(missMarks([0, 0])).toEqual([]);
    expect(missMarks([])).toEqual([]);
  });
});

describe("missTotal", () => {
  it("adds the four places", () => {
    expect(missTotal({ boundary: 148, leader: 40, snapshot: 12, elsewhere: 11 })).toBe(211);
  });
});
