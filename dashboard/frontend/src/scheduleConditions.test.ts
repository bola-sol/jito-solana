import { describe, expect, it } from "vitest";
import {
  conditionHolds,
  conditionParams,
  decodeConditions,
  endsNextDay,
  gapHolds,
  gapText,
  parseGap,
  nameHolds,
  describeCondition,
  hasRange,
  inRange,
  nextOp,
  rangeBounds,
  readConditionParams,
  toServer,
  type Condition,
} from "./scheduleConditions";
import type { EpochInfo, SlotEntry } from "./types";

function entry(fill: Partial<SlotEntry> = {}): SlotEntry {
  return {
    slot: 400,
    level: "finalized",
    mine: false,
    block: {
      transactions: 900,
      non_vote_transactions: 500,
      failed_transactions: 0,
      entries: 0,
      block_cost: 12_000_000,
      block_cost_limit: 48_000_000,
      account_cost_limit: 0,
      total_fees: 3_000_000,
      priority_fees: 1_000_000,
      tips: 1_000_000,
      replay_micros: null,
    },
    duration_nanos: 250_000_000,
    time_millis: 5_000,
    shreds: { count: 600, repaired: 2, recovered: 0, full_millis: 220 },
    replayed_millis: 230,
    reward: "unpaid",
    left_out: 3,
    ...fill,
  };
}

const number = (field: Condition["field"], op: Condition["op"], value: number): Condition => ({
  field,
  op,
  value,
  values: [],
});
const list = (field: Condition["field"], op: Condition["op"], values: string[]): Condition => ({
  field,
  op,
  value: null,
  values,
});

describe("readConditionParams", () => {
  it("drops what it cannot read", () => {
    const params = [
      ["bogus", "over-1"],
      ["constructor", "over-1"],
      ["where", "over-1"],
      ["shreds", "1"],
      ["shreds", "over-x"],
      ["shreds", "over-"],
      ["shreds", "near-1"],
      ["not-shreds", "over-1"],
      ["country", ""],
    ] as const;
    expect(readConditionParams(params)).toEqual([]);
  });

  it("leaves out an incomplete condition when writing", () => {
    expect(conditionParams([{ field: "shreds", op: "gt", value: null, values: [] }])).toEqual([]);
    expect(conditionParams([number("shreds", "ge", 5), list("voted", "is", ["paid", "none"])])).toEqual([
      "shreds=min-5",
      "voted=paid,none",
    ]);
  });
});

describe("decodeConditions", () => {
  it("reads the old form of the address", () => {
    expect(decodeConditions("base_fee:gt:0.0025;client:is:Agave%20Bam|x%7Cy")).toEqual([
      number("base_fee", "gt", 0.0025),
      list("client", "is", ["Agave Bam", "x|y"]),
    ]);
  });

  it("drops what it cannot read", () => {
    expect(decodeConditions("bogus:gt:1;shreds:is:1;shreds:gt:x;country:is:")).toEqual([]);
    expect(decodeConditions(null)).toEqual([]);
  });
});

describe("describeCondition", () => {
  it("reads as the pill shows it", () => {
    expect(describeCondition(number("base_fee", "gt", 0.0025))).toBe("Base fee > 0.0025 SOL");
    expect(describeCondition(list("country", "is", ["DE", "NL"]))).toBe("Country is DE, NL");
    expect(describeCondition(list("voted", "is_not", ["unpaid"]))).toBe("Voted is not ✗ left out");
    expect(describeCondition(number("compute", "ge", 40_000_000))).toBe("Compute ≥ 40,000,000 CU");
  });
});

