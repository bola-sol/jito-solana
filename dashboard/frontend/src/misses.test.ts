import { describe, expect, it } from "vitest";
import {
  leaderLabel,
  leaderTurns,
  lostNote,
  MAX_TURN_MARKS,
  missMarks,
  missTotal,
  placeExplain,
  turnMarks,
} from "./misses";
import type { VoteParticipation } from "./types";

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
  it("adds the places", () => {
    expect(missTotal({ boundary: 148, leader: 40, snapshot: 12, thin: 5, late: 4, lost: 2 })).toBe(211);
  });
});

function participation(lost: number, counts: number[]): VoteParticipation {
  return {
    epoch: 110,
    since_slot: 5_940_000,
    paid: 23_582,
    rewarded: 23_693,
    cluster_max: 23_690,
    misses: { boundary: 0, leader: 0, snapshot: 0, thin: 0, late: 0, lost },
    miss_bins: [],
    lost_leaders: counts.map((count, index) => ({ identity: `Key${index}`, name: null, count })),
    ranks: 114,
    thin_below: 108,
  };
}

describe("placeExplain", () => {
  it("puts the cutoff on the thin place", () => {
    expect(placeExplain("thin", participation(0, []))).toBe(
      "The certificate paid at least a tenth fewer validators than this epoch's typical certificate, now under 108 of 114.",
    );
    expect(placeExplain("thin", { ...participation(0, []), thin_below: null })).toBe(
      "The certificate paid at least a tenth fewer validators than this epoch's typical certificate.",
    );
  });

  it("gives each place a sentence", () => {
    expect(placeExplain("boundary", participation(0, []))).toBe("The slot is in the first 1,000 slots of the epoch.");
    expect(placeExplain("lost", participation(0, []))).toMatch(/^No other cause applies/);
  });
});

describe("lostNote", () => {
  it("names the leaders once they hold half the lost votes", () => {
    expect(lostNote(participation(38, [15, 9, 5]))?.text).toBe("29 lost by same 3 leaders");
    expect(lostNote(participation(6, [6]))?.text).toBe("6 lost by one leader");
  });

  it("stays quiet when the lost votes are spread, or few", () => {
    expect(lostNote(participation(38, [6, 5, 4]))).toBeNull();
    expect(lostNote(participation(4, [4]))).toBeNull();
    expect(lostNote(participation(10, []))).toBeNull();
  });
});

describe("leaderLabel", () => {
  it("prefers the name and falls back to the shortened key", () => {
    expect(leaderLabel({ identity: "GdnSyH3YtwcxFvQrVVJMm1JhTS4QVX7MFsX56uJLUfiZ", name: "Alpha", count: 1 })).toBe("Alpha");
    expect(leaderLabel({ identity: "GdnSyH3YtwcxFvQrVVJMm1JhTS4QVX7MFsX56uJLUfiZ", name: null, count: 1 })).toBe(
      "GdnSyH…LUfiZ",
    );
  });
});
