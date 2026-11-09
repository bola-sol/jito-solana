/** Stands in for scroll anchoring, which Safari lacks. */

export function heldScrollTop(
  scrollTop: number,
  previousTop: number,
  was: number,
  now: number,
): number {
  if (previousTop <= 0) return scrollTop;
  if (scrollTop !== previousTop) return scrollTop;
  const grown = now - was;
  return grown > 0 ? scrollTop + grown : scrollTop;
}
