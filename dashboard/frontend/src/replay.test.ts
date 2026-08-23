import { describe, expect, it } from "vitest";
import { cpuRows, serialRows, verifyRows } from "./replay";
import type { ReplayWindow } from "./types";

/** A window shaped like a real mainnet one, to be overridden a field at a time. */
function window(over: Partial<ReplayWindow> = {}): ReplayWindow {
  return {
    slots: 200,
    transactions: 1436,
    fetch: 2556,
    confirming: 19852,
    completing: 835,
    serial_peak: 78000,
    poh_verify: 38839,
    tx_verify: 13482,
    dispatch: 13123,
    execute: 205648,
    bytecode: 146700,
    serialising: 24900,
    deserialising: 6300,
    load: 33785,
    store: 9700,
    program_cache: 8675,
    compiling: 8900,
    program_cache_peak: 44546,
    checking: 5900,
    other: 5700,
    cpu_peak: 500000,
    ...over,
  };
}

const rowOf = (rows: ReturnType<typeof serialRows>, key: string) =>
  rows.find((row) => row.key === key)!;

describe("serialRows", () => {
  it("draws the three spans against their own sum", () => {
    // They are disjoint spans measured one after another, so they partition.
    const rows = serialRows(window());
    const total = rows.reduce((sum, row) => sum + row.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("leads with verifying, which is the bulk of it", () => {
    const rows = serialRows(window());
    expect(rows[0].key).toBe("confirming");
    expect(rowOf(rows, "confirming").share).toBeGreaterThan(0.8);
  });
});

describe("verifyRows", () => {
  it("is drawn against the three added, not against the window they ran in", () => {
    // Against `confirming` these would come to well over three times it: the
    // jobs overlap each other and each runs across many threads. Against their
    // own sum they answer the only question they can, which is which costs
    // more.
    const rows = verifyRows(window());
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);
    expect(rowOf(rows, "poh").share).toBeGreaterThan(rowOf(rows, "signatures").share);
  });

  it("would exceed the window it happened in", () => {
    // Stated as a test because it is the reason the section is labelled
    // relative: if this ever stops being true the labelling is over-cautious,
    // and if the rows are ever drawn against `confirming` it will show.
    const w = window();
    expect(w.poh_verify + w.tx_verify + w.dispatch).toBeGreaterThan(w.confirming);
  });
});

describe("cpuRows", () => {
  it("partitions the phases and leaves the parts inside them", () => {
    // The phases are sequential within a thread, so they add up. The `part`
    // rows sit inside `execute` and are drawn against the same total, so they
    // are deliberately not in that sum.
    const rows = cpuRows(window());
    const phases = rows.filter((row) => row.kind === "phase");
    expect(phases.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 10);
    expect(rowOf(rows, "execute").share).toBeGreaterThan(0.7);
  });

  it("keeps the parts of execution inside it", () => {
    const rows = cpuRows(window());
    const parts = ["bytecode", "serialising", "deserialising"].map((key) => rowOf(rows, key));
    const inside = parts.reduce((sum, row) => sum + row.micros, 0);
    expect(inside).toBeLessThan(window().execute);
    expect(parts.every((row) => row.kind === "part")).toBe(true);
  });

  it("carries a peak on compiling and on nothing else", () => {
    // The one row whose spread is worth more than its average: on this
    // validator the worst slot compiles for five times the ordinary one.
    const rows = cpuRows(window());
    expect(rowOf(rows, "compiling").peak).toBe(44546);
    expect(rows.filter((row) => row.peak !== undefined)).toHaveLength(1);
  });

  it("divides nothing by nothing on a validator that has done none of it", () => {
    const rows = cpuRows(
      window({ execute: 0, load: 0, store: 0, program_cache: 0, checking: 0, other: 0 }),
    );
    expect(rows.every((row) => row.share === 0)).toBe(true);
  });
});
