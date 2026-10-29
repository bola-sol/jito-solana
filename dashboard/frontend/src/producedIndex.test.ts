import { describe, expect, it } from "vitest";
import { ProducedIndex, headOf } from "./producedIndex";
import type { FigureRow, FiguresPage, LeaderTurn, ProducedBlock } from "./types";

function row(slot: number, transactions = 1): FigureRow {
  return [slot, 1_000 + slot, transactions, 10, 100, 5_000, 1_000, null, 400_000_000];
}

function page(slots: number[], next: number | null, floor = 0, held = slots.length): FiguresPage {
  return { figures: slots.map((slot) => row(slot)), turns: [], held, floor, next };
}

function block(slot: number, transactions = 1): ProducedBlock {
  return { ...headOf(row(slot, transactions)), blockhash: `hash${slot}` } as ProducedBlock;
}

function turn(first: number, last: number): LeaderTurn {
  return { first, last, produced: last - first + 1, drained_millis: 9, since_millis: null } as LeaderTurn;
}

describe("headOf", () => {
  it("reads each figure from its place in the row", () => {
    expect(headOf([7, 8, 9, 10, 11, 12, 13, 14, 15])).toEqual({
      slot: 7,
      slot_time_millis: 8,
      transactions: 9,
      block_cost: 10,
      block_cost_limit: 11,
      total_fees: 12,
      priority_fees: 13,
      tips: 14,
      duration_nanos: 15,
    });
  });
});

describe("ProducedIndex", () => {
  it("reads every page, each below the last", async () => {
    const index = new ProducedIndex();
    const asked: (number | undefined)[] = [];
    const pages = new Map<number | undefined, FiguresPage>([
      [undefined, page([30, 29], 29, 0, 3)],
      [29, page([28], null, 0, 3)],
    ]);
    let changes = 0;
    await index.readAll(
      (before) => {
        asked.push(before);
        return Promise.resolve(pages.get(before) ?? null);
      },
      () => (changes += 1),
    );
    expect(asked).toEqual([undefined, 29]);
    expect([...index.heads.keys()].sort()).toEqual([28, 29, 30]);
    expect(index.complete).toBe(true);
    expect(index.held).toBe(3);
    expect(changes).toBeGreaterThan(0);
  });

  it("stops at a page that did not come, and says so", async () => {
    const index = new ProducedIndex();
    await index.readAll(() => Promise.resolve(null), () => undefined);
    expect(index.failed).toBe(true);
    expect(index.complete).toBe(false);
    await index.readAll(() => Promise.reject(new Error("connection lost")), () => undefined);
    expect(index.failed).toBe(true);
  });

  it("drops a read overtaken by a reset", async () => {
    const index = new ProducedIndex();
    let answer: (page: FiguresPage) => void = () => undefined;
    const read = index.readAll(
      () => new Promise((resolve) => (answer = resolve)),
      () => undefined,
    );
    index.reset();
    answer(page([5], null));
    await read;
    expect(index.heads.size).toBe(0);
    expect(index.complete).toBe(false);
  });

  it("takes live blocks and turns, and moves only when something differs", () => {
    const index = new ProducedIndex();
    index.mergeLive([block(4), block(5)], [turn(4, 7)]);
    const after = index.revision;
    index.mergeLive([block(4), block(5)], [turn(4, 7)]);
    expect(index.revision).toBe(after);
    index.mergeLive([block(5, 99)], []);
    expect(index.revision).toBeGreaterThan(after);
    expect(index.heads.get(5)?.transactions).toBe(99);
    expect(index.turns.get(4)?.last).toBe(7);
  });

  it("keeps a turn's bundle count, and none where the stage does not count them", () => {
    const index = new ProducedIndex();
    index.addPage({ figures: [], turns: [[2, 5, 4, 1, null, 38], [8, 11, 4, 2, 1, null]], held: 0, floor: 0, next: null });
    expect(index.turns.get(2)?.bundles).toBe(38);
    expect(index.turns.get(8)?.bundles).toBeNull();
  });

  it("lets go of what falls below the floor, and takes nothing below it after", () => {
    const index = new ProducedIndex();
    index.addPage({ figures: [row(3), row(9)], turns: [[2, 5, 4, 1, null, null]], held: 2, floor: 0, next: null });
    index.setFloor(6);
    expect([...index.heads.keys()]).toEqual([9]);
    expect(index.turns.size).toBe(0);
    index.mergeLive([block(4)], [turn(2, 5)]);
    expect(index.heads.has(4)).toBe(false);
    index.setFloor(2);
    expect(index.floor).toBe(6);
  });
});
