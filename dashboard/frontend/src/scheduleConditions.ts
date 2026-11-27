/** The schedule's column conditions and range: what each reads, how it shows, how it travels in the
 *  address and to the validator, and how the page matches it on the live window. The validator
 *  matches the same in `search.rs`. */

import { LAMPORTS_PER_SOL } from "./format";
import type { ScheduleColumns } from "./layout";
import { SLOTS_PER_TURN } from "./schedule";
import { isBareTime, parseJump, type Jump } from "./scheduleFilters";
import { timelineOf } from "./timeline";
import { jitoShare } from "./tips";
import type { EpochInfo, SlotEntry, TipRates } from "./types";

export type Field =
  | "leader"
  | "name"
  | "client"
  | "version"
  | "country"
  | "stake"
  | "gap"
  | "voted"
  | "left_out"
  | "transactions"
  | "failed"
  | "failed_share"
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

/** `value` is in the unit shown, a gap's in seconds; `values` holds a list field's picks. */
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
  name: { label: "Validator", unit: "", list: true, group: "status", leader: true },
  client: { label: "Client", unit: "", list: true, group: "status", leader: true },
  version: { label: "Version", unit: "", list: true, group: "status", leader: true },
  country: { label: "Country", unit: "", list: true, group: "status", leader: true },
  stake: { label: "Stake", unit: "SOL", list: false, group: "status", leader: true },
  gap: { label: "Gap", unit: "", list: false, group: "status", leader: true },
  voted: { label: "Voted", unit: "", list: true, group: "status", leader: false },
  left_out: { label: "Left out", unit: "", list: false, group: "status", leader: false },
  transactions: { label: "Transactions", unit: "", list: false, group: "status", leader: false },
  failed: { label: "Failed", unit: "", list: false, group: "status", leader: false },
  failed_share: { label: "Failed", unit: "%", list: false, group: "status", leader: false },
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

export const NUMBER_OPS: readonly Op[] = ["gt", "ge", "lt", "le", "eq"];
export const LIST_OPS: readonly Op[] = ["is", "is_not"];

export const OP_LABELS: Readonly<Record<Op, string>> = { gt: ">", ge: "≥", lt: "<", le: "≤", eq: "=", is: "is", is_not: "is not" };

/** Our vote's verdict, as the Voted column marks it. */
const VOTED: readonly (readonly [value: string, label: string])[] = [
  ["paid", "✓ in"],
  ["unpaid", "✗ left out"],
  ["none", "○ none written"],
];

const DAY_MILLIS = 86_400_000;

/** Before the validator has said how long its slots take. */
export const DEFAULT_SLOT_MILLIS = 400;

/** Whether a condition is complete enough to ask for. */
export function ready(condition: Condition): boolean {
  return FIELDS[condition.field].list ? condition.values.length > 0 : condition.value !== null;
}

