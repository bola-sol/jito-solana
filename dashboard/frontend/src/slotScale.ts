/** Bar height for a slot duration, as a percentage: nominal at half height,
 *  each doubling a quarter more, each halving a quarter less. */
export function barHeight(durationMs: number | null, nominalMs: number): number {
  if (durationMs === null || durationMs <= 0) return 6;
  return Math.max(8, Math.min(100, 50 + 25 * Math.log2(durationMs / nominalMs)));
}
