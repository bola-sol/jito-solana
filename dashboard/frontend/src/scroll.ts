/** Holding a reading position in a list that grows at the top. Stands in for
 *  scroll anchoring, which Safari lacks. */

/**
 * Where a scroller should sit after growing from `was` to `now` tall. Left
 * alone at the top, when nothing grew, and when the browser has already
 * anchored it.
 */
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
