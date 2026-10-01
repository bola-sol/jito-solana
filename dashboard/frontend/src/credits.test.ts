import { describe, expect, it } from "vitest";
import { creditsShare, participationShare, shareText } from "./credits";
import type { VoteParticipation } from "./types";

describe("creditsShare", () => {
  it("is our credits over the cluster's best", () => {
    expect(creditsShare(1_200, 1_600)).toBe(0.75);
  });

  it("is nothing before the cluster figure has arrived, or while it is nought", () => {
    expect(creditsShare(1_200, null)).toBeNull();
    expect(creditsShare(0, 0)).toBeNull();
  });

  it("is capped at one", () => {
    expect(creditsShare(1_700, 1_600)).toBe(1);
  });
});

describe("shareText", () => {
  it("rounds down, so only the best reads as all of it", () => {
    expect(shareText(1_937_033 / 1_937_113)).toBe("99.99%");
    expect(shareText(0.99996)).toBe("99.99%");
    expect(shareText(0.9999)).toBe("99.99%");
    expect(shareText(2 / 3)).toBe("66.66%");
    expect(shareText(1)).toBe("100.00%");
  });

  it("is a dash with no share", () => {
    expect(shareText(null)).toBe("—");
  });
});

describe("participationShare", () => {
  const participation: VoteParticipation = {
    epoch: 800,
    since_slot: 345_600_100,
    paid: 1_200,
    rewarded: 1_210,
    cluster_max: 1_208,
    misses: { boundary: 10, leader: 0, snapshot: 0, thin: 0, late: 0, lost: 0 },
    miss_bins: [],
    lost_leaders: [],
    ranks: 1_500,
    thin_below: 1_400,
  };

  it("is our paid slots over the most any validator has", () => {
    expect(participationShare(participation, 800)).toBeCloseTo(1_200 / 1_208);
  });

  it("is nothing before a certificate from this epoch has been read", () => {
    expect(participationShare(null, 800)).toBeNull();
    expect(participationShare(participation, 801)).toBeNull();
    expect(participationShare({ ...participation, paid: 0, rewarded: 0, cluster_max: 0 }, 800)).toBeNull();
  });
});
