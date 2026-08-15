import { beforeAll, describe, expect, it } from "vitest";
import { Store } from "./store";
import type { Envelope, SlotEntry, TpsSample } from "./types";

beforeAll(() => {
  // The store coalesces notifications onto an animation frame, which node has
  // no concept of. Running the callback at once keeps the assertions plain.
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
});

function slot(number: number, level: SlotEntry["level"] = "completed"): SlotEntry {
  return {
    slot: number,
    level,
    leader: null,
    leader_name: null,
    leader_icon: null,
    transactions: null,
    non_vote_transactions: null,
    duration_nanos: null,
    mine: false,
  };
}

function envelope(topic: string, key: string, value: unknown): Envelope {
  return { topic, key, value } as Envelope;
}

describe("values", () => {
  it("keeps the latest value for a key", () => {
    const store = new Store();
    store.apply(envelope("summary", "cluster", "testnet"));
    expect(store.get("summary", "cluster")).toBe("testnet");
    store.apply(envelope("summary", "cluster", "mainnet-beta"));
    expect(store.get("summary", "cluster")).toBe("mainnet-beta");
  });

  it("ignores replies to our own requests", () => {
    // A reply carries the id it was asked with. Storing it would let a ping
    // answer overwrite the state under the same key.
    const store = new Store();
    store.apply(envelope("summary", "ping", "state"));
    store.apply({ ...envelope("summary", "ping", "reply"), id: 7 } as Envelope);
    expect(store.get("summary", "ping")).toBe("state");
  });
});

describe("slots", () => {
  it("replaces everything on an overview and merges an update", () => {
    const store = new Store();
    store.apply(envelope("slot", "overview", [slot(1), slot(2)]));
    expect(store.getSlots().map((entry) => entry.slot)).toEqual([1, 2]);

    store.apply(envelope("slot", "update", slot(3)));
    expect(store.getSlots().map((entry) => entry.slot)).toEqual([1, 2, 3]);

    // A second overview is a resynchronisation, not an addition.
    store.apply(envelope("slot", "overview", [slot(9)]));
    expect(store.getSlots().map((entry) => entry.slot)).toEqual([9]);
  });

  it("upgrades a slot in place as its level advances", () => {
    const store = new Store();
    store.apply(envelope("slot", "update", slot(5, "incomplete")));
    store.apply(envelope("slot", "update", slot(5, "finalized")));
    expect(store.getSlots()).toHaveLength(1);
    expect(store.getSlot(5)?.level).toBe("finalized");
  });

  it("returns slots in order however they arrived", () => {
    const store = new Store();
    for (const number of [7, 5, 9, 6]) store.apply(envelope("slot", "update", slot(number)));
    expect(store.getSlots().map((entry) => entry.slot)).toEqual([5, 6, 7, 9]);
  });

  it("drops the oldest slots rather than growing without bound", () => {
    const store = new Store();
    for (let number = 1; number <= 600; number += 1) {
      store.apply(envelope("slot", "update", slot(number)));
    }
    const slots = store.getSlots();
    expect(slots).toHaveLength(512);
    expect(slots[slots.length - 1].slot).toBe(600);
    // The oldest went, not the newest.
    expect(slots[0].slot).toBe(89);
  });
});

describe("tps samples", () => {
  const sample = (number: number): TpsSample => ({
    slot: number,
    timestamp_nanos: number * 1e9,
    total: 0,
    vote: 0,
    non_vote_success: 0,
    non_vote_failed: 0,
  });

  it("keeps the series strictly increasing across the history overlap", () => {
    // The retained history and the live samples overlap by design, so a sample
    // that repeats one already held must not be appended again.
    const store = new Store();
    store.apply(envelope("summary", "tps_history", [sample(1), sample(2), sample(3)]));
    store.apply(envelope("summary", "tps_sample", sample(2)));
    store.apply(envelope("summary", "tps_sample", sample(3)));
    expect(store.getTps().map((entry) => entry.slot)).toEqual([1, 2, 3]);

    store.apply(envelope("summary", "tps_sample", sample(4)));
    expect(store.getTps().map((entry) => entry.slot)).toEqual([1, 2, 3, 4]);
  });
});

describe("isReady", () => {
  it("waits for both the identity and the first slots", () => {
    const store = new Store();
    expect(store.isReady()).toBe(false);
    store.apply(envelope("summary", "identity_key", "abc"));
    expect(store.isReady()).toBe(false);
    store.apply(envelope("slot", "update", slot(1)));
    expect(store.isReady()).toBe(true);
  });

  it("does not wait for a validator that is still booting", () => {
    // A booting validator has no slots and no identity to report, and the boot
    // sequence is exactly what should be on screen, so there is nothing left
    // for the splash to wait for.
    const store = new Store();
    store.apply(envelope("summary", "startup_progress", { running: false }));
    expect(store.isReady()).toBe(true);
  });
});
