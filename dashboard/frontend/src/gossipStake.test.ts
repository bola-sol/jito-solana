import { describe, expect, it } from "vitest";
import { groupsOf, majorityVersion, toLine } from "./gossipStake";
import type { GossipStake, GossipValidator } from "./types";

function node(identity: string, stake: number, version: string | null): GossipValidator {
  return { identity, name: null, icon: null, version, stake, seen: version !== null };
}

const stake: GossipStake = {
  slot: 100,
  shred_version: 7,
  total: 1000,
  seen: 600,
  validators: [node("a", 500, "4.3.0"), node("b", 300, null), node("c", 100, "4.2.2"), node("d", 100, null)],
};

describe("the wait's validator list", () => {
  it("splits the seen from the unseen, keeping the order", () => {
    const { seen, unseen } = groupsOf(stake);
    expect(seen.map((row) => row.identity)).toEqual(["a", "c"]);
    expect(unseen.map((row) => row.identity)).toEqual(["b", "d"]);
  });

  it("counts what is left to the line, and nought past it", () => {
    expect(toLine(stake)).toBe(200);
    expect(toLine({ ...stake, seen: 900 })).toBe(0);
  });

  it("names the version most seen stake runs", () => {
    expect(majorityVersion(stake)).toBe("4.3.0");
    expect(majorityVersion({ ...stake, validators: [] })).toBeNull();
  });
});
