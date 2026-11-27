import { beforeAll, describe, expect, it } from "vitest";
import { keptEvery, Ring } from "./ring";
import { Store } from "./store";
import type { Envelope, SlotEntry } from "./types";

beforeAll(() => {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
});

function envelope(topic: string, key: string, value: unknown): Envelope {
  return { topic, key, value } as Envelope;
}

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
  return envelope("slot", "update", entry);
}

/** A live store and its ring, fed as the connection feeds them. */
function feed(ring = new Ring()) {
  const live = new Store();
  const deliver = (message: Envelope, at: number) => {
    ring.record(message, at, 100, live);
    live.apply(message, at);
  };
  return { live, ring, deliver };
}

describe("keptEvery", () => {
  it("keeps what adds up whole and the rest about each second", () => {
    expect(keptEvery("slot.update")).toBe(0);
    expect(keptEvery("summary.tps_sample")).toBe(0);
    expect(keptEvery("summary.root_slot")).toBe(900);
    expect(keptEvery("summary.vote_participation")).toBe(900);
    expect(keptEvery("summary.never_heard_of")).toBe(900);
  });
});

describe("stateAt", () => {
  it("rebuilds every whole key exactly at any moment", () => {
    const { ring, deliver } = feed();
    const t0 = 1_000_000;
    for (let i = 0; i < 200; i += 1) deliver(slot(100 + i), t0 + i * 400);
    for (const i of [0, 37, 74, 75, 150, 199]) {
      const view = new Store();
      ring.stateAt(t0 + i * 400, view);
      const slots = view.getSlots().map((entry) => entry.slot);
      expect(slots[slots.length - 1]).toBe(100 + i);
      expect(slots.length).toBe(i + 1);
    }
  });

  it("does not change the live store or a keyframe when the view applies", () => {
    const { live, ring, deliver } = feed();
    deliver(envelope("summary", "cluster", "testnet"), 0);
    deliver(slot(1), 10);
    const view = new Store();
    ring.stateAt(0, view);
    view.apply(slot(2));
    expect(live.getSlots().map((entry) => entry.slot)).toEqual([1]);
    const again = new Store();
    ring.stateAt(0, again);
    expect(again.getSlots()).toEqual([]);
    expect(again.get("summary", "cluster")).toBe("testnet");
  });

  it("keeps a thinned key that changes once and goes quiet within its interval", () => {
    const { ring, deliver } = feed();
    deliver(envelope("summary", "replay_rate", 1), 0);
    // Inside the interval, so held rather than kept.
    deliver(envelope("summary", "replay_rate", 2), 300);
    deliver(slot(5), 850);
    const before = new Store();
    ring.stateAt(850, before);
    expect(before.get("summary", "replay_rate")).toBe(1);
    // The next message past the interval writes the held copy.
    deliver(slot(6), 1_050);
    const after = new Store();
    ring.stateAt(1_050, after);
    expect(after.get("summary", "replay_rate")).toBe(2);
  });

  it("keeps the arriving copy when it is the message that crosses its own interval", () => {
    const { ring, deliver } = feed();
    deliver(envelope("summary", "replay_rate", 0), 0);
    deliver(envelope("summary", "replay_rate", 5), 500);
    deliver(envelope("summary", "replay_rate", 10), 1_000);
    const view = new Store();
    ring.stateAt(1_000, view);
    expect(view.get("summary", "replay_rate")).toBe(10);
  });

  it("keeps every copy of a key sent each second with jitter, at its arrival", () => {
    const { ring, deliver } = feed(new Ring(60_000, Number.POSITIVE_INFINITY, 30_000));
    const arrivals: number[] = [];
    for (let i = 0; i < 40; i += 1) arrivals.push(i * 1_000 + (i % 3 === 0 ? 15 : i % 3 === 1 ? 0 : 8));
    let next = 0;
    for (let at = 0; at < 40_000; at += 100) {
      while (next < arrivals.length && (arrivals[next] ?? Infinity) <= at) {
        deliver(envelope("summary", "replay_rate", next), arrivals[next] ?? at);
        next += 1;
      }
      deliver(slot(at / 100), at);
    }
    arrivals.forEach((arrival, i) => {
      const view = new Store();
      ring.stateAt(arrival, view);
      expect(view.get("summary", "replay_rate")).toBe(i);
    });
  });

  it("takes the exact keyframe on crossing a segment", () => {
    const { ring, deliver } = feed(new Ring(60_000, Number.POSITIVE_INFINITY, 1_000));
    deliver(envelope("summary", "replay_rate", 1), 0);
    deliver(envelope("summary", "replay_rate", 2), 500);
    // A new segment: its keyframe holds the 2 that thinning held back.
    deliver(slot(1), 1_000);
    const view = new Store();
    ring.stateAt(1_000, view);
    expect(view.get("summary", "replay_rate")).toBe(2);
  });

  it("replays clock offsets from the recorded arrival times", () => {
    const { live, ring, deliver } = feed();
    deliver(envelope("summary", "server_time_nanos", 5_000 * 1e6), 5_250);
    deliver(envelope("summary", "server_time_nanos", 6_000 * 1e6), 6_400);
    const view = new Store();
    ring.stateAt(6_400, view);
    expect(view.getClockOffset()).toBe(250);
    expect(live.getClockOffset()).toBe(250);
  });

  it("rebuilds from a reconnect snapshot recorded mid-ring", () => {
    const { ring, deliver } = feed();
    deliver(slot(1), 0);
    deliver(slot(2), 100);
    deliver(envelope("slot", "overview", [(slot(50).value as SlotEntry)]), 200);
    deliver(slot(51), 300);
    const view = new Store();
    ring.stateAt(250, view);
    expect(view.getSlots().map((entry) => entry.slot)).toEqual([50]);
    ring.stateAt(300, view);
    expect(view.getSlots().map((entry) => entry.slot)).toEqual([50, 51]);
  });

  it("skips replies to requests", () => {
    const { ring, deliver } = feed();
    deliver({ ...envelope("summary", "cluster", "reply"), id: 3 } as Envelope, 0);
    const view = new Store();
    ring.stateAt(0, view);
    expect(view.get("summary", "cluster")).toBeUndefined();
  });
});

