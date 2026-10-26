import { useEffect, useState } from "react";
import { useStore } from "./useStore";

/** How far behind live the charts draw: two of `METER_INTERVAL` in `dashboard/src/meters.rs`, one
 *  for the sample and one for its delivery. */
export const RENDER_LAG_MS = 2000;

export function chartEdge(now: number, clockOffsetMs: number | null): number {
  return now - (clockOffsetMs ?? 0) - RENDER_LAG_MS;
}

export function useChartEdge(): number {
  const store = useStore();
  return chartEdge(useNow(), store.getClockOffset());
}

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
