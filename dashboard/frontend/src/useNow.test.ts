import { describe, expect, it } from "vitest";
import { chartEdge, RENDER_LAG_MS, windowed } from "./useNow";

type Sample = { at: number };

const at = (millis: number): Sample => ({ at: millis * 1e6 });
const stamp = (sample: Sample) => sample.at;

describe("render lag", () => {
  const WIDTH = 600;
  const windowMs = 60_000;
  const at = (timestampMs: number, now: number) =>
    WIDTH * (1 - (now - RENDER_LAG_MS - timestampMs) / windowMs);

  it("keeps the newest sample past the right edge for a whole interval", () => {
    const arrived = 1_000_000;
    for (let elapsed = 0; elapsed < RENDER_LAG_MS; elapsed += 100) {
      expect(at(arrived, arrived + elapsed)).toBeGreaterThanOrEqual(WIDTH);
    }
  });

  it("has the sample reach the edge exactly as the next one is due", () => {
    const arrived = 1_000_000;
    expect(at(arrived, arrived + RENDER_LAG_MS)).toBeCloseTo(WIDTH, 6);
  });

  it("still slides at a constant rate", () => {
    const arrived = 1_000_000;
    const first = at(arrived, arrived + 500);
    const second = at(arrived, arrived + 600);
    expect(first - second).toBeCloseTo(1, 6);
  });
});

describe("chartEdge", () => {
  it("takes the clock offset off before the lag", () => {
    expect(chartEdge(1_000_000, 300)).toBe(1_000_000 - 300 - RENDER_LAG_MS);
    expect(chartEdge(1_000_000, -300)).toBe(1_000_000 + 300 - RENDER_LAG_MS);
  });

  it("assumes the clocks agree until the first reading", () => {
    expect(chartEdge(1_000_000, null)).toBe(1_000_000 - RENDER_LAG_MS);
  });
});

describe("windowed", () => {
  const now = 60_000;
  const windowMs = 10_000;

  it("keeps one sample older than the window", () => {
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
