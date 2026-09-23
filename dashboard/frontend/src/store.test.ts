import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    block: null,
    duration_nanos: null,
    time_millis: null,
    shreds: null,
    replayed_millis: null,
    reward: null,
    left_out: null,
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
    store.apply(envelope("summary", "cluster", "state"));
    store.apply({ ...envelope("summary", "cluster", "reply"), id: 7 } as Envelope);
    expect(store.get("summary", "cluster")).toBe("state");
  });
});

describe("clock offset", () => {
  afterEach(() => vi.useRealTimers());

  it("is the smallest reading, since delivery delay only ever adds", () => {
    vi.useFakeTimers();
    const store = new Store();
    expect(store.getClockOffset()).toBeNull();
    // The validator's clock reads 5,000 ms; ours reads 5,300, then 5,250
    // ahead of its next reading, then 5,400 ahead of the one after.
    vi.setSystemTime(5_300);
    store.apply(envelope("summary", "server_time_nanos", 5_000 * 1e6));
    vi.setSystemTime(6_250);
    store.apply(envelope("summary", "server_time_nanos", 6_000 * 1e6));
    vi.setSystemTime(7_400);
    store.apply(envelope("summary", "server_time_nanos", 7_000 * 1e6));
    expect(store.getClockOffset()).toBe(250);
    expect(store.get("summary", "server_time_nanos")).toBe(7_000 * 1e6);
  });

  it("measures the feed's lag from the quickest delivery the connection has had", () => {
    // Readings arrive 300, then 250, then 1,400 ms after the validator's clock
    // said: the quickest is 250 and the newest is 1,150 behind it.
    vi.useFakeTimers();
    const store = new Store();
    expect(store.getFeedLag()).toBeNull();
    vi.setSystemTime(5_300);
    store.apply(envelope("summary", "server_time_nanos", 5_000 * 1e6));
    expect(store.getFeedLag()).toBe(0);
    vi.setSystemTime(6_250);
    store.apply(envelope("summary", "server_time_nanos", 6_000 * 1e6));
    vi.setSystemTime(8_400);
    store.apply(envelope("summary", "server_time_nanos", 7_000 * 1e6));
    expect(store.getFeedLag()).toBe(1_150);

    store.setConnection("closed");
    expect(store.getFeedLag()).toBeNull();
  });

  it("lets an old low reading age out after a minute of readings", () => {
    vi.useFakeTimers();
    const store = new Store();
    vi.setSystemTime(1_000);
    store.apply(envelope("summary", "server_time_nanos", 1_000 * 1e6));
    for (let second = 2; second <= 61; second += 1) {
      vi.setSystemTime(second * 1_000 + 250);
      store.apply(envelope("summary", "server_time_nanos", second * 1_000 * 1e6));
    }
    expect(store.getClockOffset()).toBe(250);
  });

  it("starts again on a lost connection", () => {
    vi.useFakeTimers();
    const store = new Store();
    vi.setSystemTime(5_300);
    store.apply(envelope("summary", "server_time_nanos", 5_000 * 1e6));
    store.setConnection("closed");
    expect(store.getClockOffset()).toBeNull();
  });
});

