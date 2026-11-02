import { SLOTS_PER_TURN } from "./schedule";
import type { EpochInfo } from "./types";

/** The live edge's line between the turns to come and the rest, as a key in the schedule's list. */
export const EDGE_KEY = -1;

/** The line above the epoch's last turn. */
export const EPOCH_END_KEY = -2;

/** Turns to come drawn above the live one at first, and added each time the reader nears the top. */
export const FUTURE_PAGE = 256;

/** The epoch's last turn number. */
export function lastTurnOf(epoch: EpochInfo): number {
  return Math.floor(epoch.end_slot / SLOTS_PER_TURN);
}

/** The newest turn listed, kept at least a page ahead of the live turn and never past the epoch. */
export function raiseTop(was: number | null, live: number, last: number): number {
  return Math.min(last, Math.max(was ?? live, live + FUTURE_PAGE));
}

/** Turn numbers after `live` up to `top`, newest first. */
export function futureNumbers(live: number, top: number): number[] {
  const numbers: number[] = [];
  for (let number = top; number > live; number--) numbers.push(number);
  return numbers;
}

/** Our turns after `live` this epoch, newest first. */
export function ourFutureNumbers(epoch: EpochInfo, live: number): number[] {
  const turns = new Set<number>();
  for (const slot of epoch.my_leader_slots) {
    const number = Math.floor(slot / SLOTS_PER_TURN);
    if (number > live) turns.add(number);
  }
  return [...turns].sort((a, b) => b - a);
}

/** When `slot` should start, counted from `from` at the slot time the header's countdown uses. */
export function expectedAt(slot: number, from: number, now: number, slotNanos: number): number {
  return now + (slot - from) * (slotNanos / 1e6);
}

const MINUTE = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "numeric", hour12: false });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** To the minute, so the text holds still between slots; another day gets its weekday. */
export function aboutClock(millis: number, now: number): string {
  const at = new Date(millis);
  const day = at.toDateString() === new Date(now).toDateString() ? "" : `${WEEKDAY.format(at)} `;
  return `≈ ${day}${MINUTE.format(at)}`;
}
