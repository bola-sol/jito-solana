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
    block: null,
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

  it("keeps our own leader slots long after the window has passed them", () => {
    // A validator leads about four slots in eight hundred, so a window of five
    // hundred usually holds none of its own. Without this the sidebar's own
    // slots view would be empty nearly all the time.
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

  it("answers a request with the reply carrying its id", async () => {
    const store = new Store();
    const sent: string[] = [];
    store.setSender((frame) => sent.push(frame));
    store.setConnection("open");

    const reply = store.request<{ rows: number[] }>("slot", "range", { first_slot: 4 });
    const frame = JSON.parse(sent[0]) as { id: number; topic: string; params: unknown };
    expect(frame.topic).toBe("slot");
    expect(frame.params).toEqual({ first_slot: 4 });

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
    // Both paths that give up on a socket set the connection state, so this is
    // the one place that has to notice. Left pending, a caller shows a loading
    // state that never resolves.
    const store = new Store();
    store.setSender(() => {});
    store.setConnection("open");

    const reply = store.request("slot", "range", {});
    store.setConnection("closed");
    await expect(reply).rejects.toThrow("connection lost");
  });

  it("refuses a request made with no connection rather than queueing it", async () => {
    // Answered after the next reconnect, it would arrive against a page that
    // has moved on.
    const store = new Store();
    await expect(store.request("slot", "range", {})).rejects.toThrow("not connected");
  });

  it("keeps the own-slot snapshot that arrives after the overview", () => {
    // The connect snapshot is two messages. The first clears and fills the
    // recent window; the second carries our own leader slots from before it
    // and must merge into what the first left, not replace it.
    const store = new Store();
    store.apply(envelope("slot", "overview", [slot(900), slot(901), slot(902)]));
    store.apply(
      envelope("slot", "own", [
        { ...slot(10), mine: true },
        { ...slot(11), mine: true },
      ]),
    );

    const held = store.getSlots().map((entry) => entry.slot);
    expect(held).toEqual([10, 11, 900, 901, 902]);
  });

  it("clears the own slots of a previous connection when the overview arrives", () => {
    // A reconnect resends both. The overview clearing first is what stops a
    // stale own slot outliving the connection that delivered it.
    const store = new Store();
    store.apply(envelope("slot", "own", [{ ...slot(10), mine: true }]));
    store.apply(envelope("slot", "overview", [slot(900)]));

    expect(store.getSlots().map((entry) => entry.slot)).toEqual([900]);
  });

  it("bounds how many of our own slots it keeps", () => {
    const store = new Store();
    for (let number = 1; number <= 600; number += 1) {
      store.apply(envelope("slot", "update", { ...slot(number), mine: true }));
    }
    for (let number = 601; number <= 1400; number += 1) {
      store.apply(envelope("slot", "update", slot(number)));
    }
    const ours = store.getSlots().filter((entry) => entry.mine);
    expect(ours).toHaveLength(500);
    // The newest five hundred of ours, not the first five hundred we ever saw.
    expect(ours[ours.length - 1].slot).toBe(600);
    expect(ours[0].slot).toBe(101);
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
