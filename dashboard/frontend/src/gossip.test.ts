import { describe, expect, it } from "vitest";
import {
  ariaSort,
  entryRows,
  filterCounts,
  FIRST_SORT,
  gossipPeers,
  gossipVerdict,
  ledgerText,
  matchesSearch,
  nextSort,
  rate,
  snapshotText,
  sortPeers,
  span,
  stakeText,
  timeParts,
  type PeerColumn,
} from "./gossip";
import type { Gossip, GossipPeers } from "./types";

const NOW = 1_790_000_000_000;

const LIST: GossipPeers = {
  root: 10_000,
  total_stake: 1_000,
  clients: [
    ["Agave", "4.3.0"],
    ["JitoLabs", "4.3.0"],
  ],
  identity: ["Big1111", "Mid2222", "Rpc3333", "Old4444"],
  name: ["Northwind", "harbor", null, "Pinecrest"],
  stake: [600, 300, 0, 50],
  client: [0, 1, 0, 0],
  ip: ["189.1.171.215", "67.202.63.79", "198.51.100.7", null],
  rpc: [null, null, 8899, null],
  heard_ago: [1_000, 2_000, 3_000, 74_000],
  started: [NOW - 6 * 86_400_000, NOW - 3_600_000, NOW - 840_000, 0],
  snapshot_full: [6_188, 6_188, null, 0],
  snapshot_incremental: [9_958, null, null, null],
  lowest: [9_000, 9_900, 9_990, null],
};

const PEERS = gossipPeers(LIST);

function order(column: PeerColumn, reversed = false): string[] {
  return sortPeers(PEERS, { column, reversed }, NOW).map((peer) => peer.identity);
}

describe("gossipPeers", () => {
  it("turns the columns into rows read against our root", () => {
    expect(PEERS[0]).toMatchObject({
      identity: "Big1111",
      client: "Agave v4.3.0",
      full: 3_812,
      incremental: 42,
      ledger: 1_000,
    });
    expect(PEERS[1].client).toBe("JitoLabs v4.3.0");
    expect(PEERS[2]).toMatchObject({ full: null, incremental: null, rpc: 8899 });
  });
});

describe("filters and search", () => {
  it("counts every filter over the same rows", () => {
    expect(filterCounts(PEERS, NOW)).toEqual({ all: 4, staked: 3, rpc: 1, silent: 1, restarted: 2 });
  });

  it("matches any part of a name, client, IP or identity", () => {
    const found = (query: string) => PEERS.filter((peer) => matchesSearch(peer, query)).map((peer) => peer.identity);
    expect(found("HARBOR")).toEqual(["Mid2222"]);
    expect(found("jito")).toEqual(["Mid2222"]);
    expect(found("198.51")).toEqual(["Rpc3333"]);
    expect(found("old4444")).toEqual(["Old4444"]);
    expect(found("  ")).toHaveLength(4);
  });
});

describe("sortPeers", () => {
  it("orders numbers high to low and text A to Z first", () => {
    expect(order("stake")).toEqual(["Big1111", "Mid2222", "Old4444", "Rpc3333"]);
    expect(order("name")).toEqual(["Mid2222", "Big1111", "Old4444", "Rpc3333"]);
    expect(order("heard")).toEqual(["Old4444", "Rpc3333", "Mid2222", "Big1111"]);
  });

  it("reverses on the same heading and keeps missing values last", () => {
    expect(order("name", true)).toEqual(["Old4444", "Big1111", "Mid2222", "Rpc3333"]);
    expect(order("rpc")[0]).toBe("Rpc3333");
    expect(order("rpc", true)[0]).toBe("Rpc3333");
  });

  it("sorts addresses by value and no snapshot as the oldest", () => {
    expect(order("ip")).toEqual(["Mid2222", "Big1111", "Rpc3333", "Old4444"]);
    expect(order("snapshot")).toEqual(["Rpc3333", "Old4444", "Mid2222", "Big1111"]);
  });

  it("steps through a heading's two orders and names them for ARIA", () => {
    const byName = nextSort(FIRST_SORT, "name");
    expect(byName).toEqual({ column: "name", reversed: false });
    expect(nextSort(byName, "name")).toEqual({ column: "name", reversed: true });
    expect(ariaSort(byName, "name")).toBe("ascending");
    expect(ariaSort(FIRST_SORT, "stake")).toBe("descending");
    expect(ariaSort(FIRST_SORT, "name")).toBeUndefined();
  });
});

