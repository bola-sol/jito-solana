import { SLOTS_PER_TURN } from "./schedule";
import type { RangeBounds } from "./scheduleConditions";
import type { EpochInfo, FutureReply, Peer } from "./types";

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

/** The slots turns to come can fill for a range, its times as the slots expected then and its end
 *  at most the epoch's; null where it holds none, or its times cannot be placed. */
export function futureWindow(
  range: RangeBounds,
  last: number,
  completed: number | undefined,
  slotNanos: number | undefined,
  now: number,
): { from_slot: number | null; to_slot: number } | null {
  let from = range.from_slot;
  let to = Math.min(range.to_slot ?? last, last);
  if (range.from_millis !== null || range.to_millis !== null) {
    if (completed === undefined || !slotNanos) return null;
    const slotAt = (millis: number): number => completed + Math.floor((millis - now) / (slotNanos / 1e6));
    if (range.from_millis !== null) from = Math.max(from ?? 0, slotAt(range.from_millis));
    if (range.to_millis !== null) to = Math.min(to, slotAt(range.to_millis));
  }
  return to < (from ?? 0) ? null : { from_slot: from, to_slot: to };
}

/** The turns to come a filter matches, read from the validator a page at a time. */
export class FutureMatches {
  /** Oldest first. */
  private held: number[] = [];
  /** The leaders of those turns, whose objects stay while held so cards can compare them. */
  readonly peers = new Map<string, Peer>();
  rest = 0;
  loading = false;

  constructor(
    /** Where the next page starts; null once read to the end. */
    public next: number | null,
    readonly window: { from_slot: number | null; to_slot: number },
  ) {}

  add(reply: FutureReply): void {
    this.held.push(...reply.turns);
    for (const leader of reply.leaders) {
      if (!this.peers.has(leader.identity)) this.peers.set(leader.identity, { ...leader, name: null, icon: null });
    }
    this.rest = reply.rest;
    this.next = reply.next;
  }

  /** Turn numbers after `live` read so far, newest first. */
  numbers(live: number): number[] {
    return this.held.filter((number) => number > live).reverse();
  }
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
