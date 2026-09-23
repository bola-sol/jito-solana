
import { bytes } from "./format";
import type { DeviceLoad, FilesystemUsage, Host } from "./types";

export type HostTone = "good" | "warn" | "bad" | "muted";

/** A full ledger partition stops the validator. */
export const FULL_WARN = 0.8;
export const FULL_BAD = 0.9;

export const BUSY_WARN = 0.7;
export const BUSY_BAD = 0.85;

/** Set for NVMe, which answers in tenths of one. */
export const WAIT_WARN_MS = 1;
export const WAIT_BAD_MS = 5;

export const AVAILABLE_WARN = 0.1;
export const AVAILABLE_BAD = 0.05;

export const CPU_WARN = 0.8;
export const CPU_BAD = 0.9;

/** So the page cache is drawn beside the committed figure rather than inside it. */
export function memoryUse(host: Host): {
  inUse: number;
  reclaimable: number;
  available: number;
  total: number;
} {
  const total = Math.max(0, host.memory_total);
  const reclaimable = Math.max(0, Math.min(total, host.memory_reclaimable));
  const free = Math.max(0, Math.min(total, host.memory_free));
  return {
    inUse: Math.max(0, total - free - reclaimable),
    reclaimable,
    available: Math.max(0, Math.min(total, host.memory_available)),
    total,
  };
}

export function fullness(filesystem: FilesystemUsage): number {
  if (filesystem.total <= 0) return 0;
  const used = Math.max(0, filesystem.total - filesystem.available);
  return Math.min(1, used / filesystem.total);
}

export function fullnessTone(share: number): HostTone {
  if (share >= FULL_BAD) return "bad";
  if (share >= FULL_WARN) return "warn";
  return "good";
}

export function busyTone(busy: number): HostTone {
  if (busy >= BUSY_BAD) return "bad";
  if (busy >= BUSY_WARN) return "warn";
  return "good";
}

/** Muted rather than green where the device did nothing: nobody waited. */
export function waitTone(waitMs: number | null): HostTone {
  if (waitMs === null) return "muted";
  if (waitMs >= WAIT_BAD_MS) return "bad";
  if (waitMs >= WAIT_WARN_MS) return "warn";
  return "good";
}

export function cpuTone(busy: number): HostTone {
  if (busy >= CPU_BAD) return "bad";
  if (busy >= CPU_WARN) return "warn";
  return "good";
}

export function availableTone(available: number, total: number): HostTone {
  if (total <= 0) return "muted";
  const share = available / total;
  if (share <= AVAILABLE_BAD) return "bad";
  if (share <= AVAILABLE_WARN) return "warn";
  return "good";
}

/** Swap in use is amber whatever the amount: there is no healthy quantity. */
export function swapTone(used: number): HostTone {
  return used > 0 ? "warn" : "good";
}

export function loadTrend(host: Host): "rising" | "falling" | "steady" {
  const drift = host.load_one - host.load_fifteen;
  // A tenth of a core is noise on any machine a validator runs on.
  const noise = 0.1;
  if (drift > noise) return "rising";
  if (drift < -noise) return "falling";
  return "steady";
}

export function deviceLabel(device: DeviceLoad): string {
  return device.roles.join(" and ");
}

/** A move in resident memory under this, over an hour, is noise. */
export const RESIDENT_NOISE = 512 * 1024 ** 2;

export interface ResidentTrend {
  direction: "rising" | "falling";
  label: string;
}

export function residentTrend(host: Host): ResidentTrend | null {
  const now = host.process_resident;
  const before = host.process_resident_hour_ago;
  if (now === null || before === null) return null;
  const delta = now - before;
  if (Math.abs(delta) < RESIDENT_NOISE) return null;
  return {
    direction: delta > 0 ? "rising" : "falling",
    label: `${delta > 0 ? "up" : "down"} ${bytes(Math.abs(delta))} this hour`,
  };
}
