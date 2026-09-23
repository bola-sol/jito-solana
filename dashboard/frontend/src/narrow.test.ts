import { afterEach, describe, expect, it, vi } from "vitest";
import { isNarrow, NARROW_QUERY } from "./narrow";

/** A `matchMedia` that answers for one width, without a layout engine. */
function matchMediaFor(width: number) {
  return (query: string) => ({ matches: query === NARROW_QUERY && width <= 700 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNarrow", () => {
  it("uses the width the rest of the stylesheet changes shape at", () => {
    // The waterfall rows, the schedule groups and the cache headings all switch
    // here. A second breakpoint would rearrange the page twice on the way down.
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
    // Some embedded webviews have no matchMedia; they get the wide header, which needs no panel.
    vi.stubGlobal("window", {});
    expect(isNarrow()).toBe(false);
  });
});
