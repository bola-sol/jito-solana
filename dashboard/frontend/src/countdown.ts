/**
 * The rate a countdown projects at, in milliseconds per slot.
 *
 * A cluster rarely runs at exactly its configured target, and an epoch's worth
 * of remaining slots multiplies that difference into minutes, so the measured
 * rate is used wherever there is one.
 *
 * The measurement is withheld by the collector until its averaging window has
 * filled, which is what the configured rate is here to cover: a figure that is
 * still settling would make the countdown jump about, which is worse than one
 * that is steady and slightly off.
 */

/** Stands in until the validator has reported either, which is the first tick. */
const ASSUMED_SLOT_NANOS = 400_000_000;

export function countdownSlotMs(
  sustainedNanos: number | null | undefined,
  configuredNanos: number | null | undefined,
): number {
  return (sustainedNanos ?? configuredNanos ?? ASSUMED_SLOT_NANOS) / 1e6;
}
