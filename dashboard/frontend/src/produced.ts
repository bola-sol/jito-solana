/** Averages over the blocks this validator produced. */

import type { ProducedBlock } from "./types";

/** The mean of each figure over the blocks held. Null, not nought, where
 *  nothing could be averaged. */
export interface BlockAverages {
  blocks: number;
  transactions: number | null;
  /** Share of the block cost limit used, in `[0, 1]`. */
  filled: number | null;
  fees: number | null;
  durationMillis: number | null;
}

/** The mean of what the callback yields, over the entries that have one. */
function meanOf(blocks: ProducedBlock[], of: (block: ProducedBlock) => number | null): number | null {
  let total = 0;
  let counted = 0;
  for (const block of blocks) {
    const value = of(block);
    if (value === null || !Number.isFinite(value)) continue;
    total += value;
    counted += 1;
  }
  return counted === 0 ? null : total / counted;
}

/** The columns a produced block can be sorted by. */
export type SortKey = "transactions" | "filled" | "fees" | "duration";
export type SortDir = "desc" | "asc";

const SORT_VALUE: Record<SortKey, (block: ProducedBlock) => number | null> = {
  transactions: (block) => block.transactions,
  filled: (block) => (block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null),
  fees: (block) => block.total_fees,
  duration: (block) => block.duration_nanos,
};

/** The blocks by one column, a block with no figure for it last either way. */
export function sortBlocks(blocks: ProducedBlock[], key: SortKey, dir: SortDir): ProducedBlock[] {
  const value = SORT_VALUE[key];
  const sign = dir === "desc" ? -1 : 1;
  return [...blocks].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null || right === null) return left === null ? (right === null ? 0 : 1) : -1;
    return sign * (left - right);
  });
}

export function blockAverages(blocks: ProducedBlock[] | undefined): BlockAverages {
  const held = blocks ?? [];
  return {
    blocks: held.length,
    transactions: meanOf(held, (block) => block.transactions),
    // The mean of the blocks' own shares, since it heads that column.
    filled: meanOf(held, (block) =>
      block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null,
    ),
    fees: meanOf(held, (block) => block.total_fees),
    // Only the blocks whose duration was measured. A slot the validator never
    // saw timed shows a dash in its own row and is left out of the mean rather
    // than counted as nought milliseconds.
    durationMillis: meanOf(held, (block) =>
      block.duration_nanos === null ? null : block.duration_nanos / 1e6,
    ),
  };
}
