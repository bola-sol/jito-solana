
import type { SlotEntry } from "./types";

export const TIMELINE_SPAN_MS = 1000;

export interface Timeline {
  wait: number;
  /** Null where replay was not seen, which includes every block we built. */
  run: number | null;
  waitShare: number;
  runShare: number;
  label: string;
}

/** The second span is clamped at nought: two threads stamp the two clocks. */
export function timelineOf(entry: SlotEntry | null): Timeline | null {
  const shreds = entry?.shreds;
  if (!entry || !shreds) return null;

  const wait = shreds.full_millis;
  const run = entry.replayed_millis === null ? null : Math.max(0, entry.replayed_millis - wait);
  const waitShare = Math.min(1, wait / TIMELINE_SPAN_MS);
  const runShare = run === null ? 0 : Math.min(1 - waitShare, run / TIMELINE_SPAN_MS);
  const label = run === null ? `${wait} ms` : `${wait} + ${run} ms`;
  return { wait, run, waitShare, runShare, label };
}
