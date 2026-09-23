import { afterEach, describe, expect, it, vi } from "vitest";
import { isNarrow, NARROW_QUERY } from "./narrow";

function matchMediaFor(width: number) {
  return (query: string) => ({ matches: query === NARROW_QUERY && width <= 700 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNarrow", () => {
  it("uses the width the rest of the stylesheet changes shape at", () => {
    expect(NARROW_QUERY).toBe("(max-width: 700px)");
  });

  it("is true on a phone", () => {
    vi.stubGlobal("window", { matchMedia: matchMediaFor(375) });
    expect(isNarrow()).toBe(true);
  });

  it("is false on a desktop", () => {
    vi.stubGlobal("window", { matchMedia: matchMediaFor(1400) });
    expect(isNarrow()).toBe(false);
  });

  it("is false either side of the boundary in the right direction", () => {
    vi.stubGlobal("window", { matchMedia: matchMediaFor(700) });
    expect(isNarrow()).toBe(true);
    vi.stubGlobal("window", { matchMedia: matchMediaFor(701) });
    expect(isNarrow()).toBe(false);
  });

  it("answers wide where matchMedia does not exist", () => {
    vi.stubGlobal("window", {});
    expect(isNarrow()).toBe(false);
  });
});
