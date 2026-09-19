import { describe, expect, it } from "vitest";
import { creditsShare } from "./credits";

describe("creditsShare", () => {
  it("is our credits over the cluster's best", () => {
    expect(creditsShare(1_200, 1_600)).toBe(0.75);
  });

  it("is nothing before the cluster figure has arrived, or while it is nought", () => {
    expect(creditsShare(1_200, null)).toBeNull();
    expect(creditsShare(0, 0)).toBeNull();
  });

  it("is capped at one", () => {
    expect(creditsShare(1_700, 1_600)).toBe(1);
  });
});
