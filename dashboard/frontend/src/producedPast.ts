import type { BlockHead } from "./produced";
import { headOfBlock, headOfTurn, type TurnHead } from "./producedIndex";
import type { LeaderTurn, ProducedBlock } from "./types";

/** What the block list shows: its heads by slot and its turns by first slot. */
export interface Shown {
  heads: ReadonlyMap<number, BlockHead>;
  turns: ReadonlyMap<number, TurnHead>;
  /** The oldest slot still held where the list at the moment shown reached further back; else null. */
  missingBefore: number | null;
}

/** The part of the index a past list is cut from. */
export interface Held {
  heads: ReadonlyMap<number, BlockHead>;
  turns: ReadonlyMap<number, TurnHead>;
  floor: number;
}

/**
 * The blocks held at a past moment: the newest as recorded then, and older ones from the index with
 * the figures they settled on, from the floor in force then. With nothing recorded, the index's
 * blocks up to `tip`.
 */
export function heldAt(
  held: Held,
  recorded: readonly ProducedBlock[] | undefined,
  recordedTurns: readonly LeaderTurn[] | undefined,
  floorAt: number | undefined,
  tip: number | null,
): Shown {
  const low = Math.max(held.floor, floorAt ?? 0);
  let oldestRecorded = Number.POSITIVE_INFINITY;
  for (const block of recorded ?? []) oldestRecorded = Math.min(oldestRecorded, block.slot);
  const high = recorded?.length ? oldestRecorded - 1 : (tip ?? Number.NEGATIVE_INFINITY);

  const heads = new Map<number, BlockHead>();
  for (const [slot, head] of held.heads) if (slot >= low && slot <= high) heads.set(slot, head);
  for (const block of recorded ?? []) if (block.slot >= low) heads.set(block.slot, headOfBlock(block));

  let oldestTurn = Number.POSITIVE_INFINITY;
  for (const turn of recordedTurns ?? []) oldestTurn = Math.min(oldestTurn, turn.first);
  const newest = recorded?.length ? Math.max(...recorded.map((block) => block.slot)) : high;
  const turns = new Map<number, TurnHead>();
  for (const [first, turn] of held.turns) {
    if (first >= low && first < oldestTurn && first <= newest) turns.set(first, turn);
  }
  for (const turn of recordedTurns ?? []) if (turn.first >= low) turns.set(turn.first, headOfTurn(turn));

  return { heads, turns, missingBefore: floorAt !== undefined && floorAt < held.floor ? held.floor : null };
}
