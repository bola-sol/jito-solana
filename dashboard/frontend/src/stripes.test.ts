import { describe, expect, it } from "vitest";
import { Stripes } from "./stripes";

function tints(stripes: Stripes, numbers: readonly number[]): boolean[] {
  return numbers.map((number) => stripes.tinted(number));
}

function alternates(values: boolean[]): boolean {
  return values.every((value, at) => at === 0 || value !== values[at - 1]);
}

describe("Stripes", () => {
  it("stripes consecutive turns by their number", () => {
    const stripes = new Stripes();
    stripes.update("all", [11, 10, 9]);
    expect(tints(stripes, [11, 10, 9])).toEqual([true, false, true]);
  });

  it("keeps every tint when turns arrive at the top", () => {
    const stripes = new Stripes();
    stripes.update("ours", [40, 25, 13]);
    const before = tints(stripes, [40, 25, 13]);
    stripes.update("ours", [52, 40, 25, 13]);
    expect(tints(stripes, [40, 25, 13])).toEqual(before);
    expect(alternates(tints(stripes, [52, 40, 25, 13]))).toBe(true);
  });

  it("keeps every tint when turns arrive at the bottom", () => {
    const stripes = new Stripes();
    stripes.update("ours", [40, 25]);
    const before = tints(stripes, [40, 25]);
    stripes.update("ours", [40, 25, 13, 7]);
    expect(tints(stripes, [40, 25])).toEqual(before);
    expect(alternates(tints(stripes, [40, 25, 13, 7]))).toBe(true);
  });

  it("alternates where turns are not consecutive", () => {
    const stripes = new Stripes();
    stripes.update("ours", [41, 39, 37, 35]);
    expect(alternates(tints(stripes, [41, 39, 37, 35]))).toBe(true);
  });

  it("gives a turn arriving between two a tint", () => {
    const stripes = new Stripes();
    stripes.update("ours", [40, 25]);
    stripes.update("ours", [40, 31, 25]);
    expect(stripes.tinted(31)).toBe(!stripes.tinted(40));
  });

  it("starts again for a different list", () => {
    const stripes = new Stripes();
    stripes.update("ours", [41, 39]);
    stripes.update("all", [40, 39]);
    expect(tints(stripes, [40, 39])).toEqual([false, true]);
  });

  it("leaves an empty list alone", () => {
    const stripes = new Stripes();
    stripes.update("all", []);
    expect(stripes.tinted(1)).toBe(false);
  });
});
