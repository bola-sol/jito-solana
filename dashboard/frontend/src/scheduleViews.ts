/** Saved schedule views: a name and the address they restore, kept in this browser. */

import { addressOfHash } from "./route";
import { readStored, writeStored } from "./storage";

export const VIEWS_STORAGE_KEY = "agave-dashboard-schedule-views";

/** At most this many are kept, the newest first. */
const MAX_VIEWS = 20;

export interface SavedView {
  name: string;
  /** The schedule's address, `/schedule?…`. */
  address: string;
  /** What the view filters, in a line. */
  summary: string;
}

/** A stored view, one saved under a hash moved to its path; null if it is not a view. */
export function asView(value: unknown): SavedView | null {
  const view = value as (Partial<SavedView> & { hash?: unknown }) | null;
  if (typeof view !== "object" || view === null) return null;
  const { name, summary, address, hash } = view;
  if (typeof name !== "string" || typeof summary !== "string") return null;
  if (typeof hash === "string" && hash.startsWith("#/schedule")) return { name, address: addressOfHash(hash), summary };
  return typeof address === "string" && address.startsWith("/schedule") ? { name, address, summary } : null;
}

export function readViews(): SavedView[] {
  try {
    const held: unknown = JSON.parse(readStored(VIEWS_STORAGE_KEY) ?? "[]");
    return Array.isArray(held) ? held.flatMap((value) => asView(value) ?? []) : [];
  } catch {
    return [];
  }
}

/** A name already used is replaced, so saving again updates a view. */
export function withView(views: readonly SavedView[], view: SavedView): SavedView[] {
  return [view, ...views.filter((held) => held.name !== view.name)].slice(0, MAX_VIEWS);
}

export function withoutView(views: readonly SavedView[], name: string): SavedView[] {
  return views.filter((held) => held.name !== name);
}

export function writeViews(views: readonly SavedView[]): void {
  writeStored(VIEWS_STORAGE_KEY, JSON.stringify(views));
}

export const START_VIEW_STORAGE_KEY = "agave-dashboard-schedule-start-view";

/** The view the schedule opens with when its address asks for nothing, by name. */
export function readStartView(): string | null {
  return readStored(START_VIEW_STORAGE_KEY) || null;
}

export function writeStartView(name: string | null): void {
  writeStored(START_VIEW_STORAGE_KEY, name ?? "");
}

/** The start view's address, while a view of that name is still saved. */
export function startAddress(views: readonly SavedView[], start: string | null): string | null {
  return start === null ? null : (views.find((view) => view.name === start)?.address ?? null);
}
