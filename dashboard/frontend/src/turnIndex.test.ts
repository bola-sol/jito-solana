import { describe, expect, it } from "vitest";
import { NO_LEADER, type LeaderRef } from "./schedule";
import { HAS_CLOCK, type SlotRange, type WireRow } from "./slotHistory";
import { FoundTurns, liveFloor, TurnIndex, turnNumberOf } from "./turnIndex";
import type { SlotEntry } from "./types";

function entry(slot: number, mine = false, level: SlotEntry["level"] = "finalized"): SlotEntry {
  return { slot, mine, level } as SlotEntry;
}

function run(from: number, to: number, mine = false): SlotEntry[] {
  return Array.from({ length: to - from + 1 }, (_, index) => entry(from + index, mine));
}

function wire(slot: number): WireRow {
  return [4, HAS_CLOCK, 0, 0, 0, 0, 0, 0, slot * 400, 0, 0, 0, 0, 0, 0];
}

/** Rows for `[first, end)`, present except where listed. */
function rows(first: number, end: number, missing: number[] = []): (WireRow | null)[] {
  return Array.from({ length: end - first }, (_, index) =>
    missing.includes(first + index) ? null : wire(first + index),
  );
}

const nobody = (): LeaderRef => NO_LEADER;

function index(): TurnIndex {
  const held = new TurnIndex();
  held.setContext(undefined, undefined, nobody);
  return held;
}

describe("liveFloor", () => {
  it("starts the window at its oldest slot not ours, since ours are kept further back", () => {
    expect(liveFloor([entry(100, true), entry(900), entry(901)])).toBe(900);
  });

  it("falls back to the oldest slot where every one is ours", () => {
    expect(liveFloor([entry(40, true), entry(41, true)])).toBe(40);
    expect(liveFloor([])).toBeNull();
  });
});

describe("TurnIndex", () => {
  it("lists the live window newest first, leaving our kept turns below it out", () => {
    const held = index();
    held.mergeLive([entry(96, true), entry(97, true), ...run(200, 211)]);
    expect(held.floor()).toBe(200);
    expect(held.numbers()).toEqual([52, 51, 50]);
    expect(held.turn(24)).toBeUndefined();
  });

  it("brings history in below the window, in order, as columns decoded when drawn", () => {
    const held = index();
    held.mergeLive(run(200, 207));
    held.addHistory(92, rows(92, 200));
    expect(held.floor()).toBe(92);
    const numbers = held.numbers();
    expect(numbers[0]).toBe(51);
    expect(numbers.at(-1)).toBe(23);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(held.entry(96)?.time_millis).toBe(96 * 400);
    expect(held.entry(97)?.duration_nanos).toBe(400 * 1_000_000);
    expect(held.turn(24)?.slots.map((slot) => slot.slot)).toEqual([99, 98, 97, 96]);
  });

  it("leaves out a history turn with no rows", () => {
    const held = index();
    held.mergeLive(run(200, 203));
    held.addHistory(188, rows(188, 200, [192, 193, 194, 195]));
    expect(held.numbers()).toEqual([50, 49, 47]);
  });

  it("keeps a live entry over the history's copy of the same slot", () => {
    const held = index();
    const kept = entry(202, false, "completed");
    held.mergeLive([entry(201), kept, entry(203)]);
    held.addHistory(196, rows(196, 201));
    expect(held.entry(202)).toBe(kept);
    expect(held.numbers()).toEqual([50, 49]);
  });

  it("keeps slots that have left the live window", () => {
    const held = index();
    held.mergeLive(run(200, 207));
    held.mergeLive(run(204, 211));
    expect(held.entry(200)).toBeDefined();
    expect(held.numbers()).toEqual([52, 51, 50]);
  });

  it("gives a turn a new object only when one of its slots changes", () => {
    const held = index();
    const window = run(200, 207);
    held.mergeLive(window);
    const older = held.turn(50);
    const newer = held.turn(51);
    const changed = [...window.slice(0, 7), entry(207, false, "rooted")];
    expect(held.mergeLive(changed)).toBe(true);
    expect(held.turn(50)).toBe(older);
    expect(held.turn(51)).not.toBe(newer);
    expect(held.mergeLive(changed)).toBe(false);
  });

  it("relabels only the turns whose leader changed", () => {
    const held = index();
    held.mergeLive(run(200, 207));
    const untouched = held.turn(51);
    held.turn(50);
    const named = (slot: number): LeaderRef =>
      turnNumberOf(slot) === 50 ? { key: "Key", name: "Alpha", icon: null } : NO_LEADER;
    held.setContext(undefined, undefined, named);
    expect(held.relabel()).toBe(true);
    expect(held.turn(50)?.leader_name).toBe("Alpha");
    expect(held.turn(51)).toBe(untouched);
    expect(held.relabel()).toBe(false);
  });

  it("starts again when the window jumps past what it holds, as after a reconnect", () => {
    const held = index();
    held.mergeLive(run(200, 207));
    const generation = held.generation;
    held.mergeLive(run(400, 403));
    expect(held.generation).toBe(generation + 1);
    expect(held.floor()).toBe(400);
    expect(held.numbers()).toEqual([100]);
  });

  it("ignores a span that does not reach below the floor", () => {
    const held = index();
    held.mergeLive(run(200, 203));
    expect(held.addHistory(200, rows(200, 204))).toBe(false);
    expect(held.floor()).toBe(200);
  });
});

describe("FoundTurns", () => {
  function range(turnStart: number): SlotRange {
    return { first_slot: turnStart - 8, rows: rows(turnStart - 8, turnStart + 4) };
  }

  it("lists each page's turns in order and reads certificates from the rows before them", () => {
    const found = new FoundTurns("x", false, 400);
    found.add([range(360), range(200)], 200, undefined, undefined);
    found.add([range(40)], null, undefined, undefined);
    expect(found.numbers()).toEqual([90, 50, 10]);
    expect(found.next).toBeNull();
    expect(found.turn(90, nobody)?.slots.map((slot) => slot.slot)).toEqual([363, 362, 361, 360]);
    expect(found.entry(352)?.slot).toBe(352);
  });
});
