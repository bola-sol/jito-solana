import { describe, expect, it } from "vitest";
import {
  aboutClock,
  expectedAt,
  FUTURE_PAGE,
  futureNumbers,
  lastTurnOf,
  ourFutureNumbers,
  raiseTop,
} from "./future";
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
