import { describe, expect, it } from "vitest";
import { countdownSlotMs } from "./countdown";

describe("countdownSlotMs", () => {
  it("projects at the measured rate when there is one", () => {
    expect(countdownSlotMs(233_000_000, 400_000_000)).toBe(233);
  });

  it("falls back to the configured rate while the measurement is withheld", () => {
    // The collector sends null until its window has filled, rather than a mean
    // that is still settling.
    expect(countdownSlotMs(null, 400_000_000)).toBe(400);
    expect(countdownSlotMs(undefined, 200_000_000)).toBe(200);
  });

  it("stands something in before the validator has reported either", () => {
    expect(countdownSlotMs(null, null)).toBe(400);
    expect(countdownSlotMs(undefined, undefined)).toBe(400);
  });

  it("prefers a measured rate even when it is the slower of the two", () => {
    // A cluster running behind its target should read as more time remaining,
    // not less.
    expect(countdownSlotMs(480_000_000, 400_000_000)).toBe(480);
  });
});
