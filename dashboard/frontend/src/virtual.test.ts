import { describe, expect, it } from "vitest";
import { indexAt, offsetsOf, visibleRange } from "./virtual";

describe("offsetsOf", () => {
  it("puts each item under the last, ending at the total", () => {
    expect([...offsetsOf([10, 20, 30])]).toEqual([0, 10, 30, 60]);
    expect([...offsetsOf([])]).toEqual([0]);
  });
});

describe("indexAt", () => {
  const offsets = offsetsOf([10, 20, 30]);

  it("finds the item a height falls in", () => {
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, 9.9)).toBe(0);
    expect(indexAt(offsets, 10)).toBe(1);
    expect(indexAt(offsets, 45)).toBe(2);
  });

  it("clamps to the last item past the end", () => {
    expect(indexAt(offsets, 1000)).toBe(2);
  });
});

describe("visibleRange", () => {
  const offsets = offsetsOf(Array.from({ length: 100 }, () => 100));

  it("covers the view and the overscan past each edge", () => {
    expect(visibleRange(offsets, 1000, 300, 200)).toEqual([8, 15]);
  });

  it("stops at the list's ends", () => {
    expect(visibleRange(offsets, 0, 300, 200)).toEqual([0, 5]);
    expect(visibleRange(offsets, 9800, 300, 200)).toEqual([96, 99]);
  });

  it("draws nothing for an empty list", () => {
    expect(visibleRange(offsetsOf([]), 0, 300, 200)).toEqual([0, -1]);
  });
});
