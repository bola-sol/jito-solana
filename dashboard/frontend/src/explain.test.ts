import { describe, expect, it } from "vitest";
import { edgeShift } from "./components/primitives";

const VIEWPORT = 1400;

describe("edgeShift", () => {
  it("leaves a bubble alone when it already fits", () => {
    expect(edgeShift(363, 623, VIEWPORT)).toBe(0);
  });

  it("pulls a bubble back off the right edge", () => {
    // The case that gave the page a horizontal scrollbar: the right-hand
    // column of a card, whose bubble ran 201px past the window.
    expect(edgeShift(1341, 1601, VIEWPORT)).toBe(-213);
    expect(1601 + edgeShift(1341, 1601, VIEWPORT)).toBe(VIEWPORT - 12);
  });

  it("pushes a bubble in off the left edge", () => {
    expect(edgeShift(-30, 230, VIEWPORT)).toBe(42);
    expect(-30 + edgeShift(-30, 230, VIEWPORT)).toBe(12);
  });

  it("keeps the left edge readable when the bubble cannot fit at all", () => {
    // A bubble wider than the window should not be slid so far that its start
    // is off-screen, which is what correcting the right edge alone would do.
    const shift = edgeShift(0, 2000, 300);
    expect(0 + shift).toBeLessThanOrEqual(12);
  });

  it("respects the margin exactly at the boundary", () => {
    expect(edgeShift(12, VIEWPORT - 12, VIEWPORT)).toBe(0);
    expect(edgeShift(11, VIEWPORT - 13, VIEWPORT)).toBe(1);
  });
});
