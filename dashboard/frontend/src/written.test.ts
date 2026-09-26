import { describe, expect, it } from "vitest";
import type { MissList, MissPlace, MissRow, MissWriter, WrittenList, WrittenRow } from "./types";
import {
  averageLeftOut,
  leftUsOutLine,
  NO_GOSSIP_AFTER_MILLIS,
  writerFigures,
  writerKinds,
  writtenFigures,
  writtenKinds,
  writtenLine,
} from "./written";

function row(identity: string, ours: number, everywhere: number, delinquent = false, noGossip = false): WrittenRow {
  return {
    identity,
    name: null,
    client: null,
    version: null,
    ip: null,
    left_out_of_ours: ours,
    left_out_everywhere: everywhere,
    last_vote: null,
    delinquent,
    heard_millis: null,
    no_gossip: noGossip,
  };
}

function list(certificates: number, carried_all: number, rows: WrittenRow[], rewarded = 1000): WrittenList {
  return { rewarded, certificates, carried_all, rows };
}

describe("the written figures", () => {
  it("keeps the validators faring worse in ours, widest gap first", () => {
    // Of 100 we wrote and 1,000 seen: a left out of 30 and 20, b of 20 and 200 (the same share), c
    // of 50 and 10.
    const figures = writtenFigures(list(100, 60, [row("a", 30, 20), row("b", 20, 200), row("c", 50, 10)]));
    expect(figures.map((figure) => figure.row.identity)).toEqual(["c", "a"]);
    expect(figures[0].kind).toBe("worse");
    expect(figures[0].ours).toBeCloseTo(0.5);
    expect(figures[0].everywhere).toBeCloseTo(0.01);
  });

  it("keeps a validator missing everywhere, after the ones faring worse", () => {
    const figures = writtenFigures(list(100, 60, [row("down", 100, 950), row("a", 30, 20), row("gone", 100, 1000)]));
    expect(figures.map((figure) => figure.row.identity)).toEqual(["a", "gone", "down"]);
    expect(writtenKinds(figures)).toEqual({ worse: 1, missing: 2, delinquent: 0, "no-gossip": 0 });
  });

  it("names a delinquent validator instead of calling it worse or missing, after both", () => {
    const figures = writtenFigures(
      list(100, 60, [row("stopped", 38, 281, true), row("a", 30, 20), row("gone", 100, 1000, true), row("down", 100, 950)]),
    );
    expect(figures.map((figure) => [figure.row.identity, figure.kind])).toEqual([
      ["a", "worse"],
      ["down", "missing"],
      ["gone", "delinquent"],
      ["stopped", "delinquent"],
    ]);
    expect(writtenKinds(figures)).toEqual({ worse: 1, missing: 1, delinquent: 2, "no-gossip": 0 });
  });

  it("names a validator gone from gossip ahead of delinquent, listed last", () => {
    const figures = writtenFigures(
      list(100, 60, [
        row("down", 100, 1000, true, true),
        row("stuck", 100, 1000, true),
        row("quiet", 38, 281, false, true),
      ]),
    );
    expect(figures.map((figure) => [figure.row.identity, figure.kind])).toEqual([
      ["stuck", "delinquent"],
      ["down", "no-gossip"],
      ["quiet", "no-gossip"],
    ]);
    expect(writtenKinds(figures)).toEqual({ worse: 0, missing: 0, delinquent: 1, "no-gossip": 2 });
  });

  it("leaves out a delinquent validator it would not have listed", () => {
    expect(writtenFigures(list(100, 91, [row("new", 2, 3, true)]))).toEqual([]);
  });

  it("does not call a few misses faring worse", () => {
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

function writer(identity: string, certificates: number, misses: number): MissWriter {
  return { identity, name: null, client: null, version: null, ip: null, certificates, misses };
}

function misses(writers: MissWriter[], places: [number, MissPlace][], rewarded: number): MissList {
  const rows: MissRow[] = places.map(([at, place], slot) => ({
    slot,
    time_millis: null,
    place,
    paid_ranks: 0,
    others: [],
    writer: at,
    vote: null,
  }));
  return {
    epoch: 1,
    since_slot: 0,
    rewarded,
    ranks: 10,
    writers,
    validators: [],
    rows,
    written: list(0, 0, []),
  };
}

const NOW = 1_790_000_000_000;

describe("the writer figures", () => {
  // 40 of 1,000 left us out: 4% on average.
  const writers = [writer("far", 50, 25), writer("near", 100, 8), writer("few", 20, 9), writer("some", 100, 12)];
  const places: [number, MissPlace][] = [
    ...Array.from({ length: 25 }, (_, i): [number, MissPlace] => [0, i < 20 ? "lost" : "late"]),
    ...Array.from({ length: 8 }, (): [number, MissPlace] => [1, "lost"]),
    ...Array.from({ length: 7 }, (): [number, MissPlace] => [3, "late"]),
  ];
  const list40 = misses(writers, places, 1_000);
  const everyoneHeard = () => NOW;

  it("averages over every certificate read", () => {
    expect(averageLeftOut(list40)).toBeCloseTo(0.04);
    expect(leftUsOutLine(list40)).toBe("40 of 1,000 left us out · 4.0% on average");
    expect(averageLeftOut(misses([], [], 0))).toBeNull();
  });

  it("keeps writers ten times and five points above the average, widest first", () => {
    const figures = writerFigures(list40, everyoneHeard, NOW);
    // near is under five points above, few under ten times.
    expect(figures.map((figure) => [figure.writer.identity, figure.lost])).toEqual([
      ["far", 20],
      ["some", 0],
    ]);
    expect(figures[0].share).toBeCloseTo(0.5);
    expect(figures[1].kind).toBe("worse");
  });

  it("names a writer gone from gossip once the peer list is in, listed last", () => {
    const heard = (identity: string) =>
      identity === "far" ? null : identity === "some" ? NOW - NO_GOSSIP_AFTER_MILLIS - 1 : NOW;
    const figures = writerFigures(list40, heard, NOW);
    expect(figures.map((figure) => figure.kind)).toEqual(["no-gossip", "no-gossip"]);
    expect(writerKinds(figures)).toEqual({ worse: 0, "no-gossip": 2 });
    expect(writerFigures(list40, () => undefined, NOW).map((figure) => figure.kind)).toEqual(["worse", "worse"]);
  });
});
