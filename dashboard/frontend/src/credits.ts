/** Vote credits against the most an epoch could have paid so far. */

/** Credits as a share of `elapsedSlots` at `maxPerSlot` each. Null before
 *  the epoch has run a slot. Capped at one: a credit lands a slot or two
 *  after its vote. */
export function creditsShare(credits: number, elapsedSlots: number, maxPerSlot: number): number | null {
  const ceiling = elapsedSlots * maxPerSlot;
  if (ceiling <= 0) return null;
  return Math.min(1, Math.max(0, credits) / ceiling);
}
