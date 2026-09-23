import { useSyncExternalStore } from "react";

/** The same 700px the stylesheet changes shape at. */
export const NARROW_QUERY = "(max-width: 700px)";

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

export function isNarrow(): boolean {
  // Without matchMedia the answer is wide, the header that works without the panel.
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

function alwaysWide(): boolean {
  return false;
}
