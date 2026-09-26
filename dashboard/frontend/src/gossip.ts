import { buildLabel, count, decimal, percent, sol } from "./format";
import type { Gossip, GossipMessageKind, GossipPeers } from "./types";
import type { Tone } from "./verdict";

/** A node sends its contact record every seven and a half seconds, so a minute is several missed. */
export const SILENT_MILLIS = 60_000;

export const RESTARTED_MILLIS = 24 * 3_600_000;

/** Entry types listed by name; the rest share a row. */
export const BUSIEST_TYPES = 5;

export interface GossipPeer {
  identity: string;
  name: string | null;
  stake: number;
  client: string;
  ip: string | null;
  rpc: number | null;
  heardAgo: number;
  started: number;
  /** Slots behind our root, or null without that snapshot. */
  full: number | null;
  incremental: number | null;
  /** Slots from the peer's lowest slot to our root. */
  ledger: number | null;
  haystack: string;
}

function behind(root: number, slot: number | null | undefined): number | null {
  return slot === null || slot === undefined ? null : Math.max(0, root - slot);
}

export function gossipPeers(list: GossipPeers): GossipPeer[] {
  const clients = list.clients.map(([client, version]) => buildLabel(client, version));
  return list.identity.map((identity, index) => {
    const name = list.name[index] ?? null;
    const client = clients[list.client[index]] ?? "";
    const ip = list.ip[index] ?? null;
    return {
      identity,
      name,
      stake: list.stake[index] ?? 0,
      client,
      ip,
      rpc: list.rpc[index] ?? null,
      heardAgo: list.heard_ago[index] ?? 0,
      started: list.started[index] ?? 0,
      full: behind(list.root, list.snapshot_full[index]),
      incremental: behind(list.root, list.snapshot_incremental[index]),
      ledger: behind(list.root, list.lowest[index]),
      haystack: [name ?? "", client, ip ?? "", identity].join(" ").toLowerCase(),
    };
  });
}

export type PeerFilter = "all" | "staked" | "rpc" | "silent" | "restarted";

export const PEER_FILTERS: { filter: PeerFilter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "staked", label: "Staked" },
  { filter: "rpc", label: "RPC" },
  { filter: "silent", label: "Silent over 1 min" },
  { filter: "restarted", label: "Restarted today" },
];

export function inFilter(peer: GossipPeer, filter: PeerFilter, nowMillis: number): boolean {
  switch (filter) {
    case "all":
      return true;
    case "staked":
      return peer.stake > 0;
    case "rpc":
      return peer.rpc !== null;
    case "silent":
      return peer.heardAgo > SILENT_MILLIS;
    case "restarted":
      return peer.started > 0 && nowMillis - peer.started < RESTARTED_MILLIS;
  }
}

export function filterCounts(peers: GossipPeer[], nowMillis: number): Record<PeerFilter, number> {
  const counts: Record<PeerFilter, number> = { all: 0, staked: 0, rpc: 0, silent: 0, restarted: 0 };
  for (const peer of peers) {
    for (const { filter } of PEER_FILTERS) if (inFilter(peer, filter, nowMillis)) counts[filter] += 1;
  }
  return counts;
}

/** Any part of a name, client, IP or identity, ignoring case. */
export function matchesSearch(peer: GossipPeer, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || peer.haystack.includes(needle);
}

export type PeerColumn =
  | "stake"
  | "name"
  | "client"
  | "ip"
  | "rpc"
  | "heard"
  | "up"
  | "snapshot"
  | "ledger";

export interface PeerSort {
  column: PeerColumn;
  /** Against the column's first order: text A to Z, addresses low to high, and the rest high to low. */
  reversed: boolean;
}

export const FIRST_SORT: PeerSort = { column: "stake", reversed: false };

/** The same heading again reverses; a new one starts in its first order. */
export function nextSort(sort: PeerSort, column: PeerColumn): PeerSort {
  return sort.column === column ? { column, reversed: !sort.reversed } : { column, reversed: false };
}

function ipValue(ip: string | null): number | null {
  if (ip === null) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return Number.MAX_SAFE_INTEGER;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

/** The newest snapshot's age, with none as the oldest. */
function snapshotAge(peer: GossipPeer): number {
  return peer.incremental ?? peer.full ?? Infinity;
}

type Key = (peer: GossipPeer, nowMillis: number) => number | string | null;

/** A null sorts last either way. */
const COLUMNS: Record<PeerColumn, { key: Key; ascending: boolean }> = {
  stake: { key: (peer) => peer.stake, ascending: false },
  name: { key: (peer) => peer.name?.toLowerCase() ?? null, ascending: true },
  client: { key: (peer) => peer.client.toLowerCase(), ascending: true },
  ip: { key: (peer) => ipValue(peer.ip), ascending: true },
  rpc: { key: (peer) => peer.rpc, ascending: false },
  heard: { key: (peer) => peer.heardAgo, ascending: false },
  up: { key: (peer, now) => (peer.started > 0 ? now - peer.started : null), ascending: false },
  snapshot: { key: snapshotAge, ascending: false },
  ledger: { key: (peer) => peer.ledger, ascending: false },
};

function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b || 0;
  return String(a).localeCompare(String(b));
}

/** Ties fall back to stake, then identity, so a reload keeps the order. */
export function sortPeers(peers: GossipPeer[], sort: PeerSort, nowMillis: number): GossipPeer[] {
  const { key, ascending } = COLUMNS[sort.column];
  const sign = ascending !== sort.reversed ? 1 : -1;
  const keyed = peers.map((peer) => ({ peer, value: key(peer, nowMillis) }));
  keyed.sort((a, b) => {
    if (a.value !== b.value) {
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      const order = compareKeys(a.value, b.value);
      if (order !== 0) return sign * order;
    }
    return b.peer.stake - a.peer.stake || a.peer.identity.localeCompare(b.peer.identity);
  });
  return keyed.map(({ peer }) => peer);
}

