import { describe, expect, it } from "vitest";
import { dropRate } from "./components/IngestCard";

describe("dropRate", () => {
  it("never rounds a real loss down to zero", () => {
    // The whole point of the row. A packet lost every twenty seconds is a
    // fault, and `0/s` beside a total that keeps climbing reads as health.
    expect(dropRate(0.05)).toBe("<1/s");
    expect(dropRate(0.999)).toBe("<1/s");
  });

  it("rounds rates of one or more", () => {
    expect(dropRate(1)).toBe("1/s");
    expect(dropRate(12.4)).toBe("12/s");
    expect(dropRate(12.6)).toBe("13/s");
  });

  it("groups large rates", () => {
    expect(dropRate(4820)).toBe("4,820/s");
  });
});