describe("advance", () => {
  it("moves forward across segments without a seek", () => {
    const { ring, deliver } = feed(new Ring(60_000, Number.POSITIVE_INFINITY, 1_000));
    for (let i = 0; i < 30; i += 1) deliver(slot(i), i * 200);
    const view = new Store();
    let cursor = ring.stateAt(0, view);
    expect(cursor).not.toBeNull();
    for (let at = 0; at <= 6_000 && cursor; at += 700) {
      cursor = ring.advance(cursor, at, view);
      expect(view.getSlots().at(-1)?.slot).toBe(Math.min(29, Math.floor(at / 200)));
    }
  });

  it("jumps forward to a later keyframe rather than replaying up to it", () => {
    const { ring, deliver } = feed(new Ring(60_000, Number.POSITIVE_INFINITY, 1_000));
    deliver(envelope("summary", "replay_rate", 1), 0);
    deliver(envelope("summary", "replay_rate", 2), 500);
    for (let i = 0; i < 10; i += 1) deliver(slot(i), 1_000 + i * 300);
    const view = new Store();
    const cursor = ring.stateAt(0, view);
    expect(view.get("summary", "replay_rate")).toBe(1);
    if (!cursor) throw new Error("no cursor");
    const moved = ring.advance(cursor, 3_700, view);
    expect(view.get("summary", "replay_rate")).toBe(2);
    expect(view.getSlots().at(-1)?.slot).toBe(9);
    expect(moved.segment).not.toBe(cursor.segment);
  });

  it("starts again from a seek when its segment was evicted", () => {
    const { ring, deliver } = feed(new Ring(2_000, Number.POSITIVE_INFINITY, 1_000));
    for (let i = 0; i < 4; i += 1) deliver(slot(i), i * 500);
    const view = new Store();
    const cursor = ring.stateAt(0, view);
    for (let i = 4; i < 20; i += 1) deliver(slot(i), i * 500);
    expect(ring.start()).toBeGreaterThan(0);
    if (!cursor) throw new Error("no cursor");
    ring.advance(cursor, 9_500, view);
    expect(view.getSlots().at(-1)?.slot).toBe(19);
  });
});

describe("eviction", () => {
  it("drops whole segments past the span", () => {
    const { ring, deliver } = feed(new Ring(5_000, Number.POSITIVE_INFINITY, 1_000));
    for (let i = 0; i <= 20; i += 1) deliver(slot(i), i * 500);
    // Held from a segment start no later than five seconds before the newest message.
    const start = ring.start() ?? 0;
    expect(start).toBeLessThanOrEqual(10_000 - 5_000);
    expect(start).toBeGreaterThan(10_000 - 5_000 - 1_000);
  });

  it("drops whole segments past the budget", () => {
    const { ring, deliver } = feed(new Ring(60_000, 1_000, 1_000));
    for (let i = 0; i <= 40; i += 1) deliver(slot(i), i * 250);
    // A hundred characters each, four to a segment, a thousand held at most once a segment closes.
    expect(ring.heldChars()).toBeLessThanOrEqual(1_000 + 400);
    expect(ring.start()).toBeGreaterThan(0);
  });
});

describe("slotArrival", () => {
  it("finds when a slot first arrived, or the next one after it", () => {
    const { live, ring, deliver } = feed();
    // Slot 8 arrived before the ring began; a later update to it does not make it findable.
    live.apply(slot(8), 0);
    deliver(slot(10), 1_000);
    deliver(slot(8), 1_500);
    deliver(slot(12), 2_000);
    expect(ring.slotArrival(10)).toBe(1_000);
    expect(ring.slotArrival(9)).toBe(1_000);
    expect(ring.slotArrival(11)).toBe(2_000);
    expect(ring.slotArrival(13)).toBeNull();
    expect(ring.slotArrival(8)).toBeNull();
  });

  it("does not place an older slot at the start of a ring that began with no slots", () => {
    const { ring, deliver } = feed();
    deliver(slot(100), 1_000);
    deliver(slot(101), 1_400);
    expect(ring.slotArrival(50)).toBeNull();
    expect(ring.slotArrival(99)).toBeNull();
    expect(ring.slotArrival(100)).toBe(1_000);
    expect(ring.slotArrival(101)).toBe(1_400);
  });
});
