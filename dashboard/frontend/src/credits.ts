/** Vote performance against the cluster's best this epoch. */

import { percent } from "./format";
import type { VoteParticipation } from "./types";

/** Our credits as a share of the most any validator has earned. Null until
 *  the cluster figure is known or while it is still nought. */
export function creditsShare(credits: number, clusterMax: number | null): number | null {
  if (clusterMax === null || clusterMax <= 0) return null;
  return Math.min(1, Math.max(0, credits) / clusterMax);
}

/** The share to two decimals, rounded down so that 100.00% is only ever the
 *  best itself. */
export function shareText(share: number | null): string {
  if (share === null) return percent(null);
  return percent(Math.floor(share * 10_000 + 1e-9) / 10_000, 2);
}

/** Our paid slots as a share of the most any validator has. Null until a
 *  certificate from `epoch` has been read. */
export function participationShare(
  participation: VoteParticipation | null | undefined,
  epoch: number,
): number | null {
  if (!participation || participation.epoch !== epoch) return null;
  return creditsShare(participation.paid, participation.cluster_max);
}
