import { describe, expect, it } from "vitest";
import {
  conditionHolds,
  decodeConditions,
  nameHolds,
  describeCondition,
  encodeConditions,
  hasRange,
  inRange,
  nextOp,
  rangeBounds,
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

describe("encodeConditions", () => {
  it("round-trips through the address, dropping incomplete rows", () => {
    const conditions = [number("base_fee", "gt", 0.0025), list("client", "is", ["Agave Bam", "x|y"])];
    expect(decodeConditions(encodeConditions(conditions))).toEqual(conditions);
    expect(encodeConditions([{ field: "shreds", op: "gt", value: null, values: [] }])).toBe("");
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
  const facts = { client: "AgaveBam", country: "DE", stake: 5_000_000_000_000, delinquent: true };

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
