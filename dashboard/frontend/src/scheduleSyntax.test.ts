import { describe, expect, it } from "vitest";
import { FIELD_ORDER, type Condition } from "./scheduleConditions";
import { ONLY } from "./scheduleFilters";
import { browse, complete, readSearch, suggest, valueText, withValue, type Offered } from "./scheduleSyntax";

const offered: Offered = {
  fields: FIELD_ORDER,
  only: ONLY,
  clients: [
    ["Agave", 51_978],
    ["AgaveBam", 26_512],
    ["JitoLabs", 17_309],
  ],
  countries: ["DE", "NL", "US"],
  versions: ["4.4.1", "4.4.0", "4.3.2"],
  names: ["Helius", "Coinbase 05", "Coinbase Cloud", "Hamsa, Labs"],
};
const now = new Date(2026, 10, 2, 12, 0).getTime();

describe("readSearch", () => {
  it("leaves plain words as the name search", () => {
    expect(readSearch("  1000x  validator ", offered, now)).toEqual({
      words: "1000x validator",
      filters: [],
      errors: [],
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

describe("gap", () => {
  it("reads a time and says when it cannot", () => {
    expect(readSearch("gap>30m", offered, now).filters).toEqual([
      { kind: "condition", condition: { field: "gap", op: "gt", value: 1800, values: [] } },
    ]);
    expect(readSearch("gap>soon", offered, now).errors).toEqual(["gap needs a time, e.g. gap>30m."]);
  });

  it("offers the comparison and an example", () => {
    expect(suggest("ga", offered).map((option) => [option.insert, option.ghost])).toEqual([
      ["gap>", "30m"],
      ["gap<", "30m"],
    ]);
    const row = browse(offered, null, null).find((held) => held.syntax === "gap>30m");
    expect(row?.action).toEqual({ kind: "condition", condition: { field: "gap", op: "gt", value: 1800, values: [] } });
  });

  it("types back as it was read", () => {
    const condition: Condition = { field: "gap", op: "ge", value: 5400, values: [] };
    expect(valueText(condition)).toBe("1h30m");
    expect(withValue(condition, "2h", offered)).toEqual({ ...condition, value: 7200 });
  });
});

describe("version", () => {
  it("reads a version with or without its v, and negates with a dash", () => {
    expect(readSearch("version:v4.4,4.3.2 -version:4.4.0-rc.1", offered, now).filters).toEqual([
      { kind: "condition", condition: { field: "version", op: "is", value: null, values: ["4.4", "4.3.2"] } },
      { kind: "condition", condition: { field: "version", op: "is_not", value: null, values: ["4.4.0-rc.1"] } },
    ]);
  });

  it("offers the versions seen", () => {
    expect(suggest("version:4.4", offered).map((option) => option.insert)).toEqual(["version:4.4.1", "version:4.4.0"]);
  });

  it("types back as it was read", () => {
    const condition: Condition = { field: "version", op: "is", value: null, values: ["4.4", "4.3.2"] };
    expect(withValue(condition, valueText(condition), offered)).toEqual(condition);
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

describe("valueText and withValue", () => {
  const voted: Condition = { field: "voted", op: "is_not", value: null, values: ["unpaid", "none"] };
  const named: Condition = { field: "name", op: "is", value: null, values: ["Hamsa, Labs", "Coinbase 05"] };
  const duration: Condition = { field: "duration", op: "ge", value: 240, values: [] };

  it("types a value as the box would take it", () => {
    expect(valueText(duration)).toBe("240");
    expect(valueText(voted)).toBe("out, none");
    expect(valueText(named)).toBe('"Hamsa, Labs", Coinbase 05');
  });

  it("reads a typed value back, keeping the comparison", () => {
    expect(withValue(duration, " 1,000 ms", offered)).toEqual({ ...duration, value: 1000 });
    expect(withValue(voted, "in", offered)).toEqual({ ...voted, values: ["paid"] });
    expect(withValue(named, valueText(named), offered)).toEqual(named);
    expect(withValue({ field: "client", op: "is", value: null, values: ["Agave"] }, "jitolabs, agave", offered)).toEqual({
      field: "client",
      op: "is",
      value: null,
      values: ["JitoLabs", "Agave"],
    });
  });

  it("says why a typed value cannot be read", () => {
    expect(withValue(duration, "soon", offered)).toBe("duration needs a number, e.g. duration>240.");
    expect(withValue(duration, "", offered)).toBe("duration needs a number, e.g. duration>240.");
    expect(withValue(voted, "", offered)).toBe("voted needs a value, e.g. voted:out.");
    expect(withValue(voted, "maybe", offered)).toBe("voted takes in, out or none.");
  });
});

describe("failed", () => {
  const read = (text: string) => readSearch(text, offered, 0);

  it("reads a number as a count and a percentage as a share", () => {
    expect(read("failed>100").filters).toEqual([{ kind: "condition", condition: { field: "failed", op: "gt", value: 100, values: [] } }]);
    expect(read("failed>=50%").filters).toEqual([{ kind: "condition", condition: { field: "failed_share", op: "ge", value: 50, values: [] } }]);
  });

  it("names the word typed when a value can't be read", () => {
    expect(read("failed>many%").errors).toEqual(["failed needs a number, e.g. failed>100."]);
  });

  it("moves a pill between a count and a share as its value is edited", () => {
    const count: Condition = { field: "failed", op: "gt", value: 100, values: [] };
    expect(withValue(count, "50%", offered)).toEqual({ ...count, field: "failed_share", value: 50 });
    const share: Condition = { field: "failed_share", op: "gt", value: 50, values: [] };
    expect(withValue(share, "60", offered)).toEqual({ ...share, value: 60 });
  });

  it("suggests the word once", () => {
    expect(suggest("fail", offered).map((row) => row.insert)).toEqual(["failed>", "failed<"]);
  });
});

describe("browse", () => {
  it("offers the chips first, then every key with an action", () => {
    const rows = browse(offered, 460_022_000, 1077);
    expect(rows.slice(0, 2).map((row) => [row.group, row.syntax])).toEqual([
      ["only", "is:skipped"],
      ["only", "is:slow"],
    ]);
    const find = (syntax: string) => rows.find((row) => row.syntax === syntax)?.action;
    expect(find("is:slow")).toEqual({ kind: "only", only: "slow" });
    expect(find("txs<100")).toEqual({ kind: "condition", condition: { field: "transactions", op: "lt", value: 100, values: [] } });
    expect(find("failed>100")).toEqual({ kind: "condition", condition: { field: "failed", op: "gt", value: 100, values: [] } });
    expect(find("failed>50%")).toEqual({ kind: "condition", condition: { field: "failed_share", op: "gt", value: 50, values: [] } });
    expect(find("client:")).toEqual({ kind: "type", text: "client:", from: 7 });
    expect(find("time:08:00..09:30")).toEqual({ kind: "type", text: "time:08:00..09:30", from: 5 });
    expect(find("epoch:1077")).toEqual({ kind: "type", text: "epoch:1077", from: 6 });
    expect(rows.some((row) => row.syntax.startsWith("is:") && row.group !== "only")).toBe(false);
  });

  it("leaves out what this validator does not offer", () => {
    const rows = browse({ ...offered, fields: FIELD_ORDER.filter((field) => field !== "tips"), only: ["slow"] }, null, null);
    expect(rows.filter((row) => row.group === "only").map((row) => row.syntax)).toEqual(["is:slow"]);
    expect(rows.some((row) => row.syntax.startsWith("tips"))).toBe(false);
  });
});
