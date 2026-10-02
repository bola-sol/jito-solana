import type { FinalizationMinute } from "./types";

/** Under this share a validator's votes usually reach the certificate's builder too late. */
export const LOW_SHARE = 0.5;

const HOUR_MILLIS = 3_600_000;

const MINUTE_MILLIS = 60_000;

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
    const x = width * minuteX(newest, minute.start_millis);
    const y = height * (1 - value);
    points.push(`${round(x)},${round(y)}`);
  }
  if (points.length > 0) lines.push(points.join(" "));
  return lines;
}

/** Across the chart, from 0 at the left to 1 at the newest minute. */
function minuteX(newest: number, start: number): number {
  return 1 - (newest - start) / (HOUR_MILLIS - MINUTE_MILLIS);
}

/** Each minute's place across the chart, as `trendLines` draws it. */
export function minuteXs(minutes: FinalizationMinute[]): number[] {
  const newest = minutes[minutes.length - 1]?.start_millis;
  return newest === undefined ? [] : minutes.map((minute) => minuteX(newest, minute.start_millis));
}

/** The minute drawn nearest a point across the chart, or null for none. */
export function nearestMinute(xs: number[], at: number): number | null {
  let best: number | null = null;
  xs.forEach((x, index) => {
    if (best === null || Math.abs(x - at) < Math.abs((xs[best] ?? 0) - at)) best = index;
  });
  return best;
}

/** In the axis's terms: now for the newest minute, else how many minutes before it. */
export function minuteLabel(minutes: FinalizationMinute[], index: number): string {
  const newest = minutes[minutes.length - 1]?.start_millis;
  const start = minutes[index]?.start_millis;
  if (newest === undefined || start === undefined) return "";
  const before = Math.round((newest - start) / MINUTE_MILLIS);
  return before === 0 ? "now" : `−${before} min`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
