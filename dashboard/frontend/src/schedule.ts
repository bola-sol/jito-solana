/** The slot list folded into the leader turns the schedule page shows. */

import type { EpochInfo, SlotEntry } from "./types";

/** Slots the leader schedule hands out at a time. Eight in a row is two
 *  turns, drawn as two cards. */
export const SLOTS_PER_TURN = 4;

/** Who leads a slot, and what the page can call them. */
export interface LeaderRef {
  key: string | null;
  name: string | null;
  icon: string | null;
}

/** Nobody, for a slot outside any epoch the page has the schedule for. */
export const NO_LEADER: LeaderRef = { key: null, name: null, icon: null };

/** Who leads a slot, from the epoch's turn array. Null outside the epoch or
 *  where the validator sent no schedule. */
export function leaderAt(epoch: EpochInfo | undefined, slot: number): string | null {
  if (!epoch || epoch.turns.length === 0) return null;
  if (slot < epoch.start_slot || slot > epoch.end_slot) return null;
  const turn = Math.floor((slot - epoch.start_slot) / SLOTS_PER_TURN);
  const index = epoch.turns[turn];
  if (index === undefined) return null;
  return epoch.leaders[index] ?? null;
}

/**
 * Which epoch a slot fell in, counted from the current epoch's start at its
 * length, which has been constant since warmup. Null without an epoch to
 * count from.
 */
export function epochOf(epoch: EpochInfo | undefined, slot: number): number | null {
  if (!epoch || epoch.slots_in_epoch <= 0) return null;
  const at = epoch.epoch + Math.floor((slot - epoch.start_slot) / epoch.slots_in_epoch);
  return at < 0 ? null : at;
}

/** One slot of a turn: what replay found, or nothing yet. */
export interface TurnSlot {
  slot: number;
  /** What replay found, or `null` for a slot of this turn still to come. */
  entry: SlotEntry | null;
}

/** One leader's turn at producing, four slots of it. */
export interface Turn {
  leader: string | null;
  leader_name: string | null;
  leader_icon: string | null;
  mine: boolean;
  /** Newest first, so the turn's own first slot is last. */
  slots: TurnSlot[];
}

/** The turns the held slots belong to, newest first. A turn is drawn whole
 *  from its first slot so nothing below it moves as it fills; a turn the
 *  window begins part way through keeps only the slots there are. */
export function turnsOf(
  held: SlotEntry[],
  leaderOf: (slot: number, mine: boolean) => LeaderRef,
): Turn[] {
  const byTurn = new Map<number, SlotEntry[]>();
  for (const entry of held) {
    const turn = Math.floor(entry.slot / SLOTS_PER_TURN);
    const entries = byTurn.get(turn);
    if (entries) entries.push(entry);
    else byTurn.set(turn, [entry]);
  }

  return [...byTurn.entries()]
    .sort(([a], [b]) => b - a)
    .map(([turn, entries]) => {
      // One lookup per turn; the slots carry whether it was ours.
      const mine = entries.some((entry) => entry.mine);
      const leader = leaderOf(turn * SLOTS_PER_TURN, mine);
      const first = Math.min(...entries.map((entry) => entry.slot));
      const slots: TurnSlot[] = [];
      for (let slot = turn * SLOTS_PER_TURN + SLOTS_PER_TURN - 1; slot >= first; slot--) {
        slots.push({ slot, entry: entries.find((entry) => entry.slot === slot) ?? null });
      }
      return {
        leader: leader.key,
        leader_icon: leader.icon,
        leader_name: leader.name,
        mine,
        slots,
      };
    });
}

/** Whether a turn matches the leader's name or key, or a slot number in it.
 *  An empty query matches everything. */
export function matchesQuery(turn: Turn, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  if (turn.leader_name?.toLowerCase().includes(needle)) return true;
  if (turn.leader?.toLowerCase().includes(needle)) return true;
  return turn.slots.some((slot) => String(slot.slot).includes(needle));
}

/** A stable name for a turn, by its first slot rather than its position. */
export function turnKey(turn: Turn): string {
  return `turn:${turn.slots.at(-1)?.slot}`;
}

