
import { bytes, count } from "./format";
import { readStored, writeStored } from "./storage";
import type { AccountsCache, ProgramCache } from "./types";

export const CACHES_STORAGE_KEY = "agave-dashboard-caches";

export function readOpenSections(): string[] {
  const stored = readStored(CACHES_STORAGE_KEY);
  return stored ? stored.split(",").filter(Boolean) : [];
}

export function writeOpenSections(open: string[]): void {
  writeStored(CACHES_STORAGE_KEY, open.join(","));
}

export type RateTone = "good" | "warn" | "bad" | "muted";

/** The middle band is toned because a folded section shows only the dot. */
export function rateTone(rate: number | null): RateTone {
  if (rate === null) return "muted";
  if (rate >= 0.98) return "good";
  if (rate >= 0.9) return "warn";
  return "bad";
}

/** Not the read cache's own rate, which covers only reads past the write cache. */
export function servedFromMemory(accounts: AccountsCache): {
  loads: number;
  rate: number | null;
} {
  const loads = accounts.from_write_cache + accounts.from_read_cache + accounts.from_storage;
  return { loads, rate: loads > 0 ? 1 - accounts.from_storage / loads : null };
}

/** In falling order of importance, since a narrow screen shows only the first two. */
export function programGloss(cache: ProgramCache): string[] {
  const entries =
    cache.peak_entries === null
      ? `${count(cache.entry_limit)} entry limit`
      : `${count(cache.peak_entries)}/${count(cache.entry_limit)} entries`;
  return [
    `${count(cache.looked_up)} lookups`,
    `${count(cache.misses)} misses`,
    entries,
    `${count(cache.evictions)} evictions`,
  ];
}

export function accountsGloss(accounts: AccountsCache): string[] {
  const { loads } = servedFromMemory(accounts);
  const perSecond =
    accounts.window_seconds > 0 ? accounts.stored_bytes / accounts.window_seconds : 0;
  const line = [
    `${count(loads)} reads`,
    `${count(accounts.from_storage)} from disk`,
    `${bytes(Math.round(perSecond))}/s written`,
  ];
  if (accounts.disk) {
    line.push(`${bytes(accounts.disk.used)}/${bytes(accounts.disk.allocated)} on disk`);
  }
  return line;
}
