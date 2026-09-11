import { useEffect, useState } from "react";

/** A wall-clock reading that advances on its own, so the charts scroll
 *  between samples. Only the chart components use it. */
/** How far behind live the charts draw, so the newest sample sits past the
 *  edge. Must match `METER_INTERVAL` in `dashboard/src/meters.rs`. */
export const RENDER_LAG_MS = 1000;

export function useNow(intervalMs = 100): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}

/** The samples for a window ending at `now`, plus the first one outside it
 *  so the line leaves the chart continuously. */
export function windowed<T>(
  samples: T[],
  now: number,
  windowMs: number,
  timestampNanos: (sample: T) => number,
): T[] {
  const cutoff = now - windowMs;
  const first = samples.findIndex((sample) => timestampNanos(sample) / 1e6 >= cutoff);
  if (first < 0) return [];
  return samples.slice(Math.max(0, first - 1));
}
