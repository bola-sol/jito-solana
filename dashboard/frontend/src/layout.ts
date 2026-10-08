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

/** The certificates panel's list, closed until the viewer opens it. */
export const CERTIFICATES_STORAGE_KEY = "agave-dashboard-certificates";

export function readCertificatesOpen(): boolean {
  return readStored(CERTIFICATES_STORAGE_KEY) === "open";
}

export function writeCertificatesOpen(open: boolean): void {
  writeStored(CERTIFICATES_STORAGE_KEY, open ? "open" : "closed");
}

export const FOLDED_STORAGE_KEY = "agave-dashboard-folded";

export function readFolded(): string[] {
  const held = readStored(FOLDED_STORAGE_KEY);
  return held ? held.split(",").filter(Boolean) : [];
}

export function writeFolded(folded: string[]): void {
  writeStored(FOLDED_STORAGE_KEY, folded.join(","));
}

export type ScheduleColumns = "status" | "fees" | "timing" | "load";

export const SCHEDULE_COLUMNS: readonly ScheduleColumns[] = ["status", "fees", "timing", "load"];

/** Which group of the schedule's columns a screen too narrow for all of them shows. */
export const SCHEDULE_COLUMNS_STORAGE_KEY = "agave-dashboard-schedule-columns";

export function readScheduleColumns(): ScheduleColumns {
  const held = readStored(SCHEDULE_COLUMNS_STORAGE_KEY);
  return SCHEDULE_COLUMNS.find((group) => group === held) ?? "status";
}

export function writeScheduleColumns(group: ScheduleColumns): void {
  writeStored(SCHEDULE_COLUMNS_STORAGE_KEY, group);
}

/** The network card's interface list, folded until the viewer opens it. */
export const INTERFACES_STORAGE_KEY = "agave-dashboard-interfaces";

export function readInterfacesOpen(): boolean {
  return readStored(INTERFACES_STORAGE_KEY) === "open";
}

export function writeInterfacesOpen(open: boolean): void {
  writeStored(INTERFACES_STORAGE_KEY, open ? "open" : "closed");
}
