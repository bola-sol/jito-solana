/**
 * Lighting the transaction matrix: how many rows each series takes in a column.
 *
 * Kept out of the component because the dot geometry is easy to get subtly
 * wrong and none of it needs a DOM.
 */

import type { TpsSample } from "./types";

/** How much history the matrix shows. Matches the network card's window. */
export const MATRIX_WINDOW_SECONDS = 60;

/** Rows in a full-height matrix, and in the shorter one a phone gets. */
export const ROWS_TALL = 11;
export const ROWS_SHORT = 8;

/**
 * How far above the window's peak the top of the scale sits.
 *
 * A fixed ceiling rather than one fitted to each frame. Refitted every sample
 * the whole silhouette rescales whenever a spike arrives and leaves, so the
 * shape moves for reasons that have nothing to do with the traffic.
 */
export const CEILING_HEADROOM = 1.1;

/** The narrowest a column may be before samples start being dropped. */
export const MIN_PITCH = 13;

/**
 * How many rows each series lights, counting from the bottom of the column.
 *
 * Given bottom to top, and returned the same way. The series stack rather than
 * overlap: each one starts where the one beneath it stopped, so the height of
 * the lit part of a column is the total.
 *
 * Any series with something in it lights at least one row. Rounded honestly a
 * small band takes no rows at all, and an unlit band does not read as "too
 * small to draw" but as "this did not happen", which is a wrong statement
 * rather than an imprecise one. Failed transactions are the series this
 * matters for: they are the smallest and the one worth seeing.
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

/**
 * How many columns the grid has at this width.
 *
 * Never more than the window holds, so a full minute fills the grid exactly.
 * Sized from the sample count instead, a short history would spread a handful
 * of columns across the whole card with enormous gaps, which reads as a broken
 * chart rather than as one still filling up.
 */
export function slotsFor(width: number): number {
  return Math.max(1, Math.min(MATRIX_WINDOW_SECONDS, Math.floor(width / MIN_PITCH)));
}

/**
 * The sample each column draws, newest last, with nulls where nothing has
 * arrived yet.
 *
 * A card too narrow for a column per second gets a column per two or three,
 * and that column is the merge of its seconds, not one of them. Picking every
 * second sample instead made the grid blink on a phone: each tick the picked
 * set flipped between the even seconds and the odd ones, so a busy second
 * showed, vanished, and showed again.
 *
 * The seconds are bucketed by the clock, not counted back from the newest, so
 * a column keeps the same seconds from one tick to the next. The grid then
 * steps left once a bucket fills rather than reshuffling every second, and
 * only the live column, a bucket still filling, changes in between.
 *
 * The empty columns are returned rather than left out: their unlit dots are
 * what make a validator that has just started look like a grid waiting to fill
 * rather than a panel that has failed.
 */
export function columnsFor<T, C>(
  samples: T[],
  slots: number,
  second: (sample: T) => number,
  merge: (bucket: T[]) => C,
): Array<C | null> {
  // Rounded down, not up. The window deliberately carries one sample past its
  // left edge so a line can leave the view continuously, which means a full
  // minute arrives here as sixty-one samples against sixty columns. Rounded up
  // that would be two seconds a column with half the grid dark.
  const stride = Math.max(1, Math.floor(samples.length / slots));
  const buckets: T[][] = [];
  let last: number | null = null;
  for (const sample of samples) {
    const bucket = Math.floor(second(sample) / stride);
    if (bucket !== last) {
      buckets.push([]);
      last = bucket;
    }
    buckets[buckets.length - 1].push(sample);
  }
  const kept = buckets.slice(-slots).map(merge);
  const missing = Math.max(0, slots - kept.length);
  return [...(Array(missing).fill(null) as null[]), ...kept];
}

/** The second a sample belongs to, on the clock. */
export function sampleSecond(sample: TpsSample): number {
  return Math.floor(sample.timestamp_nanos / 1e9);
}

/**
 * One column for several seconds: the mean of each series, stamped as the
 * newest. A mean rather than a peak so a column of two seconds sits where a
 * column of one would, and the ceiling still comes from the samples.
 */
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

/**
 * Where the dots go, in pixels.
 *
 * Square, and sized to leave a gap on both axes: the dark grid between them is
 * what makes it read as an instrument rather than as a bar chart with gaps.
 */
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
