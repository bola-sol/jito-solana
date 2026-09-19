import { describe, expect, it } from "vitest";
import { creditsShare } from "./credits";

describe("creditsShare", () => {
  it("is the credits over the slots elapsed at the ceiling each", () => {
    expect(creditsShare(1_200, 100, 16)).toBe(0.75);
  });

  it("is nothing before the epoch has run a slot", () => {
    expect(creditsShare(0, 0, 16)).toBeNull();
  });

  it("is capped at one, since credits land after their vote", () => {
    expect(creditsShare(1_700, 100, 16)).toBe(1);
  });
});
