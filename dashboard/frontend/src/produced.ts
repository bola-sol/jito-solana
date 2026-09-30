
import { ourShare } from "./tips";
import { count } from "./format";
import type { BlockCertificate, ProducedBlock, TipRates } from "./types";

/** Fixed in `fee_distribution.rs`; the rest goes to the leader with the priority fees. */
export const BASE_FEE_BURN_PERCENT = 50;

export interface Earned {
  base: number;
  priority: number;
  tips: number | null;
  total: number;
}

/** What the list, its sort and its summary read of a block; the rest is fetched when one opens. */
export type BlockHead = Pick<
  ProducedBlock,
  | "slot"
  | "slot_time_millis"
  | "transactions"
  | "block_cost"
  | "block_cost_limit"
  | "total_fees"
  | "priority_fees"
  | "tips"
  | "duration_nanos"
>;

/** By the runtime's own arithmetic: the burn floored, the rest kept. */
export function earnedOf(block: BlockHead, rates: TipRates | undefined): Earned {
  const gross = block.total_fees - block.priority_fees;
  const base = gross - Math.floor((gross * BASE_FEE_BURN_PERCENT) / 100);
  const tips = rates && block.tips !== null ? ourShare(block.tips, rates) : null;
  return { base, priority: block.priority_fees, tips, total: base + block.priority_fees + (tips ?? 0) };
}

export interface BlockFigures {
  transactions: number | null;
  filled: number | null;
  earned: number | null;
  durationMillis: number | null;
}

export interface BlockSummary {
  blocks: number;
  mean: BlockFigures;
  median: BlockFigures;
  /** The end of each column a leader does not want: the fifth percentile, or the ninety-fifth of
   *  duration. */
  worst: BlockFigures;
}

type Figure = (block: BlockHead) => number | null;

function valuesOf(blocks: readonly BlockHead[], of: Figure): number[] {
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

/** Interpolated, so a median of an even count is the middle pair's mean. */
function quantileOf(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = q * (sorted.length - 1);
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

export type SortKey = "transactions" | "filled" | "earned" | "duration";
export type SortDir = "desc" | "asc";

const SORT_VALUE: Record<SortKey, (block: BlockHead, rates: TipRates | undefined) => number | null> = {
  transactions: (block) => block.transactions,
  filled: (block) => (block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null),
  earned: (block, rates) => earnedOf(block, rates).total,
  duration: (block) => block.duration_nanos,
};

/** A block with no figure for the column sorts last either way. */
export function sortBlocks<T extends BlockHead>(
  blocks: readonly T[],
  key: SortKey,
  dir: SortDir,
  rates?: TipRates,
): T[] {
  const value = SORT_VALUE[key];
  const sign = dir === "desc" ? -1 : 1;
  // Each value read once: a whole epoch of blocks is sorted.
  const keyed = blocks.map((block) => ({ block, value: value(block, rates) }));
  keyed.sort((a, b) => {
    const left = a.value;
    const right = b.value;
    if (left === null || right === null) return left === null ? (right === null ? 0 : 1) : -1;
    return sign * (left - right);
  });
  return keyed.map((entry) => entry.block);
}

export function blockSummary(blocks: readonly BlockHead[] | undefined, rates?: TipRates): BlockSummary {
  const held = blocks ?? [];
  const transactions = valuesOf(held, (block) => block.transactions);
  const filled = valuesOf(held, (block) =>
    block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null,
  );
  const earned = valuesOf(held, (block) => earnedOf(block, rates).total);
  // Only the blocks whose duration was measured; an untimed slot is left out rather than counted as
  // nought.
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

export function certificateVerdict(certificate: BlockCertificate): { text: string; warn: boolean } {
  const out = certificate.left_out.length;
  if (out === 0) return { text: "in line with the cluster", warn: false };
  return { text: `left out ${count(out)} certificates usually pay`, warn: true };
}
