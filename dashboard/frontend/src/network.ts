import type { NetInterface } from "./types";

export const NETWORK_WINDOW_SECONDS = 60;

const TREND_NOISE = 0.02;

/** So one noisy second does not flip it. */
const TREND_SAMPLES = 10;

export interface Direction {
  current: number;
  average: number;
  delta: number;
  /** Never toned: rising throughput is neither good nor bad. */
  trend: "up" | "down" | "flat";
}

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

/** Applied to the average and delta too, so the three compare. */
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

/** A route table this small is never judged short: a NIC's few routes come and go with the network. */
export const ROUTES_JUDGED_FROM = 10;

/** Fewer than half the most it carried in the last day. */
export function routesShort(iface: NetInterface): boolean {
  return iface.routes_peak >= ROUTES_JUDGED_FROM && iface.routes * 2 < iface.routes_peak;
}

/** A line of the interface list: a port sits one depth under the interface it belongs to. */
export interface InterfaceLine {
  iface: NetInterface;
  depth: number;
}

/** Each port after the interface it belongs to, otherwise in the server's order; a port whose
 *  master is not listed stands at the top. */
export function interfaceLines(interfaces: NetInterface[]): InterfaceLine[] {
  const listed = new Set(interfaces.map((iface) => iface.name));
  const masterOf = (iface: NetInterface) =>
    iface.member_of && listed.has(iface.member_of) ? iface.member_of : null;
  const ports = new Map<string, NetInterface[]>();
  for (const iface of interfaces) {
    const master = masterOf(iface);
    if (master !== null) ports.set(master, [...(ports.get(master) ?? []), iface]);
  }
  const lines: InterfaceLine[] = [];
  const placed = new Set<string>();
  const place = (iface: NetInterface, depth: number) => {
    if (placed.has(iface.name)) return;
    placed.add(iface.name);
    lines.push({ iface, depth });
    for (const port of ports.get(iface.name) ?? []) place(port, depth + 1);
  };
  for (const iface of interfaces) if (masterOf(iface) === null) place(iface, 0);
  // A loop of masters, which the kernel refuses, is listed rather than lost.
  for (const iface of interfaces) place(iface, 0);
  return lines;
}
