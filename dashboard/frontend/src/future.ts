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

/** Each turn's gap in slots, by its place in the epoch: from its end to its leader's next turn, or to
 *  the epoch's end for its last. */
export function turnGaps(epoch: EpochInfo): Int32Array {
  const gaps = new Int32Array(epoch.turns.length);
  const next = new Map<number, number>();
  for (let at = epoch.turns.length - 1; at >= 0; at--) {
    const leader = epoch.turns[at] ?? -1;
    const later = next.get(leader);
    next.set(leader, at);
    const end = epoch.start_slot + (at + 1) * SLOTS_PER_TURN;
    gaps[at] = (later === undefined ? epoch.end_slot + 1 : epoch.start_slot + later * SLOTS_PER_TURN) - end;
  }
  return gaps;
}

/** A leader's turn numbers this epoch, oldest first. */
export function leaderTurns(epoch: EpochInfo, identity: string): number[] {
  const leader = epoch.leaders.indexOf(identity);
  const first = Math.floor(epoch.start_slot / SLOTS_PER_TURN);
  const turns: number[] = [];
  if (leader === -1) return turns;
  epoch.turns.forEach((held, at) => {
    if (held === leader) turns.push(first + at);
  });
  return turns;
}

/** A turn's gap in slots; null outside the epoch. */
export function gapOf(gaps: Int32Array | null, epoch: EpochInfo | undefined, turn: number): number | null {
  if (!gaps || !epoch) return null;
  return gaps[turn - Math.floor(epoch.start_slot / SLOTS_PER_TURN)] ?? null;
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
  /** The validator name conditions choose, from the first page. */
  named: string | null = null;
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
    this.named = reply.named;
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

/** The index in `turns`, oldest first, nearest a turn number. */
export function nearestTurn(turns: readonly number[], turn: number): number {
  let after = 0;
  let high = turns.length;
  while (after < high) {
    const middle = (after + high) >> 1;
    if ((turns[middle] ?? 0) < turn) after = middle + 1;
    else high = middle;
  }
  if (after === 0) return 0;
  if (after >= turns.length) return turns.length - 1;
  return turn - (turns[after - 1] ?? 0) <= (turns[after] ?? 0) - turn ? after - 1 : after;
}