/** The ARIA order for a heading: what the reader sees, not the column's first order. */
export function ariaSort(sort: PeerSort, column: PeerColumn): "ascending" | "descending" | undefined {
  if (sort.column !== column) return undefined;
  return COLUMNS[column].ascending !== sort.reversed ? "ascending" : "descending";
}

/** Whole SOL, with two decimals under one so a small stake is not shown as none. */
export function stakeText(lamports: number): string {
  return sol(lamports, lamports > 0 && lamports < 1e9 ? 2 : 0);
}

/** A figure and its unit, drawn apart so the unit can be dimmed. */
export interface Part {
  value: string;
  unit: string;
}

/** At most two units, for a table column; seconds up to two minutes, where a missed refresh shows. */
export function spanParts(millis: number | null | undefined): Part[] | null {
  if (millis === null || millis === undefined || !Number.isFinite(millis) || millis < 0) return null;
  const part = (value: number, unit: string) => ({ value: String(value), unit });
  const seconds = Math.floor(millis / 1000);
  if (seconds < 120) return [part(seconds, "s")];
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return [part(minutes, "min")];
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return [part(hours, "h")];
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return days < 10 && rest > 0 ? [part(days, "d"), part(rest, "h")] : [part(days, "d")];
}

/** As a time at the slot rate we observe, or in slots without one. */
export function ledgerParts(slots: number | null, slotMillis: number | null | undefined): Part[] | null {
  if (slots === null) return null;
  if (!slotMillis) return [{ value: count(slots), unit: " slots" }];
  return spanParts(slots * slotMillis);
}

/** Labelled figures, each label ahead of its figure; an empty value reads as none. */
export function snapshotParts(peer: GossipPeer): { label: string; value: string | null }[] | null {
  const incremental = peer.incremental === null ? null : count(peer.incremental);
  if (peer.full === null) return incremental === null ? null : [{ label: "inc", value: incremental }];
  return [
    { label: "full", value: count(peer.full) },
    { label: "inc", value: incremental },
  ];
}

/** Whole numbers from ten up; below that one decimal, so a trickle is not shown as nothing. */
export function rate(value: number): string {
  if (value <= 0) return "0";
  return value < 10 ? decimal(value, 1) : count(Math.round(value));
}

export const MESSAGE_LABELS: Record<GossipMessageKind, string> = {
  push: "Push",
  pull_request: "Pull request",
  pull_response: "Pull response",
  ping: "Ping",
  pong: "Pong",
  prune: "Prune",
};

export interface EntryRow {
  label: string;
  push: number;
  pull: number;
  rejected: number;
}

/** Idle types are left out. */
export function entryRows(types: Gossip["entries"]["types"]): { shown: EntryRow[]; others: EntryRow | null } {
  const active = types.filter((type) => type.push + type.pull + type.rejected > 0);
  const shown = active.slice(0, BUSIEST_TYPES).map((type) => ({ label: type.kind, ...type }));
  const rest = active.slice(BUSIEST_TYPES);
  if (rest.length === 0) return { shown, others: null };
  const others = rest.reduce(
    (sum, type) => ({
      ...sum,
      push: sum.push + type.push,
      pull: sum.pull + type.pull,
      rejected: sum.rejected + type.rejected,
    }),
    { label: `${rest.length} other ${rest.length === 1 ? "type" : "types"}`, push: 0, pull: 0, rejected: 0 },
  );
  return { shown, others };
}

export interface TimePart {
  key: keyof Gossip["time"];
  label: string;
  millis: number;
  share: number;
}

const TIME_LABELS: [keyof Gossip["time"], string][] = [
  ["push", "Handling pushes"],
  ["verify", "Verifying packets"],
  ["pull_requests", "Answering pull requests"],
  ["pull_responses", "Handling pull responses"],
  ["ping_pong_prune", "Ping, pong and prune"],
  ["other", "Other processing"],
];

export function timeParts(time: Gossip["time"]): { parts: TimePart[]; total: number } {
  const total = TIME_LABELS.reduce((sum, [key]) => sum + Math.max(0, time[key]), 0);
  const parts = TIME_LABELS.map(([key, label]) => {
    const millis = Math.max(0, time[key]);
    return { key, label, millis, share: total > 0 ? millis / total : 0 };
  });
  return { parts, total };
}

export interface GossipVerdict {
  tone: Tone;
  headline: string;
  detail: string;
}

export function gossipVerdict(
  gossip: Gossip | null | undefined,
  peers: GossipPeers | null,
): GossipVerdict {
  if (!gossip) {
    return {
      tone: "muted",
      headline: "Gossip figures are not arriving.",
      detail: "They come from gossip's own metrics points, which need info-level logging for solana_gossip.",
    };
  }
  const nodes = peers ? peers.identity.length : gossip.table.nodes;
  let heard = `${count(nodes)} ${nodes === 1 ? "node" : "nodes"} heard`;
  if (peers && peers.total_stake > 0) {
    const held = peers.stake.reduce((sum, stake) => sum + stake, 0);
    heard += `, ${percent(Math.min(1, held / peers.total_stake), 1)} of stake among them`;
  }
  const dropped = gossip.dropped_last_minute;
  if (dropped > 0) {
    return {
      tone: "warn",
      headline: "Gossip is dropping packets.",
      detail: `${heard}. ${count(dropped)} dropped in the last minute.`,
    };
  }
  return { tone: "good", headline: "Gossip is keeping up.", detail: `${heard}. Nothing dropped in the last minute.` };
}
