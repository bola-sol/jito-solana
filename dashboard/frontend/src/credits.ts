
import { count, percent } from "./format";
import type { VoteParticipation } from "./types";

export function creditsShare(credits: number, clusterMax: number | null): number | null {
  if (clusterMax === null || clusterMax <= 0) return null;
  return Math.min(1, Math.max(0, credits) / clusterMax);
}

/** To the nearest hundredth of a percent, except that only the best itself reads as all of it. */
export function shareText(share: number | null): string {
  if (share === null) return percent(null);
  const rounded = Math.round(share * 10_000) / 10_000;
  return percent(share < 1 ? Math.min(rounded, 0.9999) : rounded, 2);
}

/** Where we stand, for the figure's explanation: the median, and how far behind the best. */
export function standingText(ours: number, best: number, median: number | null, unit: string): string {
  const gap = best - ours;
  const behind = gap > 0 ? `ours ${count(gap)} ${unit}${gap === 1 ? "" : "s"} behind the best` : "ours the best";
  const share = median === null ? null : creditsShare(median, best);
  return share === null ? behind : `cluster median ${shareText(share)}, ${behind}`;
}

export function participationShare(
  participation: VoteParticipation | null | undefined,
  epoch: number,
): number | null {
  if (!participation || participation.epoch !== epoch) return null;
  return creditsShare(participation.paid, participation.cluster_max);
}
