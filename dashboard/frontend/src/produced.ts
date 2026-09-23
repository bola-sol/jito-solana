/** Summary figures over the blocks this validator produced. */

import { ourShare } from "./tips";
import { count } from "./format";
import type { BlockCertificate, ProducedBlock, TipRates } from "./types";

/** The share of base fees the runtime burns; the rest goes to the leader
 *  with the priority fees. Fixed in `fee_distribution.rs`. */
export const BASE_FEE_BURN_PERCENT = 50;

/** What one block earned this validator, in lamports, by part. */
export interface Earned {
  /** Base fees after the burn. */
  base: number;
  priority: number;
  /** Our commission on the tips; null where they were not measured or the
   *  commission is not known. */
  tips: number | null;
  total: number;
}

/** What `block` earned this validator, by the runtime's own arithmetic: the
 *  burn floored, the rest kept. */
export function earnedOf(block: ProducedBlock, rates: TipRates | undefined): Earned {
  const gross = block.total_fees - block.priority_fees;
  const base = gross - Math.floor((gross * BASE_FEE_BURN_PERCENT) / 100);
  const tips = rates && block.tips !== null ? ourShare(block.tips, rates) : null;
  return { base, priority: block.priority_fees, tips, total: base + block.priority_fees + (tips ?? 0) };
}

/** One figure per column. Null, not nought, where no block had one. */
export interface BlockFigures {
  transactions: number | null;
  /** Share of the block cost limit used, in `[0, 1]`. */
  filled: number | null;
  /** Lamports earned this validator per block; see `earnedOf`. */
  earned: number | null;
  durationMillis: number | null;
}

/** The head of the block list: the mean, the median, and the poor tail of
 *  each column over the blocks held. */
export interface BlockSummary {
  blocks: number;
  mean: BlockFigures;
  median: BlockFigures;
  /** The fifth percentile of transactions, fill and earnings, and the ninety
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
export type SortKey = "transactions" | "filled" | "earned" | "duration";
export type SortDir = "desc" | "asc";

const SORT_VALUE: Record<SortKey, (block: ProducedBlock, rates: TipRates | undefined) => number | null> = {
  transactions: (block) => block.transactions,
  filled: (block) => (block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null),
  earned: (block, rates) => earnedOf(block, rates).total,
  duration: (block) => block.duration_nanos,
};

/** The blocks by one column, a block with no figure for it last either way. */
export function sortBlocks(
  blocks: ProducedBlock[],
  key: SortKey,
  dir: SortDir,
  rates?: TipRates,
): ProducedBlock[] {
  const value = SORT_VALUE[key];
  const sign = dir === "desc" ? -1 : 1;
  return [...blocks].sort((a, b) => {
    const left = value(a, rates);
    const right = value(b, rates);
    if (left === null || right === null) return left === null ? (right === null ? 0 : 1) : -1;
    return sign * (left - right);
  });
}

export function blockSummary(blocks: ProducedBlock[] | undefined, rates?: TipRates): BlockSummary {
  const held = blocks ?? [];
  const transactions = valuesOf(held, (block) => block.transactions);
  // The blocks' own shares, since the figure heads that column.
  const filled = valuesOf(held, (block) =>
    block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null,
  );
  const earned = valuesOf(held, (block) => earnedOf(block, rates).total);
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
      earned: meanOf(earned),
      durationMillis: meanOf(duration),
    },
    median: {
      transactions: quantileOf(transactions, 0.5),
      filled: quantileOf(filled, 0.5),
      earned: quantileOf(earned, 0.5),
      durationMillis: quantileOf(duration, 0.5),
    },
    worst: {
      transactions: quantileOf(transactions, 0.05),
      filled: quantileOf(filled, 0.05),
      earned: quantileOf(earned, 0.05),
      durationMillis: quantileOf(duration, 0.95),
    },
  };
}

/** The certificate strip's verdict: in line, or who it left out. */
export function certificateVerdict(certificate: BlockCertificate): { text: string; warn: boolean } {
  const out = certificate.left_out.length;
  if (out === 0) return { text: "in line with the cluster", warn: false };
  return { text: `left out ${count(out)} certificates usually pay`, warn: true };
}
