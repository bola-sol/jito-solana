
import type { SlotCost } from "./types";

export interface Recurrence {
  blocks: number;
  of: number;
  peakCost: number;
  peakSlot: number;
}

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
