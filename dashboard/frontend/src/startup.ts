
import type { StartupProgress } from "./types";

const NAMED = new Map<string, string>([
  ["downloading_snapshot", "snapshot download"],
  ["loading_ledger", "loading ledger"],
  ["processing_ledger", "ledger replay"],
]);

const REST = "everything else";

/** Private in core, so written down here. */
export const SUPERMAJORITY_PERCENT = 80;

export interface StakeSeen {
  fraction: number;
  /** Three decimals from the exact count, none from the whole percent. */
  decimals: number;
  online: number | null;
  total: number | null;
}

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
  phases: BootPhase[];
  catchUpMillis: number | null;
}

/** So the lines add up to the total. */
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
    const label = NAMED.get(phase);
    if (label !== undefined && millis >= 1000) named.set(label, (named.get(label) ?? 0) + millis);
    else rest += millis;
  }
  const phases = [...NAMED.values()]
    .filter((label) => named.has(label))
    .map((label) => ({ label, millis: named.get(label) ?? 0 }));
  if (rest >= 1000) phases.push({ label: REST, millis: rest });

  const startedMillis = (serverTimeNanos - uptimeNanos) / 1e6;
  const runningAt = startedMillis + startupMillis;
  const catchUpMillis =
    caughtUpNanos === undefined ? null : Math.max(0, caughtUpNanos / 1e6 - runningAt);

  return { startedMillis, startupMillis, phases, catchUpMillis };
}
