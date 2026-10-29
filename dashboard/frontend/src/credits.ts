
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

/** How far behind the best ours is, with the cluster median beside it; the best gets the median alone. */
export function standingText(ours: number, best: number, median: number | null, unit: string): string | null {
  const gap = best - ours;
  const share = median === null ? null : creditsShare(median, best);
  const medianText = share === null ? null : `cluster median ${shareText(share)}`;
  if (gap <= 0) return medianText;
  const behind = `${count(gap)} ${unit}${gap === 1 ? "" : "s"} behind the best`;
  return medianText === null ? behind : `${behind} (${medianText})`;
}

/** The figure's explanation, with where ours stands after it. */
export function withStanding(explain: string, standing: string | null): string {
  return standing === null ? `${explain}.` : `${explain}; ${standing}.`;
}

export function participationShare(
  participation: VoteParticipation | null | undefined,
  epoch: number,
): number | null {
  if (!participation || participation.epoch !== epoch) return null;
  return creditsShare(participation.paid, participation.cluster_max);
}
