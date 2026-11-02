/** The schedule's column conditions and range: what each reads, how it shows, how it travels in the
 *  address and to the validator, and how the page matches it on the live window. The validator
 *  matches the same in `search.rs`. */

import type { ScheduleColumns } from "./layout";
import { parseJump, type Jump } from "./scheduleFilters";
import { timelineOf } from "./timeline";
import { jitoShare } from "./tips";
import type { EpochInfo, SlotEntry, TipRates } from "./types";

export type Field =
  | "leader"
  | "client"
  | "country"
  | "stake"
  | "voted"
  | "left_out"
  | "transactions"
  | "base_fee"
  | "priority"
  | "tips"
  | "duration"
  | "shreds"
  | "repaired"
  | "received"
  | "replay"
  | "compute"
  | "block_fill";

export type Op = "gt" | "ge" | "lt" | "le" | "eq" | "is" | "is_not";

/** `value` is in the unit shown; `values` holds a list field's picks. */
export interface Condition {
  field: Field;
  op: Op;
  value: number | null;
  values: readonly string[];
}

interface FieldInfo {
  label: string;
  unit: string;
  /** A list is picked from; a number is compared. */
  list: boolean;
  /** The column group that shows the figure, where the table shows one at a time. */
  group: ScheduleColumns;
  /** Read from the turn's leader rather than its slot. */
  leader: boolean;
}

export const FIELDS: Record<Field, FieldInfo> = {
  leader: { label: "Leader", unit: "", list: true, group: "status", leader: true },
  client: { label: "Client", unit: "", list: true, group: "status", leader: true },
  country: { label: "Country", unit: "", list: true, group: "status", leader: true },
  stake: { label: "Stake", unit: "SOL", list: false, group: "status", leader: true },
  voted: { label: "Voted", unit: "", list: true, group: "status", leader: false },
  left_out: { label: "Left out", unit: "", list: false, group: "status", leader: false },
  transactions: { label: "Transactions", unit: "", list: false, group: "status", leader: false },
  base_fee: { label: "Base fee", unit: "SOL", list: false, group: "fees", leader: false },
  priority: { label: "Priority", unit: "SOL", list: false, group: "fees", leader: false },
  tips: { label: "Tips", unit: "SOL", list: false, group: "fees", leader: false },
  duration: { label: "Duration", unit: "ms", list: false, group: "timing", leader: false },
  shreds: { label: "Shreds", unit: "", list: false, group: "load", leader: false },
  repaired: { label: "Repaired", unit: "", list: false, group: "load", leader: false },
  received: { label: "Received", unit: "ms", list: false, group: "timing", leader: false },
  replay: { label: "Replay", unit: "ms", list: false, group: "timing", leader: false },
  compute: { label: "Compute", unit: "CU", list: false, group: "load", leader: false },
  block_fill: { label: "Block fill", unit: "%", list: false, group: "load", leader: false },
};

export const FIELD_ORDER = Object.keys(FIELDS) as Field[];

const NUMBER_OPS: readonly Op[] = ["gt", "ge", "lt", "le", "eq"];
const LIST_OPS: readonly Op[] = ["is", "is_not"];

const OP_LABELS: Record<Op, string> = { gt: ">", ge: "≥", lt: "<", le: "≤", eq: "=", is: "is", is_not: "is not" };

/** Our vote's verdict, as the Voted column marks it. */
const VOTED: readonly (readonly [value: string, label: string])[] = [
  ["paid", "✓ in"],
  ["unpaid", "✗ left out"],
  ["none", "○ none written"],
];

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Whether a condition is complete enough to ask for. */
export function ready(condition: Condition): boolean {
  return FIELDS[condition.field].list ? condition.values.length > 0 : condition.value !== null;
}