describe("slots", () => {
  it("replaces everything on an overview and merges an update", () => {
    const store = new Store();
    store.apply(envelope("slot", "overview", [slot(1), slot(2)]));
    expect(store.getSlots().map((entry) => entry.slot)).toEqual([1, 2]);

    store.apply(envelope("slot", "update", slot(3)));
    expect(store.getSlots().map((entry) => entry.slot)).toEqual([1, 2, 3]);

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
    expect(slots[0].slot).toBe(89);
  });

  it("keeps our own leader slots long after the window has passed them", () => {
    const store = new Store();
    for (const number of [1, 2, 3, 4]) {
      store.apply(envelope("slot", "update", { ...slot(number), mine: true }));
    }
    for (let number = 5; number <= 2000; number += 1) {
      store.apply(envelope("slot", "update", slot(number)));
    }
    const ours = store.getSlots().filter((entry) => entry.mine);
    expect(ours.map((entry) => entry.slot)).toEqual([1, 2, 3, 4]);
  });

  it("names a leader in an epoch the page was never sent, once it is fetched", async () => {
    const store = new Store();
    const sent: string[] = [];
    store.setSender((frame) => sent.push(frame));
    store.setConnection("open");
    store.apply(
      envelope("epoch", "new", {
        epoch: 2,
        start_slot: 200,
        end_slot: 299,
        slots_in_epoch: 100,
        my_leader_slots: [],
        leaders: ["NOW"],
        turns: Array.from({ length: 25 }, () => 0),
        block_cost_limit: 0,
        account_cost_limit: 0,
      }),
    );
    expect(store.leaderOf(104, false).key).toBeNull();
    const before = store.getLeaderRevision();

    const loading = store.loadEpoch(1);
    const id = (JSON.parse(sent[0]) as { id: number }).id;
    store.apply({
      topic: "epoch",
      key: "query",
      id,
      value: {
        epoch: 1,
        start_slot: 100,
        end_slot: 199,
        slots_in_epoch: 100,
        my_leader_slots: [],
        leaders: ["BEFORE"],
        turns: Array.from({ length: 25 }, () => 0),
        block_cost_limit: 0,
        account_cost_limit: 0,
      },
    });
    await loading;

    expect(store.leaderOf(104, false).key).toBe("BEFORE");
    expect(store.leaderOf(204, false).key).toBe("NOW");
    expect(store.getLeaderRevision()).toBeGreaterThan(before);
  });

  it("asks about an epoch it has no schedule for only once", async () => {
    const store = new Store();
    const sent: string[] = [];
    store.setSender((frame) => sent.push(frame));
    store.setConnection("open");

    const loading = store.loadEpoch(1);
    const id = (JSON.parse(sent[0]) as { id: number }).id;
    store.apply({ topic: "epoch", key: "query", id, value: null });
    await loading;

    await store.loadEpoch(1);
    expect(sent).toHaveLength(1);
  });

  it("names a leader the peer table does not reach, once the table is fetched", async () => {
    const store = new Store();
    const sent: string[] = [];
    store.setSender((frame) => sent.push(frame));
    store.setConnection("open");
    store.apply(
      envelope("epoch", "new", {
        epoch: 1,
        start_slot: 100,
        end_slot: 115,
        slots_in_epoch: 16,
        my_leader_slots: [],
        leaders: ["FARAWAY"],
        turns: [0, 0, 0, 0],
        block_cost_limit: 0,
        account_cost_limit: 0,
      }),
    );
    expect(store.leaderOf(104, false)).toEqual({ key: "FARAWAY", name: null, icon: null });

    const loading = store.loadDisplays();
    const id = (JSON.parse(sent[0]) as { id: number }).id;
    store.apply({
      topic: "summary",
      key: "displays",
      id,
      value: { keys: ["FARAWAY"], names: ["Far Away Co"], icons: [null] },
    });
    await loading;

    expect(store.leaderOf(104, false)).toEqual({
      key: "FARAWAY",
      name: "Far Away Co",
      icon: null,
    });
  });

  it("asks for the display table once and no more", async () => {
    const store = new Store();
    const sent: string[] = [];
    store.setSender((frame) => sent.push(frame));
    store.setConnection("open");

    const loading = store.loadDisplays();
    const id = (JSON.parse(sent[0]) as { id: number }).id;
    store.apply({
      topic: "summary",
      key: "displays",
      id,
      value: { keys: ["A"], names: ["Alpha"], icons: [null] },
    });
    await loading;

    await store.loadDisplays();
    expect(sent).toHaveLength(1);
  });

  it("names a slot of ours from what the validator says about itself", () => {
    const store = new Store();
    store.apply(envelope("summary", "identity_key", "OURKEY"));
    store.apply(envelope("summary", "identity_name", "Lantern"));
    store.apply(envelope("summary", "identity_icon", "https://l/i.png"));

    const ours = store.leaderOf(443_227_896, true);
    expect(ours).toEqual({ key: "OURKEY", name: "Lantern", icon: "https://l/i.png" });
  });

  it("gives the same object back for ours until one of its parts changes", () => {
    // The rows that draw a leader are memoised on their props, so a fresh
    // object every render would rebuild the whole list on each meter sample.
    const store = new Store();
    store.apply(envelope("summary", "identity_key", "OURKEY"));
    const first = store.leaderOf(1, true);
    expect(store.leaderOf(2, true)).toBe(first);

    store.apply(envelope("summary", "identity_name", "Lantern"));
    expect(store.leaderOf(1, true)).not.toBe(first);
    expect(store.leaderOf(1, true).name).toBe("Lantern");
  });

  it("still looks a slot that is not ours up the long way", () => {
    const store = new Store();
    store.apply(envelope("summary", "identity_key", "OURKEY"));
    store.apply(
      envelope("epoch", "new", {
        epoch: 1,
        start_slot: 100,
        end_slot: 115,
        slots_in_epoch: 16,
        my_leader_slots: [],
        leaders: ["THEIRKEY"],
        turns: [0, 0, 0, 0],
        block_cost_limit: 0,
        account_cost_limit: 0,
      }),
    );
    expect(store.leaderOf(104, false).key).toBe("THEIRKEY");
    expect(store.leaderOf(99, false).key).toBeNull();
  });

  it("answers a request with the reply carrying its id", async () => {
    const store = new Store();
    const sent: string[] = [];
    store.setSender((frame) => sent.push(frame));
    store.setConnection("open");

    const reply = store.request("slot.range", { first_slot: 4, count: 2 });
    const frame = JSON.parse(sent[0]) as { id: number; topic: string; key: string; params: unknown };
    expect([frame.topic, frame.key]).toEqual(["slot", "range"]);
    expect(frame.params).toEqual({ first_slot: 4, count: 2 });

    store.apply({ topic: "slot", key: "range", id: frame.id, value: { rows: [1, 2] } });
    expect(await reply).toEqual({ rows: [1, 2] });
  });

  it("does not fold a reply into the state it happens to be named after", () => {
    // The envelope of a reply and of a push differ only by the id, so without
    // that check a queried range would overwrite the live slot map.
    const store = new Store();
    store.setSender(() => {});
    store.setConnection("open");
    store.apply(envelope("slot", "overview", [slot(900)]));

    store.apply({ topic: "slot", key: "update", id: 77, value: slot(1) });
    expect(store.getSlots().map((entry) => entry.slot)).toEqual([900]);
  });

  it("fails the requests in flight when the connection goes", async () => {
    const store = new Store();
    store.setSender(() => {});
    store.setConnection("open");

    const reply = store.request("summary.misses", {});
    store.setConnection("closed");
    await expect(reply).rejects.toThrow("connection lost");
  });

  it("refuses a request made with no connection rather than queueing it", async () => {
    const store = new Store();
    await expect(store.request("summary.misses", {})).rejects.toThrow("not connected");
  });

  it("bounds how many of our own slots it keeps", () => {
    const store = new Store();
    for (let number = 1; number <= 200; number += 1) {
      store.apply(envelope("slot", "update", { ...slot(number), mine: true }));
    }
    for (let number = 201; number <= 1000; number += 1) {
      store.apply(envelope("slot", "update", slot(number)));
    }
    const ours = store.getSlots().filter((entry) => entry.mine);
    expect(ours).toHaveLength(64);
    expect(ours[ours.length - 1].slot).toBe(200);
    expect(ours[0].slot).toBe(137);
  });

  it("does not let retained slots displace the recent window", () => {
    // The strip reads the tail of this list. Holding old slots of ours must
    // not push newer ones out of it.
    const store = new Store();
    store.apply(envelope("slot", "update", { ...slot(1), mine: true }));
    for (let number = 2; number <= 1000; number += 1) {
      store.apply(envelope("slot", "update", slot(number)));
    }
    const recent = store.getSlots().slice(-64);
    expect(recent[0].slot).toBe(937);
    expect(recent[recent.length - 1].slot).toBe(1000);
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
    const store = new Store();
    store.apply(envelope("summary", "startup_progress", { running: false }));
    expect(store.isReady()).toBe(true);
  });
});
