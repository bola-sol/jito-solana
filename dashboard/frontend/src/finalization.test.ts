import { describe, expect, it } from "vitest";
import { bandHeights, bandOf, trendLines } from "./finalization";
import type { FinalizationMinute } from "./types";

const MINUTE = 60_000;

function minutes(values: (number | null)[]): FinalizationMinute[] {
  return values.map((ours, index) => ({ start_millis: index * MINUTE, ours, median: 0.99 }));
}

describe("bandHeights", () => {
  it("scales by square root against the tallest band", () => {
    expect(bandHeights([0, 25, 100])).toEqual([0, 0.5, 1]);
    expect(bandHeights([0, 0])).toEqual([0, 0]);
  });
});

describe("bandOf", () => {
  it("puts a share of 1 in the top band", () => {
    expect(bandOf(0, 10)).toBe(0);
    expect(bandOf(0.93, 10)).toBe(9);
    expect(bandOf(1, 10)).toBe(9);
    expect(bandOf(0.25, 10)).toBe(2);
  });
});

describe("trendLines", () => {
  it("places the newest minute at the right edge and a full share at the top", () => {
    const lines = trendLines(minutes(Array(60).fill(1)), (minute) => minute.ours, 300, 90);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("0,0")).toBe(true);
    expect(lines[0].endsWith("300,0")).toBe(true);
  });

  it("breaks the line where a minute has no value", () => {
    const lines = trendLines(minutes([0.2, null, 0.9, 0.9]), (minute) => minute.ours, 300, 90);
    expect(lines).toHaveLength(2);
    expect(lines[1].split(" ")).toHaveLength(2);
  });

  it("draws nothing without minutes", () => {
    expect(trendLines([], (minute) => minute.ours, 300, 90)).toEqual([]);
  });
});
