import type { FinalizationMinute } from "./types";

/** Under this share a validator's votes usually reach the certificate's builder too late. */
export const LOW_SHARE = 0.5;

const HOUR_MILLIS = 3_600_000;

/** Heights against the tallest band on a square-root scale, so a band of a few shows beside hundreds. */
export function bandHeights(bands: number[]): number[] {
  const tallest = Math.max(0, ...bands);
  return bands.map((validators) => (tallest > 0 ? Math.sqrt(validators / tallest) : 0));
}

/** The band a share falls in; a share of 1 is in the top one. */
export function bandOf(share: number, bands: number): number {
  return Math.max(0, Math.min(bands - 1, Math.floor(share * bands)));
}

/**
 * Polyline points for one series in a box `width` by `height`, placed by time with the newest
 * minute at the right edge. A minute without a value breaks the line.
 */
export function trendLines(
  minutes: FinalizationMinute[],
  pick: (minute: FinalizationMinute) => number | null,
  width: number,
  height: number,
): string[] {
  const newest = minutes[minutes.length - 1]?.start_millis;
  if (newest === undefined) return [];
  const lines: string[] = [];
  let points: string[] = [];
  for (const minute of minutes) {
    const value = pick(minute);
    if (value === null) {
      if (points.length > 0) lines.push(points.join(" "));
      points = [];
      continue;
    }
    const x = width * (1 - (newest - minute.start_millis) / (HOUR_MILLIS - 60_000));
    const y = height * (1 - value);
    points.push(`${round(x)},${round(y)}`);
  }
  if (points.length > 0) lines.push(points.join(" "));
  return lines;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
