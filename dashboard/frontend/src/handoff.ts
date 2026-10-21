import type { HandoffBand, HandoffNow } from "./types";

/** A leader's own band means something from this many handoffs. */
export const SETTLED = 10;

/** The server's bin widths, in milliseconds. */
export const GAP_BIN = 10;
export const MEDIAN_BIN = 6;

/** Late dots stack this many pixels apart, across and up. */
const DOT_STEP = 7;

/** Wide enough for a slot and a little past it, and never below 300 ms. */
export function axisMax(slotMillis: number | null): number {
  const slot = slotMillis !== null && Number.isFinite(slotMillis) ? slotMillis : 0;
  return Math.max(300, Math.ceil((1.15 * slot) / 10) * 10);
}

/** A gap's place along the axis in percent, clamped to its ends. */
export function place(millis: number, max: number): number {
  if (max <= 0) return 0;
  return (Math.min(max, Math.max(0, millis)) / max) * 100;
}

/** The bins that fit the axis, with every later bin added into the last. */
export function foldBins(bins: readonly number[], width: number, max: number): number[] {
  const shown = Math.max(1, Math.floor(max / width));
  const folded = bins.slice(0, shown);
  while (folded.length < shown) folded.push(0);
  const rest = bins.slice(shown).reduce((sum, value) => sum + value, 0);
  folded[shown - 1] = (folded[shown - 1] ?? 0) + rest;
  return folded;
}

/** Which of `count` bins of `width` a gap falls in, clamped to both ends. */
export function binOf(millis: number, width: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(millis / width)));
}

/** A level for each dot, in order: the lowest at which it keeps clear of every dot already placed. */
export function stackLevels(positions: readonly number[]): number[] {
  const levels: number[][] = [];
  return positions.map((x) => {
    let level = 0;
    while ((levels[level] ?? []).some((other) => Math.abs(other - x) < DOT_STEP)) level += 1;
    (levels[level] ??= []).push(x);
    return level;
  });
}

export function dotBottom(level: number): number {
  return 4 + level * DOT_STEP;
}

/** Handoffs above the cluster's p75 out of all of them, without separators to stay narrow. */
export function tally(over: number, total: number): string {
  return `${over}/${total}`;
}

/** Late on most turns: its own p25 is above the cluster's p75. */
export function isLate(band: HandoffBand | null, cluster: HandoffBand | null): boolean {
  return band !== null && cluster !== null && band.p25 > cluster.p75;
}

export type LeadingLine =
  | { kind: "settled"; usual: string; late: string; isLate: boolean }
  | { kind: "few"; text: string }
  | { kind: "none" };

export function leadingLine(now: HandoffNow | null): LeadingLine {
  if (now === null) return { kind: "none" };
  if (now.band !== null) {
    return {
      kind: "settled",
      usual: `usual ${now.band.p25}–${now.band.p75} ms`,
      late: `late ${tally(now.over, now.n)}`,
      isLate: now.late,
    };
  }
  return { kind: "few", text: `${now.n} ${now.n === 1 ? "handoff" : "handoffs"} so far, too few to call usual` };
}

/** Where the window starts: an epoch of slots once full, else the time of its oldest handoff. */
export function windowLabel(full: boolean, sinceMillis: number, nowMillis: number): string {
  if (full) return "the last 432,000 slots";
  const since = new Date(sinceMillis);
  const clock = since.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const today = new Date(nowMillis).toDateString() === since.toDateString();
  return today ? `since ${clock}` : `since ${since.toLocaleDateString("en-GB", { weekday: "short" })} ${clock}`;
}