/** In the address: `field:op:value`, or `field:op:a|b` for a list, joined by `;`. */
export function encodeConditions(conditions: readonly Condition[]): string {
  return conditions
    .filter(ready)
    .map((condition) =>
      [
        condition.field,
        condition.op,
        FIELDS[condition.field].list
          ? condition.values.map(encodeURIComponent).join("|")
          : String(condition.value),
      ].join(":"),
    )
    .join(";");
}

export function decodeConditions(text: string | null): Condition[] {
  const read: Condition[] = [];
  for (const part of (text ?? "").split(";")) {
    const [field, op, rest = ""] = part.split(":");
    if (!field || !op || !(field in FIELDS)) continue;
    const info = FIELDS[field as Field];
    if (!(info.list ? LIST_OPS : NUMBER_OPS).includes(op as Op)) continue;
    if (info.list) {
      const values = rest.split("|").filter(Boolean).map(decodeURIComponent);
      if (values.length > 0) read.push({ field: field as Field, op: op as Op, value: null, values });
    } else {
      const value = Number(rest);
      if (rest !== "" && Number.isFinite(value)) read.push({ field: field as Field, op: op as Op, value, values: [] });
    }
  }
  return read;
}

/** A pill's text: "Base fee > 0.0025 SOL", "Country is DE, NL". */
export function describeCondition(condition: Condition): string {
  const info = FIELDS[condition.field];
  const shown =
    condition.field === "voted"
      ? condition.values.map((value) => VOTED.find(([held]) => held === value)?.[1] ?? value).join(", ")
      : info.list
        ? condition.values.join(", ")
        : `${condition.value?.toLocaleString("en-US", { maximumFractionDigits: 6 }) ?? ""}${info.unit ? ` ${info.unit}` : ""}`;
  return `${info.label} ${OP_LABELS[condition.op]} ${shown}`;
}

export interface ServerCondition {
  field: Field;
  op: Op;
  value: number;
  values: readonly string[];
}

/** In the validator's units: lamports, and tips before jito's cut, which the page takes off. */
export function toServer(condition: Condition, rates: TipRates | null | undefined): ServerCondition {
  const value = condition.value ?? 0;
  let sent = value;
  if (condition.field === "stake" || condition.field === "base_fee" || condition.field === "priority") {
    sent = value * LAMPORTS_PER_SOL;
  } else if (condition.field === "tips") {
    const kept = rates ? jitoShare(LAMPORTS_PER_SOL, rates) / LAMPORTS_PER_SOL : 1;
    sent = kept > 0 ? (value * LAMPORTS_PER_SOL) / kept : value * LAMPORTS_PER_SOL;
  }
  return { field: condition.field, op: condition.op, value: sent, values: condition.values };
}

/** What the page knows of a live turn's leader, from the peer table. */
export interface LeaderFacts {
  client: string | null;
  country: string | null;
  stake: number;
  delinquent: boolean;
}

function voted(entry: SlotEntry): string | null {
  switch (entry.reward) {
    case "paid":
      return "paid";
    case "unpaid":
      return "unpaid";
    case "no_certificate":
      return "none";
    default:
      return null;
  }
}

/** A figure in the unit shown; null where not measured. */
function figure(
  field: Field,
  entry: SlotEntry,
  leader: LeaderFacts | null,
  rates: TipRates | null | undefined,
): number | null {
  const block = entry.block;
  switch (field) {
    case "stake":
      return leader ? leader.stake / LAMPORTS_PER_SOL : null;
    case "left_out":
      return entry.left_out;
    case "transactions":
      return block ? block.non_vote_transactions : null;
    case "base_fee":
      return block ? (block.total_fees - block.priority_fees) / LAMPORTS_PER_SOL : null;
    case "priority":
      return block ? block.priority_fees / LAMPORTS_PER_SOL : null;
    case "tips":
      return block?.tips == null ? null : (rates ? jitoShare(block.tips, rates) : block.tips) / LAMPORTS_PER_SOL;
    case "duration":
      return entry.duration_nanos === null ? null : entry.duration_nanos / 1e6;
    case "shreds":
      return entry.shreds ? entry.shreds.count : null;
    case "repaired":
      return entry.shreds ? entry.shreds.repaired : null;
    case "received":
      return entry.shreds ? entry.shreds.full_millis : null;
    case "replay":
      return timelineOf(entry)?.run ?? null;
    case "compute":
      return block ? block.block_cost : null;
    case "block_fill":
      return block && block.block_cost_limit > 0 ? (block.block_cost / block.block_cost_limit) * 100 : null;
    case "leader":
    case "client":
    case "country":
    case "voted":
      return null;
  }
}

