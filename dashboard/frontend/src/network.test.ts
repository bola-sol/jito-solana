import { describe, expect, it } from "vitest";
import { direction, NETWORK_WINDOW_SECONDS, sharedPeak, unitFor } from "./network";

const KB = 1024;
const MB = 1024 * 1024;

describe("direction", () => {
  it("takes the newest reading and the mean of the window", () => {
    const read = direction([10, 20, 30, 40])!;
    expect(read.current).toBe(40);
    expect(read.average).toBe(25);
    expect(read.delta).toBe(15);
  });

  it("does not let one noisy second move the arrow", () => {
    // Throughput jitters by more than this from second to second, and an arrow
    // that flips every time is an arrow nobody reads. The figure itself still
    // shows the spike.
    const jitter = [...Array(59).fill(100), 115];
    expect(direction(jitter)!.trend).toBe("flat");
    expect(direction(jitter)!.current).toBe(115);
  });

  it("fires once the last ten seconds are genuinely above the minute", () => {
    const climbing = [...Array(50).fill(100), ...Array(10).fill(140)];
    expect(direction(climbing)!.trend).toBe("up");
    const falling = [...Array(50).fill(100), ...Array(10).fill(60)];
    expect(direction(falling)!.trend).toBe("down");
  });

  it("still fires on a single second large enough to be an event", () => {
    // A doubling is not jitter. Damped to a tenth it still clears the floor,
    // and it should: something changed.
    expect(direction([...Array(59).fill(100), 300])!.trend).toBe("up");
  });

  it("calls a two percent drift flat", () => {
    expect(direction([...Array(50).fill(100), ...Array(10).fill(101)])!.trend).toBe("flat");
  });

  it("is flat rather than dividing by an average of nought", () => {
    expect(direction([0, 0, 0])!.trend).toBe("flat");
  });

  it("has nothing to report before any samples arrive", () => {
    expect(direction([])).toBeNull();
  });
});

describe("sharedPeak", () => {
  it("is the highest reading either direction took", () => {
    // One scale for both. Given a band each, ten kilobytes a second fills its
    // band exactly as ten megabytes fills the other, and the picture says the
    // two are equals.
    expect(sharedPeak([1 * MB, 2 * MB], [7 * MB, 3 * MB])).toBe(7 * MB);
  });

  it("never returns nought, so nothing divides by it on an idle host", () => {
    expect(sharedPeak([0, 0], [0])).toBe(1);
    expect(sharedPeak([], [])).toBe(1);
  });
});

describe("unitFor", () => {
  it("picks the unit a reading of that size wants", () => {
    expect(unitFor(512)).toEqual({ unit: "B", divisor: 1 });
    expect(unitFor(42 * MB)).toEqual({ unit: "MB", divisor: MB });
  });

  it("is taken from the current reading and used for the rest", () => {
    // An average of 1.02 MB/s printed beside a current 980 KB/s would read as
    // "980" against "avg 1.02", and the second looks like the smaller number.
    const { divisor, unit } = unitFor(980 * KB);
    expect(unit).toBe("KB");
    expect((1.02 * MB) / divisor).toBeCloseTo(1044.48, 2);
  });

  it("handles a negative delta without falling to bytes", () => {
    expect(unitFor(-42 * MB).unit).toBe("MB");
  });

  it("stops at the largest unit it knows", () => {
    expect(unitFor(9 * 1024 ** 5).unit).toBe("TB");
  });
});

describe("the window", () => {
  it("matches the transactions chart, so both read on one timebase", () => {
    expect(NETWORK_WINDOW_SECONDS).toBe(60);
  });
});
