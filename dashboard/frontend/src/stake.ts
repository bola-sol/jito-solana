/** Delinquent stake as the ticks that draw it. */

/** Ticks in the strip, one per two percent of staked SOL. As many as the
 *  card holds at its narrow width. */
export const STAKE_TICKS = 50;

/** The least of a tick filled when any stake is delinquent, so a trace draws
 *  as a mark rather than as nothing. */
const MINIMUM_SLIVER = 0.14;

export interface StakeTicks {
  /** Whole ticks given over to delinquent stake, counted from the right. */
  full: number;
  /** How much of the next tick leftward is filled, from 0 to 1. */
  partial: number;
}

/** How much of the strip delinquent stake takes: whole ticks and a part of
 *  one, since normal is well under one tick. */
export function stakeTicks(delinquent: number, total: number): StakeTicks {
  const none = { full: 0, partial: 0 };
  if (!Number.isFinite(delinquent) || !Number.isFinite(total)) return none;
  if (total <= 0 || delinquent <= 0) return none;

  const share = Math.min(1, delinquent / total);
  const exact = share * STAKE_TICKS;
  const full = Math.min(STAKE_TICKS, Math.floor(exact));
  if (full >= STAKE_TICKS) return { full: STAKE_TICKS, partial: 0 };

  // The floor only applies where there is nothing else to see. Once a whole
  // tick is red the strip already reads as non-zero, and the part-filled one
  // beside it can be left true.
  const partial = exact - full;
  if (full > 0) return { full, partial };

  return { full, partial: Math.max(MINIMUM_SLIVER, partial) };
}
