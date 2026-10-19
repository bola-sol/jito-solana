import { describe, expect, it } from "vitest";
import {
  AXIS_FLOOR,
  HOLD_MS,
  REPLAY_SLOWDOWN,
  axisEnd,
  barTone,
  bars,
  geometry,
  milestones,
  msAt,
  replayAt,
  runningPath,
  shareBy,
  ticks,
  unmeasured,
  xAt,
} from "./certFormation";
import type { CertFormation } from "./types";

/** A curve with `steps` of `[ms, share in hundredths of a percent]` arriving at each ms. */
function curve(steps: [number, number][]): number[] {
  const points = new Array<number>(481).fill(0);
  for (const [ms, share] of steps) {
    for (let at = ms + 1; at <= 480; at++) points[at] = (points[at] ?? 0) + share;
  }
  return points;
}

function formation(over: Partial<CertFormation> = {}): CertFormation {
  return {
    epoch: 1_063,
    slot_nanos: 222_000_000,
    notarize: curve([
      [270, 4_000],
      [285, 2_000],
      [310, 2_000],
    ]),
    finalize: curve([
      [300, 3_000],
      [412, 3_000],
    ]),
    notarize_total: 9_150,
    finalize_total: 9_000,
    notarized_millis: 285,
    fast_final_millis: 310,
    second_round_millis: 412,
    ...over,
  };
}

describe("geometry", () => {
  it("uses the phone sizes below 360 px", () => {
    expect(geometry(1_208, 480)).toMatchObject({ phone: false, half: 120, bin: 5, scale: 5, height: 280 });
    expect(geometry(295, 480)).toMatchObject({ phone: true, half: 84, bin: 10, scale: 2.5, height: 208 });
  });

  it("keeps the axis end from the curve", () => {
    expect(axisEnd(formation())).toBe(480);
  });
});

describe("the broken axis", () => {
  const g = geometry(1_000, 480);

  it("squeezes the time before the floor into the stub", () => {
    expect(xAt(g, 0)).toBe(g.left);
    expect(xAt(g, AXIS_FLOOR)).toBe(g.left + g.stub);
    expect(xAt(g, 480)).toBe(g.right);
    expect(xAt(g, 600)).toBe(g.right);
  });

  it("reads pointer positions back, the stub as the floor", () => {
    expect(msAt(g, xAt(g, 300))).toBeCloseTo(300);
    expect(msAt(g, g.left)).toBe(AXIS_FLOOR);
    expect(msAt(g, g.width + 50)).toBe(480);
  });
});

describe("shares", () => {
  it("reads what had arrived by a time", () => {
    const f = formation();
    expect(shareBy(f.notarize, 269)).toBe(0);
    expect(shareBy(f.notarize, 270)).toBe(0.4);
    expect(shareBy(f.notarize, 300)).toBe(0.6);
    expect(shareBy(f.notarize, 480)).toBe(0.8);
  });

  it("counts stake with no measured vote", () => {
    expect(unmeasured(formation())).toBeCloseTo(0.085);
  });
});

describe("bars", () => {
  it("puts each arrival in its bin and caps the tall ones", () => {
    const g = geometry(1_000, 480);
    const list = bars(g, formation().notarize);
    expect(list.map((bar) => bar.from)).toEqual([270, 285, 310]);
    // 40% of stake at 5 px per percent is past the half.
    expect(list[0]).toMatchObject({ capped: true, height: g.half - 4 });
    expect(list[1]).toMatchObject({ capped: false, height: 100 });
  });

  it("has no bar for votes past the axis", () => {
    const g = geometry(1_000, 480);
    expect(bars(g, curve([[479, 100]]))).toHaveLength(1);
    expect(bars(g, curve([]))).toHaveLength(0);
  });
});

describe("runningPath", () => {
  it("steps at each arrival and joins later votes at the axis end", () => {
    const g = geometry(1_000, 480);
    const path = runningPath(g, curve([[300, 5_000]]), 7_000, -1);
    expect(path.startsWith(`M${g.left} ${g.base}`)).toBe(true);
    expect(path).toContain(`H${xAt(g, 300).toFixed(1)} V${(g.base - 0.5 * g.half).toFixed(1)}`);
    expect(path.endsWith(`H${g.right} V${(g.base - 0.7 * g.half).toFixed(1)}`)).toBe(true);
  });
});

describe("ticks", () => {
  it("drops 400 where it would meet the last tick", () => {
    expect(ticks(geometry(295, 480)).map((tick) => tick.ms)).toEqual([0, 240, 320, 400, 480]);
    expect(ticks(geometry(240, 480)).map((tick) => tick.ms)).toEqual([0, 240, 320, 480]);
  });

  it("names the ends", () => {
    const list = ticks(geometry(1_000, 480));
    expect(list[0]).toEqual({ ms: 0, label: "slot start", align: "start" });
    expect(list.at(-1)).toEqual({ ms: 480, label: "480 ms", align: "end" });
  });
});

describe("milestones", () => {
  it("lists the certificates within the axis, earliest first", () => {
    expect(milestones(formation(), 480).map((mark) => mark.key)).toEqual(["notarized", "fast", "second"]);
    expect(milestones(formation({ second_round_millis: 520, fast_final_millis: null }), 480)).toEqual([
      { key: "notarized", ms: 285, direction: -1, level: 0.6 },
    ]);
  });
});

describe("barTone", () => {
  const f = formation();

  it("shades notarize bars by the certificate they count toward", () => {
    expect(barTone(-1, 282.5, f, null)).toBe("notarize");
    expect(barTone(-1, 297.5, f, null)).toBe("notarize-late");
    expect(barTone(-1, 320, f, null)).toBe("after");
  });

  it("holds bars as pending until their certificate forms in the replay", () => {
    expect(barTone(-1, 282.5, f, 280)).toBe("pending");
    expect(barTone(-1, 282.5, f, 285)).toBe("notarize");
    expect(barTone(-1, 297.5, f, 300)).toBe("pending");
    expect(barTone(1, 302.5, f, 400)).toBe("pending");
    expect(barTone(1, 302.5, f, 412)).toBe("finalize");
    expect(barTone(1, 450, f, 450)).toBe("after");
  });
});

describe("replayAt", () => {
  const marks = [285, 310, 412];

  it("runs at a tenth of speed from the floor", () => {
    expect(replayAt(0, marks, 480)).toEqual({ ms: AXIS_FLOOR, hold: null, done: false });
    expect(replayAt(100 * REPLAY_SLOWDOWN, marks, 480).ms).toBe(260);
  });

  it("stops at each milestone for the hold", () => {
    const reach = (285 - AXIS_FLOOR) * REPLAY_SLOWDOWN;
    expect(replayAt(reach + HOLD_MS / 2, marks, 480)).toEqual({
      ms: 285,
      hold: { index: 0, fraction: 0.5 },
      done: false,
    });
    expect(replayAt(reach + HOLD_MS + 10 * REPLAY_SLOWDOWN, marks, 480).ms).toBe(295);
  });

  it("ends at the axis end", () => {
    const total = (480 - AXIS_FLOOR) * REPLAY_SLOWDOWN + marks.length * HOLD_MS;
    expect(replayAt(total - 1, marks, 480).done).toBe(false);
    expect(replayAt(total, marks, 480)).toEqual({ ms: 480, hold: null, done: true });
  });
});
