import type { LeaderRow, Peer } from "./types";

function sameFacts(a: LeaderRow, b: LeaderRow): boolean {
  return (
    a.stake === b.stake && a.version === b.version && a.client === b.client && a.ip === b.ip && a.country === b.country
  );
}

/** Each leader by identity, the peer table over the validator's list. An entry keeps its object while
 *  its facts read the same, so leaving the peer table redraws no card; cards take names from the turn. */
export function mergeLeaders(
  held: ReadonlyMap<string, Peer>,
  rows: readonly LeaderRow[],
  peers: readonly Peer[],
): Map<string, Peer> {
  const next = new Map<string, Peer>();
  const keep = (row: LeaderRow): void => {
    const was = held.get(row.identity);
    next.set(row.identity, was && sameFacts(was, row) ? was : { name: null, icon: null, ...row });
  };
  rows.forEach(keep);
  peers.forEach(keep);
  return next;
}
