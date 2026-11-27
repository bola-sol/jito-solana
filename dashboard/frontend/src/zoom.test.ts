import { describe, expect, it } from "vitest";
import { ZOOMS, zoomFor, zoomsFor } from "./zoom";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const spans = (held: number) => zoomsFor(held).map((zoom) => zoom.ms);

describe("zoom", () => {
  it("offers the spans the history fills and the first that holds it all", () => {
    expect(spans(5 * MINUTE)).toEqual([15 * MINUTE]);
    expect(spans(40 * MINUTE)).toEqual([15 * MINUTE, HOUR]);
    expect(spans(3 * HOUR)).toEqual([15 * MINUTE, HOUR, 6 * HOUR]);
    expect(spans(50 * HOUR)).toEqual(ZOOMS.map((zoom) => zoom.ms));
  });

  it("widens the span chosen to show a moment before it", () => {
    const zooms = zoomsFor(30 * HOUR);
    expect(zoomFor(zooms, 15 * MINUTE, 5 * MINUTE)?.ms).toBe(15 * MINUTE);
    expect(zoomFor(zooms, 15 * MINUTE, 20 * MINUTE)?.ms).toBe(HOUR);
    expect(zoomFor(zooms, 15 * MINUTE, 26 * HOUR)?.ms).toBe(48 * HOUR);
    expect(zoomFor(zooms, 6 * HOUR, 5 * MINUTE)?.ms).toBe(6 * HOUR);
  });

  it("spans everything held until a span is chosen", () => {
    expect(zoomFor(zoomsFor(5 * MINUTE), null, 0)?.ms).toBe(15 * MINUTE);
    expect(zoomFor(zoomsFor(2 * HOUR), null, 0)?.ms).toBe(6 * HOUR);
    expect(zoomFor(zoomsFor(50 * HOUR), null, 0)?.ms).toBe(48 * HOUR);
  });

  it("steps by each span's smallest jump", () => {
    expect(ZOOMS.map((zoom) => zoom.jumps[0]?.spoken)).toEqual(["10 seconds", "1 minute", "15 minutes", "1 hour"]);
  });
});
