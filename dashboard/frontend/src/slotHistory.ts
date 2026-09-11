/**
 * Slots fetched from the validator's packed history, turned back into the
 * entries the schedule page draws. A reconstruction: the packed row carries
 * only the schedule columns, so failed transactions and entries read as
 * nought here and must not be drawn from these.
 */

import { leaderAt } from "./schedule";
import type { EpochInfo, SlotEntry, SlotLevel } from "./types";

/** Set where the slot recorded a block. */
export const HAS_BLOCK = 1;
/** Set where the slot's first shred was timed. */
export const HAS_CLOCK = 1 << 1;
/** Set where the slot's tips were measured; nought is then a real reading. */
export const HAS_TIPS = 1 << 2;
/** Set where replay's time on the slot was seen. */
export const HAS_REPLAY = 1 << 3;
/** Set where the blockstore reported the slot filling. */
export const HAS_SHREDS = 1 << 4;
/** Set where replay's finish was seen, and so timed from the first shred. */
export const HAS_REPLAYED = 1 << 5;

/** One slot as the validator sends it, positional: level, flags, votes,
 *  non-votes, compute, fees, priority fees, tips, time, replay, shreds,
 *  repaired, full, replayed. Pinned by a test on each side. */
export type WireRow = [
  level: number,
  flags: number,
  votes: number,
  nonVotes: number,
  compute: number,
  fees: number,
  priorityFees: number,
  tips: number,
  timeMillis: number,
  replayMicros: number,
  shreds: number,
  repaired: number,
  fullMillis: number,
  replayedMillis: number,
];

/** A span of history, oldest first, with `null` for slots it does not hold. */
export interface SlotRange {
  first_slot: number;
  rows: (WireRow | null)[];
}

/** Levels by discriminant, in the validator's enum order. */
const LEVELS: SlotLevel[] = [
  "incomplete",
  "completed",
  "optimistically_confirmed",
  "rooted",
  "finalized",
  "skipped",
];

/** A fetched span as slot entries, oldest first. Holes are dropped;
 *  `turnsOf` draws the gap from the slots either side. */
export function entriesOf(
  range: SlotRange,
  epoch: EpochInfo | undefined,
  identity: string | undefined,
): SlotEntry[] {
  const entries: SlotEntry[] = [];
  // The gap to the previous slot that had a clock, which is what the validator
  // measures a duration as. Carried across holes for the same reason it is
  // there: a skipped slot shows up as one long interval, not as none.
  let previousTime: number | null = null;

  range.rows.forEach((row, index) => {
    if (row === null) return;
    const slot = range.first_slot + index;
    const [
      level,
      flags,
      votes,
      nonVotes,
      compute,
      fees,
      priorityFees,
      tips,
      timeMillis,
      replay,
      shreds,
      repaired,
      fullMillis,
      replayedMillis,
    ] = row;
    // Only to decide whether the slot was ours. Who the leader is, and what
    // they are called, the page resolves for itself through `store.leaderOf`,
    // the same way it does for a live slot.
    const leader = leaderAt(epoch, slot);
    const timed = (flags & HAS_CLOCK) !== 0;

    entries.push({
      slot,
      level: LEVELS[level] ?? "incomplete",
      mine: leader !== null && leader === identity,
      block:
        (flags & HAS_BLOCK) === 0
          ? null
          : {
              transactions: votes + nonVotes,
              non_vote_transactions: nonVotes,
              // Not carried by the packed row. Nought here means "not
              // measured", and no schedule row reads them.
              failed_transactions: 0,
              entries: 0,
              block_cost: compute,
              block_cost_limit: epoch?.block_cost_limit ?? 0,
              account_cost_limit: epoch?.account_cost_limit ?? 0,
              total_fees: fees,
              priority_fees: priorityFees,
              tips: (flags & HAS_TIPS) === 0 ? null : tips,
              replay_micros: (flags & HAS_REPLAY) === 0 ? null : replay,
            },
      duration_nanos:
        timed && previousTime !== null ? (timeMillis - previousTime) * 1_000_000 : null,
      time_millis: timed ? timeMillis : null,
      shreds:
        (flags & HAS_SHREDS) === 0
          ? null
          : { count: shreds, repaired, full_millis: fullMillis },
      replayed_millis: (flags & HAS_REPLAYED) === 0 ? null : replayedMillis,
    });

    if (timed) previousTime = timeMillis;
  });

  return entries;
}
