/** A slot's two spans from its first shred: waiting for the block, then
 *  finishing it. */

import type { SlotEntry } from "./types";

/** The track every timeline is drawn against, in milliseconds, fixed so rows
 *  compare. */
export const TIMELINE_SPAN_MS = 1000;

export interface Timeline {
  /** Milliseconds from the first shred to the last. */
  wait: number;
  /** Milliseconds from full to replayed, null where replay was not seen,
   *  which includes every block we built. */
  run: number | null;
  /** The two spans as shares of the track, clamped so together they fit it. */
  waitShare: number;
  runShare: number;
  label: string;
}

/** The timeline for a slot, null where its arrival was never reported. The
 *  second span is clamped at nought: two threads stamp the two clocks. */
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
