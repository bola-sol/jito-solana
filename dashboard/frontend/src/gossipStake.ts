/** The supermajority wait's validator list, split and summed for the card. */

import { SUPERMAJORITY_PERCENT } from "./startup";
import type { GossipStake, GossipValidator } from "./types";

/** The validators gossip has seen and the ones it has not, each in the
 *  validator's order, which is stake descending. */
export function groupsOf(stake: GossipStake): {
  seen: GossipValidator[];
  unseen: GossipValidator[];
} {
  return {
    seen: stake.validators.filter((row) => row.seen),
    unseen: stake.validators.filter((row) => !row.seen),
  };
}

/** Lamports still to be seen before the wait ends, nought once it has. */
export function toLine(stake: GossipStake): number {
  return Math.max(0, (stake.total * SUPERMAJORITY_PERCENT) / 100 - stake.seen);
}

/** The version most seen stake runs, so the others can be marked. */
export function majorityVersion(stake: GossipStake): string | null {
  const weight = new Map<string, number>();
  for (const row of stake.validators) {
    if (row.version === null) continue;
    weight.set(row.version, (weight.get(row.version) ?? 0) + row.stake);
  }
  let best: string | null = null;
  let most = 0;
  for (const [version, sum] of weight) {
    if (sum > most) {
      most = sum;
      best = version;
    }
  }
  return best;
}
