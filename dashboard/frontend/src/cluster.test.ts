import { describe, expect, it } from "vitest";
import {
  bandPaths,
  binLabel,
  chartWindowStart,
  clusterVerdict,
  epochThrough,
  gridlines,
  linePath,
  niceTop,
  skipBaseline,
  ticks,
  txNote,
  type ClusterSignals,
} from "./cluster";

const calm: ClusterSignals = {
  stalledSeconds: null,
  slotRecent: 201,
  slotBaseline: 201,
  skipRecent: 0.2,
  skipBaseline: 0.37,
  skipBaselineLabel: "this epoch",
  notarizedRecent: 99.9,
  fastRecent: 99.1,
};

describe("clusterVerdict", () => {
  it("reads a calm cluster as running normally, with no evidence", () => {
    expect(clusterVerdict(calm)).toEqual({ tone: "good", headline: "The cluster is running normally.", evidence: "" });
  });

  it("names a stall first, whatever else holds", () => {
    const verdict = clusterVerdict({ ...calm, stalledSeconds: 14, slotRecent: 400, fastRecent: 10 });
    expect(verdict.tone).toBe("bad");
    expect(verdict.evidence).toBe("No slot finalized for 14 s.");
  });

  it("waits ten seconds before calling a stall", () => {
    expect(clusterVerdict({ ...calm, stalledSeconds: 9 }).tone).toBe("good");
  });

  it("flags slow slots at a quarter over the baseline", () => {
    expect(clusterVerdict({ ...calm, slotRecent: 250 }).tone).toBe("good");
    const verdict = clusterVerdict({ ...calm, slotRecent: 252 });
    expect(verdict.headline).toBe("Slots are running slow.");
    expect(verdict.evidence).toBe("252 ms in the last 10 minutes, 201 ms this epoch.");
  });

  it("needs skips both three times the baseline and at least two percent", () => {
    expect(clusterVerdict({ ...calm, skipRecent: 1.5, skipBaseline: 0.1 }).tone).toBe("good");
    expect(clusterVerdict({ ...calm, skipRecent: 4, skipBaseline: 2 }).tone).toBe("good");
    const verdict = clusterVerdict({ ...calm, skipRecent: 4.2 });
    expect(verdict.headline).toBe("Skips are up.");
    expect(verdict.evidence).toBe("4.2% skipped in the last 10 minutes, 0.37% this epoch.");
  });

  it("names the baseline it judged skips by", () => {
    const verdict = clusterVerdict({ ...calm, skipRecent: 12, skipBaseline: 0.8, skipBaselineLabel: "last epoch" });
    expect(verdict.evidence).toBe("12.0% skipped in the last 10 minutes, 0.80% last epoch.");
  });

  it("flags thin notarization and a slow fast path, notarization first", () => {
    expect(clusterVerdict({ ...calm, notarizedRecent: 93.4, fastRecent: 80 }).headline).toBe("Notarized stake is down.");
    expect(clusterVerdict({ ...calm, fastRecent: 86.2 }).evidence).toBe("86.2% fast in the last 10 minutes.");
  });

  it("leaves a rule out where its readings are missing", () => {
    const verdict = clusterVerdict({
      ...calm,
      slotRecent: null,
      skipRecent: null,
      notarizedRecent: null,
      fastRecent: null,
    });
    expect(verdict.tone).toBe("good");
  });
});

describe("skipBaseline", () => {
  it("judges a young epoch by the last one", () => {
    expect(skipBaseline(60, 500, 0.8, 0.02)).toEqual({ share: 0.8, label: "last epoch" });
  });

  it("judges by this epoch once a tenth has passed, or with nothing to go on", () => {
    expect(skipBaseline(37, 10_000, 0.8, 0.5)).toEqual({ share: 0.37, label: "this epoch" });
    expect(skipBaseline(5, 500, null, 0.02)).toEqual({ share: 1, label: "this epoch" });
    expect(skipBaseline(0, 0, null, 0)).toEqual({ share: null, label: "this epoch" });
  });
});

describe("txNote", () => {
  it("says what failed on All and each part's share of all on its own tab", () => {
    expect(txNote("all", 33.7)).toBe("34% failed");
    expect(txNote("succeeded", 33.7)).toBe("66% of all");
    expect(txNote("failed", 33.7)).toBe("34% of all");
    expect(txNote("failed", 4.25)).toBe("4.3% of all");
  });
});

describe("axes", () => {
  it("steps up to three round gridlines under the top", () => {
    expect(ticks(5_000)).toEqual([2_000, 4_000]);
    expect(ticks(100)).toEqual([50, 100]);
    expect(ticks(300)).toEqual([100, 200, 300]);
    expect(ticks(0)).toEqual([]);
  });

  it("rounds an axis up to the next round step", () => {
    expect(niceTop(31.4)).toBe(40);
    expect(niceTop(12)).toBe(15);
    expect(niceTop(4)).toBe(4);
    expect(niceTop(0.7)).toBe(0.8);
    expect(niceTop(0)).toBe(1);
    expect(ticks(niceTop(31.4))).toEqual([20, 40]);
  });

  it("names references, splits a raised floor, else steps", () => {
    expect(gridlines(50, 100, [60, 80])).toEqual([60, 80, 100]);
    expect(gridlines(90, 100)).toEqual([90, 95, 100]);
    expect(gridlines(0, 300)).toEqual([100, 200, 300]);
  });
});

describe("shapes", () => {
  const x = (index: number) => index * 10;
  const y = (value: number) => 100 - value;

  it("breaks a line at an empty bin", () => {
    expect(linePath([1, 2, null, 4], x, y)).toBe("M0.0,99.0L10.0,98.0M30.0,96.0");
  });

  it("draws a band per unbroken run of two or more bins", () => {
    const shapes = bandPaths([1, 1, null, 1, 1, 1], [3, 3, null, 3, null, 3], x, y);
    expect(shapes).toEqual(["M0.0,97.0L10.0,97.0L10.0,99.0L0.0,99.0Z"]);
  });
});

describe("binLabel", () => {
  it("names a bin in seconds, then minutes", () => {
    expect(binLabel(0, 3_480_000, 120)).toBe("29 s");
    expect(binLabel(0, 86_400_000, 120)).toBe("12 min");
  });
});

describe("the epoch line", () => {
  it("places a slot within its epoch, held to the bar", () => {
    expect(epochThrough(2_710_800, 2_700_000, 18_000)).toBeCloseTo(0.6);
    expect(epochThrough(2_699_000, 2_700_000, 18_000)).toBe(0);
    expect(epochThrough(2_720_000, 2_700_000, 18_000)).toBe(1);
  });

  it("starts the charts at the epoch's start when the node held it all", () => {
    expect(chartWindowStart(1_000, 1_000, 2_000, 0.6)).toBe(0);
  });

  it("starts the charts part way in after a restart", () => {
    expect(chartWindowStart(1_500, 1_000, 2_000, 0.6)).toBeCloseTo(0.3);
  });

  it("leaves the window out without a span to place it in", () => {
    expect(chartWindowStart(1_500, 2_000, 2_000, 0.6)).toBeNull();
  });
});
