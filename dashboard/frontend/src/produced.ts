/** Summary figures over the blocks this validator produced. */

import type { ProducedBlock } from "./types";

/** One figure per column. Null, not nought, where no block had one. */
export interface BlockFigures {
  transactions: number | null;
  /** Share of the block cost limit used, in `[0, 1]`. */
  filled: number | null;
  fees: number | null;
  durationMillis: number | null;
}

/** The head of the block list: the mean, the median, and the poor tail of
 *  each column over the blocks held. */
export interface BlockSummary {
  blocks: number;
  mean: BlockFigures;
  median: BlockFigures;
  /** The fifth percentile of transactions, fill and fees, and the ninety
   *  fifth of duration: the end of each column a leader does not want. */
  worst: BlockFigures;
}

type Figure = (block: ProducedBlock) => number | null;

/** What the callback yields, over the blocks that have one. */
function valuesOf(blocks: ProducedBlock[], of: Figure): number[] {
  const values: number[] = [];
  for (const block of blocks) {
    const value = of(block);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  return values;
}

function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** The value `q` of the way through the sorted values, interpolated between
 *  neighbours, so a median of an even count is the middle pair's mean. */
function quantileOf(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = q * (sorted.length - 1);
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
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

export function blockSummary(blocks: ProducedBlock[] | undefined): BlockSummary {
  const held = blocks ?? [];
  const transactions = valuesOf(held, (block) => block.transactions);
  // The blocks' own shares, since the figure heads that column.
  const filled = valuesOf(held, (block) =>
    block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null,
  );
  const fees = valuesOf(held, (block) => block.total_fees);
  // Only the blocks whose duration was measured. A slot the validator never
  // saw timed shows a dash in its own row and is left out rather than counted
  // as nought milliseconds.
  const duration = valuesOf(held, (block) =>
    block.duration_nanos === null ? null : block.duration_nanos / 1e6,
  );
  return {
    blocks: held.length,
    mean: {
      transactions: meanOf(transactions),
      filled: meanOf(filled),
      fees: meanOf(fees),
      durationMillis: meanOf(duration),
    },
    median: {
      transactions: quantileOf(transactions, 0.5),
      filled: quantileOf(filled, 0.5),
      fees: quantileOf(fees, 0.5),
      durationMillis: quantileOf(duration, 0.5),
    },
    worst: {
      transactions: quantileOf(transactions, 0.05),
      filled: quantileOf(filled, 0.05),
      fees: quantileOf(fees, 0.05),
      durationMillis: quantileOf(duration, 0.95),
    },
  };
}
