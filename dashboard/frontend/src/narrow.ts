import { useSyncExternalStore } from "react";

/** The width below which a phone is being held: the same 700px the stylesheet
 *  changes shape at. */
export const NARROW_QUERY = "(max-width: 700px)";

/**
 * Whether the window is narrow, for the cases CSS cannot reach: whether a
 * thing is a control at all, and rendering each figure once rather than a
 * hidden copy per layout.
 */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, alwaysWide);
}

function subscribe(onChange: () => void): () => void {
  // Guarded for the same webviews `isNarrow` guards against. Without this the
  // subscription throws where the query is missing, which takes the header down
  // at render rather than falling back to the wide arrangement.
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the window matches, read afresh. Exported for tests. */
export function isNarrow(): boolean {
  // Older embedded webviews are missing matchMedia entirely. Answering "wide"
  // there gives a header with everything in it, which is the arrangement that
  // works without the panel.
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

function alwaysWide(): boolean {
  return false;
}
