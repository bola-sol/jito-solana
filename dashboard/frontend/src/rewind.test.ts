import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readMoment, Rewind } from "./rewind";
import { Ring } from "./ring";
import type { Envelope, SlotEntry } from "./types";

beforeAll(() => {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    now: 1_000_000,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function slot(number: number): Envelope {
  const entry: SlotEntry = {
    slot: number,
    level: "completed",
    block: null,
    duration_nanos: null,
    time_millis: null,
    shreds: null,
    replayed_millis: null,
    reward: null,
    left_out: null,
    mine: false,
  };
  return { topic: "slot", key: "update", value: entry } as Envelope;
}

const newest = (rewind: Rewind, live: boolean) => (live ? rewind.live : rewind.view).getSlots().at(-1)?.slot;

/** A slot a second for `seconds`, from slot 0. */
function feed(rewind: Rewind, seconds: number, from = 0): void {
  for (let i = 0; i < seconds; i += 1) {
    rewind.deliver(slot(from + i), 100);
    vi.advanceTimersByTime(1_000);
  }
}

describe("pause", () => {
  it("holds the view while the live store keeps applying", () => {
    const rewind = new Rewind();
    feed(rewind, 5);
    rewind.pause();
    expect(rewind.getState().live).toBe(false);
    expect(newest(rewind, false)).toBe(4);
    feed(rewind, 5, 5);
    expect(newest(rewind, false)).toBe(4);
    expect(newest(rewind, true)).toBe(9);
    expect(rewind.view.now()).toBe(1_005_000);
  });

  it("returns to live", () => {
    const rewind = new Rewind();
    feed(rewind, 2);
    rewind.pause();
    rewind.goLive();
    expect(rewind.getState()).toMatchObject({ live: true, playing: false });
  });
});

describe("seek", () => {
  it("shows an earlier moment and clamps to what is held and to now", () => {
    const rewind = new Rewind();
    feed(rewind, 20);
    rewind.seek(1_005_500);
    expect(newest(rewind, false)).toBe(5);
    rewind.seek(0);
    expect(rewind.at()).toBe(1_000_000);
    expect(newest(rewind, false)).toBe(0);
    rewind.seek(Number.MAX_SAFE_INTEGER);
    expect(rewind.at()).toBe(Date.now());
    expect(newest(rewind, false)).toBe(19);
  });

  it("bumps the generation once a move back settles, and not for a move forward", () => {
    const rewind = new Rewind();
    feed(rewind, 20);
    rewind.seek(1_010_000);
    rewind.seek(1_005_000);
    expect(rewind.getGeneration()).toBe(0);
    rewind.settle();
    expect(rewind.getGeneration()).toBe(1);
    rewind.seek(1_008_000);
    rewind.settle();
    expect(rewind.getGeneration()).toBe(1);
  });
});

describe("play", () => {
  it("moves the view forward at the speed chosen and goes live on catching up", () => {
    const rewind = new Rewind();
    feed(rewind, 30);
    rewind.seek(1_010_000);
    rewind.setSpeed(4);
    rewind.play();
    // Two seconds at four times is eight.
    vi.advanceTimersByTime(2_000);
    expect(rewind.at()).toBe(1_018_000);
    expect(newest(rewind, false)).toBe(18);
    // Fourteen seconds behind gains three a second at four times.
    vi.advanceTimersByTime(5_000);
    expect(rewind.getState().live).toBe(true);
  });

  it("keeps its place when the speed changes mid-play", () => {
    const rewind = new Rewind();
    feed(rewind, 60);
    rewind.seek(1_010_000);
    rewind.play();
    vi.advanceTimersByTime(2_000);
    rewind.setSpeed(16);
    expect(rewind.at()).toBe(1_012_000);
    vi.advanceTimersByTime(1_000);
    expect(rewind.at()).toBe(1_028_000);
  });

  it("runs behind live at one times", () => {
    const rewind = new Rewind();
    feed(rewind, 30);
    rewind.seek(1_010_000);
    rewind.play();
    feed(rewind, 10, 30);
    expect(rewind.getState().live).toBe(false);
    expect(rewind.at()).toBe(1_020_000);
    expect(newest(rewind, false)).toBe(20);
  });

  it("starts from the earliest moment held when the view was left before it", () => {
    const rewind = new Rewind(new Ring(10_000, Number.POSITIVE_INFINITY, 1_000));
    feed(rewind, 5);
    rewind.seek(1_000_000);
    feed(rewind, 20, 5);
    const start = rewind.ring.start() ?? 0;
    expect(start).toBeGreaterThan(1_000_000);
    rewind.play();
    expect(rewind.at()).toBe(start);
  });

  it("stops where it is", () => {
    const rewind = new Rewind();
    feed(rewind, 30);
    rewind.seek(1_010_000);
    rewind.play();
    vi.advanceTimersByTime(3_000);
    rewind.stop();
    vi.advanceTimersByTime(3_000);
    expect(rewind.at()).toBe(1_013_000);
  });
});

describe("past view", () => {
  it("asks the live store's socket and reports its connection", async () => {
    const rewind = new Rewind();
    const sent: string[] = [];
    rewind.live.setSender((frame) => sent.push(frame));
    rewind.live.setConnection("open");
    rewind.pause();
    expect(rewind.view.getConnection()).toBe("open");
    const reply = rewind.view.request("summary.misses", {});
    const asked = JSON.parse(sent[0] ?? "{}") as { id: number };
    rewind.live.apply({ topic: "summary", key: "misses", value: "list", id: asked.id } as unknown as Envelope);
    await expect(reply).resolves.toBe("list");
    expect(rewind.view.isLive()).toBe(false);
    expect(rewind.live.isLive()).toBe(true);
  });
});

describe("readMoment", () => {
  const now = new Date(2026, 10, 18, 12, 0, 0).getTime();
  const arrival = (slot: number) => (slot === 400_000_000 ? 42 : null);

  it("reads a time of day today, or yesterday when it is later than now", () => {
    expect(readMoment("11:59:30", now, arrival)).toBe(now - 30_000);
    expect(readMoment("11:58", now, arrival)).toBe(now - 120_000);
    expect(readMoment("12:00:01", now, arrival)).toBe(now + 1_000 - 86_400_000);
  });

  it("reads a slot from when it arrived", () => {
    expect(readMoment("400000000", now, arrival)).toBe(42);
    expect(readMoment("400000001", now, arrival)).toBeNull();
  });

  it("refuses anything else", () => {
    expect(readMoment("25:00", now, arrival)).toBeNull();
    expect(readMoment("noon", now, arrival)).toBeNull();
    expect(readMoment("", now, arrival)).toBeNull();
  });
});
