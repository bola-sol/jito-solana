import { describe, expect, it } from "vitest";
import type { MissList, WrittenRow } from "./types";
import { writtenFigures, writtenKinds, writtenLine } from "./written";

function row(identity: string, ours: number, everywhere: number): WrittenRow {
  return { identity, name: null, client: null, version: null, ip: null, left_out_of_ours: ours, left_out_everywhere: everywhere };
}

function list(certificates: number, carried_all: number, rows: WrittenRow[], rewarded = 1000): MissList {
  return {
    epoch: 1,
    since_slot: 0,
    rewarded,
    ranks: rows.length,
    writers: [],
    validators: [],
    rows: [],
    written: { certificates, carried_all, rows },
  };
}

describe("the written figures", () => {
  it("keeps the validators faring worse in ours, widest gap first", () => {
    // Of 100 certificates we wrote, out of 1,000 seen: a left out of 30 of
    // ours and 20 everywhere, b of 20 and 200 (the same share in both), c of
    // 50 and 10.
    const figures = writtenFigures(list(100, 60, [row("a", 30, 20), row("b", 20, 200), row("c", 50, 10)]));
    expect(figures.map((figure) => figure.row.identity)).toEqual(["c", "a"]);
    expect(figures[0].kind).toBe("worse");
    expect(figures[0].ours).toBeCloseTo(0.5);
    expect(figures[0].everywhere).toBeCloseTo(0.01);
  });

  it("keeps a validator missing everywhere, after the ones faring worse", () => {
    const figures = writtenFigures(list(100, 60, [row("down", 100, 950), row("a", 30, 20), row("gone", 100, 1000)]));
    expect(figures.map((figure) => figure.row.identity)).toEqual(["a", "gone", "down"]);
    expect(writtenKinds(figures)).toEqual({ worse: 1, missing: 2 });
  });

  it("does not call a few misses faring worse", () => {
    // Nine of a hundred is under the floor, whatever the gap.
    expect(writtenFigures(list(100, 91, [row("a", 9, 0)]))).toEqual([]);
  });

  it("has nothing to say before we wrote a certificate", () => {
    expect(writtenFigures(list(0, 0, [row("a", 0, 0)]))).toEqual([]);
    expect(writtenLine(list(0, 0, []))).toBe("none written yet this epoch");
  });

  it("words the line", () => {
    expect(writtenLine(list(4312, 4140, []))).toBe("4,312 written · 96.0% carried everyone");
  });
});
