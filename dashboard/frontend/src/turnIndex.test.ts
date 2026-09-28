import { describe, expect, it } from "vitest";
import { NO_LEADER, type LeaderRef } from "./schedule";
import { liveFloor, TurnIndex, turnNumberOf } from "./turnIndex";
import type { SlotEntry } from "./types";

function entry(slot: number, mine = false, level: SlotEntry["level"] = "finalized"): SlotEntry {
  return { slot, mine, level } as SlotEntry;
}

function run(from: number, to: number, mine = false): SlotEntry[] {
  return Array.from({ length: to - from + 1 }, (_, index) => entry(from + index, mine));
}

const nobody = (): LeaderRef => NO_LEADER;

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
    const index = new TurnIndex();
    index.mergeLive([entry(96, true), entry(97, true), ...run(200, 211)], nobody);
    expect(index.floor()).toBe(200);
    expect(index.numbers()).toEqual([52, 51, 50]);
    expect(index.turn(24)).toBeUndefined();
  });

  it("brings history in below the window, where our kept turn then takes its place in order", () => {
    const index = new TurnIndex();
    index.mergeLive([entry(96, true), ...run(200, 207)], nobody);
    index.addHistory(92, [...run(92, 95), entry(96, true), ...run(97, 199)], nobody);
    expect(index.floor()).toBe(92);
    const numbers = index.numbers();
    expect(numbers[0]).toBe(51);
    expect(numbers.at(-1)).toBe(23);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(index.turn(24)?.mine).toBe(true);
  });

  it("keeps a live entry over the history's copy of the same slot", () => {
    const index = new TurnIndex();
    const held = entry(200, false, "completed");
    index.mergeLive([held, ...run(201, 203)], nobody);
    index.addHistory(196, [...run(196, 199), entry(200)], nobody);
    expect(index.entry(200)).toBe(held);
  });

  it("keeps slots that have left the live window", () => {
    const index = new TurnIndex();
    index.mergeLive(run(200, 207), nobody);
    index.mergeLive(run(204, 211), nobody);
    expect(index.entry(200)).toBeDefined();
    expect(index.numbers()).toEqual([52, 51, 50]);
  });

  it("gives a turn a new object only when one of its slots changes", () => {
    const index = new TurnIndex();
    const window = run(200, 207);
    index.mergeLive(window, nobody);
    const older = index.turn(50);
    const newer = index.turn(51);
    const changed = [...window.slice(0, 7), entry(207, false, "rooted")];
    expect(index.mergeLive(changed, nobody)).toBe(true);
    expect(index.turn(50)).toBe(older);
    expect(index.turn(51)).not.toBe(newer);
    expect(index.mergeLive(changed, nobody)).toBe(false);
  });

  it("relabels only the turns whose leader changed", () => {
    const index = new TurnIndex();
    index.mergeLive(run(200, 207), nobody);
    const untouched = index.turn(51);
    const named = (slot: number): LeaderRef =>
      turnNumberOf(slot) === 50 ? { key: "Key", name: "Alpha", icon: null } : NO_LEADER;
    expect(index.relabel(named)).toBe(true);
    expect(index.turn(50)?.leader_name).toBe("Alpha");
    expect(index.turn(51)).toBe(untouched);
    expect(index.relabel(named)).toBe(false);
  });

  it("starts again when the window jumps past what it holds, as after a reconnect", () => {
    const index = new TurnIndex();
    index.mergeLive(run(200, 207), nobody);
    const generation = index.generation;
    index.mergeLive(run(400, 403), nobody);
    expect(index.generation).toBe(generation + 1);
    expect(index.floor()).toBe(400);
    expect(index.numbers()).toEqual([100]);
  });

  it("ignores a span that does not reach below the floor", () => {
    const index = new TurnIndex();
    index.mergeLive(run(200, 203), nobody);
    expect(index.addHistory(200, run(200, 203), nobody)).toBe(false);
    expect(index.floor()).toBe(200);
  });
});
