import { describe, expect, it } from "vitest";
import {
  leaderLabel,
  leaderTurns,
  lostNote,
  MAX_TURN_MARKS,
  missMarks,
  missTotal,
  leftOutMost,
  leftOutText,
  placeExplain,
  turnMarks,
  voteText,
  writerSummary,
} from "./misses";
import type { MissList, VoteParticipation } from "./types";

function list(
  rows: [writer: number | null, others: number[]][],
  writers: [name: string, misses: number, certificates: number][],
  validators: string[] = [],
): MissList {
  return {
    epoch: 124,
    since_slot: 6_696_000,
    rewarded: 5_774,
    ranks: 112,
    writers: writers.map(([name, misses, certificates]) => ({
      identity: `${name}Key111111111111111`,
      name,
      client: "Agave",
      version: "4.3.0",
      ip: null,
      certificates,
      misses,
    })),
    validators: validators.map((name) => ({ identity: `${name}Key111111111111111`, name, ip: null })),
    rows: rows.map(([writer, others], index) => ({
      slot: 6_700_000 + index,
      time_millis: null,
      place: "lost",
      paid_ranks: 111,
      others,
      writer,
      vote: null,
    })),
  };
}

describe("leftOutMost", () => {
  it("names the validators most often left out beside us, most first", () => {
    const summary = leftOutMost(
      list([[0, [1]], [0, [0, 1]], [0, [1, 2]], [0, []]], [["CaraSol", 4, 63]], ["Bitwise", "Hamsa", "Pigs"]),
    );
    expect(summary).toBe("Left out beside us most: Hamsa in 3, Bitwise in 1, Pigs in 1.");
  });

  it("says nothing where every certificate left out only us", () => {
    expect(leftOutMost(list([[0, []], [0, []]], [["CaraSol", 2, 63]]))).toBeNull();
  });
});

describe("voteText", () => {
  it("names the vote and its delay after the first shred", () => {
    expect(voteText({ notarize_us: 412_400, skip_us: null, from_first_shred: true })).toBe("notarize +412 ms");
    expect(voteText({ notarize_us: null, skip_us: 1_850_000, from_first_shred: true })).toBe("skip +1,850 ms");
  });

  it("says none where votor sent neither, and nothing where it has not reported", () => {
    expect(voteText({ notarize_us: null, skip_us: null, from_first_shred: false })).toBe("none");
    expect(voteText(null)).toBe("—");
  });
});

describe("leftOutText", () => {
  it("says only us, else how many others", () => {
    expect(leftOutText(0)).toBe("only us");
    expect(leftOutText(9)).toBe("9 others");
  });
});

describe("writerSummary", () => {
  it("names the writer behind at least half the misses", () => {
    const summary = writerSummary(
      list([[0, []], [0, []], [0, []], [1, [0, 1, 2, 3]]], [["CaraSol", 3, 63], ["Hamsa", 1, 58]], ["A", "B", "C", "D"]),
    );
    expect(summary).toBe(
      "CaraSol wrote 3 of the 4 certificates that left this validator out, 3 of the 63 it wrote. Every one of them paid everybody else.",
    );
  });

  it("counts how many of them paid everybody else", () => {
    const summary = writerSummary(list([[0, []], [0, [0, 1]], [0, []]], [["CaraSol", 3, 63]], ["A", "B", "C"]));
    expect(summary).toMatch(/ 2 of them paid everybody else\.$/);
    expect(writerSummary(list([[0, [0, 1, 2]], [0, [0, 1]]], [["CaraSol", 2, 63]], ["A", "B", "C"]))).toMatch(
      /it wrote\.$/,
    );
  });

  it("says nothing where no writer holds half, or there is nothing to say", () => {
    expect(writerSummary(list([[0, []], [1, []], [2, []]], [["A", 1, 9], ["B", 1, 9], ["C", 1, 9]]))).toBeNull();
    expect(writerSummary(list([], []))).toBeNull();
  });
});

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
