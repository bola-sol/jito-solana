import { describe, expect, it } from "vitest";
import { heldAt, type Held } from "./producedPast";
import { headOf, type TurnHead } from "./producedIndex";
import type { FigureRow, LeaderTurn, ProducedBlock } from "./types";

function row(slot: number, transactions = 1): FigureRow {
  return [slot, 1_000 + slot, transactions, 10, 100, 5_000, 1_000, null, 400_000_000];
}

function block(slot: number, transactions = 1): ProducedBlock {
  return { ...headOf(row(slot, transactions)), blockhash: `hash${slot}` } as ProducedBlock;
}

function turnHead(first: number, last: number): TurnHead {
  return { first, last, produced: last - first + 1, drained_millis: 9, since_millis: null, bundles: null };
}

function turn(first: number, last: number, produced = last - first + 1): LeaderTurn {
  return { ...turnHead(first, last), produced } as LeaderTurn;
}

/** Blocks 10 to 19 held now, in turns of two, with final transaction counts of 9. */
function held(floor = 10): Held {
  const heads = new Map(Array.from({ length: 10 }, (_, at) => [10 + at, headOf(row(10 + at, 9))]));
  const turns = new Map(Array.from({ length: 5 }, (_, at) => [10 + 2 * at, turnHead(10 + 2 * at, 11 + 2 * at)]));
  return { heads, turns, floor };
}

const slots = (map: ReadonlyMap<number, unknown>) => [...map.keys()].sort((a, b) => a - b);

describe("heldAt", () => {
  it("takes the recorded blocks over their span and the index's below it", () => {
    const shown = heldAt(held(), [block(14, 3), block(15, 3)], [turn(14, 15, 1)], 10, null);
    expect(slots(shown.heads)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(shown.heads.get(14)?.transactions).toBe(3);
    expect(shown.heads.get(13)?.transactions).toBe(9);
    expect(slots(shown.turns)).toEqual([10, 12, 14]);
    expect(shown.turns.get(14)?.produced).toBe(1);
    expect(shown.missingBefore).toBeNull();
  });

  it("shows a block recorded then and dropped since", () => {
    const shown = heldAt(held(), [block(20)], undefined, 10, null);
    expect(shown.heads.has(20)).toBe(true);
  });

  it("cuts the index at the moment's tip when nothing was recorded", () => {
    const shown = heldAt(held(), undefined, undefined, undefined, 13);
    expect(slots(shown.heads)).toEqual([10, 11, 12, 13]);
    expect(slots(shown.turns)).toEqual([10, 12]);
    expect(heldAt(held(), [], undefined, undefined, null).heads.size).toBe(0);
  });

  it("keeps to the floor in force then, and says what is no longer held", () => {
    expect(slots(heldAt(held(), [block(19)], undefined, 15, null).heads)).toEqual([15, 16, 17, 18, 19]);
    const older = heldAt(held(), [block(19)], undefined, 4, null);
    expect(older.missingBefore).toBe(10);
    expect(slots(older.heads)[0]).toBe(10);
  });
});
