import { describe, expect, it } from "vitest";
import {
  ceilingFor,
  columnRows,
  geometry,
  MATRIX_WINDOW_SECONDS,
  columnsFor,
  meanSample,
  MIN_PITCH,
  readoutMean,
  ROWS_TALL,
  sampleSecond,
  slotsFor,
} from "./matrix";
import type { TpsSample } from "./types";

/** Numbered samples: the number is the second, and the merge keeps the newest. */
const second = (sample: number) => sample;
const newest = (bucket: number[]) => bucket[bucket.length - 1];

/** A mainnet-shaped second: vote, then failed, then succeeded on top. */
const MAINNET = [1654.28, 412, 1087.44];
const CEILING = ceilingFor(3684);

describe("columnRows", () => {
  it("stacks the series bottom up and fills the column to the total", () => {
    const lit = columnRows(MAINNET, CEILING, ROWS_TALL);
    expect(lit).toEqual([5, 1, 3]);
    // Nine of eleven rows lit, against a total that is 78% of the ceiling.
    expect(lit.reduce((sum, rows) => sum + rows, 0)).toBe(9);
  });

  it("never lights more rows than the grid has", () => {
    const lit = columnRows([5000, 5000, 5000], CEILING, ROWS_TALL);
    expect(lit.reduce((sum, rows) => sum + rows, 0)).toBeLessThanOrEqual(ROWS_TALL);
  });

  it("gives a series too small to round to a row one anyway", () => {
    // On this ceiling a row is worth about 368 tps, so 40 failed rounds to
    // nothing. An unlit band reads as no failures rather than few.
    const lit = columnRows([1654.28, 40, 1087.44], CEILING, ROWS_TALL);
    expect(lit[1]).toBe(1);
  });

  it("leaves a series at nought unlit", () => {
    // The guarantee is for small, not for absent. Nothing failed here.
    const lit = columnRows([1654.28, 0, 1087.44], CEILING, ROWS_TALL);
    expect(lit[1]).toBe(0);
  });

  it("takes the guaranteed row from the largest series, not from another small one", () => {
    // A column already full, with a sliver that has to fit somewhere.
    const lit = columnRows([4000, 1, 60], CEILING, ROWS_TALL);
    expect(lit[1]).toBe(1);
    expect(lit[2]).toBeGreaterThanOrEqual(1);
    expect(lit.reduce((sum, rows) => sum + rows, 0)).toBeLessThanOrEqual(ROWS_TALL);
  });

  it("lights nothing on an idle second", () => {
    expect(columnRows([0, 0, 0], CEILING, ROWS_TALL)).toEqual([0, 0, 0]);
  });

  it("divides by neither a ceiling nor a grid of nought", () => {
    expect(columnRows(MAINNET, 0, ROWS_TALL)).toEqual([0, 0, 0]);
    expect(columnRows(MAINNET, CEILING, 0)).toEqual([0, 0, 0]);
  });
});

