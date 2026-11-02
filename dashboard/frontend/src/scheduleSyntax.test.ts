import { describe, expect, it } from "vitest";
import { FIELD_ORDER } from "./scheduleConditions";
import { ONLY } from "./scheduleFilters";
import { complete, readSearch, suggest, type Offered } from "./scheduleSyntax";

const offered: Offered = {
  fields: FIELD_ORDER,
  only: ONLY,
  clients: [
    ["Agave", 51_978],
    ["AgaveBam", 26_512],
    ["JitoLabs", 17_309],
  ],
  countries: ["DE", "NL", "US"],
  names: ["Helius", "Coinbase 05", "Coinbase Cloud", "Hamsa, Labs"],
};
const now = new Date(2026, 10, 2, 12, 0).getTime();

describe("readSearch", () => {
  it("leaves plain words as the name search", () => {
    expect(readSearch("  1000x  validator ", offered, now)).toEqual({
      words: "1000x validator",
      filters: [],
      errors: [],
      syntax: false,
    });
  });

  it("reads comparisons in the units shown, units and commas allowed", () => {
    const read = readSearch("duration>=240ms compute<40,000,000 basefee:0.002", offered, now);
    expect(read.errors).toEqual([]);
    expect(read.filters).toEqual([
      { kind: "condition", condition: { field: "duration", op: "ge", value: 240, values: [] } },
      { kind: "condition", condition: { field: "compute", op: "lt", value: 40_000_000, values: [] } },
      { kind: "condition", condition: { field: "base_fee", op: "eq", value: 0.002, values: [] } },
    ]);
  });

  it("names lists as the validator does, and negates with a dash", () => {
    const read = readSearch("client:agave,JITOLABS -geo:de voted:out leader:delinquent", offered, now);
    expect(read.errors).toEqual([]);
    expect(read.filters.map((filter) => (filter.kind === "condition" ? filter.condition : filter))).toEqual([
      { field: "client", op: "is", value: null, values: ["Agave", "JitoLabs"] },
      { field: "country", op: "is_not", value: null, values: ["DE"] },
      { field: "voted", op: "is", value: null, values: ["unpaid"] },
      { field: "leader", op: "is", value: null, values: ["delinquent"] },
    ]);
  });

  it("names validators, quoted where a name holds a space or comma", () => {
    const read = readSearch('name:Helius,"Coinbase 05" -name:"Hamsa, Labs" duration>400', offered, now);
    expect(read.errors).toEqual([]);
    expect(read.filters.map((filter) => (filter.kind === "condition" ? filter.condition : filter))).toEqual([
      { field: "name", op: "is", value: null, values: ["Helius", "Coinbase 05"] },
      { field: "name", op: "is_not", value: null, values: ["Hamsa, Labs"] },
      { field: "duration", op: "gt", value: 400, values: [] },
    ]);
    expect(readSearch('name:"a duration>3"', offered, now).filters).toEqual([
      { kind: "condition", condition: { field: "name", op: "is", value: null, values: ["a duration>3"] } },
    ]);
  });

  it("types the chips", () => {
    expect(readSearch("is:slow,fewtxs", offered, now).filters).toEqual([
      { kind: "only", only: "slow" },
      { kind: "only", only: "few_transactions" },
    ]);
  });

  it("reads ranges, epochs and the jump, times with spaces in them", () => {
    expect(readSearch("time:08:00..09:30", offered, now).filters).toEqual([{ kind: "range", since: "08:00", until: "09:30" }]);
    expect(readSearch("slot:459660000..", offered, now).filters).toEqual([{ kind: "range", since: "459660000", until: "" }]);
    expect(readSearch("epoch:1074..1076", offered, now).filters).toEqual([
      { kind: "range", since: "epoch 1074", until: "epoch 1076" },
    ]);
    const jump = readSearch("at:Nov 2 08:00 1000x", offered, now);
    expect(jump.filters).toEqual([{ kind: "at", text: "Nov 2 08:00" }]);
    expect(jump.words).toBe("1000x");
  });

  it("says why an expression cannot be read", () => {
    expect(readSearch("dura>240", offered, now).errors).toEqual(["No filter named dura."]);
    expect(readSearch("duration>", offered, now).errors).toEqual(["duration needs a number, e.g. duration>240."]);
    expect(readSearch("client:Nope", offered, now).errors).toEqual(["No leader runs a client named Nope."]);
    expect(readSearch("-duration>2", offered, now).errors).toHaveLength(1);
    expect(readSearch("at:soon", offered, now).errors).toHaveLength(1);
    expect(readSearch("tips>1", { ...offered, fields: ["duration"] }, now).errors).toEqual([
      "tips is not offered by this validator.",
    ]);
  });

  it("takes any client from a validator too old to name them", () => {
    expect(readSearch("client:Whatever", { ...offered, clients: [] }, now).errors).toEqual([]);
  });
});

describe("suggest", () => {
  it("offers names for a word begun, both ways round for a number", () => {
    expect(suggest("dur", offered).map((suggestion) => suggestion.insert)).toEqual(["duration>", "duration<"]);
    expect(suggest("1000x cl", offered).map((suggestion) => suggestion.insert)).toEqual(["client:"]);
    expect(suggest("-c", offered).map((suggestion) => suggestion.insert)).toEqual(["-client:"]);
  });

  it("offers values once the name is typed, leaving out those already in", () => {
    expect(suggest("client:", offered).map((suggestion) => suggestion.insert)).toEqual([
      "client:Agave",
      "client:AgaveBam",
      "client:JitoLabs",
    ]);
    expect(suggest("client:Agave,a", offered).map((suggestion) => suggestion.insert)).toEqual(["client:Agave,AgaveBam"]);
    expect(suggest("duration>2", offered)).toEqual([]);
    expect(suggest("voted:in,out", offered)).toEqual([]);
  });

  it("offers names by any part, quoting those that need it", () => {
    expect(suggest("name:coin", offered).map((suggestion) => suggestion.insert)).toEqual([
      'name:"Coinbase 05"',
      'name:"Coinbase Cloud"',
    ]);
    expect(suggest("name:Helius,ham", offered).map((suggestion) => suggestion.insert)).toEqual([
      'name:Helius,"Hamsa, Labs"',
    ]);
  });
});

describe("complete", () => {
  it("replaces the word at the caret", () => {
    expect(complete("1000x dur rest", 9, "duration>")).toEqual({ text: "1000x duration> rest", caret: 15 });
  });
});
