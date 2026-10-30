import { readStored, writeStored } from "./storage";

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

/** The Overview's slot strip, open until the viewer folds it. */
export const SLOT_STRIP_STORAGE_KEY = "agave-dashboard-slot-strip";

export function readSlotStripFolded(): boolean {
  return readStored(SLOT_STRIP_STORAGE_KEY) === "folded";
}

export function writeSlotStripFolded(folded: boolean): void {
  writeStored(SLOT_STRIP_STORAGE_KEY, folded ? "folded" : "open");
}

/** The folds the viewer opened; every fold starts folded. */
export const OPENED_STORAGE_KEY = "agave-dashboard-opened";

function readOpened(): string[] {
  const held = readStored(OPENED_STORAGE_KEY);
  return held ? held.split(",").filter(Boolean) : [];
}

export function readFoldOpen(id: string): boolean {
  return readOpened().includes(id);
}

export function writeFoldOpen(id: string, open: boolean): void {
  const rest = readOpened().filter((held) => held !== id);
  writeStored(OPENED_STORAGE_KEY, (open ? [...rest, id] : rest).join(","));
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
