import type { CertFormation } from "./types";

export const HOLD_MS = 400;

export const REPLAY_SLOWDOWN = 10;

const GROW_MS = 35;

const SHARE_SCALE = 10_000;

/** Axis ends and the first tick land on this step. */
const AXIS_STEP_MS = 40;

/** A floor nearer the slot's start than this is not worth breaking the axis for. */
const MIN_FLOOR_MS = 80;

/** Mono 11 px, for keeping labels apart. */
const CHAR_WIDTH = 6.7;

const LABEL_GAP = 8;

export interface AxisRange {
  /** Before this the axis is a squeezed stub; zero for no break. */
  floor: number;
  end: number;
}

/** From the epoch's own arrivals, so it holds still for the whole epoch: a step before the first
 *  vote to a step past the last within the curves. */
export function axisRange(formation: CertFormation): AxisRange {
  const max = formation.notarize.length - 1;
  let first = max;
  let last = 0;
  for (const curve of [formation.notarize, formation.finalize]) {
    for (let ms = 1; ms <= max; ms++) {
      if ((curve[ms] ?? 0) === (curve[ms - 1] ?? 0)) continue;
      first = Math.min(first, ms - 1);
      last = Math.max(last, ms - 1);
    }
  }
  if (first > last) return { floor: 0, end: max };
  const below = Math.floor(first / AXIS_STEP_MS) * AXIS_STEP_MS - AXIS_STEP_MS;
  const floor = below < MIN_FLOOR_MS ? 0 : below;
  const past = Math.ceil((last + 1) / AXIS_STEP_MS) * AXIS_STEP_MS;
  return { floor, end: Math.min(max, Math.max(floor + 2 * AXIS_STEP_MS, past)) };
}

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
  floor: number;
  end: number;
}

export function geometry(width: number, range: AxisRange): Geometry {
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
    stub: range.floor === 0 ? 0 : phone ? 14 : 18,
    top,
    half,
    base,
    bottom,
    height: bottom + 22,
    bin: phone ? 10 : 5,
    scale: phone ? 2.5 : 5,
    floor: range.floor,
    end: range.end,
  };
}

export function xAt(g: Geometry, ms: number): number {
  const at = Math.min(ms, g.end);
  if (at < g.floor) return g.left + (Math.max(0, at) / g.floor) * g.stub;
  return g.left + g.stub + ((at - g.floor) / (g.end - g.floor)) * (g.right - g.left - g.stub);
}

/** Pointer positions in the stub read as the floor. */
export function msAt(g: Geometry, px: number): number {
  const ms = g.floor + ((px - g.left - g.stub) / (g.right - g.left - g.stub)) * (g.end - g.floor);
  return Math.max(g.floor, Math.min(g.end, ms));
}

/** The share whose average vote had arrived by `ms`, from 0 to 1. */
export function shareBy(curve: readonly number[], ms: number): number {
  const index = Math.min(curve.length - 1, Math.max(0, Math.floor(ms) + 1));
  return (curve[index] ?? 0) / SHARE_SCALE;
}

