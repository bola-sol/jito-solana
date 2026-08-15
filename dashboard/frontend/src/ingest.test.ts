import { describe, expect, it } from "vitest";
import { windowLabel } from "./components/IngestCard";

describe("windowLabel", () => {
  it("names the period actually watched while the window fills", () => {
    // The point of the heading: for the first minute the card must not claim a
    // minute it has not watched, because "0 drops in the last minute" read off
    // a five-second window is a reassurance nobody measured.
    expect(windowLabel(0)).toBe("Last 5s");
    expect(windowLabel(12)).toBe("Last 10s");
    expect(windowLabel(38)).toBe("Last 40s");
  });

  it("settles once the window is full", () => {
    expect(windowLabel(55)).toBe("Last min");
    expect(windowLabel(60)).toBe("Last min");
  });

  it("rounds so the heading does not redraw every tick", () => {
    expect(windowLabel(31)).toBe(windowLabel(32));
  });
});
