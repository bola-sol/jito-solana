
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

export interface DiskAlarm {
  filesystem: FilesystemUsage;
  share: number;
  tone: "warn" | "bad";
}

/** The fullest filesystem once it is amber or red, for the verdict's line. */
export function diskAlarm(host: Host | null | undefined): DiskAlarm | null {
  if (!host) return null;
  let worst: DiskAlarm | null = null;
  for (const filesystem of host.filesystems) {
    const share = fullness(filesystem);
    const tone = fullnessTone(share);
    if (tone === "good" || tone === "muted") continue;
    if (!worst || share > worst.share) worst = { filesystem, share, tone };
  }
  return worst;
}

export interface MemoryAlarm {
  available: number;
  total: number;
  tone: "warn" | "bad";
}

/** Available memory once it is amber or red, for the verdict's line. */
export function memoryAlarm(host: Host | null | undefined): MemoryAlarm | null {
  if (!host || host.memory_total <= 0) return null;
  const tone = availableTone(host.memory_available, host.memory_total);
  if (tone === "good" || tone === "muted") return null;
  return { available: host.memory_available, total: host.memory_total, tone };
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

export type MemoryPartKey = "rest" | "blockstore" | "read" | "write" | "files" | "shared";

export interface MemorySegment {
  key: MemoryPartKey;
  bytes: number;
}

export interface MemoryRow {
  key: MemoryPartKey | "heap" | "index";
  label: string;
  bytes: number;
  depth: 0 | 1 | 2;
}

export interface ValidatorSplit {
  resident: number;
  /** Left to right; the measured parts come out of the heap, so they add up to the resident figure. */
  segments: MemorySegment[];
  /** Capped at the rest of the heap, and never taken out of it. */
  indexEstimate: number | null;
  rows: MemoryRow[];
}

/** Null until the kernel splits the resident figure. */
export function validatorSplit(host: Host): ValidatorSplit | null {
  const kinds = host.process_kinds;
  if (!kinds || host.process_resident === null) return null;
  const parts = host.memory_parts;
  const measured: { key: MemoryPartKey; label: string; bytes: number | null }[] = [
    { key: "blockstore", label: "blockstore", bytes: parts.blockstore },
    { key: "read", label: "read cache", bytes: parts.read_cache },
    { key: "write", label: "write cache", bytes: parts.write_cache },
  ];
  const reported = measured.flatMap((part) =>
    part.bytes === null ? [] : [{ key: part.key, label: part.label, bytes: Math.max(0, part.bytes) }],
  );
  const heap = Math.max(0, kinds.anonymous);
  const files = Math.max(0, kinds.file);
  const shared = Math.max(0, kinds.shared);
  // The parts report at their own moments, so their sum can briefly pass the heap's.
  const rest = Math.max(0, heap - reported.reduce((sum, part) => sum + part.bytes, 0));
  const indexEstimate =
    parts.index_estimate === null ? null : Math.min(Math.max(0, parts.index_estimate), rest);

  const rows: MemoryRow[] = [
    { key: "heap", label: "heap", bytes: heap, depth: 0 },
    { key: "rest", label: "rest of heap", bytes: rest, depth: 1 },
  ];
  if (indexEstimate !== null) {
    rows.push({ key: "index", label: "accounts index", bytes: indexEstimate, depth: 2 });
  }
  for (const part of reported) rows.push({ ...part, depth: 1 });
  rows.push(
    { key: "files", label: "mapped files", bytes: files, depth: 0 },
    { key: "shared", label: "shared", bytes: shared, depth: 0 },
  );

  return {
    resident: host.process_resident,
    segments: [
      { key: "rest", bytes: rest },
      ...reported.map(({ key, bytes }) => ({ key, bytes })),
      { key: "files", bytes: files },
      { key: "shared", bytes: shared },
    ],
    indexEstimate,
    rows,
  };
}

/** A move in resident memory under this, over an hour, is noise. */
export const RESIDENT_NOISE = 512 * 1024 ** 2;

export interface ResidentTrend {
  direction: "rising" | "falling" | "steady";
  label: string;
}

export function residentTrend(host: Host): ResidentTrend | null {
  const now = host.process_resident;
  const before = host.process_resident_hour_ago;
  if (now === null || before === null) return null;
  const delta = now - before;
  if (Math.abs(delta) < RESIDENT_NOISE) return { direction: "steady", label: "steady this hour" };
  return {
    direction: delta > 0 ? "rising" : "falling",
    label: `${delta > 0 ? "up" : "down"} ${bytes(Math.abs(delta))} this hour`,
  };
}

/** The governor voting nodes run; any other lets idle cores slow and clock back up as each block arrives. */
export const PERFORMANCE_GOVERNOR = "performance";

/** Null where the kernel exposes no frequency governor, as on most virtual machines. */
export function slowGovernor(governor: string | null): boolean {
  return governor !== null && governor !== PERFORMANCE_GOVERNOR;
}
