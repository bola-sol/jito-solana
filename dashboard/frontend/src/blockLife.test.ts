import { describe, expect, it } from "vitest";
import {
  clockNote,
  LIFE_FROM_MS,
  LIFE_SPAN_MS,
  lifeAt,
  lifeMarks,
  lifeSegments,
  lifeTicks,
  lifeWindow,
  replayedAt,
  slowNote,
} from "./blockLife";
import type { BlockLifeStages, SlowBlock } from "./types";

const full: BlockLifeStages = { building: 148, reaching: 103, replay: 9, vote: 3, finalize: 58 };
const untimed: BlockLifeStages = { building: 150, reaching: 102, replay: 8, vote: null, finalize: null };

function slow(over: Partial<SlowBlock>): SlowBlock {
  return {
    slot: 1,
    stages: untimed,
    total: null,
    leader_clock_off: null,
    cause: "reaching",
    shreds: 200,
    repaired: 0,
    recovered: 0,
    ...over,
  };
}

describe("lifeAt", () => {
  it("places the leader's close and clamps to the track", () => {
    expect(lifeAt(0)).toBeCloseTo((-LIFE_FROM_MS / LIFE_SPAN_MS) * 100);
    expect(lifeAt(LIFE_FROM_MS - 50)).toBe(0);
    expect(lifeAt(10_000)).toBe(100);
  });
});

describe("lifeSegments", () => {
  it("chains the stages from the close and draws the building before it", () => {
    const segments = lifeSegments(full);
    expect(segments.map((segment) => segment.part)).toEqual(["building", "reaching", "replay", "vote", "finalize"]);
    expect(segments[0]?.left).toBeCloseTo(lifeAt(-148));
    expect(segments[0]!.left + segments[0]!.width).toBeCloseTo(lifeAt(0));
    expect(segments[2]?.left).toBeCloseTo(lifeAt(103));
    expect(segments[4]!.left + segments[4]!.width).toBeCloseTo(lifeAt(173));
  });

  it("stops at replay where the vote was not timed", () => {
    expect(lifeSegments(untimed).map((segment) => segment.part)).toEqual(["building", "reaching", "replay"]);
  });

  it("runs on to finalization where this node did not vote", () => {
    const parts = lifeSegments({ ...full, vote: null, finalize: 61 });
    expect(parts.map((segment) => segment.part)).toEqual(["building", "reaching", "replay", "finalize"]);
    expect(parts[3]!.left + parts[3]!.width).toBeCloseTo(lifeAt(173));
  });

  it("cuts a stage that runs off the end of the track", () => {
    const late = lifeSegments({ ...untimed, reaching: 900 });
    expect(late[1]!.left + late[1]!.width).toBe(100);
  });
});

describe("lifeMarks", () => {
  it("marks where each median stage ends", () => {
    expect(lifeMarks(full).map((mark) => Math.round(mark * 100) / 100)).toEqual(
      [-148, 103, 112, 115, 173].map((ms) => Math.round(lifeAt(ms) * 100) / 100),
    );
  });
});

describe("lifeTicks", () => {
  it("labels the close and every hundred milliseconds as major", () => {
    const ticks = lifeTicks();
    expect(ticks.find((tick) => tick.label === "closed")?.minor).toBe(false);
    expect(ticks.filter((tick) => !tick.minor).map((tick) => tick.label)).toEqual([
      "-200",
      "-100",
      "closed",
      "100",
      "200",
      "300",
    ]);
    expect(ticks.filter((tick) => tick.before).map((tick) => tick.label)).toEqual(["-200", "-150", "-100", "-50"]);
  });
});

describe("replayedAt", () => {
  it("adds reaching us and replay", () => {
    expect(replayedAt(full)).toBe(112);
    expect(replayedAt({ ...full, replay: null })).toBeNull();
  });
});

describe("lifeWindow", () => {
  it("says an hour once the medians cover one", () => {
    expect(lifeWindow(60)).toBe("the last hour");
    expect(lifeWindow(12)).toBe("the last 12 min");
  });
});

describe("slowNote", () => {
  it("gives the repaired and recovered shares for a late block", () => {
    expect(slowNote(slow({ repaired: 62, recovered: 12 }))).toBe("late: 31% repaired, 6% recovered");
    expect(slowNote(slow({ repaired: 0, recovered: 0 }))).toBe("reached us late");
  });

  it("names the stage that ran long", () => {
    expect(slowNote(slow({ cause: "replay", stages: { ...untimed, replay: 41 } }))).toBe("replay 41 ms");
    expect(slowNote(slow({ cause: "vote", stages: { ...full, vote: 22 } }))).toBe("our vote 22 ms after replay");
    expect(slowNote(slow({ cause: "finalize", stages: { ...full, finalize: 118 } }))).toBe(
      "finalized 118 ms after our vote",
    );
    expect(slowNote(slow({ cause: "finalize", stages: { ...full, vote: null, finalize: 90 } }))).toBe(
      "finalized 90 ms after replay",
    );
  });
});

describe("clockNote", () => {
  it("names the way on the row and keeps the amount for the tooltip", () => {
    expect(clockNote(slow({ leader_clock_off: 870 }))).toEqual({
      label: "leader clock behind",
      tip: "About 870 ms behind ours, so this row starts from our first shred.",
    });
    expect(clockNote(slow({ leader_clock_off: -1_240 }))?.label).toBe("leader clock ahead");
    expect(clockNote(slow({ leader_clock_off: -1_240 }))?.tip).toContain("1,240 ms ahead");
  });

  it("says nothing for a leader whose close is plausible", () => {
    expect(clockNote(slow({}))).toBeNull();
  });
});