/** On the page, as the validator matches it. With no leader facts, a leader condition is taken as
 *  met: the validator already matched it for the turns it returned. */
export function conditionHolds(
  condition: Condition,
  entry: SlotEntry | null | undefined,
  leader: LeaderFacts | null | "matched",
  rates: TipRates | null | undefined,
): boolean {
  if (!entry) return false;
  const info = FIELDS[condition.field];
  if (info.leader && leader === "matched") return true;
  const facts = leader === "matched" ? null : leader;
  if (info.list) {
    const value =
      condition.field === "voted"
        ? voted(entry)
        : condition.field === "leader"
          ? facts && (facts.delinquent ? "delinquent" : "voting")
          : condition.field === "client"
            ? facts?.client
            : facts?.country;
    if (value == null) return false;
    const named = condition.values.includes(value);
    return condition.op === "is_not" ? !named : named;
  }
  const value = figure(condition.field, entry, facts, rates);
  const wanted = condition.value;
  if (value === null || wanted === null) return false;
  switch (condition.op) {
    case "gt":
      return value > wanted;
    case "ge":
      return value >= wanted;
    case "lt":
      return value < wanted;
    case "le":
      return value <= wanted;
    case "eq":
      return Math.abs(value - wanted) < 1e-9;
    default:
      return false;
  }
}

/** A range in the validator's terms, each end a slot or a time. */
export interface RangeBounds {
  from_slot: number | null;
  to_slot: number | null;
  from_millis: number | null;
  to_millis: number | null;
}

export const NO_RANGE: RangeBounds = { from_slot: null, to_slot: null, from_millis: null, to_millis: null };

/** The epoch's first and last slots, sizing earlier epochs as the current one. */
function epochSlots(epoch: number, current: EpochInfo): [number, number] {
  const first = current.start_slot + (epoch - current.epoch) * current.slots_in_epoch;
  return [first, first + current.slots_in_epoch - 1];
}

function bound(jump: Jump | null, end: "from" | "to", epoch: EpochInfo | undefined): Partial<RangeBounds> {
  if (!jump) return {};
  if (jump.kind === "slot") return end === "from" ? { from_slot: jump.slot } : { to_slot: jump.slot };
  if (jump.kind === "time") return end === "from" ? { from_millis: jump.millis } : { to_millis: jump.millis };
  if (!epoch) return {};
  const [first, last] = epochSlots(jump.epoch, epoch);
  return end === "from" ? { from_slot: first } : { to_slot: last };
}

/** The range's two ends as typed, each a slot, a time or an epoch; empty or unreadable is open. */
export function rangeBounds(since: string, until: string, epoch: EpochInfo | undefined, now: number): RangeBounds {
  return {
    ...NO_RANGE,
    ...bound(parseJump(since, now), "from", epoch),
    ...bound(parseJump(until, now), "to", epoch),
  };
}

export function hasRange(range: RangeBounds): boolean {
  return Object.values(range).some((value) => value !== null);
}

/** Whether a live slot lies inside the range. */
export function inRange(range: RangeBounds, entry: SlotEntry): boolean {
  if (range.from_slot !== null && entry.slot < range.from_slot) return false;
  if (range.to_slot !== null && entry.slot > range.to_slot) return false;
  const time = entry.time_millis;
  if (time === null) return true;
  if (range.from_millis !== null && time < range.from_millis) return false;
  if (range.to_millis !== null && time > range.to_millis) return false;
  return true;
}
