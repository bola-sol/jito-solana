import { readStored, writeStored } from "./storage";
import type { SummaryGroup } from "./summaryTable";

/** A yes/no choice kept under `key` as one of two words; anything else reads as no. */
function storedFlag(key: string, yes: string, no: string): [() => boolean, (value: boolean) => void] {
  return [() => readStored(key) === yes, (value) => writeStored(key, value ? yes : no)];
}

export const BALANCES_STORAGE_KEY = "agave-dashboard-balances";
export const [readBalancesHidden, writeBalancesHidden] = storedFlag(BALANCES_STORAGE_KEY, "hidden", "shown");

export const LOGOS_STORAGE_KEY = "agave-dashboard-logos";
export const [readLogosHidden, writeLogosHidden] = storedFlag(LOGOS_STORAGE_KEY, "hidden", "shown");

/** The certificates panel's list, closed until the viewer opens it. */
export const CERTIFICATES_STORAGE_KEY = "agave-dashboard-certificates";
export const [readCertificatesOpen, writeCertificatesOpen] = storedFlag(CERTIFICATES_STORAGE_KEY, "open", "closed");

/** The Overview's slot strip, open until the viewer folds it. */
export const SLOT_STRIP_STORAGE_KEY = "agave-dashboard-slot-strip";
export const [readSlotStripFolded, writeSlotStripFolded] = storedFlag(SLOT_STRIP_STORAGE_KEY, "folded", "open");

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

/** Whether the schedule's summary table groups by client or by country. */
export const SUMMARY_GROUP_STORAGE_KEY = "agave-dashboard-schedule-group";

export function readSummaryGroup(): SummaryGroup {
  return readStored(SUMMARY_GROUP_STORAGE_KEY) === "country" ? "country" : "client";
}

export function writeSummaryGroup(group: SummaryGroup): void {
  writeStored(SUMMARY_GROUP_STORAGE_KEY, group);
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
export const [readInterfacesOpen, writeInterfacesOpen] = storedFlag(INTERFACES_STORAGE_KEY, "open", "closed");
