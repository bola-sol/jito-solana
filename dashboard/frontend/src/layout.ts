import { readStored, writeStored } from "./storage";

export const SIDEBAR_STORAGE_KEY = "agave-dashboard-sidebar";

export function readSidebarCollapsed(): boolean {
  return readStored(SIDEBAR_STORAGE_KEY) === "collapsed";
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  writeStored(SIDEBAR_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
}

/** Null where the viewer has never chosen, so the card defaults by width. */
export const THREADS_STORAGE_KEY = "agave-dashboard-threads";

export function readThreadsCollapsed(): boolean | null {
  const held = readStored(THREADS_STORAGE_KEY);
  return held === null ? null : held === "collapsed";
}

export function writeThreadsCollapsed(collapsed: boolean): void {
  writeStored(THREADS_STORAGE_KEY, collapsed ? "collapsed" : "expanded");
}

export const BALANCES_STORAGE_KEY = "agave-dashboard-balances";

export function readBalancesHidden(): boolean {
  return readStored(BALANCES_STORAGE_KEY) === "hidden";
}

export function writeBalancesHidden(hidden: boolean): void {
  writeStored(BALANCES_STORAGE_KEY, hidden ? "hidden" : "shown");
}

export const FOLDED_STORAGE_KEY = "agave-dashboard-folded";

export function readFolded(): string[] {
  const held = readStored(FOLDED_STORAGE_KEY);
  return held ? held.split(",").filter(Boolean) : [];
}

export function writeFolded(folded: string[]): void {
  writeStored(FOLDED_STORAGE_KEY, folded.join(","));
}
