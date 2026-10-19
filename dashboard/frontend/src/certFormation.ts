import type { CertFormation } from "./types";

/** The broken axis squeezes everything before this into a stub; fixed so the chart never rescales. */
export const AXIS_FLOOR = 160;

export const HOLD_MS = 400;

export const REPLAY_SLOWDOWN = 10;

const GROW_MS = 35;

const SHARE_SCALE = 10_000;

/** Mono 11 px, for flipping a label before it passes the edge. */
const CHAR_WIDTH = 6.7;

export interface Geometry {
  phone: boolean;
  width: number;
  left: number;
  right: number;
  stub: number;
  top: number;
  half: number;
  base: number;
  bottom: number;
  height: number;
  /** Milliseconds per bar. */
  bin: number;
  /** Pixels per percent of stake in one bar. */
  scale: number;
  axisEnd: number;
}

export function geometry(width: number, axisEnd: number): Geometry {
  const phone = width < 360;
  const top = 18;
  const half = phone ? 84 : 120;
  const base = top + half;
  const bottom = base + half;
  return {
    phone,
    width,
    left: 34,
    right: width - 4,
    stub: phone ? 14 : 18,
    top,
    half,
    base,
    bottom,
    height: bottom + 22,
    bin: phone ? 10 : 5,
    scale: phone ? 2.5 : 5,
    axisEnd,
  };
}

export function axisEnd(formation: CertFormation): number {
  return Math.max(AXIS_FLOOR + 1, formation.notarize.length - 1);
}

export function xAt(g: Geometry, ms: number): number {
  const at = Math.min(ms, g.axisEnd);
  if (at < AXIS_FLOOR) return g.left + (Math.max(0, at) / AXIS_FLOOR) * g.stub;
  return g.left + g.stub + ((at - AXIS_FLOOR) / (g.axisEnd - AXIS_FLOOR)) * (g.right - g.left - g.stub);
}

/** Pointer positions in the stub read as the floor. */
export function msAt(g: Geometry, px: number): number {
  const ms = AXIS_FLOOR + ((px - g.left - g.stub) / (g.right - g.left - g.stub)) * (g.axisEnd - AXIS_FLOOR);
  return Math.max(AXIS_FLOOR, Math.min(g.axisEnd, ms));
}

/** The share whose average vote had arrived by `ms`, from 0 to 1. */
export function shareBy(curve: readonly number[], ms: number): number {
  const index = Math.min(curve.length - 1, Math.max(0, Math.floor(ms) + 1));
  return (curve[index] ?? 0) / SHARE_SCALE;
}

export function unmeasured(formation: CertFormation): number {
  return Math.max(0, SHARE_SCALE - formation.notarize_total) / SHARE_SCALE;
}

export interface Bar {
  from: number;
  middle: number;
  left: number;
  width: number;
  height: number;
  capped: boolean;
}

/** Stake arriving in each bin from the floor to the axis end; later votes have no bar. */
export function bars(g: Geometry, curve: readonly number[]): Bar[] {
  const list: Bar[] = [];
  for (let from = AXIS_FLOOR; from < g.axisEnd; from += g.bin) {
    const to = Math.min(from + g.bin, g.axisEnd);
    const share = ((curve[to] ?? 0) - (curve[from] ?? 0)) / SHARE_SCALE;
    if (share <= 0) continue;
    const raw = share * 100 * g.scale;
    const capped = raw > g.half - 4;
    list.push({
      from,
      middle: from + g.bin / 2,
      left: xAt(g, from) + 0.5,
      width: Math.max(1, xAt(g, to) - xAt(g, from) - 1),
      height: capped ? g.half - 4 : raw,
      capped,
    });
  }
  return list;
}

/** A step line up (-1) or down (1) from the axis; votes past the axis join at its end. */
export function runningPath(g: Geometry, curve: readonly number[], total: number, direction: 1 | -1): string {
  const y = (share: number) => (g.base + direction * share * g.half).toFixed(1);
  let path = `M${g.left} ${g.base}`;
  let held = 0;
  for (let ms = 1; ms <= g.axisEnd && ms < curve.length; ms++) {
    const share = (curve[ms] ?? 0) / SHARE_SCALE;
    if (share === held) continue;
    path += ` H${xAt(g, ms - 1).toFixed(1)} V${y(share)}`;
    held = share;
  }
  path += ` H${g.right}`;
  const end = total / SHARE_SCALE;
  if (end !== held) path += ` V${y(end)}`;
  return path;
}

