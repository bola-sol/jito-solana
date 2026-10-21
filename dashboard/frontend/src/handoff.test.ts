import { describe, expect, it } from "vitest";
import { axisMax, binOf, dotBottom, foldBins, isLate, leadingLine, place, stackLevels, windowLabel } from "./handoff";
import type { HandoffNow } from "./types";

function now(over: Partial<HandoffNow>): HandoffNow {
  return {
    leader: "L",
    slot: 1,
    gap: 80,
    n: 40,
    band: { p25: 60, p50: 70, p75: 90 },
    over: 6,
    late: false,
    gaps: [],
    minute_mean: 78,
    ...over,
  };
}

describe("axisMax", () => {
  it("keeps 300 ms for today's slots and widens past a slot for longer ones", () => {
    expect(axisMax(218)).toBe(300);
    expect(axisMax(null)).toBe(300);
    expect(axisMax(400)).toBe(460);
  });
});

describe("place", () => {
  it("clamps to the axis", () => {
    expect(place(-20, 300)).toBe(0);
    expect(place(150, 300)).toBe(50);
    expect(place(900, 300)).toBe(100);
  });
});

describe("foldBins", () => {
  it("keeps the bins on the axis and adds the rest into the last", () => {
    expect(foldBins([1, 2, 3, 4, 5], 10, 30)).toEqual([1, 2, 12]);
  });

  it("pads where the server sent fewer", () => {
    expect(foldBins([1], 10, 30)).toEqual([1, 0, 0]);
  });
});

describe("binOf", () => {
  it("clamps both ends", () => {
    expect(binOf(-5, 6, 50)).toBe(0);
    expect(binOf(71, 6, 50)).toBe(11);
    expect(binOf(999, 6, 50)).toBe(49);
  });
});

describe("stackLevels", () => {
  it("stacks dots that would touch and keeps apart ones that would not", () => {
    expect(stackLevels([100, 103, 105, 120, 101])).toEqual([0, 1, 2, 0, 3]);
    expect(dotBottom(2)).toBe(18);
  });
});

describe("isLate", () => {
  it("needs the leader's p25 above the cluster's p75", () => {
    const cluster = { p25: 55, p50: 71, p75: 91 };
    expect(isLate({ p25: 198, p50: 220, p75: 232 }, cluster)).toBe(true);
    expect(isLate({ p25: 91, p50: 120, p75: 140 }, cluster)).toBe(false);
    expect(isLate(null, cluster)).toBe(false);
  });
});

describe("leadingLine", () => {
  it("gives a settled leader's band and late count", () => {
    expect(leadingLine(now({ late: true, over: 25, n: 25, band: { p25: 198, p50: 220, p75: 232 } }))).toEqual({
      kind: "settled",
      usual: "usual 198–232 ms",
      late: "late 25 of 25",
      isLate: true,
    });
  });

  it("says when there are too few handoffs", () => {
    expect(leadingLine(now({ band: null, n: 1, gaps: [80] }))).toEqual({
      kind: "few",
      text: "1 handoff so far, too few to call usual",
    });
    expect(leadingLine(now({ band: null, n: 5 }))).toEqual({
      kind: "few",
      text: "5 handoffs so far, too few to call usual",
    });
  });

  it("is empty without a leader", () => {
    expect(leadingLine(null)).toEqual({ kind: "none" });
  });
});

describe("windowLabel", () => {
  it("names the slots once the window is full", () => {
    expect(windowLabel(true, 0, 0)).toBe("the last 432,000 slots");
  });

  it("gives the start time today, and its day before that", () => {
    const start = new Date(2026, 9, 21, 9, 40).getTime();
    expect(windowLabel(false, start, new Date(2026, 9, 21, 16, 0).getTime())).toBe("since 09:40");
    expect(windowLabel(false, start, new Date(2026, 9, 22, 8, 0).getTime())).toBe("since Wed 09:40");
  });
});
