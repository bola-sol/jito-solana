import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});
import { Archive, type BlockReply } from "./archive";
import { recording, slotsBlock, value } from "./archive.fixture";
import { Ring } from "./ring";
import { Store } from "./store";

const newest = (store: Store) => store.getSlots().at(-1)?.slot;

describe("archive", () => {
  it("replays a recorded segment as the live feed would have been held", async () => {
    const blocks = [
      { keyframe: true, first: 1_000, last: 1_000, records: [[1_000, value("cluster", "testnet")]] } as BlockReply,
      slotsBlock(1_000, 10, 20),
      slotsBlock(21_000, 30, 20),
    ];
    const archive = new Archive(recording([{ start: 1_000, blocks }]), () => 0);
    await archive.refresh();
    expect(await archive.ensure(40_000)).toBe(true);

    const live = new Store();
    const ring = new Ring(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    for (const block of blocks) {
      for (const [at, envelope] of block.records) {
        ring.record(envelope, at, 0, live);
        live.apply(envelope, at);
      }
    }
    for (const at of [1_000, 9_500, 21_000, 33_000, 40_000]) {
      const fromArchive = new Store();
      const fromLive = new Store();
      archive.ringAt(at)?.stateAt(at, fromArchive);
      ring.stateAt(at, fromLive);
      expect(fromArchive.getSlots()).toEqual(fromLive.getSlots());
      expect(fromArchive.get("summary", "cluster")).toBe("testnet");
    }
  });

  it("loads only as far as asked, a block at a time", async () => {
    const requests = recording([{ start: 0, blocks: [slotsBlock(0, 0, 10), slotsBlock(10_000, 10, 10), slotsBlock(20_000, 20, 10)] }]);
    const archive = new Archive(requests, () => 0);
    await archive.refresh();
    expect(archive.ringAt(5_000)).toBeNull();
    await archive.ensure(12_000);
    expect(requests.reads).toEqual(["0:0", "0:1"]);
    expect(archive.ringAt(12_000)).not.toBeNull();
    expect(archive.ringAt(25_000)).toBeNull();
  });

  it("moves recorded times by the clock offset", async () => {
    const archive = new Archive(recording([{ start: 0, blocks: [slotsBlock(0, 0, 10)] }]), () => 500);
    await archive.refresh();
    expect(archive.start()).toBe(500);
    expect(await archive.ensure(9_500)).toBe(true);
    const view = new Store();
    archive.ringAt(5_400)?.stateAt(5_400, view);
    expect(newest(view)).toBe(4);
    archive.ringAt(5_500)?.stateAt(5_500, view);
    expect(newest(view)).toBe(5);
  });

  it("finds the gaps between segments and snaps a moment in one to what follows", async () => {
    const archive = new Archive(
      recording([
        { start: 0, blocks: [slotsBlock(0, 0, 10)] },
        { start: 9_500, blocks: [slotsBlock(9_500, 10, 10)] },
        { start: 60_000, blocks: [slotsBlock(60_000, 100, 10)] },
      ]),
      () => 0,
    );
    await archive.refresh();
    expect(archive.gaps()).toEqual([[18_500, 60_000]]);
    expect(archive.snap(30_000)).toBe(60_000);
    expect(archive.snap(5_000)).toBe(5_000);
    expect(archive.segmentAt(30_000)).toBeNull();
  });

  it("keeps two segments loaded and drops the least recently used", async () => {
    const requests = recording([0, 100_000, 200_000].map((start) => ({ start, blocks: [slotsBlock(start, start / 1_000, 5)] })));
    const archive = new Archive(requests, () => 0);
    await archive.refresh();
    await archive.ensure(1_000);
    await archive.ensure(101_000);
    expect(archive.ringAt(1_000)).not.toBeNull();
    await archive.ensure(201_000);
    expect(archive.ringAt(101_000)).toBeNull();
    expect(archive.ringAt(1_000)).not.toBeNull();
    expect(archive.ringAt(201_000)).not.toBeNull();
  });

  it("ends a segment at a refused block and fetches nothing more of it", async () => {
    const requests = recording([{ start: 0, blocks: [slotsBlock(0, 0, 5)] }]);
    const archive = new Archive(
      { range: () => Promise.resolve({ enabled: true, segments: [[0, 9_000, 2]] }), read: requests.read },
      () => 0,
    );
    await archive.refresh();
    expect(await archive.ensure(8_000)).toBe(true);
    expect(await archive.ensure(8_000)).toBe(true);
    expect(requests.reads).toEqual(["0:0", "0:1"]);
    const view = new Store();
    archive.ringAt(8_000)?.stateAt(8_000, view);
    expect(newest(view)).toBe(4);
  });

  it("asks again for a block whose fetch failed on the connection, after a pause", async () => {
    const requests = recording([{ start: 0, blocks: [slotsBlock(0, 0, 10)] }]);
    let fail = true;
    const archive = new Archive(
      {
        range: requests.range,
        read: (segment, block) => (fail ? Promise.reject(new Error("connection lost")) : requests.read(segment, block)),
      },
      () => 0,
    );
    await archive.refresh();
    expect(await archive.ensure(5_000)).toBe(false);
    fail = false;
    // Not straight away, so a dropped connection is not asked in a loop.
    expect(archive.canFetch()).toBe(false);
    expect(await archive.ensure(5_000)).toBe(false);
    vi.setSystemTime(Date.now() + 2_000);
    expect(await archive.ensure(5_000)).toBe(true);
    expect(archive.ringAt(5_000)).not.toBeNull();
  });

  it("drops a segment whose first block is gone, as one deleted when it aged out", async () => {
    const archive = new Archive(
      {
        range: () => Promise.resolve({ enabled: true, segments: [[0, 9_000, 1], [10_000, 19_000, 1]] }),
        read: (segment) => Promise.resolve(segment === 0 ? null : slotsBlock(10_000, 10, 10)),
      },
      () => 0,
    );
    await archive.refresh();
    expect(await archive.ensure(5_000)).toBe(false);
    expect(archive.start()).toBe(10_000);
    expect(archive.snap(5_000)).toBe(10_000);
  });

  it("is off when the validator records nothing", async () => {
    const archive = new Archive({ range: () => Promise.resolve({ enabled: false }), read: () => Promise.resolve(null) }, () => 0);
    await archive.refresh();
    expect(archive.isEnabled()).toBe(false);
    expect(archive.start()).toBeNull();
  });
});
