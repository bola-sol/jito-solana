/** The tab's title: the base, then the validator and its cluster, so an
 *  operator watching several can tell the tabs apart. */

/** Kept in step with index.html so the tab reads the same before the first
 *  snapshot arrives as it does after. */
export const TITLE = "Agave Dashboard";

/** `Private` matches what the header shows for a node with no on-chain name,
 *  and the plain title stands until a node answers. */
export function pageTitle(
  name: string | null | undefined,
  identity: string | undefined,
  cluster: string | undefined,
): string {
  const label = name ?? (identity ? "Private" : undefined);
  if (label === undefined) return TITLE;
  return cluster ? `${TITLE} | ${label} · ${cluster}` : `${TITLE} | ${label}`;
}
