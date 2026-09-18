import { describe, expect, it } from "vitest";
import { agoLabel, blocksUntil, snapshotLine } from "./snapshot";
import type { Snapshots } from "./types";

const both: Snapshots = {
  full: { slot: 441_600_000, written_millis: 1_000_000 },
  incremental: { slot: 441_685_500, written_millis: 9_960_000 },
  full_interval: 25_000,
  incremental_interval: 100,
};

describe("agoLabel", () => {
  it("uses the largest unit that fits, rounded down", () => {
    expect(agoLabel(40_500)).toBe("40s ago");
    expect(agoLabel(16 * 60_000 + 40_000)).toBe("16m ago");
    expect(agoLabel(2 * 3_600_000 + 5 * 60_000)).toBe("2h ago");
    expect(agoLabel(3 * 86_400_000 + 7 * 3_600_000)).toBe("3d ago");
  });

  it("changes unit exactly at the boundary", () => {
    expect(agoLabel(59_999)).toBe("59s ago");
    expect(agoLabel(60_000)).toBe("1m ago");
    expect(agoLabel(3_600_000)).toBe("1h ago");
    expect(agoLabel(86_400_000)).toBe("1d ago");
  });
});

describe("blocksUntil", () => {
  it("counts to the next multiple above the height", () => {
    expect(blocksUntil(393_444_647, 100)).toBe(53);
    expect(blocksUntil(393_444_647, 25_000)).toBe(5_353);
  });

  it("names the one after when the height is on a multiple", () => {
    expect(blocksUntil(1_000, 100)).toBe(100);
  });
});

describe("snapshotLine", () => {
  it("leads with the incremental, then its age, then the full it sits on", () => {
    const line = snapshotLine(both, 10_000_000, 393_444_647, 400);
    expect(line?.detail).toBe("441,685,500 · 40s ago · full 441,600,000");
  });

  it("names when the next of each kind is due, on the hover", () => {
    const line = snapshotLine(both, 10_000_000, 393_444_647, 400);
    expect(line?.title).toBe("Next incremental in about 21s, next full in about 35m 41s.");
  });

  it("falls back to the full alone where there is no incremental", () => {
    const line = snapshotLine({ ...both, incremental: null, incremental_interval: null }, 2_000_000, 393_444_647, 400);
    expect(line?.detail).toBe("441,600,000 · 16m ago");
    expect(line?.title).toBe("Next full in about 35m 41s.");
  });

  it("leaves the age out where the file could not be read", () => {
    const unread = { ...both, incremental: { slot: 441_685_500, written_millis: null } };
    expect(snapshotLine(unread, 10_000_000, undefined, undefined)?.detail).toBe(
      "441,685,500 · full 441,600,000",
    );
  });

  it("has no hover before the block height or the slot rate is known", () => {
    expect(snapshotLine(both, 10_000_000, undefined, 400)?.title).toBeUndefined();
  });

  it("is nothing where no archive is on disk", () => {
    expect(snapshotLine({ ...both, full: null, incremental: null }, 1, 1, 1)).toBeNull();
  });
});
