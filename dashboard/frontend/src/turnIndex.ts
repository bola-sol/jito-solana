import { NO_LEADER, SLOTS_PER_TURN, turnsOf, type LeaderRef, type Turn } from "./schedule";
import { SlotColumns, SlotRows } from "./slotColumns";
import type { SlotRange, WireRow } from "./slotHistory";
import type { EpochInfo, SlotEntry } from "./types";

export type LeaderOf = (slot: number, mine: boolean) => LeaderRef;

/** Built turns kept, many screens' worth; the rest are built from their slots when drawn. */
const TURNS_KEPT = 1024;

export function turnNumberOf(slot: number): number {
  return Math.floor(slot / SLOTS_PER_TURN);
}

/** Where the live window starts: its oldest slot not ours, since ours are also kept below it. */
export function liveFloor(live: readonly SlotEntry[]): number | null {
  const oldest = live.find((entry) => !entry.mine) ?? live[0];
  return oldest?.slot ?? null;
}

function sameLeader(turn: Turn, leader: LeaderRef): boolean {
  return leader.key === turn.leader && leader.name === turn.leader_name && leader.icon === turn.leader_icon;
}

/** Built turns by number, least recently drawn dropped first; a turn keeps its object while kept. */
class BuiltTurns {
  private turns = new Map<number, Turn>();

  get(number: number, build: () => Turn | undefined): Turn | undefined {
    const kept = this.turns.get(number);
    if (kept) {
      this.turns.delete(number);
      this.turns.set(number, kept);
      return kept;
    }
    const turn = build();
    if (!turn) return undefined;
    this.turns.set(number, turn);
    if (this.turns.size > TURNS_KEPT) {
      const oldest = this.turns.keys().next().value;
      if (oldest !== undefined) this.turns.delete(oldest);
    }
    return turn;
  }

  forget(number: number): void {
    this.turns.delete(number);
  }

  clear(): void {
    this.turns.clear();
  }

  /** A turn whose leader answers the same keeps its object. */
  relabel(leaderOf: LeaderOf): boolean {
    let changed = false;
    for (const [number, turn] of this.turns) {
      const leader = leaderOf(number * SLOTS_PER_TURN, turn.mine);
      if (sameLeader(turn, leader)) continue;
      this.turns.set(number, { ...turn, leader: leader.key, leader_name: leader.name, leader_icon: leader.icon });
      changed = true;
    }
    return changed;
  }
}

/** The rows a turn draws, from its first held slot to its end, without building it. */
function rowsOf(number: number, held: (slot: number) => boolean): number {
  const first = number * SLOTS_PER_TURN;
  for (let slot = first; slot < first + SLOTS_PER_TURN; slot++) {
    if (held(slot)) return first + SLOTS_PER_TURN - slot;
  }
  return SLOTS_PER_TURN;
}

function buildTurn(number: number, entryOf: (slot: number) => SlotEntry | undefined, leaderOf: LeaderOf) {
  const held: SlotEntry[] = [];
  for (let slot = number * SLOTS_PER_TURN; slot < (number + 1) * SLOTS_PER_TURN; slot++) {
    const entry = entryOf(slot);
    if (entry) held.push(entry);
  }
  return turnsOf(held, leaderOf)[0];
}

/**
 * The schedule's turns, newest first, over one unbroken run of slots: the live window and every
 * live slot seen since, as entries, and the history fetched below it, as columns.
 */
export class TurnIndex {
  private live = new Map<number, SlotEntry>();
  private history = new SlotColumns();
  private liveTurns: number[] = [];
  private historyTurns: number[] = [];
  private order: readonly number[] = [];
  private built = new BuiltTurns();
  private start: number | null = null;
  private lowest: number | null = null;
  private highest = -1;
  private epoch: EpochInfo | undefined;
  private identity: string | undefined;
  private leaderOf: LeaderOf = () => NO_LEADER;
  /** Moves on a reset, so a fetch begun before one can be dropped. */
  generation = 0;

  /** What history rows are read against; turns built against an older one are dropped. */
  setContext(epoch: EpochInfo | undefined, identity: string | undefined, leaderOf: LeaderOf): void {
    if (epoch !== this.epoch || identity !== this.identity) {
      this.history.forget();
      this.built.clear();
    }
    this.epoch = epoch;
    this.identity = identity;
    this.leaderOf = leaderOf;
  }

  /** The lowest slot held, with everything above it; null before the first live slots. */
  floor(): number | null {
    return this.lowest;
  }

  /** Where the live window began; history lies below it. */
  liveStart(): number | null {
    return this.start;
  }

  /** Turn numbers, newest first; replaced rather than changed. */
  numbers(): readonly number[] {
    return this.order;
  }

  /** Turn numbers from the live window and since, newest first. */
  liveNumbers(): readonly number[] {
    return this.liveTurns;
  }