describe("the grid's columns", () => {
  const samples = Array.from({ length: 60 }, (_unused, index) => index);

  it("gives every column at least the legible pitch", () => {
    const width = 340;
    expect(width / slotsFor(width)).toBeGreaterThanOrEqual(MIN_PITCH);
  });

  it("never has more columns than the window holds", () => {
    // A very wide card does not get a wider grid; a full minute fills it
    // exactly, and beyond that the dots would simply spread apart.
    expect(slotsFor(4000)).toBe(60);
  });

  it("drops columns rather than let one go below a legible width", () => {
    expect(slotsFor(340)).toBe(26);
    expect(slotsFor(340)).toBeLessThan(60);
  });

  it("keeps at least one column on a card too narrow for any", () => {
    expect(slotsFor(0)).toBe(1);
  });

  it("does not halve the grid when the window carries one sample too many", () => {
    // `windowed` keeps one sample past the left edge on purpose, so a full
    // minute arrives as sixty-one samples against sixty columns. Rounding the
    // stride up makes that a stride of two, and the grid visibly halves and
    // un-halves every time a sample lands.
    const over = Array.from({ length: 61 }, (_unused, index) => index);
    const columns = columnsFor(over, 60, second, newest);
    expect(columns).toHaveLength(60);
    expect(columns.filter((column) => column === null)).toHaveLength(0);
    expect(columns[columns.length - 1]).toBe(60);
    expect(columns[0]).toBe(1);
  });

  it("merges the seconds a column stands for and keeps the newest last", () => {
    // Picking every second sample instead made the grid blink on a phone: the
    // picked set flipped between the even seconds and the odd ones each tick.
    const columns = columnsFor(samples, 26, second, (bucket) => bucket.join("+"));
    expect(columns).toHaveLength(26);
    expect(columns[columns.length - 1]).toBe("58+59");
    expect(columns[0]).toBe("8+9");
    expect(columns.filter((column) => column === null)).toHaveLength(0);
  });

  it("keeps a column's seconds from one tick to the next", () => {
    // Bucketed by the clock, a tick changes only the live column until its
    // bucket fills, and then the grid steps left by one whole column.
    const at = (from: number) => {
      const window = Array.from({ length: 61 }, (_unused, index) => from + index);
      return columnsFor(window, 24, second, (bucket) => bucket.join("+"));
    };
    const before = at(0);
    const filling = at(1);
    const stepped = at(2);
    expect(before[before.length - 1]).toBe("60");
    expect(filling[filling.length - 1]).toBe("60+61");
    expect(filling.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(stepped[stepped.length - 1]).toBe("62");
    expect(stepped.slice(0, -1)).toEqual(filling.slice(1));
  });

  it("pads the left with nothing while the window is still filling", () => {
    // The unlit columns are what make a validator that has just started look
    // like a grid waiting to fill rather than a panel that has failed.
    const columns = columnsFor([1, 2, 3], 10, second, newest);
    expect(columns).toHaveLength(10);
    expect(columns.slice(0, 7)).toEqual([null, null, null, null, null, null, null]);
    expect(columns.slice(7)).toEqual([1, 2, 3]);
  });

  it("returns a grid of nothing before any sample arrives", () => {
    expect(columnsFor([], 5, second, newest)).toEqual([null, null, null, null, null]);
  });

  it("leaves a skipped second as a hole where it was", () => {
    // The validator skips a sample now and then. Padding the gap at the left
    // edge put the whole minute a column out of place.
    expect(columnsFor([1, 2, 4, 5], 5, second, newest)).toEqual([1, 2, null, 4, 5]);
    expect(columnsFor([3, 5], 5, second, newest)).toEqual([null, null, 3, null, 5]);
  });

  it("averages the readout over the newest seconds", () => {
    const sample = (total: number): TpsSample => ({
      slot: total,
      timestamp_nanos: total,
      total,
      vote: 0,
      non_vote_success: total,
      non_vote_failed: 0,
    });
    expect(readoutMean([sample(10), sample(20), sample(0)], 2)?.total).toBe(10);
    expect(readoutMean([], 5)).toBeUndefined();
  });

  it("draws a merged column as the mean of its seconds, stamped as the newest", () => {
    const sample = (timestamp_nanos: number, total: number, vote: number): TpsSample => ({
      slot: timestamp_nanos,
      timestamp_nanos,
      total,
      vote,
      non_vote_success: total - vote - 10,
      non_vote_failed: 10,
    });
    const merged = meanSample([sample(1e9, 3000, 1500), sample(2e9, 1000, 500)]);
    expect(merged.total).toBe(2000);
    expect(merged.vote).toBe(1000);
    expect(merged.non_vote_success).toBe(990);
    expect(merged.non_vote_failed).toBe(10);
    expect(merged.timestamp_nanos).toBe(2e9);
    expect(sampleSecond(sample(2.7e9, 0, 0))).toBe(2);
  });
});

describe("geometry", () => {
  it("keeps the dot square and leaves a gap on both axes", () => {
    const { dot, pitch, rowHeight } = geometry(780, 132, 60, ROWS_TALL);
    expect(dot).toBeLessThan(pitch);
    expect(dot).toBeLessThan(rowHeight);
    expect(dot).toBeGreaterThanOrEqual(3);
  });

  it("caps the dot so a wide card does not draw blocks", () => {
    expect(geometry(2000, 400, 20, ROWS_TALL).dot).toBe(6);
  });

  it("holds a floor so a narrow card draws dots rather than dust", () => {
    expect(geometry(120, 60, 60, ROWS_TALL).dot).toBe(3);
  });
});

describe("the scale", () => {
  it("sits above the window's peak, so the tallest column is not flush", () => {
    expect(ceilingFor(1000)).toBeCloseTo(1100, 6);
  });

  it("is never nought, so nothing divides by it before the first sample", () => {
    expect(ceilingFor(0)).toBe(1);
  });

  it("covers the same minute as the other charts", () => {
    expect(MATRIX_WINDOW_SECONDS).toBe(60);
  });
});
