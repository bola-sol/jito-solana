/** The schedule's filters and its jump: what each condition asks of a slot, and what the jump field
 *  reads. The validator applies the same conditions to its history in `search.rs`. */

import type { ScheduleColumns } from "./layout";
import { SLOTS_PER_TURN } from "./schedule";
import type { EpochInfo, SlotEntry } from "./types";

export type Only = "skipped" | "slow" | "left_out" | "few_transactions" | "no_tips";

export const ONLY: readonly Only[] = ["skipped", "slow", "left_out", "few_transactions", "no_tips"];

/** Fewer non-vote transactions than this is few. Matches `FEW_TRANSACTIONS` on the server. */
export const FEW_TRANSACTIONS = 100;

export const ONLY_LABELS: Record<Only, string> = {
  skipped: "Skipped",
  slow: "Slow",
  left_out: "Left out",
  few_transactions: "Few txs",
  no_tips: "No tips",
};

export const ONLY_TITLES: Record<Only, string> = {
  skipped: "Slots the leader did not produce.",
  slow: "Slots in the slowest 5% for their place in the turn.",
  left_out: "Slots whose reward certificate left our vote out.",
  few_transactions: `Blocks with fewer than ${FEW_TRANSACTIONS} non-vote transactions.`,
  no_tips: "Blocks whose tips were read as nought.",
};

/** The column group that shows each condition's figure, where the table shows one at a time. */
export const ONLY_COLUMNS: Record<Only, ScheduleColumns> = {
  skipped: "status",
  slow: "timing",
  left_out: "status",
  few_transactions: "status",
  no_tips: "fees",
};

/** Each place in the turn's slow cut-off in milliseconds, first slot first; null where too few
 *  slots were measured. */
export type SlowCutOffs = readonly (number | null)[];

/** Reads the conditions from the address, in their own order, dropping any not known. */
export function readOnly(text: string | null): Only[] {
  const named = new Set((text ?? "").split(","));
  return ONLY.filter((condition) => named.has(condition));
}

/** Whether a slot meets every condition; slow needs the validator's cut-offs. */
export function meets(
  slot: number,
  entry: SlotEntry | null | undefined,
  only: readonly Only[],
  slow: SlowCutOffs | null,
): boolean {
  if (!entry) return false;
  return only.every((condition) => {
    switch (condition) {
      case "skipped":
        return entry.level === "skipped";
      case "slow": {
        const limit = slow?.[slot % SLOTS_PER_TURN] ?? null;
        return limit !== null && entry.duration_nanos !== null && entry.duration_nanos / 1e6 > limit;
      }
      case "left_out":
        return entry.reward === "unpaid";
      case "few_transactions":
        return entry.block !== null && entry.block.non_vote_transactions < FEW_TRANSACTIONS;
      case "no_tips":
        return entry.block?.tips === 0;
    }
  });
}

/** What the filters keep, in a sentence; the slow cut-offs once the validator has sent them. */
export function describeOnly(only: readonly Only[], slow: SlowCutOffs | null): string {
  const cutOffs = only.includes("slow") ? describeSlow(slow) : "";
  if (only.length === 1 && only[0] !== undefined) {
    return only[0] === "slow" && cutOffs ? `The slowest 5% for their place in the turn: ${cutOffs}.` : ONLY_TITLES[only[0]];
  }
  const all = `Slots that are all of ${only.map((condition) => ONLY_LABELS[condition].toLowerCase()).join(", ")}.`;
  return cutOffs ? `${all} Slow: ${cutOffs}.` : all;
}

function describeSlow(slow: SlowCutOffs | null): string {
  const [first, ...rest] = slow ?? [];
  const known = rest.filter((limit): limit is number => limit !== null);
  if (first == null || known.length === 0) return "";
  const low = Math.min(...known);
  const high = Math.max(...known);
  return `over ${first} ms for a first slot, ${low === high ? low : `${low}–${high}`} ms for the rest`;
}

export type Jump = { kind: "slot"; slot: number } | { kind: "time"; millis: number } | { kind: "epoch"; epoch: number };

/** Where a jumped list starts: turns below `before`, and for a time, from the turn begun by `until`.
 *  `top` is one past the newest turn's last slot; the epoch sizes earlier epochs as the current one. */
