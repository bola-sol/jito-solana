import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUMMARY_SORT,
  nextSummarySort,
  sortSummaryRows,
  summaryColumns,
  summaryRows,
  type SummaryRow,
} from "./summaryTable";
import type { ScanFigures, ScheduleSummary } from "./types";

const FIGURES: ScanFigures = {
  slots: 100,
  skipped: 0,
  transactions: 1_000,
  duration_ms: 200,
  first_slot_ms: 200,
  rest_of_turn_ms: 200,
  replay_ms: 8,
  base_fee: 1,
  priority_fee: 1,
  tips: 1,
  compute: 1,
};

function row(name: string, figures: Partial<ScanFigures> & { validators?: number } = {}): SummaryRow {
  return { ...FIGURES, name, ...figures };
}

function names(rows: SummaryRow[]): string[] {
  return rows.map((held) => held.name);
}

function summary(fields: Partial<ScheduleSummary>): ScheduleSummary {
  return {
    turns: 0,
    figures: FIGURES,
    clients: [],
    held_from: null,
    choices: { clients: [], countries: [], versions: [] },
    slow: null,
    delinquent: [],
    ...fields,
  };
}

describe("summaryColumns", () => {
  it("splits duration only by country", () => {
    expect(summaryColumns("client", true)).toContain("duration");
    expect(summaryColumns("client", true)).not.toContain("first_slot");
    expect(summaryColumns("country", true)).toContain("first_slot");
    expect(summaryColumns("country", true)).toContain("rest_of_turn");
    expect(summaryColumns("country", true)).not.toContain("duration");
  });

  it("holds slots, validators and skipped in the same places in both", () => {
    expect(summaryColumns("client", true).slice(0, 4)).toEqual(summaryColumns("country", true).slice(0, 4));
  });

  it("leaves tips out where they are not read", () => {
    expect(summaryColumns("client", false)).not.toContain("tips");
  });
});

describe("summaryRows", () => {
  it("names each group and leaves out those with few slots", () => {
    const held = summary({
      clients: [
        { ...FIGURES, client: "Agave", validators: 3 },
        { ...FIGURES, client: null, validators: 1 },
        { ...FIGURES, client: "Few", slots: 7, validators: 1 },
      ],
      countries: [
        { ...FIGURES, country: "DE", validators: 3 },
        { ...FIGURES, country: null, validators: 1 },
        { ...FIGURES, country: "FR", slots: 7, validators: 1 },
      ],
    });
    expect(names(summaryRows(held, "client"))).toEqual(["Agave", "Not in gossip"]);
    expect(names(summaryRows(held, "country"))).toEqual(["Germany", "Unknown"]);
  });

  it("has no country rows from a validator that sends none", () => {
    expect(summaryRows(summary({}), "country")).toEqual([]);
  });
});

describe("sortSummaryRows", () => {
  it("sorts by the column in either direction", () => {
    const rows = [row("A", { slots: 10 }), row("B", { slots: 30 }), row("C", { slots: 20 })];
    expect(names(sortSummaryRows(rows, DEFAULT_SUMMARY_SORT))).toEqual(["B", "C", "A"]);
    expect(names(sortSummaryRows(rows, { column: "slots", descending: false }))).toEqual(["A", "C", "B"]);
  });

  it("keeps rows without a figure last either way", () => {
    const rows = [row("A", { replay_ms: null }), row("B", { replay_ms: 5 }), row("C", { replay_ms: 9 })];
    expect(names(sortSummaryRows(rows, { column: "replay", descending: true }))).toEqual(["C", "B", "A"]);
    expect(names(sortSummaryRows(rows, { column: "replay", descending: false }))).toEqual(["B", "C", "A"]);
  });

  it("orders ties by name either way, so equal rows do not swap", () => {
    const rows = [row("C", { slots: 10 }), row("A", { slots: 10 }), row("B", { slots: 10 })];
    expect(names(sortSummaryRows(rows, { column: "slots", descending: true }))).toEqual(["A", "B", "C"]);
    expect(names(sortSummaryRows(rows, { column: "slots", descending: false }))).toEqual(["A", "B", "C"]);
  });

  it("sorts skipped by share, not count", () => {
    const rows = [row("Big", { slots: 1_000, skipped: 5 }), row("Small", { slots: 10, skipped: 1 })];
    expect(names(sortSummaryRows(rows, { column: "skipped", descending: true }))).toEqual(["Small", "Big"]);
  });

  it("sorts transactions per slot, not in total", () => {
    const rows = [row("Big", { slots: 1_000, transactions: 200_000 }), row("Small", { slots: 10, transactions: 3_000 })];
    expect(names(sortSummaryRows(rows, { column: "transactions", descending: true }))).toEqual(["Small", "Big"]);
  });

  it("sorts names and the first-slot split", () => {
    const rows = [row("B", { first_slot_ms: 300, validators: 1 }), row("A", { first_slot_ms: 400, validators: 2 })];
    expect(names(sortSummaryRows(rows, { column: "name", descending: false }))).toEqual(["A", "B"]);
    expect(names(sortSummaryRows(rows, { column: "name", descending: true }))).toEqual(["B", "A"]);
    expect(names(sortSummaryRows(rows, { column: "first_slot", descending: false }))).toEqual(["B", "A"]);
    expect(names(sortSummaryRows(rows, { column: "validators", descending: true }))).toEqual(["A", "B"]);
  });

  it("leaves the rows it was given in their order", () => {
    const rows = [row("B"), row("A")];
    sortSummaryRows(rows, { column: "name", descending: false });
    expect(names(rows)).toEqual(["B", "A"]);
  });
});

describe("nextSummarySort", () => {
  it("starts a new number column highest first and names A to Z", () => {
    expect(nextSummarySort(DEFAULT_SUMMARY_SORT, "replay")).toEqual({ column: "replay", descending: true });
    expect(nextSummarySort(DEFAULT_SUMMARY_SORT, "name")).toEqual({ column: "name", descending: false });
  });

  it("reverses the same column", () => {
    expect(nextSummarySort(DEFAULT_SUMMARY_SORT, "slots")).toEqual({ column: "slots", descending: false });
  });
});
