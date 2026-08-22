import { describe, expect, it } from "vitest";
import { matchesQuery, turnKey, turnsOf } from "./schedule";
import type { SlotEntry } from "./types";

function held(slot: number, leader = "alice", name: string | null = null): SlotEntry {
  return {
    slot,
    level: "completed",
    leader,
    leader_name: name,
    leader_icon: null,
    mine: false,
    block: null,
    duration_nanos: null,
  };
}

describe("turnsOf", () => {
  it("draws a turn whole from its first slot alone", () => {
    // The other three share a leader by definition, so they are rows waiting to
    // be filled. Growing the card as each arrives would move everything below.
    const [turn] = turnsOf([held(100)]);
    expect(turn.slots.map((slot) => slot.slot)).toEqual([103, 102, 101, 100]);
    expect(turn.slots.map((slot) => slot.entry !== null)).toEqual([false, false, false, true]);
  });

  it("fills the rows where they stand as the slots arrive", () => {
    const [turn] = turnsOf([held(100), held(101)]);
    expect(turn.slots).toHaveLength(4);
    expect(turn.slots.map((slot) => slot.entry !== null)).toEqual([false, false, true, true]);
  });

  it("splits a leader drawn twice in a row into two turns", () => {
    // Eight consecutive slots is two turns. Run together the card is twice the
    // height of every other, and a list of cards of different heights has no
    // fixed place to hold.
    const slots = [96, 97, 98, 99, 100, 101, 102, 103].map((slot) => held(slot));
    const turns = turnsOf(slots);
    expect(turns.map((turn) => turn.slots.length)).toEqual([4, 4]);
    expect(turns[0].slots.map((slot) => slot.slot)).toEqual([103, 102, 101, 100]);
  });

  it("puts the newest turn first", () => {
    const turns = turnsOf([held(100), held(200)]);
    expect(turns.map((turn) => turn.slots.at(-1)?.slot)).toEqual([200, 100]);
  });

  it("invents no rows for slots older than the window", () => {
    // A turn the list begins part way through keeps the slots there are. The
    // missing ones happened before anything was watching, not after.
    const [turn] = turnsOf([held(102), held(103)]);
    expect(turn.slots.map((slot) => slot.slot)).toEqual([103, 102]);
  });

  it("takes the leader from whichever slot has one", () => {
    // The schedule is not always resolved for every slot in a turn.
    const unknown = { ...held(100), leader: null };
    const [turn] = turnsOf([unknown, held(101, "bob")]);
    expect(turn.leader).toBe("bob");
  });

  it("has nothing to say about an empty list", () => {
    expect(turnsOf([])).toEqual([]);
  });
});

describe("matchesQuery", () => {
  const [turn] = turnsOf([held(430789128, "J7v9KQ8s", "Staking Facilities")]);

  it("matches a name whatever its case", () => {
    expect(matchesQuery(turn, "staking")).toBe(true);
    expect(matchesQuery(turn, "STAKING")).toBe(true);
  });

  it("matches part of the leader key", () => {
    expect(matchesQuery(turn, "J7v9")).toBe(true);
  });

  it("matches a slot in the turn", () => {
    expect(matchesQuery(turn, "430789128")).toBe(true);
  });

  it("matches everything when nothing was asked", () => {
    expect(matchesQuery(turn, "")).toBe(true);
    expect(matchesQuery(turn, "   ")).toBe(true);
  });

  it("does not match something absent", () => {
    expect(matchesQuery(turn, "nansen")).toBe(false);
  });
});

describe("turnKey", () => {
  it("names a turn by its own first slot, not its position", () => {
    // Turns arrive above and fall off below constantly; a name that moved with
    // them would identify nothing.
    const [turn] = turnsOf([held(100), held(101)]);
    expect(turnKey(turn)).toBe("turn:100");
  });
});