export function jumpStart(
  jump: Jump,
  epoch: EpochInfo | undefined,
  top: number,
): { before: number; until: number | null } {
  switch (jump.kind) {
    case "slot":
      return { before: Math.min(top, (Math.floor(jump.slot / SLOTS_PER_TURN) + 1) * SLOTS_PER_TURN), until: null };
    case "time":
      return { before: top, until: jump.millis };
    case "epoch": {
      if (!epoch) return { before: top, until: null };
      const end = epoch.start_slot + (jump.epoch - epoch.epoch + 1) * epoch.slots_in_epoch;
      return { before: Math.max(0, Math.min(top, end)), until: null };
    }
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?`;
const TIME_ONLY = new RegExp(`^${TIME}$`);
const ISO = new RegExp(String.raw`^(\d{4})-(\d{1,2})-(\d{1,2})[ T]${TIME}$`);
const MONTH_DAY = new RegExp(String.raw`^([a-z]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?,?\s+${TIME}$`);
const DAY_MONTH = new RegExp(String.raw`^(\d{1,2})\s+([a-z]{3,})\.?(?:\s+(\d{4}))?,?\s+${TIME}$`);

/** A slot, a local time (`08:00`, `Nov 2 08:00`, `2 Nov 08:00`, `2026-11-02 08:00`) or an epoch
 *  (`epoch 1071`); null for anything else. A time with no date is the latest one not after `now`, and
 *  a date with no year likewise. */
export function parseJump(text: string, now: number): Jump | null {
  const typed = text.trim().toLowerCase();
  if (!typed) return null;
  const epoch = /^epoch\s*(\d+)$/.exec(typed);
  if (epoch) return { kind: "epoch", epoch: Number(epoch[1]) };
  if (/^\d[\d,\s]*$/.test(typed)) return { kind: "slot", slot: Number(typed.replace(/[,\s]/g, "")) };

  const today = new Date(now);
  let match = TIME_ONLY.exec(typed);
  if (match) {
    const millis = localTime(today.getFullYear(), today.getMonth(), today.getDate(), match.slice(1, 4));
    if (millis === null) return null;
    if (millis <= now) return { kind: "time", millis };
    const yesterday = new Date(now - 86_400_000);
    const earlier = localTime(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), match.slice(1, 4));
    return earlier === null ? null : { kind: "time", millis: earlier };
  }
  match = ISO.exec(typed);
  if (match) {
    const millis = localTime(Number(match[1]), Number(match[2]) - 1, Number(match[3]), match.slice(4, 7));
    return millis === null ? null : { kind: "time", millis };
  }
  match = MONTH_DAY.exec(typed);
  const dayMonth = match ? null : DAY_MONTH.exec(typed);
  const [monthName, day, year, clock] = match
    ? [match[1], match[2], match[3], match.slice(4, 7)]
    : dayMonth
      ? [dayMonth[2], dayMonth[1], dayMonth[3], dayMonth.slice(4, 7)]
      : [undefined, undefined, undefined, []];
  const month = MONTHS.findIndex((name) => monthName?.startsWith(name));
  if (month === -1 || day === undefined) return null;
  if (year !== undefined) {
    const millis = localTime(Number(year), month, Number(day), clock);
    return millis === null ? null : { kind: "time", millis };
  }
  const millis = localTime(today.getFullYear(), month, Number(day), clock);
  if (millis === null) return null;
  if (millis <= now) return { kind: "time", millis };
  const lastYear = localTime(today.getFullYear() - 1, month, Number(day), clock);
  return lastYear === null ? null : { kind: "time", millis: lastYear };
}

/** Null where a field is out of range, rather than the date rolling over. */
function localTime(year: number, month: number, day: number, clock: readonly (string | undefined)[]): number | null {
  const [hours, minutes, seconds] = [Number(clock[0]), Number(clock[1]), Number(clock[2] ?? 0)];
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const date = new Date(year, month, day, hours, minutes, seconds);
  return date.getMonth() === month && date.getDate() === day ? date.getTime() : null;
}

/** The oldest slot the validator holds, and when it began. */
export interface Held {
  slot: number;
  millis: number | null;
}

/** An entry once finished: moved to the oldest held where older, emptied (live) where newer. */
export interface Clamped {
  text: string;
  moved: "older" | "newer" | null;
}

/** A time as the jump field reads it back: `Nov 2 08:00`, seconds where there are any. */
export function typedTime(millis: number): string {
  const at = new Date(millis);
  const name = MONTHS[at.getMonth()] ?? "jan";
  const month = name.charAt(0).toUpperCase() + name.slice(1);
  const clock = [at.getHours(), at.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":");
  const seconds = at.getSeconds() > 0 ? `:${String(at.getSeconds()).padStart(2, "0")}` : "";
  return `${month} ${at.getDate()} ${clock}${seconds}`;
}

/** A local time as a date-and-time picker takes it. */
export function pickerValue(millis: number): string {
  const at = new Date(millis);
  const two = (part: number) => String(part).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** Where an entry lies against what the validator holds, from `held` to `newest` and now. */
export function placeEntry(
  jump: Jump,
  held: Held | null,
  newest: number | null,
  epoch: EpochInfo | undefined,
  now: number,
): "older" | "newer" | null {
  switch (jump.kind) {
    case "slot":
      if (held && jump.slot < held.slot) return "older";
      return newest !== null && jump.slot > newest ? "newer" : null;
    case "time":
      if (held?.millis != null && jump.millis < held.millis) return "older";
      return jump.millis > now ? "newer" : null;
    case "epoch": {
      if (!epoch) return null;
      const first = epoch.start_slot + (jump.epoch - epoch.epoch) * epoch.slots_in_epoch;
      if (held && first + epoch.slots_in_epoch - 1 < held.slot) return "older";
      return newest !== null && first > newest ? "newer" : null;
    }
  }
}

/** A finished entry, moved inside what is held. Unreadable text is left as typed. */
export function clampEntry(
  text: string,
  held: Held | null,
  newest: number | null,
  epoch: EpochInfo | undefined,
  now: number,
): Clamped {
  const jump = parseJump(text, now);
  if (!jump) return { text, moved: null };
  const moved = placeEntry(jump, held, newest, epoch, now);
  if (moved === "older" && held) return { text: held.slot.toLocaleString("en-US"), moved };
  if (moved === "newer") return { text: "", moved };
  return { text, moved: null };
}
