
export const STAKE_TICKS = 50;

/** The least of a tick filled when any stake is delinquent, so a trace draws
 *  as a mark rather than as nothing. */
const MINIMUM_SLIVER = 0.14;

export interface StakeTicks {
  full: number;
  partial: number;
}

/** Normal is well under one tick. */
export function stakeTicks(delinquent: number, total: number): StakeTicks {
  const none = { full: 0, partial: 0 };
  if (!Number.isFinite(delinquent) || !Number.isFinite(total)) return none;
  if (total <= 0 || delinquent <= 0) return none;

  const share = Math.min(1, delinquent / total);
  const exact = share * STAKE_TICKS;
  const full = Math.min(STAKE_TICKS, Math.floor(exact));
  if (full >= STAKE_TICKS) return { full: STAKE_TICKS, partial: 0 };

  // The floor applies only while no tick is full, since a red tick already reads as non-zero.
  const partial = exact - full;
  if (full > 0) return { full, partial };

  return { full, partial: Math.max(MINIMUM_SLIVER, partial) };
}
