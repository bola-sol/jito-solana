/** Saved schedule views: a name and the address they restore, kept in this browser. */

import { readStored, writeStored } from "./storage";

export const VIEWS_STORAGE_KEY = "agave-dashboard-schedule-views";

/** At most this many are kept, the newest first. */
const MAX_VIEWS = 20;

export interface SavedView {
  name: string;
  /** The schedule's address, `#/schedule?…`. */
  hash: string;
  /** What the view filters, in a line. */
  summary: string;
}

function isView(value: unknown): value is SavedView {
  const view = value as SavedView;
  return (
    typeof view === "object" &&
    view !== null &&
    typeof view.name === "string" &&
    typeof view.hash === "string" &&
    typeof view.summary === "string" &&
    view.hash.startsWith("#/schedule")
  );
}

export function readViews(): SavedView[] {
  try {
    const held: unknown = JSON.parse(readStored(VIEWS_STORAGE_KEY) ?? "[]");
    return Array.isArray(held) ? held.filter(isView) : [];
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
export function startHash(views: readonly SavedView[], start: string | null): string | null {
  return start === null ? null : (views.find((view) => view.name === start)?.hash ?? null);
}