/** Seconds from `30m`, `2h`, `90s`, `1d` or `1h30m`; a bare number is minutes. */
export function parseGap(text: string): number | null {
  const bare = /^\d+(?:\.\d+)?$/.test(text);
  if (bare) return Number(text) * 60;
  const parts = /^(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(text);
  if (!parts || text === "") return null;
  return Number(parts[1] ?? 0) * 86_400 + Number(parts[2] ?? 0) * 3600 + Number(parts[3] ?? 0) * 60 + Number(parts[4] ?? 0);
}

/** A gap as typed: `1d`, `1h30m`, or with a separator as shown. */
export function gapText(seconds: number, separator = ""): string {
  const whole = Math.round(seconds);
  const parts: [number, string][] = [
    [Math.floor(whole / 86_400), "d"],
    [Math.floor((whole % 86_400) / 3600), "h"],
    [Math.floor((whole % 3600) / 60), "m"],
    [whole % 60, "s"],
  ];
  const held = parts.filter(([part]) => part > 0).map(([part, unit]) => `${part}${unit}`);
  return held.length > 0 ? held.join(separator) : "0s";
}

const OP_WORDS: Readonly<Partial<Record<Op, string>>> = { gt: "over", ge: "min", lt: "under", le: "max", eq: "is" };

/** A value in the address, its spaces, colons and commas left readable. */
export function encodeValue(text: string): string {
  return encodeURIComponent(text).replace(/%20/g, "+").replace(/%3A/g, ":").replace(/%2C/g, ",");
}

export function decodeValue(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/** In the address: `duration=over-400`, `country=DE,NL`, `not-client=Agave`. */
export function conditionParams(conditions: readonly Condition[]): string[] {
  return conditions.filter(ready).map((condition) => {
    if (!FIELDS[condition.field].list) {
      const value = condition.field === "gap" ? gapText(condition.value ?? 0) : condition.value;
      return `${condition.field}=${OP_WORDS[condition.op] ?? "is"}-${value}`;
    }
    const values = condition.values.map((value) => encodeValue(value).replace(/,/g, "%2C")).join(",");
    return `${condition.op === "is_not" ? "not-" : ""}${condition.field}=${values}`;
  });
}

/** Conditions from the address's keys and undecoded values; anything else is left out. */
export function readConditionParams(params: readonly (readonly [key: string, raw: string])[]): Condition[] {
  const read: Condition[] = [];
  for (const [key, raw] of params) {
    const not = key.startsWith("not-");
    const field = (not ? key.slice(4) : key) as Field;
    if (!FIELD_ORDER.includes(field)) continue;
    if (FIELDS[field].list) {
      const values = raw.split(",").map(decodeValue).filter(Boolean);
      if (values.length > 0) read.push({ field, op: not ? "is_not" : "is", value: null, values });
      continue;
    }
    const [, word, number = ""] = /^([a-z]+)-(.+)$/.exec(decodeValue(raw)) ?? [];
    const op = NUMBER_OPS.find((held) => OP_WORDS[held] === word);
    const value = field === "gap" ? parseGap(number) : Number(number);
    if (!not && op && number !== "" && value !== null && Number.isFinite(value)) read.push({ field, op, value, values: [] });
  }
  return read;
}

/** The address's form until 2026-11: `field:op:value`, or `field:op:a|b` for a list, joined by `;`. */
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

export interface ConditionParts {
  label: string;
  op: string;
  value: string;
  unit: string;
}

/** A pill's parts: "Base fee", ">", "0.0025", "SOL". */
export function conditionParts(condition: Condition): ConditionParts {
  const info = FIELDS[condition.field];
  const value =
    condition.field === "gap"
      ? gapText(condition.value ?? 0, " ")
      : condition.field === "voted"
        ? condition.values.map((held) => VOTED.find(([named]) => named === held)?.[1] ?? held).join(", ")
        : info.list
          ? condition.values.join(", ")
          : (condition.value?.toLocaleString("en-US", { maximumFractionDigits: 6 }) ?? "");
  return { label: info.label, op: OP_LABELS[condition.op], value, unit: info.list ? "" : info.unit };
}

/** A pill's text: "Base fee > 0.0025 SOL", "Country is DE, NL". */
export function describeCondition(condition: Condition): string {
  const { label, op, value, unit } = conditionParts(condition);
  return `${label} ${op} ${value}${unit ? ` ${unit}` : ""}`;
}

/** The comparison a pill moves to on a click. */
export function nextOp(condition: Condition): Op {
  const ops = FIELDS[condition.field].list ? LIST_OPS : NUMBER_OPS;
  return ops[(ops.indexOf(condition.op) + 1) % ops.length] ?? condition.op;
}

export interface ServerCondition {
  field: Field;
  op: Op;
  value: number;
  values: readonly string[];
}

/** In the validator's units: lamports, tips before jito's cut, which the page takes off, and a gap in
 *  slots at the slot time given. */
export function toServer(condition: Condition, rates: TipRates | null | undefined, slotMillis = DEFAULT_SLOT_MILLIS): ServerCondition {
  const value = condition.value ?? 0;
  let sent = value;
  if (condition.field === "gap") sent = gapSlots(value, slotMillis);
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
  version: string | null;
  country: string | null;
  stake: number;
  delinquent: boolean;
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
    case "failed":
      return block ? block.failed_transactions : null;
    case "failed_share":
      return block && block.non_vote_transactions > 0
        ? (block.failed_transactions / block.non_vote_transactions) * 100
        : null;
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
    case "name":
    case "client":
    case "version":
    case "country":
    case "gap":
    case "voted":
      return null;
  }
}

/** Whether a turn's leader is named by a name condition: part of its name or key, any case. */
export function nameHolds(condition: Pick<Condition, "op" | "values">, name: string | null | undefined, key: string | null | undefined): boolean {
  const parts = [name, key].filter((part): part is string => !!part).map((part) => part.toLowerCase());
  const named = condition.values.some((value) => {
    const wanted = value.trim().toLowerCase();
    return wanted !== "" && parts.some((part) => part.includes(wanted));
  });
  return condition.op === "is_not" ? !named : named;
}

/** Whether a version is named whole or by its start at a dot or dash: `4.4` holds `4.4.0`. */
export function versionNamed(condition: Pick<Condition, "values">, version: string): boolean {
  return condition.values.some((value) => {
    if (!version.startsWith(value)) return false;
    const rest = version.slice(value.length);
    return rest === "" || rest.startsWith(".") || rest.startsWith("-");
  });
}

/** On the page, as the validator matches it. With no leader facts, a leader condition is taken as
 *  met: the validator already matched it for the turns it returned. A name and a gap are matched on
 *  the turn, by `nameHolds` and `gapHolds`. */
export function conditionHolds(
  condition: Condition,
  entry: SlotEntry | null | undefined,
  leader: LeaderFacts | null | "matched",
  rates: TipRates | null | undefined,
): boolean {
  if (!entry) return false;
  const info = FIELDS[condition.field];
  if ((info.leader && leader === "matched") || condition.field === "name" || condition.field === "gap") return true;
  const facts = leader === "matched" ? null : leader;
  if (info.list) {
    const value =
      condition.field === "voted"
        ? entry.reward === "no_certificate" ? "none" : entry.reward
        : condition.field === "leader"
          ? facts && (facts.delinquent ? "delinquent" : "voting")
          : condition.field === "client"
            ? facts?.client
            : condition.field === "version"
              ? facts?.version
              : facts?.country;
    if (value == null) return false;
    const named = condition.field === "version" ? versionNamed(condition, value) : condition.values.includes(value);
    return condition.op === "is_not" ? !named : named;
  }
  return compared(condition.op, figure(condition.field, entry, facts, rates), condition.value);
}

export function compared(op: Op, value: number | null, wanted: number | null): boolean {
  if (value === null || wanted === null) return false;
  switch (op) {
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

/** A gap in slots, as the validator is sent it: to the nearest whole turn, so `=` can hold. */
function gapSlots(seconds: number, slotMillis: number): number {
  return Math.round((seconds * 1000) / slotMillis / SLOTS_PER_TURN) * SLOTS_PER_TURN;
}

/** Whether a turn with this gap in slots meets a gap condition; null where its gap is not known. */
export function gapHolds(condition: Condition, slots: number | null, slotMillis: number): boolean {
  return compared(condition.op, slots, gapSlots(condition.value ?? 0, slotMillis));
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

/** A time with no date ending before the range's start is the next day, so `14:00..16:00` at 15:00
 *  ends today. */
export function endsNextDay(since: string, until: string, now: number): boolean {
  const from = parseJump(since, now);
  const to = parseJump(until, now);
  return from?.kind === "time" && to?.kind === "time" && to.millis < from.millis && isBareTime(until);
}

/** The range's two ends as typed, each a slot, a time or an epoch; empty or unreadable is open. */
export function rangeBounds(since: string, until: string, epoch: EpochInfo | undefined, now: number): RangeBounds {
  const to = parseJump(until, now);
  const end = to?.kind === "time" && endsNextDay(since, until, now) ? { ...to, millis: to.millis + DAY_MILLIS } : to;
  return { ...NO_RANGE, ...bound(parseJump(since, now), "from", epoch), ...bound(end, "to", epoch) };
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
