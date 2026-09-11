/** The two cache panels folded to one line each, testable without a DOM. */

import { bytes, count } from "./format";
import type { AccountsCache, ProgramCache } from "./types";

export const CACHES_STORAGE_KEY = "agave-dashboard-caches";

/** Which sections the viewer last left unfolded. Both start folded. */
export function readOpenSections(): string[] {
  try {
    const stored = window.localStorage.getItem(CACHES_STORAGE_KEY);
    return stored ? stored.split(",").filter(Boolean) : [];
  } catch {
    // Private browsing and some embedded webviews refuse storage outright.
    return [];
  }
}

export function writeOpenSections(open: string[]): void {
  try {
    window.localStorage.setItem(CACHES_STORAGE_KEY, open.join(","));
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}

/** How a rate is coloured, matching the tones the rest of the page uses. */
export type RateTone = "good" | "warn" | "bad" | "muted";

/** What colour a hit rate is worth. The middle band is toned because a folded
 *  section shows only the dot. */
export function rateTone(rate: number | null): RateTone {
  if (rate === null) return "muted";
  if (rate >= 0.98) return "good";
  if (rate >= 0.9) return "warn";
  return "bad";
}

/** Every account read in the window and the share answered from memory. Not
 *  the read cache's own rate, which covers only reads past the write cache. */
export function servedFromMemory(accounts: AccountsCache): {
  loads: number;
  rate: number | null;
} {
  const loads = accounts.from_write_cache + accounts.from_read_cache + accounts.from_storage;
  return { loads, rate: loads > 0 ? 1 - accounts.from_storage / loads : null };
}

/** The program cache in one line, for a folded section. A list in falling
 *  order of importance, since a narrow screen shows only the first two. */
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

/** The accounts database in one line, on the same principle. */
export function accountsGloss(accounts: AccountsCache): string[] {
  const { loads } = servedFromMemory(accounts);
  const perSecond =
    accounts.window_seconds > 0 ? accounts.stored_bytes / accounts.window_seconds : 0;
  const line = [
    `${count(loads)} reads`,
    `${count(accounts.from_storage)} from disk`,
    `${bytes(Math.round(perSecond))}/s written`,
  ];
  // Absent on a validator whose accounts database has not reported its files
  // yet, rather than shown as nought of nought.
  if (accounts.disk) {
    line.push(`${bytes(accounts.disk.used)}/${bytes(accounts.disk.allocated)} on disk`);
  }
  return line;
}
