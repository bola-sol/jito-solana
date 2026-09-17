/** Lighting the transaction matrix: how many rows each series takes in a
 *  column. */

import type { Tps, TpsSample } from "./types";

/** How much history the matrix shows. Matches the network card's window. */
export const MATRIX_WINDOW_SECONDS = 60;

/** Rows in a full-height matrix, and in the shorter one a phone gets. */
export const ROWS_TALL = 11;
export const ROWS_SHORT = 8;

/** How far above the window's peak the top of the scale sits. Fixed, so the
 *  silhouette does not rescale as spikes come and go. */
export const CEILING_HEADROOM = 1.1;

/** The narrowest a column may be before samples start being dropped. */
export const MIN_PITCH = 13;

/** Seconds the readout averages: at least six leader turns on a cluster with
 *  200 ms slots, where one second can fall wholly on an empty turn. */
export const READOUT_SECONDS = 5;

/**
 * How many rows each series lights, bottom to top, stacked. Any series with
 * something in it lights at least one row: unlit reads as "did not happen".
 */
export function columnRows(values: number[], ceiling: number, rows: number): number[] {
  if (ceiling <= 0 || rows <= 0) return values.map(() => 0);

  const scale = rows / ceiling;
  let below = 0;
  const lit = values.map((value) => {
    const from = Math.ceil(Math.min(below * scale, rows));
    below += Math.max(0, value);
    const to = Math.ceil(Math.min(below * scale, rows));
    return Math.max(0, to - from);
  });

  for (const [index, value] of values.entries()) {
    if (value > 0 && lit[index] === 0) lit[index] = 1;
  }

  // The guarantee can push a column past the grid it has to fit in. Take the
  // rows back from the largest series, which is the one that loses least by it,
  // and never from a series down to its single guaranteed row.
  let total = lit.reduce((sum, count) => sum + count, 0);
  while (total > rows) {
    let largest = 1;
    let at = -1;
    for (const [index, count] of lit.entries()) {
      if (count > largest) {
        largest = count;
        at = index;
      }
    }
    if (at < 0) break;
    lit[at] -= 1;
    total -= 1;
  }

  return lit;
}

/** Columns at this width, never more than the window holds. */
export function slotsFor(width: number): number {
  return Math.max(1, Math.min(MATRIX_WINDOW_SECONDS, Math.floor(width / MIN_PITCH)));
}

/**
 * The sample each column draws, newest last, null where nothing arrived for
 * that column's seconds. A narrow card merges several seconds per column,
 * bucketed by the clock so a column keeps the same seconds from one tick to
 * the next, and a second the validator skipped stays a hole where it was.
 */
export function columnsFor<T, C>(
  samples: T[],
  slots: number,
  second: (sample: T) => number,
  merge: (bucket: T[]) => C,
): Array<C | null> {
  if (samples.length === 0) return Array(slots).fill(null) as null[];
  // Rounded down: a full minute arrives as sixty-one samples for sixty
  // columns.
  const span = second(samples[samples.length - 1]) - second(samples[0]) + 1;
  const stride = Math.max(1, Math.floor(span / slots));
  const buckets = new Map<number, T[]>();
  for (const sample of samples) {
    const bucket = Math.floor(second(sample) / stride);
    const held = buckets.get(bucket);
    if (held) held.push(sample);
    else buckets.set(bucket, [sample]);
  }
  const last = Math.floor(second(samples[samples.length - 1]) / stride);
  return Array.from({ length: slots }, (_unused, index) => {
    const bucket = buckets.get(last - slots + 1 + index);
    return bucket ? merge(bucket) : null;
  });
}

/** The readout: the mean of the newest samples rather than the last one. */
export function readoutMean(samples: TpsSample[], seconds = READOUT_SECONDS): Tps | undefined {
  const recent = samples.slice(-seconds);
  if (recent.length === 0) return undefined;
  const mean = (of: (sample: TpsSample) => number): number =>
    recent.reduce((sum, sample) => sum + of(sample), 0) / recent.length;
  return {
    total: mean((sample) => sample.total),
    vote: mean((sample) => sample.vote),
    non_vote_success: mean((sample) => sample.non_vote_success),
    non_vote_failed: mean((sample) => sample.non_vote_failed),
  };
}

/** The second a sample belongs to, on the clock. */
export function sampleSecond(sample: TpsSample): number {
  return Math.floor(sample.timestamp_nanos / 1e9);
}

/** One column for several seconds: the mean of each series, stamped as the
 *  newest. */
export function meanSample(bucket: TpsSample[]): TpsSample {
  const newest = bucket[bucket.length - 1];
  const mean = (of: (sample: TpsSample) => number): number =>
    bucket.reduce((sum, sample) => sum + of(sample), 0) / bucket.length;
  return {
    slot: newest.slot,
    timestamp_nanos: newest.timestamp_nanos,
    total: mean((sample) => sample.total),
    vote: mean((sample) => sample.vote),
    non_vote_success: mean((sample) => sample.non_vote_success),
    non_vote_failed: mean((sample) => sample.non_vote_failed),
  };
}

export interface Geometry {
  /** Horizontal space one column gets, dot and gap together. */
  pitch: number;
  rowHeight: number;
  /** Side of the square. */
  dot: number;
}

/** Where the dots go, in pixels: square, with a gap on both axes. */
export function geometry(width: number, height: number, columns: number, rows: number): Geometry {
  const pitch = columns > 0 ? width / columns : width;
  const rowHeight = rows > 0 ? height / rows : height;
  const dot = Math.max(3, Math.min(pitch - (pitch > 10 ? 2.5 : 1.5), rowHeight - 2, 6));
  return { pitch, rowHeight, dot };
}

/** The scale the columns are drawn against. Never nought. */
export function ceilingFor(peak: number): number {
  return Math.max(1, peak * CEILING_HEADROOM);
}
