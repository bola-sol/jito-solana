/** Drawing a block's path on this node, from its leader closing it to its finalization here. */

import { count, percent } from "./format";
import type { BlockLifeStages, SlowBlock } from "./types";

/** The track runs from before the leader closed the block to well past a typical finalization. */
export const LIFE_FROM_MS = -200;
export const LIFE_SPAN_MS = 560;

export type LifePart = keyof BlockLifeStages;

export interface LifeSegment {
  part: LifePart;
  /** Percentages of the track. */
  left: number;
  width: number;
}

export interface LifeTick {
  left: number;
  label: string;
  /** Left out where the track is narrow. */
  minor: boolean;
  /** Before the close; left out where the track is narrowest. */
  before: boolean;
}

/** Where a time from the leader's close sits on the track, as a percentage. */
export function lifeAt(ms: number): number {
  const at = ((ms - LIFE_FROM_MS) / LIFE_SPAN_MS) * 100;
  return Math.min(100, Math.max(0, at));
}

/** The building runs up to the close; each later stage starts where the one before ended. The
 *  chain stops at the first stage not timed, except our vote, which a node not voting lacks. */
export function lifeSegments(stages: BlockLifeStages): LifeSegment[] {
  const segments: LifeSegment[] = [];
  const span = (part: LifePart, from: number, to: number) => {
    const left = lifeAt(from);
    segments.push({ part, left, width: lifeAt(to) - left });
  };
  if (stages.building !== null) span("building", -stages.building, 0);
  let at = 0;
  for (const part of ["reaching", "replay", "vote", "finalize"] as const) {
    const ms = stages[part];
    if (ms === null) {
      if (part === "vote") continue;
      break;
    }
    span(part, at, at + ms);
    at += ms;
  }
  return segments;
}

/** Where each stage of the median ends, to mark on every row. */
export function lifeMarks(median: BlockLifeStages): number[] {
  const marks = median.building === null ? [] : [lifeAt(-median.building)];
  let at = 0;
  for (const part of ["reaching", "replay", "vote", "finalize"] as const) {
    const ms = median[part];
    if (ms === null) {
      if (part === "vote") continue;
      break;
    }
    at += ms;
    marks.push(lifeAt(at));
  }
  return marks;
}

export function lifeTicks(): LifeTick[] {
  const ticks: LifeTick[] = [];
  for (let ms = LIFE_FROM_MS; ms <= LIFE_FROM_MS + LIFE_SPAN_MS - 10; ms += 50) {
    ticks.push({ left: lifeAt(ms), label: ms === 0 ? "closed" : String(ms), minor: ms % 100 !== 0, before: ms < 0 });
  }
  return ticks;
}

/** From the leader's close to replay finishing, which every timed block has. */
export function replayedAt(stages: BlockLifeStages): number | null {
  return stages.reaching === null || stages.replay === null ? null : stages.reaching + stages.replay;
}

export function lifeWindow(minutes: number): string {
  return minutes >= 60 ? "the last hour" : `the last ${count(minutes)} min`;
}

export interface ClockNote {
  label: string;
  tip: string;
}

/** For a leader whose close cannot be right: the words on the row, and the amount behind them. */
export function clockNote(block: SlowBlock): ClockNote | null {
  const off = block.leader_clock_off;
  if (off === null || off === undefined) return null;
  const way = off >= 0 ? "behind" : "ahead";
  return {
    label: `leader clock ${way}`,
    tip: `About ${count(Math.abs(off))} ms ${way} ours, so this row starts from our first shred.`,
  };
}

/** What made the block slow, in a few words. */
export function slowNote(block: SlowBlock): string {
  const { stages } = block;
  switch (block.cause) {
    case "reaching": {
      const shares = [
        block.repaired > 0 && block.shreds > 0 ? `${percent(block.repaired / block.shreds, 0)} repaired` : null,
        block.recovered > 0 && block.shreds > 0 ? `${percent(block.recovered / block.shreds, 0)} recovered` : null,
      ].filter((share) => share !== null);
      return shares.length > 0 ? `late: ${shares.join(", ")}` : "reached us late";
    }
    case "replay":
      return `replay ${count(stages.replay ?? 0)} ms`;
    case "vote":
      return `our vote ${count(stages.vote ?? 0)} ms after replay`;
    case "finalize":
      return `finalized ${count(stages.finalize ?? 0)} ms after ${stages.vote === null ? "replay" : "our vote"}`;
  }
}
