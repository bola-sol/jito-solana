import { describe, expect, it } from "vitest";
import {
  aboutClock,
  expectedAt,
  FUTURE_PAGE,
  futureNumbers,
  gapOf,
  leaderTurns,
  nearestTurn,
  turnGaps,
  lastTurnOf,
  ourFutureNumbers,
  raiseTop,
  FutureMatches,
  futureWindow,
} from "./future";
import { NO_RANGE, type RangeBounds } from "./scheduleConditions";
import type { EpochInfo } from "./types";

const epoch: EpochInfo = {
  epoch: 900,
  start_slot: 388_800_000,
  end_slot: 389_231_999,
  slots_in_epoch: 432_000,
  my_leader_slots: [388_800_100, 388_800_101, 388_800_102, 388_800_103, 388_900_000, 388_900_001],
  leaders: [],
  turns: [],
  block_cost_limit: 0,
  account_cost_limit: 0,
};

describe("futureWindow", () => {
  const range = (fill: Partial<RangeBounds>): RangeBounds => ({ ...NO_RANGE, ...fill });
  const now = 1_000_000;

  it("runs to the epoch's end with nothing asked", () => {
    expect(futureWindow(NO_RANGE, 9_000, undefined, undefined, now)).toEqual({ from_slot: null, to_slot: 9_000 });
  });

  it("keeps a slot range inside the epoch", () => {
    expect(futureWindow(range({ from_slot: 100, to_slot: 20_000 }), 9_000, 50, 400_000_000, now)).toEqual({
      from_slot: 100,
      to_slot: 9_000,
    });
  });

  it("places times as the slots expected then", () => {
    const window = futureWindow(range({ from_millis: now + 4_000, to_millis: now + 8_000 }), 9_000, 100, 400_000_000, now);
    expect(window).toEqual({ from_slot: 110, to_slot: 120 });
  });

  it("is null for times it cannot place and for a range holding nothing", () => {
    expect(futureWindow(range({ to_millis: now }), 9_000, undefined, undefined, now)).toBeNull();
    expect(futureWindow(range({ from_slot: 9_001 }), 9_000, 100, 400_000_000, now)).toBeNull();
  });
});

describe("FutureMatches", () => {
  const leader = { identity: "a", client: "Agave", version: "4.4.1", ip: null, country: "DE", stake: 5 };

  it("holds pages in order and drops turns passed", () => {
    const held = new FutureMatches(40, { from_slot: null, to_slot: 99 });
    held.add({ turns: [10, 12], leaders: [leader], next: 56, rest: 3, named: null });
    held.add({ turns: [14], leaders: [], next: null, rest: 0, named: null });
    expect(held.numbers(9)).toEqual([14, 12, 10]);
    expect(held.numbers(12)).toEqual([14]);
    expect(held.next).toBeNull();
    expect(held.rest).toBe(0);
  });

  it("keeps a leader's object across pages", () => {
    const held = new FutureMatches(40, { from_slot: null, to_slot: 99 });
    held.add({ turns: [10], leaders: [leader], next: 44, rest: 1, named: "a" });
    const first = held.peers.get("a");
    held.add({ turns: [11], leaders: [{ ...leader }], next: null, rest: 0, named: "a" });
    expect(held.peers.get("a")).toBe(first);
    expect(first).toEqual({ ...leader, name: null, icon: null });
  });
});

describe("a validator's turns and gaps", () => {
  // Turns of four slots: a at 0, 2 and 3; b at 1, 4 and 5; then 16 slots to the epoch's end.
  const held: EpochInfo = { ...epoch, start_slot: 400, end_slot: 439, leaders: ["a", "b"], turns: [0, 1, 0, 0, 1, 1] };

  it("runs a gap to the leader's next turn or the epoch's end", () => {
    expect([...turnGaps(held)]).toEqual([4, 8, 0, 24, 0, 16]);
    expect(gapOf(turnGaps(held), held, 101)).toBe(8);
    expect(gapOf(turnGaps(held), held, 106)).toBeNull();
    expect(gapOf(null, held, 101)).toBeNull();
  });

  it("lists a leader's turn numbers", () => {
    expect(leaderTurns(held, "b")).toEqual([101, 104, 105]);
    expect(leaderTurns(held, "nobody")).toEqual([]);
  });

  it("finds the nearest turn", () => {
    expect(nearestTurn([10, 20, 30], 5)).toBe(0);
    expect(nearestTurn([10, 20, 30], 14)).toBe(0);
    expect(nearestTurn([10, 20, 30], 16)).toBe(1);
    expect(nearestTurn([10, 20, 30], 99)).toBe(2);
    expect(nearestTurn([], 5)).toBe(0);
  });
});

describe("lastTurnOf", () => {
  it("is the turn holding the epoch's last slot", () => {
    expect(lastTurnOf(epoch)).toBe(97_307_999);
    expect(lastTurnOf(epoch) * 4 + 3).toBe(epoch.end_slot);
  });
});

describe("raiseTop", () => {
  it("starts a page ahead of the live turn", () => {
    expect(raiseTop(null, 1000, 1_000_000)).toBe(1000 + FUTURE_PAGE);
  });

  it("keeps a top already further out", () => {
    expect(raiseTop(5000, 1000, 1_000_000)).toBe(5000);
  });

  it("moves up with the live turn once within a page of it", () => {
    expect(raiseTop(1000 + FUTURE_PAGE, 1001, 1_000_000)).toBe(1001 + FUTURE_PAGE);
  });

  it("stops at the epoch's last turn", () => {
    expect(raiseTop(null, 1000, 1100)).toBe(1100);
    expect(raiseTop(9000, 1000, 1100)).toBe(1100);
  });
});

describe("futureNumbers", () => {
  it("lists the turns after the live one, newest first", () => {
    expect(futureNumbers(10, 13)).toEqual([13, 12, 11]);
  });

  it("is empty at the epoch's last turn", () => {
    expect(futureNumbers(10, 10)).toEqual([]);
  });
});

describe("ourFutureNumbers", () => {
  it("lists each of our turns after the live one once, newest first", () => {
    expect(ourFutureNumbers(epoch, 97_200_000)).toEqual([97_225_000, 97_200_025]);
  });

  it("leaves out the live turn itself", () => {
    expect(ourFutureNumbers(epoch, 97_200_025)).toEqual([97_225_000]);
  });
});

describe("expectedAt", () => {
  it("counts slots at the given slot time", () => {
    expect(expectedAt(110, 100, 1_000_000, 400_000_000)).toBe(1_004_000);
  });
});

describe("aboutClock", () => {
  it("leaves the day out on the same day", () => {
    const now = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const later = new Date(2026, 10, 2, 13, 5, 40).getTime();
    expect(aboutClock(later, now)).toMatch(/^≈ 13:05$/);
  });

  it("names the weekday on another day", () => {
    const now = new Date(2026, 10, 2, 23, 0, 0).getTime();
    const tomorrow = new Date(2026, 10, 3, 1, 30, 0).getTime();
    expect(aboutClock(tomorrow, now)).toMatch(/^≈ \S+ 01:30$/);
  });
});