describe("rangeBounds with a bare time", () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime();

  it("ends a range after it starts, into the hours to come", () => {
    expect(rangeBounds("14:00", "16:00", undefined, now)).toEqual({
      from_slot: null,
      to_slot: null,
      from_millis: new Date(2026, 10, 4, 14, 0).getTime(),
      to_millis: new Date(2026, 10, 4, 16, 0).getTime(),
    });
  });

  it("says when an end has rolled over, which only a bare time can", () => {
    expect(endsNextDay("14:00", "16:00", now)).toBe(true);
    expect(endsNextDay("14:00", "14:30", now)).toBe(false);
    expect(endsNextDay("Nov 4 14:00", "Nov 3 16:00", now)).toBe(false);
    expect(endsNextDay("", "16:00", now)).toBe(false);
  });

  it("leaves dated ends and a range over midnight as read", () => {
    expect(rangeBounds("23:00", "01:00", undefined, now).to_millis).toBe(new Date(2026, 10, 4, 1, 0).getTime());
    expect(rangeBounds("Nov 5 08:00", "Nov 5 09:00", undefined, now).to_millis).toBe(new Date(2026, 10, 5, 9, 0).getTime());
  });
});

describe("a gap condition", () => {
  const gap = (op: "gt" | "eq", seconds: number) => number("gap", op, seconds);

  it("reads a time, a bare number being minutes", () => {
    expect(parseGap("30m")).toBe(1800);
    expect(parseGap("2h")).toBe(7200);
    expect(parseGap("90s")).toBe(90);
    expect(parseGap("1h30m")).toBe(5400);
    expect(parseGap("1.5h")).toBe(5400);
    expect(parseGap("30")).toBe(1800);
    expect(parseGap("")).toBeNull();
    expect(parseGap("soon")).toBeNull();
  });

  it("shows and writes the time", () => {
    expect(gapText(5400)).toBe("1h30m");
    expect(gapText(0)).toBe("0s");
    expect(describeCondition(gap("gt", 5400))).toBe("Gap > 1h 30m");
    expect(conditionParams([gap("gt", 1800)])).toEqual(["gap=over-30m"]);
    expect(readConditionParams([["gap", "over-30m"]])).toEqual([gap("gt", 1800)]);
    expect(readConditionParams([["gap", "over-soon"]])).toEqual([]);
  });

  it("goes to the validator in whole turns of slots at the slot time", () => {
    expect(toServer(gap("gt", 60), null, 400).value).toBe(152);
    expect(toServer(gap("gt", 60), null, 200).value).toBe(300);
    expect(toServer(gap("gt", 60), null).value).toBe(152);
  });

  it("holds against a turn's gap in slots, and is left to the turn by the slot test", () => {
    expect(gapHolds(gap("gt", 60), 200, 400)).toBe(true);
    expect(gapHolds(gap("gt", 60), 100, 400)).toBe(false);
    expect(gapHolds(gap("eq", 60), 152, 400)).toBe(true);
    expect(gapHolds(gap("gt", 60), null, 400)).toBe(false);
    expect(conditionHolds(gap("gt", 60), entry(), null, null)).toBe(true);
  });
});

describe("a version condition", () => {
  const held = (values: string[], version: string | null, op: "is" | "is_not" = "is") =>
    conditionHolds(list("version", op, values), entry(), { client: null, version, country: null, stake: 0, delinquent: false }, null);

  it("names a version whole or by its start at a dot", () => {
    expect(held(["4.4.1"], "4.4.1")).toBe(true);
    expect(held(["4.4"], "4.4.1")).toBe(true);
    expect(held(["4.4.0"], "4.4.0-rc.1")).toBe(true);
    expect(held(["4.4"], "4.40.1")).toBe(false);
    expect(held(["4.4"], null)).toBe(false);
    expect(held(["4.3"], "4.4.1", "is_not")).toBe(true);
  });
});

describe("nextOp", () => {
  it("moves a number round every comparison and a list between is and is not", () => {
    const seen = ["gt"];
    let condition = number("duration", "gt", 240);
    for (let step = 0; step < 5; step += 1) {
      condition = { ...condition, op: nextOp(condition) };
      seen.push(condition.op);
    }
    expect(seen).toEqual(["gt", "ge", "lt", "le", "eq", "gt"]);
    expect(nextOp(list("client", "is", ["Agave"]))).toBe("is_not");
    expect(nextOp(list("client", "is_not", ["Agave"]))).toBe("is");
  });
});

describe("toServer", () => {
  it("sends fees and stake in lamports, and tips before jito's cut", () => {
    expect(toServer(number("base_fee", "gt", 0.0025), null).value).toBeCloseTo(2_500_000);
    expect(toServer(number("stake", "ge", 1000), null).value).toBe(1_000_000_000_000);
    expect(toServer(number("tips", "gt", 0.0009), { jito_cut_bps: 1000, commission_bps: null }).value).toBeCloseTo(
      1_000_000,
    );
    expect(toServer(number("duration", "gt", 300), null).value).toBe(300);
  });
});