export interface Tick {
  ms: number;
  label: string;
  align: "start" | "middle" | "end";
}

export function ticks(g: Geometry): Tick[] {
  const list = g.phone
    ? g.width < 280
      ? [0, 240, 320, 480]
      : [0, 240, 320, 400, 480]
    : [0, 200, 240, 280, 320, 360, 400, 440, 480];
  return list
    .filter((ms) => ms <= g.axisEnd)
    .map((ms) => ({
      ms,
      label: ms === 0 ? (g.phone ? "0" : "slot start") : ms === g.axisEnd ? `${ms} ms` : `${ms}`,
      align: ms === 0 ? "start" : ms === g.axisEnd ? "end" : "middle",
    }));
}

export type MilestoneKey = "notarized" | "fast" | "second";

export interface Milestone {
  key: MilestoneKey;
  ms: number;
  /** Up for notarize votes, down for finalize. */
  direction: 1 | -1;
  level: number;
}

/** The certificates that form within the axis, earliest first. */
export function milestones(formation: CertFormation, end: number): Milestone[] {
  const all: [MilestoneKey, number | null, 1 | -1, number][] = [
    ["notarized", formation.notarized_millis, -1, 0.6],
    ["fast", formation.fast_final_millis, -1, 0.8],
    ["second", formation.second_round_millis, 1, 0.6],
  ];
  return all
    .flatMap(([key, ms, direction, level]) => (ms !== null && ms <= end ? [{ key, ms, direction, level }] : []))
    .sort((a, b) => a.ms - b.ms);
}

export type BarTone = "notarize" | "notarize-late" | "after" | "finalize" | "pending";

/** Bars count toward a certificate until it forms; while replaying, those still counting are pending. */
export function barTone(direction: 1 | -1, middle: number, formation: CertFormation, replayMs: number | null): BarTone {
  const notarized = formation.notarized_millis ?? Infinity;
  const fast = formation.fast_final_millis ?? Infinity;
  const second = formation.second_round_millis ?? Infinity;
  if (direction === -1) {
    const towardNotarized = replayMs !== null && replayMs < notarized && middle <= notarized;
    const towardFast = replayMs !== null && replayMs < fast && middle > notarized && middle <= fast;
    if (towardNotarized || towardFast) return "pending";
    return middle <= notarized ? "notarize" : middle <= fast ? "notarize-late" : "after";
  }
  if (replayMs !== null && replayMs < second && middle <= second) return "pending";
  return middle <= second ? "finalize" : "after";
}

export function growth(replayMs: number | null, from: number): number {
  if (replayMs === null) return 1;
  const done = Math.max(0, Math.min(1, (replayMs - from) / GROW_MS));
  return 1 - Math.pow(1 - done, 3);
}

export interface ReplayFrame {
  ms: number;
  /** Which of the sorted milestones time is stopped at, and how far through the hold. */
  hold: { index: number; fraction: number } | null;
  done: boolean;
}

/** Data time from the floor at a tenth of real speed, stopping at each milestone. */
export function replayAt(elapsed: number, marks: readonly number[], end: number): ReplayFrame {
  let ms = AXIS_FLOOR;
  let left = elapsed;
  for (const [index, mark] of marks.entries()) {
    const travel = Math.max(0, mark - ms) * REPLAY_SLOWDOWN;
    if (left <= travel) return { ms: ms + left / REPLAY_SLOWDOWN, hold: null, done: false };
    left -= travel;
    ms = Math.max(ms, mark);
    if (left <= HOLD_MS) return { ms, hold: { index, fraction: left / HOLD_MS }, done: false };
    left -= HOLD_MS;
  }
  ms += left / REPLAY_SLOWDOWN;
  return { ms: Math.min(ms, end), hold: null, done: ms >= end };
}

export function labelWidth(text: string): number {
  return text.length * CHAR_WIDTH;
}