describe("text", () => {
  it("keeps a span to two units", () => {
    expect(span(74_000)).toBe("74 s");
    expect(span(840_000)).toBe("14 min");
    expect(span(19 * 3_600_000)).toBe("19 h");
    expect(span((6 * 24 + 3) * 3_600_000)).toBe("6 d 3 h");
    expect(span(41 * 86_400_000)).toBe("41 d");
    expect(span(undefined)).toBe("—");
  });

  it("describes snapshots and ledger depth", () => {
    expect(snapshotText(PEERS[0])).toBe("full 3,812 · inc 42");
    expect(snapshotText(PEERS[1])).toBe("full 3,812 · none");
    expect(snapshotText(PEERS[2])).toBe("—");
    expect(ledgerText(1_000, 400)).toBe("6 min");
    expect(ledgerText(1_000, null)).toBe("1,000 slots");
    expect(ledgerText(null, 400)).toBe("—");
  });

  it("keeps two decimals of stake under one SOL", () => {
    expect(stakeText(17_840_232_000_000_000)).toBe("17,840,232");
    expect(stakeText(500_000_000)).toBe("0.50");
    expect(stakeText(0)).toBe("0");
  });

  it("keeps a decimal below ten", () => {
    expect(rate(0)).toBe("0");
    expect(rate(0.25)).toBe("0.3");
    expect(rate(11_534.6)).toBe("11,535");
  });
});

const GOSSIP: Gossip = {
  window_seconds: 10,
  table: {
    entries: 231_904,
    pubkeys: 4_112,
    pubkey_capacity: 8_192,
    nodes: 4_000,
    staked_nodes: 1_212,
    expired_per_second: 176,
    evicted_last_minute: 0,
  },
  messages: [],
  entries: {
    accepted_push: 0,
    accepted_pull: 0,
    duplicate_push: 0,
    redundant_pull: 0,
    rejected_push: 0,
    rejected_pull: 0,
    types: [
      { kind: "Vote", push: 10, pull: 1, rejected: 2 },
      { kind: "EpochSlots", push: 5, pull: 1, rejected: 0 },
      { kind: "ContactInfo", push: 4, pull: 1, rejected: 0 },
      { kind: "SnapshotHashes", push: 3, pull: 0, rejected: 0 },
      { kind: "LowestSlot", push: 2, pull: 0, rejected: 0 },
      { kind: "Version", push: 1, pull: 0, rejected: 1 },
      { kind: "NodeInstance", push: 1, pull: 0, rejected: 0 },
      { kind: "LegacyVersion", push: 0, pull: 0, rejected: 0 },
    ],
  },
  pressure: {
    dropped_in: 0,
    dropped_out: 0,
    pull_no_budget: 0,
    pull_scan_exhausted: 0,
    other_shred_version: 0,
    ping_check_failed: 0,
    unverified_addresses: 0,
    bad_prune_destination: 0,
  },
  time: { push: 150, pull_requests: 90, pull_responses: 50, ping_pong_prune: 10, verify: 75, other: -5 },
  dropped_last_minute: 0,
};

describe("cards", () => {
  it("names the five busiest types and sums the active rest", () => {
    const { shown, others } = entryRows(GOSSIP.entries.types);
    expect(shown.map((row) => row.label)).toEqual(["Vote", "EpochSlots", "ContactInfo", "SnapshotHashes", "LowestSlot"]);
    expect(others).toEqual({ label: "2 other types", push: 2, pull: 0, rejected: 1 });
    expect(entryRows(GOSSIP.entries.types.slice(0, 5)).others).toBeNull();
    const idle = GOSSIP.entries.types.map((type) => (type.kind === "Vote" ? type : { ...type, push: 0, pull: 0, rejected: 0 }));
    expect(entryRows(idle)).toEqual({ shown: [{ label: "Vote", kind: "Vote", push: 10, pull: 1, rejected: 2 }], others: null });
  });

  it("shares the time out, with a negative remainder as nothing", () => {
    const { parts, total } = timeParts(GOSSIP.time);
    expect(total).toBe(375);
    expect(parts[0]).toMatchObject({ label: "Handling pushes", millis: 150, share: 0.4 });
    expect(parts.find((part) => part.key === "other")?.millis).toBe(0);
  });
});

describe("gossipVerdict", () => {
  it("says when the points stop", () => {
    expect(gossipVerdict(null, null).tone).toBe("muted");
  });

  it("counts nodes and their stake from the peer list when it is in", () => {
    expect(gossipVerdict(GOSSIP, null).detail).toBe("4,000 nodes heard. Nothing dropped in the last minute.");
    expect(gossipVerdict(GOSSIP, LIST)).toEqual({
      tone: "good",
      headline: "Gossip is keeping up.",
      detail: "4 nodes heard, 95.0% of stake among them. Nothing dropped in the last minute.",
    });
  });

  it("warns on drops", () => {
    const verdict = gossipVerdict({ ...GOSSIP, dropped_last_minute: 1_204 }, LIST);
    expect(verdict.tone).toBe("warn");
    expect(verdict.detail).toMatch(/1,204 dropped in the last minute\.$/);
  });
});
