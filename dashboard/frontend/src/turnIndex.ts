import { SLOTS_PER_TURN, turnsOf, type LeaderRef, type Turn } from "./schedule";
import type { SlotEntry } from "./types";

type LeaderOf = (slot: number, mine: boolean) => LeaderRef;

export function turnNumberOf(slot: number): number {
  return Math.floor(slot / SLOTS_PER_TURN);
}

/** Where the live window starts: its oldest slot not ours, since ours are also kept below it. */
export function liveFloor(live: readonly SlotEntry[]): number | null {
  const oldest = live.find((entry) => !entry.mine) ?? live[0];
  return oldest?.slot ?? null;
}

/**
 * The schedule's turns, newest first, over one unbroken run of slots: the live window, every live
 * slot seen since, and the history fetched below it. A turn keeps its object until one of its
 * slots or its leader changes.
 */
export class TurnIndex {
  private entries = new Map<number, SlotEntry>();
  private turns = new Map<number, Turn>();
  private order: readonly number[] = [];
  private lowest: number | null = null;
  private highest = -1;
  /** Moves on a reset, so a fetch begun before one can be dropped. */
  generation = 0;

  /** The lowest slot held, with everything above it; null before the first live slots. */
  floor(): number | null {
    return this.lowest;
  }

  /** Turn numbers, newest first; replaced rather than changed. */
  numbers(): readonly number[] {
    return this.order;
  }

  turn(number: number): Turn | undefined {
    return this.turns.get(number);
  }

  entry(slot: number): SlotEntry | undefined {
    return this.entries.get(slot);
  }

  /** Our own slots kept below the live window are left for the history to bring in, in order. */
  mergeLive(live: readonly SlotEntry[], leaderOf: LeaderOf): boolean {
    const start = liveFloor(live);
    if (start === null) return false;
    // A window beginning past what is held, as after a reconnect, would leave a gap.
    if (this.lowest === null || start > this.highest + 1) this.reset(start);
    const floor = this.lowest ?? start;
    const dirty = new Set<number>();
    for (const entry of live) {
      if (entry.slot < floor || this.entries.get(entry.slot) === entry) continue;
      this.entries.set(entry.slot, entry);
      this.highest = Math.max(this.highest, entry.slot);
      dirty.add(turnNumberOf(entry.slot));
    }
    return this.rebuild(dirty, leaderOf);
  }

  /** A fetched span from `first` up to the floor; a slot already held keeps its live entry. */
  addHistory(first: number, fetched: readonly SlotEntry[], leaderOf: LeaderOf): boolean {
    const floor = this.lowest;
    if (floor === null || first >= floor) return false;
    const dirty = new Set<number>();
    for (const entry of fetched) {
      if (entry.slot < first || entry.slot >= floor || this.entries.has(entry.slot)) continue;
      this.entries.set(entry.slot, entry);
      dirty.add(turnNumberOf(entry.slot));
    }
    this.lowest = first;
    this.rebuild(dirty, leaderOf);
    return true;
  }

  /** Asks every turn's leader again; a turn whose answer is unchanged keeps its object. */
  relabel(leaderOf: LeaderOf): boolean {
    let changed = false;
    for (const [number, turn] of this.turns) {
      const leader = leaderOf(number * SLOTS_PER_TURN, turn.mine);
      if (leader.key === turn.leader && leader.name === turn.leader_name && leader.icon === turn.leader_icon) {
        continue;
      }
      this.turns.set(number, { ...turn, leader: leader.key, leader_name: leader.name, leader_icon: leader.icon });
      changed = true;
    }
    return changed;
  }

  private reset(floor: number): void {
    this.entries.clear();
    this.turns.clear();
    this.order = [];
    this.lowest = floor;
    this.highest = floor - 1;
    this.generation += 1;
  }

  private rebuild(dirty: ReadonlySet<number>, leaderOf: LeaderOf): boolean {
    if (dirty.size === 0) return false;
    let added = false;
    for (const number of dirty) {
      const held: SlotEntry[] = [];
      for (let slot = number * SLOTS_PER_TURN; slot < (number + 1) * SLOTS_PER_TURN; slot++) {
        const entry = this.entries.get(slot);
        if (entry) held.push(entry);
      }
      const [turn] = turnsOf(held, leaderOf);
      if (!turn) continue;
      if (!this.turns.has(number)) added = true;
      this.turns.set(number, turn);
    }
    if (added) this.order = [...this.turns.keys()].sort((a, b) => b - a);
    return true;
  }
}
