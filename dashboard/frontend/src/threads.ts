/** The validator's threads over the last minute, as the host card draws
 *  them: one sample a second into rows with a minute of bars each. */

import type { ThreadsSample } from "./types";

/** Samples the card draws, one a second. */
export const THREADS_WINDOW = 60;

/** The one thread whose healthy state is a whole core: PoH, toned when it
 *  loses it. The only tone on the card. */
export const POH_THREAD = "solPohTickProd";
export const POH_LOW = 0.9;

export interface ThreadRow {
  name: string;
  /** What the row is called: a pool carries a star, the folded row a phrase. */
  label: string;
  count: number;
  cores: string | null;
  other: boolean;
  poh: boolean;
  /** On-cpu share per second, oldest first; null where the group had no row that second. */
  series: (number | null)[];
  now: number;
  /** The minute's worst second of waiting. */
  waiting: number;
}

function sameRow(a: { name: string; other: boolean }, b: { name: string; other: boolean }): boolean {
  return a.other ? b.other : !b.other && a.name === b.name;
}

/** The rows the last sample names, each with its minute read back through the samples before it. */
export function threadRows(samples: ThreadsSample[]): ThreadRow[] {
  const recent = samples.slice(-THREADS_WINDOW);
  const last = recent[recent.length - 1];
  if (!last) return [];

  return last.groups.map((group) => {
    const matching = recent.map((sample) => sample.groups.find((held) => sameRow(held, group)));
    const series = matching.map((held) => held?.on_cpu ?? null);
    const waiting = matching.reduce((peak, held) => Math.max(peak, held?.waiting ?? 0), 0);
    return {
      name: group.name,
      label: group.other ? "everything else" : group.count > 1 ? `${group.name}*` : group.name,
      count: group.count,
      cores: group.cores,
      other: group.other,
      poh: !group.other && group.name === POH_THREAD,
      series,
      now: group.on_cpu,
      waiting,
    };
  });
}

/** The row kept when the group is folded: the busiest, which the validator lists first. */
export function busiest(rows: ThreadRow[]): ThreadRow | undefined {
  return rows.find((row) => !row.other);
}

/** On cpu is untoned, except for PoH, where low is the bad reading. */
export function onCpuTone(row: ThreadRow): "warn" | null {
  return row.poh && row.now < POH_LOW ? "warn" : null;
}

/** What the pinned column says; "core 2" rather than a bare number. */
export function pinnedLabel(cores: string | null): string {
  if (cores === null) return "any";
  return /[-,]/.test(cores) ? `cores ${cores}` : `core ${cores}`;
}

/** Whether one second's bar is toned: only PoH's, and only when it lost its core. */
export function barLow(row: ThreadRow, share: number): boolean {
  return row.poh && share < POH_LOW;
}
