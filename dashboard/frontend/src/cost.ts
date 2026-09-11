/** A block's cost against the recent blocks around it, testable without a DOM. */

import type { SlotCost } from "./types";

/** How often one account has been the costliest across the blocks held. */
export interface Recurrence {
  /** Blocks in which this account was the costliest, including the one shown. */
  blocks: number;
  /** Blocks held, which is what those are out of. */
  of: number;
  /** The most it cost in any of them. */
  peakCost: number;
  /** The slot that happened in. */
  peakSlot: number;
}

/** How often the same account tops this validator's blocks, over every block
 *  held. `of` says what the count is out of. */
export function recurrence(costs: SlotCost[], account: string): Recurrence | null {
  if (!account) return null;
  const matching = costs.filter((cost) => cost.costliest_account === account);
  if (matching.length === 0) return null;

  let peak = matching[0];
  for (const cost of matching) {
    if (cost.costliest_cost > peak.costliest_cost) peak = cost;
  }

  return {
    blocks: matching.length,
    of: costs.length,
    peakCost: peak.costliest_cost,
    peakSlot: peak.slot,
  };
}
