import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { recording, slotsBlock } from "./archive.fixture";
import { clockTime, dayText } from "./format";
import { LOOK_AHEAD_SLOTS, parseMoment, resolveMoment, Rewind, type MomentSource } from "./rewind";
import { HAS_CLOCK, type SlotRange, type WireRow } from "./slotHistory";
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

  it("plays slower than live at a quarter", () => {
    const rewind = new Rewind();
    feed(rewind, 30);
    rewind.seek(1_010_000);
    rewind.setSpeed(0.25);
    rewind.play();
    vi.advanceTimersByTime(8_000);
    expect(rewind.at()).toBe(1_012_000);
    expect(newest(rewind, false)).toBe(12);
    expect(rewind.getState().live).toBe(false);
  });

  it("carries on from the earliest moment held once the ring drops where it was", () => {
    const rewind = new Rewind(new Ring(10_000, Number.POSITIVE_INFINITY, 1_000));
    feed(rewind, 30);
    rewind.seek(0);
    rewind.setSpeed(0.25);
    rewind.play();
    feed(rewind, 20, 30);
    const start = rewind.ring.start() ?? 0;
    expect(rewind.at()).toBeGreaterThanOrEqual(start);
    expect(rewind.at() - start).toBeLessThan(1_000);
    expect(newest(rewind, false)).toBeGreaterThanOrEqual((start - 1_000_000) / 1_000);
    expect(rewind.getState().live).toBe(false);
    // It keeps playing at a quarter from there.
    const carried = rewind.at();
    vi.advanceTimersByTime(4_000);
    expect(rewind.at()).toBe(carried + 1_000);
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
    // Pausing asks for the recorded range first.
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ topic: "rewind", key: "range" });
    const asked = JSON.parse(sent.at(-1) ?? "{}") as { id: number };
    rewind.live.apply({ topic: "summary", key: "misses", value: "list", id: asked.id } as unknown as Envelope);
    await expect(reply).resolves.toBe("list");
    expect(rewind.view.isLive()).toBe(false);
    expect(rewind.live.isLive()).toBe(true);
  });
});

