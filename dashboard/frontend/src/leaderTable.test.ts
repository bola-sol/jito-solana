import { describe, expect, it } from "vitest";
import { mergeLeaders } from "./leaderTable";
import type { LeaderRow, Peer } from "./types";

const row = (identity: string, stake = 1): LeaderRow => ({
  identity,
  client: "Agave",
  version: "4.4.1",
  ip: "8.8.8.8",
  country: "US",
  stake,
});
const peer = (identity: string, stake = 1): Peer => ({ ...row(identity, stake), name: "Named", icon: "icon" });

describe("mergeLeaders", () => {
  it("holds leaders the peer table has dropped", () => {
    const merged = mergeLeaders(new Map(), [row("far")], [peer("near")]);
    expect(merged.get("far")?.version).toBe("4.4.1");
    expect(merged.get("near")?.name).toBe("Named");
  });

  it("prefers the peer table, which is newer", () => {
    const merged = mergeLeaders(new Map(), [row("near", 1)], [peer("near", 2)]);
    expect(merged.get("near")?.stake).toBe(2);
  });

  it("keeps an entry's object as its leader leaves the peer table", () => {
    const near = mergeLeaders(new Map(), [row("a")], [peer("a")]);
    const left = mergeLeaders(near, [row("a")], []);
    expect(left.get("a")).toBe(near.get("a"));
  });

  it("gives a new object when a fact changes", () => {
    const first = mergeLeaders(new Map(), [row("a", 1)], []);
    const second = mergeLeaders(first, [row("a", 2)], []);
    expect(second.get("a")).not.toBe(first.get("a"));
    expect(second.get("a")?.stake).toBe(2);
  });

  it("works before the validator's list has come", () => {
    expect(mergeLeaders(new Map(), [], [peer("near")]).size).toBe(1);
  });
});
