import { describe, expect, it } from "vitest";
import { windowed } from "./useNow";

type Sample = { at: number };

const at = (millis: number): Sample => ({ at: millis * 1e6 });
const stamp = (sample: Sample) => sample.at;

describe("windowed", () => {
  const now = 60_000;
  const windowMs = 10_000;

  it("keeps one sample older than the window", () => {
    // That extra point is what lets the line leave the chart by sliding under
    // the viewBox edge. Filtering strictly to the window made the leftmost
    // segment vanish the moment its older end expired.
    const samples = [at(30_000), at(45_000), at(52_000), at(58_000)];
    expect(windowed(samples, now, windowMs, stamp)).toEqual([
      at(45_000),
      at(52_000),
      at(58_000),
    ]);
  });

  it("keeps everything when nothing has expired yet", () => {
    const samples = [at(55_000), at(58_000)];
    expect(windowed(samples, now, windowMs, stamp)).toEqual(samples);
  });

  it("returns nothing when every sample is older than the window", () => {
    // Not the last sample: a stale series should empty the chart rather than
    // draw a flat line from a reading minutes old.
    expect(windowed([at(10_000), at(20_000)], now, windowMs, stamp)).toEqual([]);
  });

  it("returns nothing for an empty series", () => {
    expect(windowed([], now, windowMs, stamp)).toEqual([]);
  });
});