describe("conditionHolds", () => {
  const facts = { client: "AgaveBam", version: null, country: "DE", stake: 5_000_000_000_000, delinquent: true };

  it("compares a slot's figures in the units shown", () => {
    expect(conditionHolds(number("base_fee", "eq", 0.002), entry(), null, null)).toBe(true);
    expect(conditionHolds(number("duration", "gt", 249), entry(), null, null)).toBe(true);
    expect(conditionHolds(number("replay", "eq", 10), entry(), null, null)).toBe(true);
    expect(conditionHolds(number("block_fill", "eq", 25), entry(), null, null)).toBe(true);
    expect(conditionHolds(number("tips", "lt", 0.00095), entry(), null, { jito_cut_bps: 1000, commission_bps: null })).toBe(
      true,
    );
    expect(conditionHolds(number("shreds", "gt", 600), entry(), null, null)).toBe(false);
  });

  it("matches lists, and leaves a figure not measured unmatched either way", () => {
    expect(conditionHolds(list("voted", "is", ["unpaid"]), entry(), null, null)).toBe(true);
    expect(conditionHolds(list("country", "is", ["NL", "DE"]), entry(), facts, null)).toBe(true);
    expect(conditionHolds(list("client", "is_not", ["AgaveBam"]), entry(), facts, null)).toBe(false);
    expect(conditionHolds(list("country", "is_not", ["DE"]), entry(), null, null)).toBe(false);
    expect(conditionHolds(number("duration", "lt", 1000), entry({ duration_nanos: null }), null, null)).toBe(false);
  });

  it("takes a leader condition as met for a turn the validator returned", () => {
    expect(conditionHolds(list("country", "is", ["JP"]), entry(), "matched", null)).toBe(true);
    expect(conditionHolds(number("stake", "ge", 5000), entry(), facts, null)).toBe(true);
    expect(conditionHolds(list("leader", "is", ["delinquent"]), entry(), facts, null)).toBe(true);
    expect(conditionHolds(list("leader", "is", ["voting"]), entry(), { ...facts, delinquent: false }, null)).toBe(true);
  });
});

describe("nameHolds", () => {
  it("matches part of a name or key, any case, and any value listed", () => {
    expect(nameHolds(list("name", "is", ["nobody", "HELIUS"]), "Helius 2", "Key1")).toBe(true);
    expect(nameHolds(list("name", "is", ["key1"]), null, "Key1abc")).toBe(true);
    expect(nameHolds(list("name", "is_not", ["helius"]), "Helius", "Key1")).toBe(false);
    expect(nameHolds(list("name", "is", ["helius"]), null, null)).toBe(false);
  });
});

describe("rangeBounds", () => {
  const epoch = { epoch: 10, start_slot: 4_320, slots_in_epoch: 432 } as EpochInfo;
  const now = new Date(2026, 10, 2, 12, 0).getTime();

  it("reads each end as a slot, a time or an epoch", () => {
    expect(rangeBounds("4,400", "epoch 10", epoch, now)).toEqual({
      from_slot: 4_400,
      to_slot: 4_751,
      from_millis: null,
      to_millis: null,
    });
    const timed = rangeBounds("Nov 2 08:00", "", epoch, now);
    expect(timed.from_millis).toBe(new Date(2026, 10, 2, 8, 0).getTime());
    expect(hasRange(rangeBounds("", "", epoch, now))).toBe(false);
  });

  it("places a live slot by number and time", () => {
    const range = rangeBounds("390", "Nov 2 08:00", epoch, now);
    expect(inRange(range, entry({ slot: 400, time_millis: new Date(2026, 10, 2, 7, 0).getTime() }))).toBe(true);
    expect(inRange(range, entry({ slot: 380 }))).toBe(false);
    expect(inRange(range, entry({ slot: 400, time_millis: new Date(2026, 10, 2, 9, 0).getTime() }))).toBe(false);
  });
});
