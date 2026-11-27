/** Each item's top, and after the last the total height. */
export function offsetsOf(heights: readonly number[]): Float64Array {
  const offsets = new Float64Array(heights.length + 1);
  for (let index = 0; index < heights.length; index++) {
    offsets[index + 1] = (offsets[index] ?? 0) + (heights[index] ?? 0);
  }
  return offsets;
}

/** The index of the item at a height: the last whose top is at or above it. */
export function indexAt(offsets: Float64Array, height: number): number {
  const items = offsets.length - 1;
  if (items <= 0) return 0;
  let low = 0;
  let high = items - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? 0) <= height) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The first and last items to draw for a viewport, reaching `overscan` pixels past each edge. */
export function visibleRange(
  offsets: Float64Array,
  top: number,
  height: number,
  overscan: number,
): [first: number, last: number] {
  const items = offsets.length - 1;
  if (items <= 0) return [0, -1];
  return [indexAt(offsets, Math.max(0, top - overscan)), indexAt(offsets, top + height + overscan)];
}

/** The browser cut the scroll short as the list shrank: it went up, to as far down as it now goes. */
export function cutShort(current: number, settled: number | null, scrollHeight: number, clientHeight: number): boolean {
  return settled !== null && current < settled && current >= scrollHeight - clientHeight - 0.5;
}

/** Where a marked item sits against the view: above it, in it, or below it. */
export type EdgeSide = "above" | "in" | "below";

/**
 * Where a line at `offset` (from the view's top) sits: above once scrolled past by more than
 * `margin`, below once not wholly in view at the bottom.
 */
export function edgeSide(offset: number, height: number, viewHeight: number, margin: number): EdgeSide {
  if (offset < -margin) return "above";
  if (offset > viewHeight - height) return "below";
  return "in";
}
