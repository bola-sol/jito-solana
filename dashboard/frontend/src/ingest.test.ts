import { describe, expect, it } from "vitest";
import { lossShare, shareLabel, windowLabel } from "./components/IngestCard";

describe("windowLabel", () => {
  it("names the period actually watched while the window fills", () => {
    // For its first minute the card does not claim a minute it has not watched.
    expect(windowLabel(0)).toBe("last 5s");
    expect(windowLabel(12)).toBe("last 10s");
    expect(windowLabel(38)).toBe("last 40s");
  });

  it("settles once the window is full", () => {
    expect(windowLabel(55)).toBe("last min");
    expect(windowLabel(60)).toBe("last min");
  });

  it("rounds so the heading does not redraw every tick", () => {
    expect(windowLabel(31)).toBe(windowLabel(32));
  });
});

describe("lossShare", () => {
  it("divides drops by everything that arrived, not by what got through", () => {
    // A dropped datagram never reached the reader that counts delivered ones, so the loss is out of
    // both.
    expect(lossShare(1, 99)).toBeCloseTo(0.01, 10);
    expect(lossShare(50, 50)).toBeCloseTo(0.5, 10);
  });

  it("has nothing to say about a port nothing counts", () => {
    // The QUIC ports and serve repair. Their drop figures stand alone.
    expect(lossShare(12, null)).toBeNull();
  });

  it("refuses to call it total loss when nothing was counted as received", () => {
    // Received counts arrive only while info logging is on, so nought received is unknown, not
    // total loss.
    expect(lossShare(12, 0)).toBeNull();
  });

  it("says nothing where there is nothing to say", () => {
    // A share of nought adds nothing to the nought already beside it.
    expect(lossShare(0, 5000)).toBeNull();
    expect(lossShare(0, 0)).toBeNull();
  });
});

describe("shareLabel", () => {
  it("does not round a real loss away to nothing", () => {
    // One in fifty thousand is shown, not rounded to 0.00%.
    expect(shareLabel(1 / 50_000)).toBe("<0.01%");
  });

  it("reads as a percentage once there is one to read", () => {
    expect(shareLabel(0.0125)).toBe("1.25%");
    expect(shareLabel(0.5)).toBe("50.00%");
  });
});
