import { describe, expect, it } from "vitest";
import { schedulerSection, sumWaterfalls, turnOf, turnRangeLabel, turnSpanLabel } from "./turns";
import type { LeaderTurn, SlotWaterfall } from "./types";

function waterfall(over: Partial<SlotWaterfall> = {}): SlotWaterfall {
  return {
    slot: 100,
    source: "scheduler",
    received: 0,
    not_held: 0,
    check_queue_full: 0,
    unparsable: 0,
    bad_locks: 0,
    compute_budget: 0,
    too_old: 0,
    already_processed: 0,
    fee_payer: 0,
    filtered: 0,
    nonce_conflict: 0,
    buffered: 0,
    queue_full: 0,
    nonce_evicted: 0,
    cleared: 0,
    cleaned: 0,
    scheduled: 0,
    blocked_conflicts: 0,
    blocked_threads: 0,
    finished: 0,
    retried: 0,
    ...over,
  };
}

const turn = {
  first: 88,
  last: 91,
  produced: 4,
  drained_millis: 1_000_000,
  since_millis: 748_000,
} as LeaderTurn;

describe("turnOf", () => {
  it("keys every slot of a turn to it", () => {
    const map = turnOf([turn, { ...turn, first: 12, last: 12 }]);
    expect(map.get(88)).toBe(turn);
    expect(map.get(91)).toBe(turn);
    expect(map.get(92)).toBeUndefined();
    expect(map.get(12)?.first).toBe(12);
  });
});

describe("labels", () => {
  it("ranges the slots and names the span", () => {
    expect(turnRangeLabel(turn)).toBe("88–91");
    expect(turnRangeLabel({ ...turn, last: 88 })).toBe("88");
    expect(turnSpanLabel(turn)).toBe("4m 12s since the previous turn drained");
    expect(turnSpanLabel({ ...turn, since_millis: null })).toBe("since the dashboard started");
  });
});

describe("sumWaterfalls", () => {
  it("adds the counts and takes the newest slot's source", () => {
    const sum = sumWaterfalls([
      waterfall({ slot: 88, received: 100, scheduled: 10 }),
      waterfall({ slot: 89, received: 50, scheduled: 5, source: "bam" }),
    ]);
    expect(sum?.received).toBe(150);
    expect(sum?.scheduled).toBe(15);
    expect(sum?.source).toBe("bam");
    expect(sumWaterfalls([])).toBeNull();
  });
});

describe("schedulerSection", () => {
  it("draws the intake losses against what arrived, scheduled as the way through", () => {
    const section = schedulerSection(
      waterfall({
        received: 1000,
        too_old: 300,
        already_processed: 500,
        buffered: 200,
        scheduled: 150,
      }),
    );
    expect(section.total).toBe(1000);
    expect(section.through).toEqual({ label: "scheduled", count: 150 });
    expect(section.losses.map((loss) => loss.key)).toEqual(["already_processed", "too_old"]);
    expect(section.losses[0].share).toBeCloseTo(0.5, 6);
    expect(section.zeros).toBeGreaterThan(0);
    expect(section.aside).toBeNull();
  });

  it("draws a BAM turn against buffered, with the batches as an aside", () => {
    const section = schedulerSection(
      waterfall({ source: "bam", received: 700, buffered: 690, scheduled: 680 }),
    );
    expect(section.total).toBe(690);
    expect(section.aside?.count).toBe(700);
    expect(section.note).toContain("BAM");
  });
});