/** Lets fetched blocks arrive and the code waiting on them run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

describe("recorded on the validator", () => {
  it("seeks older than the page's own ring, fetches on settle, then shows it", async () => {
    const requests = recording([{ start: 500_000, blocks: [slotsBlock(500_000, 1_000, 30), slotsBlock(530_000, 1_030, 30)] }]);
    const rewind = new Rewind(undefined, requests);
    feed(rewind, 30);
    rewind.pause();
    await flush();
    expect(rewind.earliest()).toBe(500_000);
    rewind.seek(540_000);
    // Nothing is fetched while the slider is still moving.
    expect(requests.reads).toEqual([]);
    expect(newest(rewind, false)).toBe(29);
    rewind.settle();
    expect(rewind.getState().loading).toBe(true);
    await flush();
    expect(rewind.getState().loading).toBe(false);
    expect(requests.reads).toEqual(["500000:0", "500000:1"]);
    expect(newest(rewind, false)).toBe(1_040);
    expect(rewind.slotArrival(1_040)).toBe(540_000);
  });

  it("leaves the view where it moved when a fetch for an earlier place finishes", async () => {
    const requests = recording([{ start: 500_000, blocks: [slotsBlock(500_000, 1_000, 30)] }]);
    const rewind = new Rewind(undefined, requests);
    feed(rewind, 30);
    rewind.pause();
    await flush();
    rewind.seek(510_000);
    rewind.settle();
    rewind.seek(1_010_000);
    rewind.settle();
    expect(rewind.getState().loading).toBe(false);
    await flush();
    expect(rewind.getState().loading).toBe(false);
    expect(newest(rewind, false)).toBe(10);
  });

  it("plays across a segment boundary, over a gap and on into its own ring", async () => {
    const requests = recording([
      { start: 500_000, blocks: [slotsBlock(500_000, 1_000, 20)] },
      { start: 520_000, blocks: [slotsBlock(520_000, 2_000, 20)] },
      { start: 600_000, blocks: [slotsBlock(600_000, 3_000, 10)] },
    ]);
    const rewind = new Rewind(undefined, requests);
    feed(rewind, 30);
    rewind.pause();
    await flush();
    rewind.seek(505_000);
    rewind.settle();
    await flush();
    expect(newest(rewind, false)).toBe(1_005);
    rewind.setSpeed(4);
    rewind.play();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(newest(rewind, false)).toBeGreaterThanOrEqual(2_004);
    expect(newest(rewind, false)).toBeLessThan(2_020);
    // Past the second segment's end the gap is skipped.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(rewind.at()).toBeGreaterThanOrEqual(600_000);
    expect(newest(rewind, false)).toBeGreaterThanOrEqual(3_000);
    // After the recording, its own ring from where it starts.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(rewind.at()).toBeGreaterThanOrEqual(1_000_000);
    expect(rewind.getState().live).toBe(false);
  });

  it("moves the generation once a fetched moment back shows, not when the move settles", async () => {
    const requests = recording([{ start: 500_000, blocks: [slotsBlock(500_000, 1_000, 30)] }]);
    const rewind = new Rewind(undefined, requests);
    feed(rewind, 30);
    rewind.pause();
    await flush();
    const before = rewind.getGeneration();
    rewind.seek(510_000);
    rewind.settle();
    expect(rewind.getGeneration()).toBe(before);
    await flush();
    expect(newest(rewind, false)).toBe(1_010);
    expect(rewind.getGeneration()).toBe(before + 1);
  });

  it("moves on to the next recorded moment when the segment it wanted has gone", async () => {
    const rewind = new Rewind(undefined, {
      range: () => Promise.resolve({ enabled: true, segments: [[500_000, 529_000, 1], [600_000, 629_000, 1]] }),
      read: (segment) => Promise.resolve(segment === 500_000 ? null : slotsBlock(600_000, 2_000, 30)),
    });
    feed(rewind, 30);
    rewind.pause();
    await flush();
    rewind.seek(510_000);
    rewind.settle();
    await flush();
    expect(rewind.at()).toBe(600_000);
    expect(newest(rewind, false)).toBe(2_000);
  });

  it("holds playback without asking again in a loop while the connection fails", async () => {
    let reads = 0;
    const rewind = new Rewind(undefined, {
      range: () => Promise.resolve({ enabled: true, segments: [[500_000, 529_000, 1]] }),
      read: () => {
        reads += 1;
        return Promise.reject(new Error("connection lost"));
      },
    });
    feed(rewind, 30);
    rewind.pause();
    await flush();
    rewind.seek(510_000);
    rewind.settle();
    rewind.play();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toBe(1);
    expect(rewind.at()).toBe(510_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(reads).toBe(2);
  });

  it("asks again by itself when a paused fetch failed on the connection", async () => {
    const requests = recording([{ start: 500_000, blocks: [slotsBlock(500_000, 1_000, 30)] }]);
    let fail = true;
    const rewind = new Rewind(undefined, {
      range: requests.range,
      read: (segment, block) => (fail ? Promise.reject(new Error("connection lost")) : requests.read(segment, block)),
    });
    feed(rewind, 30);
    rewind.pause();
    await flush();
    rewind.seek(510_000);
    rewind.settle();
    await flush();
    expect(newest(rewind, false)).toBe(29);
    fail = false;
    await vi.advanceTimersByTimeAsync(2_500);
    await flush();
    expect(newest(rewind, false)).toBe(1_010);
  });

  it("behaves as before when the validator records nothing", async () => {
    const rewind = new Rewind(undefined, {
      range: () => Promise.resolve({ enabled: false }),
      read: () => Promise.resolve(null),
    });
    feed(rewind, 30);
    rewind.pause();
    await flush();
    rewind.seek(0);
    rewind.settle();
    expect(rewind.at()).toBe(1_000_000);
    expect(rewind.getState().loading).toBe(false);
    expect(newest(rewind, false)).toBe(0);
  });
});

describe("parseMoment", () => {
  const now = new Date(2026, 10, 18, 12, 0, 0).getTime();
  const time = (at: number) => ({ kind: "time", at });
  const none = { kind: "none" };

  it("reads a time of day today, or yesterday when it is later than now", () => {
    expect(parseMoment("11:59:30", now)).toEqual(time(now - 30_000));
    expect(parseMoment("11:58", now)).toEqual(time(now - 120_000));
    expect(parseMoment("12:00:01", now)).toEqual(time(now + 1_000 - 86_400_000));
  });

  it("reads a slot, grouped or not", () => {
    for (const text of ["400000000", "400,000,000", "400_000_000", "400 000 000", " 400000000 "]) {
      expect(parseMoment(text, now)).toEqual({ kind: "slot", slot: 400_000_000 });
    }
    expect(parseMoment("1234", now)).toEqual(none);
    expect(parseMoment("12 30", now)).toEqual(none);
    expect(parseMoment("1,234", now)).toEqual(none);
    expect(parseMoment("11 59 30", now)).toEqual(none);
    expect(parseMoment("400,00,000", now)).toEqual(none);
    expect(parseMoment("99999999999999999999", now)).toEqual(none);
  });

  it("reads an epoch", () => {
    for (const text of ["e1066", "E1066", "epoch 1066", "Epoch1066", " e 1066 "]) {
      expect(parseMoment(text, now)).toEqual({ kind: "epoch", epoch: 1_066 });
    }
    for (const text of ["e", "epoch", "e10x", "1066"]) expect(parseMoment(text, now)).toEqual(none);
  });

  it("reads a date and time, and refuses a day the month does not have", () => {
    expect(parseMoment("2026-11-17 09:30", now)).toEqual(time(new Date(2026, 10, 17, 9, 30, 0).getTime()));
    expect(parseMoment("2026-11-16 23:59:59", now)).toEqual(time(new Date(2026, 10, 16, 23, 59, 59).getTime()));
    expect(parseMoment("2026-02-30 10:00", now)).toEqual(none);
    expect(parseMoment("2026-11-17 24:00", now)).toEqual(none);
  });

  it("refuses anything else", () => {
    expect(parseMoment("25:00", now)).toEqual(none);
    expect(parseMoment("noon", now)).toEqual(none);
    expect(parseMoment("", now)).toEqual(none);
  });
});

describe("resolveMoment", () => {
  const now = new Date(2026, 10, 18, 12, 0, 0).getTime();
  const earliest = now - 86_400_000;
  const tip = 400_500_000;
  const timed = (millis: number): WireRow => {
    const row = new Array<number>(17).fill(0) as WireRow;
    row[1] = HAS_CLOCK;
    row[8] = millis;
    return row;
  };

  /** A source whose history answers with `rows`, recording each range asked. */
  function source(rows: (WireRow | null)[] | undefined, change: Partial<MomentSource> = {}) {
    const asked: [number, number][] = [];
    const given: MomentSource = {
      now,
      earliest,
      tip,
      epoch: { epoch: 1_066, start_slot: 400_200_000, slots_in_epoch: 432_000 },
      held: () => null,
      range: (first, count) => {
        asked.push([first, count]);
        return Promise.resolve({ first_slot: first, rows } as SlotRange);
      },
      offset: 250,
      ...change,
    };
    return { given, asked };
  }
  const slot = (number: number) => ({ kind: "slot", slot: number }) as const;
  const epoch = (number: number) => ({ kind: "epoch", epoch: number }) as const;

  it("takes a slot held here without asking the validator", async () => {
    const { given, asked } = source([], { held: (number) => (number === 400_400_000 ? now - 5_000 : null) });
    expect(await resolveMoment(slot(400_400_000), given)).toEqual({ at: now - 5_000 });
    expect(asked).toEqual([]);
  });

  it("asks the history and moves its time onto this clock", async () => {
    const { given, asked } = source([timed(now - 60_000)]);
    expect(await resolveMoment(slot(400_400_000), given)).toEqual({ at: now - 60_000 + 250 });
    expect(asked).toEqual([[400_400_000, LOOK_AHEAD_SLOTS]]);
  });

  it("lands on the next slot with a time past skipped and untimed ones", async () => {
    const untimed = timed(now - 70_000);
    untimed[1] = 0;
    const { given } = source([null, untimed, null, timed(now - 60_000)]);
    expect(await resolveMoment(slot(400_400_000), given)).toEqual({ at: now - 60_000 + 250 });
  });

  it("refuses a slot the history has no time near", async () => {
    const missing = { refused: "Slot 400,400,000 is not in the validator's history." };
    expect(await resolveMoment(slot(400_400_000), source([null, null]).given)).toEqual(missing);
    expect(await resolveMoment(slot(400_400_000), source(undefined).given)).toEqual(missing);
  });

  it("says when the validator does not answer", async () => {
    const { given } = source([], { range: () => Promise.reject(new Error("closed")) });
    expect(await resolveMoment(slot(400_400_000), given)).toEqual({ refused: "The validator did not answer." });
  });

  it("refuses slots past the tip or older than the history without asking", async () => {
    const { given, asked } = source([timed(now)]);
    expect(await resolveMoment(slot(tip + 1), given)).toEqual({ refused: "Slot 400,500,001 has not been reached." });
    expect(await resolveMoment(slot(tip - 432_000 - LOOK_AHEAD_SLOTS), given)).toEqual({
      refused: "Slot 400,067,936 is not in the validator's history.",
    });
    expect(asked).toEqual([]);
  });

  it("refuses a slot timed before the recording, naming when it starts", async () => {
    const { given } = source([timed(earliest - 1_000)]);
    const refused = await resolveMoment(slot(400_100_000), given);
    expect(refused).toEqual({
      refused: `Slot 400,100,000 is before the recording, which starts ${dayText(earliest)} ${clockTime(earliest)}.`,
    });
  });

  it("finds an epoch from its first slot", async () => {
    const current = source([timed(now - 60_000)]);
    expect(await resolveMoment(epoch(1_066), current.given)).toEqual({ at: now - 60_000 + 250 });
    expect(current.asked).toEqual([[400_200_000, LOOK_AHEAD_SLOTS]]);
    // Only at the epoch's first slot is the previous epoch's start still within the history.
    const previous = source([timed(earliest - 1_000)], { tip: 400_200_000 });
    expect(await resolveMoment(epoch(1_065), previous.given)).toEqual({
      refused: `Epoch 1065 began before the recording, which starts ${dayText(earliest)} ${clockTime(earliest)}.`,
    });
    expect(previous.asked).toEqual([[399_768_000, LOOK_AHEAD_SLOTS]]);
  });

  it("refuses an epoch not started or not known", async () => {
    expect(await resolveMoment(epoch(1_067), source([]).given)).toEqual({ refused: "Epoch 1067 has not started." });
    expect(await resolveMoment(epoch(1_066), source([], { epoch: null }).given)).toEqual({
      refused: "The epoch is not known yet.",
    });
  });

  it("bounds a time by the recording and by now", async () => {
    const { given } = source([]);
    expect(await resolveMoment({ kind: "time", at: now - 1_000 }, given)).toEqual({ at: now - 1_000 });
    expect(await resolveMoment({ kind: "time", at: now + 1_000 }, given)).toEqual({ refused: "Later than now." });
    expect(await resolveMoment({ kind: "time", at: earliest - 1 }, given)).toEqual({
      refused: `Before the recording, which starts ${dayText(earliest)} ${clockTime(earliest)}.`,
    });
    expect(await resolveMoment({ kind: "time", at: now - 1_000 }, source([], { earliest: null }).given)).toEqual({
      refused: "Nothing is recorded yet.",
    });
    expect(await resolveMoment({ kind: "none" }, given)).toEqual({ refused: "Not a time, a slot or an epoch." });
  });
});