/** 4.3's votor times a leader window's later slots from this node finishing their replay. */
export function timedFromReplay(version: string | null | undefined): boolean {
  return version?.startsWith("4.3.") ?? false;
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
  for (let from = g.floor; from < g.end; from += g.bin) {
    const to = Math.min(from + g.bin, g.end);
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
  for (let ms = 1; ms <= g.end && ms < curve.length; ms++) {
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

function tickSpan(g: Geometry, tick: Tick): [number, number] {
  const x = tick.ms === 0 ? g.left : xAt(g, tick.ms);
  const width = labelWidth(tick.label);
  if (tick.align === "start") return [x - 3, x - 3 + width];
  if (tick.align === "end") return [x - width, x];
  return [x - width / 2, x + width / 2];
}

/** The clock's zero, steps from just past the floor, and the end; a step whose label would run into
 *  a neighbour is left out. Where most slots are timed from our replay, zero says so. */
export function ticks(g: Geometry, fromReplay: boolean): Tick[] {
  const step = g.phone ? 2 * AXIS_STEP_MS : AXIS_STEP_MS;
  const zero = fromReplay ? "replayed" : g.phone ? "0" : "slot start";
  const start: Tick = { ms: 0, label: zero, align: "start" };
  const end: Tick = { ms: g.end, label: `${g.end} ms`, align: "end" };
  const endSpan = tickSpan(g, end);
  const kept = [start];
  let reach = tickSpan(g, start)[1];
  for (let ms = Math.floor(g.floor / step) * step + step; ms < g.end; ms += step) {
    const tick: Tick = { ms, label: `${ms}`, align: "middle" };
    const [from, to] = tickSpan(g, tick);
    if (from < reach + LABEL_GAP || to > endSpan[0] - LABEL_GAP) continue;
    kept.push(tick);
    reach = to;
  }
  return [...kept, end];
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
export function replayAt(elapsed: number, marks: readonly number[], floor: number, end: number): ReplayFrame {
  let ms = floor;
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

export interface Placed {
  left: number;
  top: number;
  width: number;
}

/** Mono 11 px. */
const LABEL_HEIGHT = 13;

/** If a label would sit on a bar of the half that grows in `direction`. */
export function onBars(g: Geometry, place: Placed, halfBars: readonly Bar[], direction: 1 | -1): boolean {
  return halfBars.some((bar) => {
    const top = direction === 1 ? g.base + 1 : g.base - bar.height;
    const bottom = direction === 1 ? g.base + 1 + bar.height : g.base;
    return (
      bar.left < place.left + place.width &&
      bar.left + bar.width > place.left &&
      top < place.top + LABEL_HEIGHT &&
      bottom > place.top
    );
  });
}

/** Notarized sits in the top row. Fast final sits under the 80% line right of its rule, where the
 *  running total has passed it, else above the line to the left. Second round sits past the lower
 *  60% line left of its rule, else short of it to the right. Each keeps clear of the totals it labels,
 *  and takes its second place when the first would leave the chart or cover a bar. */
export function milestoneLabel(g: Geometry, mark: Milestone, text: string, halfBars: readonly Bar[]): Placed {
  const x = xAt(g, mark.ms);
  const width = labelWidth(text);
  const line = g.base + mark.direction * mark.level * g.half;
  const right = x + 5;
  const left = x - 5 - width;
  if (mark.key === "notarized") {
    return { left: right + width > g.right + 2 ? left : right, top: g.top - 16, width };
  }
  const [first, second]: [Placed, Placed] =
    mark.key === "fast"
      ? [
          { left: right, top: line + 3, width },
          { left, top: line - 3 - LABEL_HEIGHT, width },
        ]
      : [
          { left, top: line + 3, width },
          { left: right, top: line - 3 - LABEL_HEIGHT, width },
        ];
  const fits = (place: Placed) =>
    place.left >= g.left && place.left + place.width <= g.right + 2 && !onBars(g, place, halfBars, mark.direction);
  return fits(first) || !fits(second) ? first : second;
}

/** If two labels would touch. */
export function overlaps(a: Placed, b: Placed): boolean {
  return (
    a.top < b.top + LABEL_HEIGHT &&
    a.top + LABEL_HEIGHT > b.top &&
    a.left < b.left + b.width + LABEL_GAP &&
    a.left + a.width + LABEL_GAP > b.left
  );
}

/** A half's own label gives way to a milestone label in its row, or a bar reaching into it. */
export function halfLabelClear(
  g: Geometry,
  place: Placed,
  others: readonly (Placed | undefined)[],
  halfBars: readonly Bar[],
  direction: 1 | -1,
): boolean {
  const blocked = others.some((other) => other !== undefined && overlaps(place, other));
  return !blocked && !onBars(g, place, halfBars, direction);
}
