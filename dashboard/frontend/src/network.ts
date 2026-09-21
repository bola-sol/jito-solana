/** A minute of throughput read into the three figures the card shows. */

/** How much of the past the card covers. Matches the transactions chart. */
export const NETWORK_WINDOW_SECONDS = 60;

/** How far from the average a reading must be to count as a direction.
 *  Relative, since the card reads kilobytes on testnet and megabytes on
 *  mainnet. */
const TREND_NOISE = 0.02;

/** Seconds of trailing readings the arrow is taken from, so one noisy second
 *  does not flip it. */
const TREND_SAMPLES = 10;

export interface Direction {
  /** The newest reading. */
  current: number;
  average: number;
  /** The newest reading less the average, in the same unit. */
  delta: number;
  /** Which way it is going, the last few seconds against the minute. Never
   *  toned: rising throughput is neither good nor bad. */
  trend: "up" | "down" | "flat";
}

/** The three figures for one direction of traffic, from its samples. */
export function direction(values: number[]): Direction | null {
  if (values.length === 0) return null;
  const current = values[values.length - 1];
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = total / values.length;
  const delta = current - average;
  const trailing = values.slice(-TREND_SAMPLES);
  const recent = trailing.reduce((sum, value) => sum + value, 0) / trailing.length;
  return { current, average, delta, trend: trendOf(recent, average) };
}

function trendOf(recent: number, average: number): Direction["trend"] {
  if (average <= 0) return "flat";
  const drift = (recent - average) / average;
  if (drift > TREND_NOISE) return "up";
  if (drift < -TREND_NOISE) return "down";
  return "flat";
}

/** One scale for both directions, so the lines compare. Never nought. */
export function sharedPeak(...series: number[][]): number {
  let peak = 0;
  for (const values of series) {
    for (const value of values) {
      if (value > peak) peak = value;
    }
  }
  return Math.max(peak, 1);
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** The unit a reading of this size wants, applied to the average and delta
 *  too so the three compare. */
/** Egress cut into what is measured and what is not, none of it below nought. */
export interface EgressShares {
  gossip: number;
  repair: number;
  /** What no sender accounts for, mostly shreds over XDP. */
  remainder: number;
  measured: number;
}

export function egressShares(
  total: number,
  split: { gossip_per_second: number | null; repair_per_second: number | null },
): EgressShares {
  const gossip = Math.max(0, split.gossip_per_second ?? 0);
  const repair = Math.max(0, split.repair_per_second ?? 0);
  const measured = gossip + repair;
  return { gossip, repair, measured, remainder: Math.max(0, total - measured) };
}

export function unitFor(value: number): { unit: string; divisor: number } {
  let divisor = 1;
  let index = 0;
  while (Math.abs(value) / divisor >= 1024 && index < UNITS.length - 1) {
    divisor *= 1024;
    index += 1;
  }
  return { unit: UNITS[index], divisor };
}
