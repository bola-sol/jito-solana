/** Vote credits against the cluster's best this epoch. */

/** Our credits as a share of the most any validator has earned. Null until
 *  the cluster figure is known or while it is still nought. */
export function creditsShare(credits: number, clusterMax: number | null): number | null {
  if (clusterMax === null || clusterMax <= 0) return null;
  return Math.min(1, Math.max(0, credits) / clusterMax);
}
