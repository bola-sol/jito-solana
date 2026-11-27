import { describe, expect, it } from "vitest";
import { barParts, commissionText, earningsTotal, kept } from "./earnings";
import type { EpochEarnings } from "./types";

const EARNINGS: EpochEarnings = {
  epoch: 1079,
  voting: 18_939_572_339,
  voting_lost: 0,
  voting_max: 20_039_352_000,
  bonus: 20_750_296_343,
  bonus_lost: 286_000_000,
  bonus_max: 22_476_808_000,
  commission_bps: 400,
  unread: 0,
};

describe("kept", () => {
  it("takes the commission's share", () => {
    expect(kept(39_689_868_682, 400)).toBeCloseTo(1_587_594_747.28);
    expect(kept(1_000, 0)).toBe(0);
  });
});

describe("commissionText", () => {
  it("drops the decimals of a whole percent", () => {
    expect(commissionText(400)).toBe("4%");
    expect(commissionText(450)).toBe("4.5%");
    expect(commissionText(425)).toBe("4.25%");
    expect(commissionText(10_000)).toBe("100%");
  });
});

describe("barParts", () => {
  it("keeps earned and lost inside the bar", () => {
    expect(barParts(50, 10, 100)).toEqual({ earned: 0.5, lost: 0.1 });
    expect(barParts(90, 30, 100)).toEqual({ earned: 0.9, lost: expect.closeTo(0.1) });
    expect(barParts(120, 5, 100)).toEqual({ earned: 1, lost: 0 });
    expect(barParts(5, 5, 0)).toEqual({ earned: 0, lost: 0 });
  });
});

describe("earningsTotal", () => {
  it("reads kept, the commission and the gross", () => {
    expect(earningsTotal(EARNINGS)).toEqual({ kept: "1.588", rest: "SOL, 4% of 39.69" });
  });
});
