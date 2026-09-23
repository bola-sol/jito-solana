import { useSyncExternalStore } from "react";

/** The width below which a phone is being held: the same 700px the stylesheet
 *  changes shape at. */
export const NARROW_QUERY = "(max-width: 700px)";

/** Whether the window is narrow, for what CSS cannot decide: whether a thing is a control, and
 *  rendering each figure once. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, alwaysWide);
}

function subscribe(onChange: () => void): () => void {
  // Some embedded webviews have no matchMedia, and subscribing would throw at render.
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the window matches, read afresh. Exported for tests. */
export function isNarrow(): boolean {
  // Without matchMedia the answer is wide, the header that works without the panel.
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

function alwaysWide(): boolean {
  return false;
}
