import type { HandoffNow, HandoffTrend } from "./types";

/** A leader's own band means something from this many handoffs. */
export const SETTLED = 10;

/** The server's bin widths, in milliseconds. */
export const GAP_BIN = 10;
export const MEDIAN_BIN = 6;

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

/** One bin of settled leaders: heights in percent of the strip, both parts of one bar. */
export interface StackedBin {
  onTime: number;
  late: number;
}

/** Each bin's total on a square-root scale against the fullest bin, split between its two parts. */
export function stackedBins(onTime: readonly number[], late: readonly number[]): StackedBin[] {
  const totals = onTime.map((count, index) => count + (late[index] ?? 0));
  const top = Math.sqrt(Math.max(1, ...totals));
  return totals.map((total, index) => {
    if (total === 0) return { onTime: 0, late: 0 };
    const height = (Math.sqrt(total) / top) * 100;
    const lateCount = late[index] ?? 0;
    return { onTime: (height * (total - lateCount)) / total, late: (height * lateCount) / total };
  });
}

/** Handoffs above the cluster's p75 out of all of them, without separators to stay narrow. */
export function tally(over: number, total: number): string {
  return `${over}/${total}`;
}

/** The medians a bin of the leaders strip covers: the first also takes every lower one, the last
 *  every higher one. */
export interface BinRange {
  from: number | null;
  to: number | null;
  label: string;
}

export function binRange(index: number, count: number, width: number): BinRange {
  const low = index * width;
  const last = index >= count - 1;
  return {
    from: index === 0 ? null : low,
    to: last ? null : low + width,
    label: last ? `${low}+` : `${low}–${low + width - 1}`,
  };
}

export type LeadingLine =
  | { kind: "settled"; usual: string; late: string; isLate: boolean }
  | { kind: "unjudged"; usual: string }
  | { kind: "few"; text: string }
  | { kind: "none" };

export function leadingLine(now: HandoffNow | null): LeadingLine {
  if (now === null) return { kind: "none" };
  if (now.band !== null) {
    const usual = `usual ${now.band.p25}–${now.band.p75} ms`;
    if (!now.judged) return { kind: "unjudged", usual };
    return {
      kind: "settled",
      usual,
      late: `late ${tally(now.over, now.n)}`,
      isLate: now.late,
    };
  }
  return { kind: "few", text: `${now.n} ${now.n === 1 ? "handoff" : "handoffs"} so far, too few to call usual` };
}

export interface TrendShape {
  /** Milliseconds at the top of the chart. */
  top: number;
  /** One path, broken where a minute had no handoff. */
  line: string;
  /** A closed outline per unbroken run of p25 to p75. */
  bands: string[];
  /** Height of the hour's median, or null. */
  median: number | null;
  /** The lowest and highest mean, or null without any. */
  range: [number, number] | null;
}

/** The trend drawn in a box `width` by `height`, oldest at the left, nought at the bottom. */
export function trendShape(trend: HandoffTrend, width: number, height: number): TrendShape {
  const means = trend.mean.filter((value): value is number => value !== null);
  const highest = Math.max(0, ...trend.p75.map((value) => value ?? 0), ...means);
  const top = Math.max(150, Math.ceil(highest / 50) * 50);
  const last = Math.max(1, trend.mean.length - 1);
  const x = (index: number) => ((index / last) * width).toFixed(1);
  const y = (millis: number) => (height - (Math.min(top, Math.max(0, millis)) / top) * height).toFixed(1);

  let line = "";
  let drawing = false;
  trend.mean.forEach((value, index) => {
    if (value === null) {
      drawing = false;
      return;
    }
    line += `${drawing ? "L" : "M"}${x(index)},${y(value)}`;
    drawing = true;
  });

  const bands: string[] = [];
  let run: number[] = [];
  const close = () => {
    if (run.length > 1) {
      const upper = run.map((index, at) => `${at ? "L" : "M"}${x(index)},${y(trend.p75[index] ?? 0)}`).join("");
      const lower = [...run].reverse().map((index) => `L${x(index)},${y(trend.p25[index] ?? 0)}`).join("");
      bands.push(`${upper}${lower}Z`);
    }
    run = [];
  };
  trend.p25.forEach((low, index) => {
    if (low === null || trend.p75[index] === null) close();
    else run.push(index);
  });
  close();

  return {
    top,
    line,
    bands,
    median: trend.hour_p50 === null ? null : Number(y(trend.hour_p50)),
    range: means.length ? [Math.min(...means), Math.max(...means)] : null,
  };
}

const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short" });

/** Where the window starts: an epoch of slots once full, else the time of its oldest handoff. */
export function windowLabel(full: boolean, sinceMillis: number, nowMillis: number): string {
  if (full) return "the last 432,000 slots";
  const since = new Date(sinceMillis);
  const clock = CLOCK.format(since);
  const today = new Date(nowMillis).toDateString() === since.toDateString();
  return today ? `since ${clock}` : `since ${WEEKDAY.format(since)} ${clock}`;
}
