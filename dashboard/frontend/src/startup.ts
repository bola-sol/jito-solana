/**
 * What the Uptime hover shows: when the validator started, how long the boot
 * took and where, and how long it then trailed the cluster tip.
 */

import type { StartupProgress } from "./types";

/** The phases worth a line of their own; the rest are folded together. */
const NAMED: Record<string, string> = {
  downloading_snapshot: "snapshot download",
  loading_ledger: "loading ledger",
  processing_ledger: "ledger replay",
};

const REST = "everything else";

/**
 * The share of stake the validator waits to see in gossip before it starts.
 * The validator keeps this figure private, so it is written down here; it is
 * a cluster-wide rule rather than a setting.
 */
export const SUPERMAJORITY_PERCENT = 80;

/** What the supermajority wait has seen, in the form the status card draws. */
export interface StakeSeen {
  /** In `[0, 1]`. */
  fraction: number;
  /** Decimals worth drawing: three from the exact count, none from the whole percent. */
  decimals: number;
  /** Lamports, or null while only the whole percent has arrived. */
  online: number | null;
  total: number | null;
}

/**
 * The wait's progress, from the validator's own count where it has arrived
 * and from the whole percent in the progress report before then. Null outside
 * the wait.
 */
export function stakeSeen(startup: StartupProgress): StakeSeen | null {
  if (startup.phase !== "waiting_for_supermajority") return null;
  const counted = startup.stake_in_gossip;
  if (counted && counted.total > 0) {
    return {
      fraction: Math.min(1, counted.online / counted.total),
      decimals: 3,
      online: counted.online,
      total: counted.total,
    };
  }
  if (startup.stake_percent === null) return null;
  return { fraction: startup.stake_percent, decimals: 0, online: null, total: null };
}

export interface BootPhase {
  label: string;
  millis: number;
}

export interface BootTimes {
  startedMillis: number;
  startupMillis: number;
  /** Only phases that took time, summing to `startupMillis`. */
  phases: BootPhase[];
  /** After running, or null until the collector has caught up. */
  catchUpMillis: number | null;
}

/**
 * Phases under a second go into the rest rather than showing as nought, and
 * the rest is dropped if that is all it holds, so the lines shown always add
 * up to the total.
 */
export function bootTimes(
  startup: StartupProgress | undefined,
  uptimeNanos: number | undefined,
  serverTimeNanos: number | undefined,
  caughtUpNanos: number | undefined,
): BootTimes | null {
  if (!startup?.running || uptimeNanos === undefined || serverTimeNanos === undefined) return null;

  let startupMillis = 0;
  let rest = 0;
  const named = new Map<string, number>();
  for (const { phase, elapsed_nanos } of startup.phases_taken) {
    const millis = elapsed_nanos / 1e6;
    startupMillis += millis;
    const label = NAMED[phase];
    if (label !== undefined && millis >= 1000) named.set(label, (named.get(label) ?? 0) + millis);
    else rest += millis;
  }
  const phases = Object.values(NAMED)
    .filter((label) => named.has(label))
    .map((label) => ({ label, millis: named.get(label) ?? 0 }));
  if (rest >= 1000) phases.push({ label: REST, millis: rest });

  const startedMillis = (serverTimeNanos - uptimeNanos) / 1e6;
  const runningAt = startedMillis + startupMillis;
  const catchUpMillis =
    caughtUpNanos === undefined ? null : Math.max(0, caughtUpNanos / 1e6 - runningAt);

  return { startedMillis, startupMillis, phases, catchUpMillis };
}
