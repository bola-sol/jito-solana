/** Where this validator's unrewarded votes fell, for the epoch card. */

import type { Misses } from "./types";

/** More leader turns than this read as a band on the meter, not marks, and
 *  are left off it. */
export const MAX_TURN_MARKS = 80;

/** The four places, in the order the legend lists them. */
export const MISS_PLACES = ["boundary", "leader", "snapshot", "elsewhere"] as const;

export interface MissMark {
  /** Along the epoch, in [0, 1]. */
  at: number;
  /** The bin's misses against the busiest bin's, in (0, 1]. */
  weight: number;
}

/** The first slot of each run of consecutive leader slots. */
export function leaderTurns(slots: number[]): number[] {
  const turns: number[] = [];
  let previous: number | undefined;
  for (const slot of slots) {
    if (previous === undefined || slot !== previous + 1) turns.push(slot);
    previous = slot;
  }
  return turns;
}

/** Where each leader turn sits along the epoch. Null with too many to read
 *  as marks. */
export function turnMarks(slots: number[], startSlot: number, slotsInEpoch: number): number[] | null {
  const turns = leaderTurns(slots);
  if (turns.length > MAX_TURN_MARKS) return null;
  return turns.map((slot) => (slot - startSlot) / Math.max(1, slotsInEpoch));
}

/** One mark per bin with a miss in it. */
export function missMarks(bins: number[]): MissMark[] {
  const busiest = bins.reduce((most, count) => Math.max(most, count), 0);
  if (busiest <= 0) return [];
  return bins.flatMap((count, index) =>
    count > 0 ? [{ at: (index + 0.5) / bins.length, weight: count / busiest }] : [],
  );
}

export function missTotal(misses: Misses): number {
  return MISS_PLACES.reduce((total, place) => total + misses[place], 0);
}
