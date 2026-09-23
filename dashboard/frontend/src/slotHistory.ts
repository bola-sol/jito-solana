/** Slots fetched from the validator's packed history, turned back into schedule entries. Only the
 *  schedule columns survive packing; the rest read as nought. */

import { leaderAt } from "./schedule";
import type { EpochInfo, Reward, SlotEntry, SlotLevel } from "./types";

export const HAS_BLOCK = 1;
export const HAS_CLOCK = 1 << 1;
/** Nought is then a real reading. */
export const HAS_TIPS = 1 << 2;
export const HAS_REPLAY = 1 << 3;
export const HAS_SHREDS = 1 << 4;
export const HAS_REPLAYED = 1 << 5;
export const REWARD_SHIFT = 6;
export const REWARD_MASK = 0b11 << REWARD_SHIFT;
const REWARDS: (Reward | null)[] = [null, "paid", "unpaid", "no_certificate"];

/** One slot as the validator sends it, positional: level, flags, votes, non-votes, compute, fees,
 *  priority fees, tips, time, replay, shreds, repaired, full, replayed, left out. */
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
  leftOut: number,
];

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

/** Holes are dropped; `turnsOf` draws the gap from the slots either side. */
export function entriesOf(
  range: SlotRange,
  epoch: EpochInfo | undefined,
  identity: string | undefined,
): SlotEntry[] {
  const entries: SlotEntry[] = [];
  // The gap to the previous slot with a clock, as the validator measures it, so a skipped slot is
  // one long interval.
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
      leftOut,
    ] = row;
    const leader = leaderAt(epoch, slot);
    const timed = (flags & HAS_CLOCK) !== 0;
    const reward = REWARDS[(flags & REWARD_MASK) >> REWARD_SHIFT] ?? null;

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
      reward,
      left_out: reward === "paid" || reward === "unpaid" ? leftOut : null,
    });

    if (timed) previousTime = timeMillis;
  });

  return entries;
}
