import { describe, expect, it } from "vitest";
import {
  axisMax,
  binOf,
  binRange,
  foldBins,
  leadingLine,
  place,
  stackedBins,
  tally,
  trendShape,
  windowLabel,
} from "./handoff";
import type { HandoffNow } from "./types";

function now(over: Partial<HandoffNow>): HandoffNow {
  return {
    leader: "L",
    country: null,
    slot: 1,
    gap: 80,
    n: 40,
    band: { p25: 60, p50: 70, p75: 90 },
    over: 6,
    late: false,
    gaps: [],
    judged: true,
    minute_mean: 78,
    ...over,
  };
}

describe("axisMax", () => {
  it("keeps 300 ms for today's slots and widens past a slot for longer ones", () => {
    expect(axisMax(218)).toBe(300);
    expect(axisMax(null)).toBe(300);
    expect(axisMax(400)).toBe(460);
  });
});

describe("place", () => {
  it("clamps to the axis", () => {
    expect(place(-20, 300)).toBe(0);
    expect(place(150, 300)).toBe(50);
    expect(place(900, 300)).toBe(100);
  });
});

describe("foldBins", () => {
  it("keeps the bins on the axis and adds the rest into the last", () => {
    expect(foldBins([1, 2, 3, 4, 5], 10, 30)).toEqual([1, 2, 12]);
  });

  it("pads where the server sent fewer", () => {
    expect(foldBins([1], 10, 30)).toEqual([1, 0, 0]);
  });
});

describe("binOf", () => {
  it("clamps both ends", () => {
    expect(binOf(-5, 6, 50)).toBe(0);
    expect(binOf(71, 6, 50)).toBe(11);
    expect(binOf(999, 6, 50)).toBe(49);
  });
});

describe("stackedBins", () => {
  it("scales each bin's total by its square root and splits it between its parts", () => {
    const bins = stackedBins([100, 9, 0, 0], [0, 16, 4, 0]);
    expect(bins[0]).toEqual({ onTime: 100, late: 0 });
    // 25 leaders of 100 at the top: half the height, split 9 to 16.
    expect(bins[1]?.onTime).toBeCloseTo(18);
    expect(bins[1]?.late).toBeCloseTo(32);
    expect(bins[2]).toEqual({ onTime: 0, late: 20 });
    expect(bins[3]).toEqual({ onTime: 0, late: 0 });
  });

  it("draws nothing for an empty strip", () => {
    expect(stackedBins([0, 0], [0, 0])).toEqual([
      { onTime: 0, late: 0 },
      { onTime: 0, late: 0 },
    ]);
  });
});

describe("trendShape", () => {
  const trend = {
    end_millis: 0,
    step_millis: 15_000,
    mean: [100, 120, null, 90, 110],
    p25: [60, 70, null, 50, 60],
    p75: [140, 160, null, 120, 130],
    hour_p50: 75,
  };

  it("breaks the line and the band where a minute had no handoff", () => {
    const shape = trendShape(trend, 400, 40);
    expect(shape.line).toBe("M0.0,20.0L100.0,16.0M300.0,22.0L400.0,18.0");
    expect(shape.bands).toHaveLength(2);
    expect(shape.range).toEqual([90, 120]);
    expect(shape.median).toBe(25);
    expect(shape.top).toBe(200);
  });

  it("keeps at least 150 ms and rounds the top up to the next 50 ms over the highest p75", () => {
    expect(trendShape({ ...trend, p75: [140, 120, null, 120, 130] }, 400, 40).top).toBe(150);
    expect(trendShape({ ...trend, p75: [140, 260, null, 120, 130] }, 400, 40).top).toBe(300);
  });

  it("draws nothing without a mean", () => {
    const shape = trendShape({ ...trend, mean: [null, null], p25: [null, null], p75: [null, null], hour_p50: null }, 400, 40);
    expect(shape).toEqual({ top: 150, line: "", bands: [], median: null, range: null });
  });
});

describe("tally", () => {
  it("writes the late count over the total", () => {
    expect(tally(10, 10)).toBe("10/10");
    expect(tally(1089, 1089)).toBe("1089/1089");
  });
});

describe("binRange", () => {
  it("leaves the first bin open below and the last open above", () => {
    expect(binRange(0, 50, 6)).toEqual({ from: null, to: 6, label: "0–5" });
    expect(binRange(7, 50, 6)).toEqual({ from: 42, to: 48, label: "42–47" });
    expect(binRange(49, 50, 6)).toEqual({ from: 294, to: null, label: "294+" });
  });
});

describe("leadingLine", () => {
  it("gives a settled leader's band and late count", () => {
    expect(leadingLine(now({ late: true, over: 25, n: 25, band: { p25: 198, p50: 220, p75: 232 } }))).toEqual({
      kind: "settled",
      usual: "usual 198–232 ms",
      late: "late 25/25",
      isLate: true,
    });
  });

  it("says when the leader's country cannot be judged", () => {
    expect(leadingLine(now({ judged: false }))).toEqual({ kind: "unjudged", usual: "usual 60–90 ms" });
  });

  it("says when there are too few handoffs", () => {
    expect(leadingLine(now({ band: null, n: 1, gaps: [80] }))).toEqual({
      kind: "few",
      text: "1 handoff so far, too few to call usual",
    });
    expect(leadingLine(now({ band: null, n: 5 }))).toEqual({
      kind: "few",
      text: "5 handoffs so far, too few to call usual",
    });
  });

  it("is empty without a leader", () => {
    expect(leadingLine(null)).toEqual({ kind: "none" });
  });
});

describe("windowLabel", () => {
  it("names the slots once the window is full", () => {
    expect(windowLabel(true, 0, 0)).toBe("the last 432,000 slots");
  });

  it("gives the start time today, and its day before that", () => {
    const start = new Date(2026, 9, 21, 9, 40).getTime();
    expect(windowLabel(false, start, new Date(2026, 9, 21, 16, 0).getTime())).toBe("since 09:40");
    expect(windowLabel(false, start, new Date(2026, 9, 22, 8, 0).getTime())).toBe("since Wed 09:40");
  });
});
