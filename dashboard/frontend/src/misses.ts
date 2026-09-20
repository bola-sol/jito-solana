/** Where this validator's unrewarded votes fell, for the epoch card. */

import { count, shortKey } from "./format";
import type { LostLeader, Misses, VoteParticipation } from "./types";

/** More leader turns than this read as a band on the meter, not marks, and
 *  are left off it. */
export const MAX_TURN_MARKS = 80;

/** The places, in the order the legend lists them. */
export const MISS_PLACES = ["boundary", "leader", "snapshot", "thin", "late", "lost"] as const;

/** Fewer lost votes than this are not worth a line about who wrote them out. */
export const LOST_NOTE_MIN = 5;

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

/** A line naming how many of the lost votes a few leaders wrote out, once
 *  they hold at least half of them. Null otherwise. */
export function lostNote(participation: VoteParticipation): { text: string; leaders: LostLeader[] } | null {
  const { lost } = participation.misses;
  const leaders = participation.lost_leaders;
  if (lost < LOST_NOTE_MIN || leaders.length === 0) return null;
  const held = leaders.reduce((total, leader) => total + leader.count, 0);
  if (held * 2 < lost) return null;
  const by = leaders.length === 1 ? "one leader" : `same ${leaders.length} leaders`;
  return { text: `${count(held)} lost by ${by}`, leaders };
}

/** The leader's published name, else its key shortened. */
export function leaderLabel(leader: LostLeader): string {
  return leader.name ?? shortKey(leader.identity);
}