  entry(slot: number): SlotEntry | undefined {
    return this.live.get(slot) ?? this.history.entry(slot, this.epoch, this.identity);
  }

  turn(number: number): Turn | undefined {
    return this.built.get(number, () => buildTurn(number, (slot) => this.entry(slot), this.leaderOf));
  }

  rowCount(number: number): number {
    return rowsOf(number, (slot) => this.live.has(slot) || this.history.has(slot));
  }

  /** Our own slots kept below the live window are left for the history to bring in, in order. */
  mergeLive(live: readonly SlotEntry[]): boolean {
    const start = liveFloor(live);
    if (start === null) return false;
    // A window beginning past what is held, as after a reconnect, would leave a gap.
    if (this.lowest === null || start > this.highest + 1) this.reset(start);
    const floor = this.start ?? start;
    const known = new Set(this.liveTurns);
    const added: number[] = [];
    let changed = false;
    for (const entry of live) {
      if (entry.slot < floor || this.live.get(entry.slot) === entry) continue;
      this.live.set(entry.slot, entry);
      this.highest = Math.max(this.highest, entry.slot);
      const number = turnNumberOf(entry.slot);
      this.built.forget(number);
      changed = true;
      if (!known.has(number)) {
        known.add(number);
        added.push(number);
      }
    }
    if (added.length > 0) {
      this.liveTurns = [...known].sort((a, b) => b - a);
      // Only a turn as old as the history's newest can already be listed there.
      const newestHistory = this.historyTurns[0];
      if (newestHistory !== undefined && added.some((number) => number <= newestHistory)) {
        this.historyTurns = this.historyTurns.filter((number) => !known.has(number));
      }
      this.order = [...this.liveTurns, ...this.historyTurns];
    }
    return changed;
  }

  /** A fetched span from `first` up to the floor, one row a slot. */
  addHistory(first: number, rows: readonly (WireRow | null)[]): boolean {
    const floor = this.lowest;
    if (floor === null || first >= floor) return false;
    const span = rows.slice(0, floor - first);
    this.history.add(first, span);
    this.lowest = first;
    const live = new Set(this.liveTurns);
    const added: number[] = [];
    for (let slot = floor - 1; slot >= first; slot--) {
      if (span[slot - first] == null) continue;
      const number = turnNumberOf(slot);
      // The turn across the old floor gains rows; a live one stays listed where it is.
      this.built.forget(number);
      if (live.has(number) || added.at(-1) === number || this.historyTurns.at(-1) === number) continue;
      added.push(number);
    }
    if (added.length > 0) {
      this.historyTurns = [...this.historyTurns, ...added];
      this.order = [...this.liveTurns, ...this.historyTurns];
    }
    return true;
  }

  relabel(): boolean {
    return this.built.relabel(this.leaderOf);
  }

  private reset(floor: number): void {
    this.live.clear();
    this.history = new SlotColumns();
    this.liveTurns = [];
    this.historyTurns = [];
    this.order = [];
    this.built.clear();
    this.start = floor;
    this.lowest = floor;
    this.highest = floor - 1;
    this.generation += 1;
  }
}

/** A search's matching turns, a page at a time as the validator finds them, each with the rows its
 *  certificates are read from. */
export class FoundTurns {
  private rows = new SlotRows();
  private epoch: EpochInfo | undefined;
  private identity: string | undefined;
  private order: readonly number[] = [];
  private built = new BuiltTurns();
  /** Where the next page starts; null once the validator has read its history to the end. */
  next: number | null;
  /** A page is on its way. */
  loading = false;
  readonly query: string;
  readonly ours: boolean;

  constructor(query: string, ours: boolean, before: number) {
    this.query = query;
    this.ours = ours;
    this.next = before;
  }

  add(
    turns: readonly SlotRange[],
    next: number | null,
    epoch: EpochInfo | undefined,
    identity: string | undefined,
  ): void {
    this.epoch = epoch;
    this.identity = identity;
    const added: number[] = [];
    for (const range of turns) {
      this.rows.add(range.first_slot, range.rows);
      added.push(turnNumberOf(range.first_slot + range.rows.length - 1));
    }
    this.order = [...this.order, ...added];
    this.next = next;
  }

  numbers(): readonly number[] {
    return this.order;
  }

  entry(slot: number): SlotEntry | undefined {
    return this.rows.entry(slot, this.epoch, this.identity);
  }

  turn(number: number, leaderOf: LeaderOf): Turn | undefined {
    return this.built.get(number, () => buildTurn(number, (slot) => this.entry(slot), leaderOf));
  }

  rowCount(number: number): number {
    return rowsOf(number, (slot) => this.rows.has(slot));
  }

  relabel(leaderOf: LeaderOf): boolean {
    return this.built.relabel(leaderOf);
  }
}
