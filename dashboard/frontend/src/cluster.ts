/** The Cluster page's verdict and the shapes its charts are drawn from. */

import { count } from "./format";
import type { Tone } from "./verdict";

/** The readings the verdict judges, each over the last ten minutes against a baseline. */
export interface ClusterSignals {
  /** Seconds since a slot was last finalized here; null while finalizing or unknown. */
  stalledSeconds: number | null;
  slotRecent: number | null;
  slotBaseline: number | null;
  skipRecent: number | null;
  skipBaseline: number | null;
  /** "this epoch", or "last epoch" while this one is too young to judge by. */
  skipBaselineLabel: string;
  notarizedRecent: number | null;
  fastRecent: number | null;
}

export interface ClusterVerdict {
  tone: Tone;
  headline: string;
  /** Why, in place of the figures; empty when all is well. */
  evidence: string;
}

export const STALL_SECONDS = 10;
export const SLOW_RATIO = 1.25;
export const SKIP_RATIO = 3;
export const SKIP_FLOOR = 2;
export const NOTARIZED_FLOOR = 95;
export const FAST_FLOOR = 90;

/** Two decimals under one percent, one above. */
export function percentText(value: number): string {
  return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}%`;
}

/** The worst rule that holds; the cluster's own figures are the baseline, not fixed targets. */
export function clusterVerdict(signals: ClusterSignals): ClusterVerdict {
  const { stalledSeconds, slotRecent, slotBaseline, skipRecent, skipBaseline } = signals;
  if (stalledSeconds !== null && stalledSeconds >= STALL_SECONDS) {
    return {
      tone: "bad",
      headline: "The cluster has stopped finalizing.",
      evidence: `No slot finalized for ${count(Math.round(stalledSeconds))} s.`,
    };
  }
  if (slotRecent !== null && slotBaseline !== null && slotRecent >= slotBaseline * SLOW_RATIO) {
    return {
      tone: "warn",
      headline: "Slots are running slow.",
      evidence: `${count(Math.round(slotRecent))} ms in the last 10 minutes, ${count(Math.round(slotBaseline))} ms this epoch.`,
    };
  }
  if (
    skipRecent !== null &&
    skipBaseline !== null &&
    skipRecent >= SKIP_FLOOR &&
    skipRecent >= skipBaseline * SKIP_RATIO
  ) {
    return {
      tone: "warn",
      headline: "Skips are up.",
      evidence: `${percentText(skipRecent)} skipped in the last 10 minutes, ${percentText(skipBaseline)} ${signals.skipBaselineLabel}.`,
    };
  }
  if (signals.notarizedRecent !== null && signals.notarizedRecent < NOTARIZED_FLOOR) {
    return {
      tone: "warn",
      headline: "Notarized stake is down.",
      evidence: `${percentText(signals.notarizedRecent)} of stake notarized in the last 10 minutes.`,
    };
  }
  if (signals.fastRecent !== null && signals.fastRecent < FAST_FLOOR) {
    return {
      tone: "warn",
      headline: "Fast finalization is down.",
      evidence: `${percentText(signals.fastRecent)} fast in the last 10 minutes.`,
    };
  }
  return { tone: "good", headline: "The cluster is running normally.", evidence: "" };
}

/** A young epoch's skips are mostly its boundary, so until a tenth of it has passed the previous
 *  epoch is the baseline. */
export function skipBaseline(
  skipped: number,
  slots: number,
  previous: number | null,
  through: number,
): { share: number | null; label: string } {
  if (through < 0.1 && previous !== null) return { share: previous, label: "last epoch" };
  return { share: slots > 0 ? (skipped / slots) * 100 : null, label: "this epoch" };
}

export type TxView = "all" | "succeeded" | "failed";

/** The total's makeup on All; each part's share of the total on its own tab. */
export function txNote(view: TxView, failedShare: number): string {
  const whole = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
  if (view === "all") return `${whole(failedShare)} failed`;
  return `${whole(view === "failed" ? failedShare : 100 - failedShare)} of all`;
}

/** The first round step at or above `value`, so an axis ends a little over its tallest mark. */
export function niceTop(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((step) => step * power).find((top) => top >= value - 1e-9) ?? value;
}

/** Up to three round gridlines at or under `top`, above nought. */
export function ticks(top: number): number[] {
  if (!(top > 0)) return [];
  const raw = top / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * power).find((step) => step >= raw) ?? raw;
  return [step, step * 2, step * 3].filter((tick) => tick <= top + 1e-9);
}

/** Gridlines for an axis: the named references and the top, the floor and its midpoint where it
 *  does not start at nought, else round steps. */
export function gridlines(floor: number, top: number, refs: number[] = []): number[] {
  if (refs.length > 0) return [...refs, top];
  if (floor > 0) return [floor, (floor + top) / 2, top];
  return ticks(top);
}

/** A line through each value, broken where a bin is empty. */
export function linePath(
  values: (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  let d = "";
  let open = false;
  values.forEach((value, index) => {
    if (value === null) {
      open = false;
      return;
    }
    d += `${open ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    open = true;
  });
  return d;
}

/** A filled band between two lines, one shape per unbroken run of bins. */
export function bandPaths(
  low: (number | null)[],
  high: (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string[] {
  const shapes: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      const top = run.map((index) => `${x(index).toFixed(1)},${y(high[index] ?? 0).toFixed(1)}`);
      const bottom = [...run].reverse().map((index) => `${x(index).toFixed(1)},${y(low[index] ?? 0).toFixed(1)}`);
      shapes.push(`M${top.join("L")}L${bottom.join("L")}Z`);
    }
    run = [];
  };
  low.forEach((value, index) => {
    if (value === null || high[index] === null || high[index] === undefined) flush();
    else run.push(index);
  });
  flush();
  return shapes;
}

/** How long one of `bins` is over a window, as the key names it. */
export function binLabel(fromMillis: number, toMillis: number, bins: number): string {
  const seconds = Math.max(1, Math.round((toMillis - fromMillis) / bins / 1000));
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}
