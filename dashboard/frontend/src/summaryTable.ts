/** The rows of the schedule's by-client and by-country table, and how they sort. */

import { countryName } from "./format";
import type { ScanFigures, ScheduleSummary } from "./types";

/** Groups with fewer slots than this are left out, their means being noise. */
export const MIN_GROUP_SLOTS = 8;

export type SummaryGroup = "client" | "country";

export type SummaryColumn =
  | "name"
  | "slots"
  | "validators"
  | "skipped"
  | "duration"
  | "first_slot"
  | "rest_of_turn"
  | "replay"
  | "transactions"
  | "compute"
  | "base_fee"
  | "priority_fee"
  | "tips";

export interface SummarySort {
  column: SummaryColumn;
  descending: boolean;
}

export const DEFAULT_SUMMARY_SORT: SummarySort = { column: "slots", descending: true };

export interface SummaryRow extends ScanFigures {
  name: string;
  validators?: number;
}

export function summaryColumns(group: SummaryGroup, tips: boolean): SummaryColumn[] {
  return [
    "name",
    "slots",
    "validators",
    "skipped",
    ...(group === "country" ? (["first_slot", "rest_of_turn"] as const) : (["duration"] as const)),
    "replay",
    "transactions",
    "compute",
    "base_fee",
    "priority_fee",
    ...(tips ? (["tips"] as const) : []),
  ];
}

export function summaryRows(summary: ScheduleSummary, group: SummaryGroup): SummaryRow[] {
  const rows: SummaryRow[] =
    group === "country"
      ? (summary.countries ?? []).map((row) => ({ ...row, name: row.country === null ? "Unknown" : countryName(row.country) }))
      : summary.clients.map((row) => ({ ...row, name: row.client ?? "Not in gossip" }));
  return rows.filter((row) => row.slots >= MIN_GROUP_SLOTS);
}

function sortValue(row: SummaryRow, column: Exclude<SummaryColumn, "name">): number | null {
  switch (column) {
    case "slots":
      return row.slots;
    case "validators":
      return row.validators ?? null;
    case "skipped":
      return row.slots > 0 ? row.skipped / row.slots : null;
    case "duration":
      return row.duration_ms;
    case "first_slot":
      return row.first_slot_ms ?? null;
    case "rest_of_turn":
      return row.rest_of_turn_ms ?? null;
    case "replay":
      return row.replay_ms;
    case "transactions":
      return row.slots > 0 ? row.transactions / row.slots : null;
    case "compute":
      return row.compute;
    case "base_fee":
      return row.base_fee;
    case "priority_fee":
      return row.priority_fee;
    case "tips":
      return row.tips;
  }
}

/** Sorted by the column, rows without a figure last either way and ties by name. */
export function sortSummaryRows(rows: readonly SummaryRow[], sort: SummarySort): SummaryRow[] {
  const direction = sort.descending ? -1 : 1;
  const { column } = sort;
  return [...rows].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (column === "name") return direction * byName;
    const [left, right] = [sortValue(a, column), sortValue(b, column)];
    if (left === right) return byName;
    if (left === null) return 1;
    if (right === null) return -1;
    return direction * (left - right);
  });
}

/** A new column starts highest first, or A to Z for names; the same column reverses. */
export function nextSummarySort(current: SummarySort, column: SummaryColumn): SummarySort {
  return current.column === column
    ? { column, descending: !current.descending }
    : { column, descending: column !== "name" };
}
