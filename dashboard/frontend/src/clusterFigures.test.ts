import { describe, expect, it } from "vitest";
import { figureColumns, figuresWindow, rate, share } from "./clusterFigures";
import type { ClusterFigures } from "./types";

const figures: ClusterFigures = {
  epoch: 1064,
  since_millis: null,
  cu_used: { p05: 20.47, p50: 44.2, p95: 93.01 },
  slot_time_millis: { p05: 188, p50: 202, p95: 284 },
  skip_rate: { p05: 0, p50: 0, p95: 0.81 },
  tps: { p05: 1_813.4, p50: 2_372.4, p95: 4_287.5 },
  failed_tps: { p05: 502.6, p50: 896.2, p95: 1_400 },
};

describe("figureColumns", () => {
  it("puts the unit on the median alone", () => {
    const [cu, slot, skip, tps, failed] = figureColumns(figures);
    expect([cu.median, cu.p05, cu.p95]).toEqual(["44%", "20", "93"]);
    expect([slot.median, slot.p05, slot.p95]).toEqual(["202 ms", "188", "284"]);
    expect([skip.median, skip.p05, skip.p95]).toEqual(["0%", "0", "0.81"]);
    expect([tps.median, tps.p05, tps.p95]).toEqual(["2,372", "1,813", "4,288"]);
    expect([failed.median, failed.p95]).toEqual(["896", "1,400"]);
  });

  it("dashes a figure still short of samples", () => {
    const columns = figureColumns({ ...figures, tps: null });
    expect(columns.map((column) => column.key)).toEqual(["cu", "slot", "skip", "tps", "failed"]);
    expect(columns[3]).toMatchObject({ median: "—", p05: "—", p95: "—" });
  });
});

describe("the number formats", () => {
  it("keeps shares short", () => {
    expect([share(0), share(0.121), share(2.04), share(44.2), share(100)]).toEqual(["0", "0.12", "2.0", "44", "100"]);
  });

  it("keeps a rate to five characters", () => {
    expect([rate(812.4), rate(9_999), rate(12_345), rate(123_456)]).toEqual(["812", "9,999", "12.3k", "123k"]);
  });
});

describe("figuresWindow", () => {
  it("names the epoch unless the held slots start after it", () => {
    const now = new Date(2026, 9, 21, 20, 0).getTime();
    expect(figuresWindow(null, now)).toBe("this epoch");
    expect(figuresWindow(new Date(2026, 9, 21, 13, 36).getTime(), now)).toBe("since 13:36");
    expect(figuresWindow(new Date(2026, 9, 20, 9, 5).getTime(), now)).toBe("since Tue 09:05");
  });
});
