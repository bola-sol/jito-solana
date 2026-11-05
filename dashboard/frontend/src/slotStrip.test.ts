import { describe, expect, it } from "vitest";
import { markerTip, slotClasses } from "./components/SlotStrip";

describe("markerTip", () => {
  it("ends the explanation with the slot, since the phone layout shows only offsets", () => {
    expect(markerTip("Highest slot this validator has rooted", 450_714_528)).toBe(
      "Highest slot this validator has rooted: 450,714,528",
    );
  });

  it("is the explanation alone before the slot is known", () => {
    expect(markerTip("Highest slot this validator has rooted", undefined)).toBe(
      "Highest slot this validator has rooted",
    );
  });
});

describe("slotClasses", () => {
  it("gives the level and our marking, which the bars and the ribbon both read", () => {
    expect(slotClasses({ level: "skipped", mine: false })).toBe("level-skipped");
    expect(slotClasses({ level: "finalized", mine: true })).toBe("level-finalized mine");
  });
});
