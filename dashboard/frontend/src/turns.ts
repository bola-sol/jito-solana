import { count, duration } from "./format";
import {
  executedSection,
  listenerSection,
  verifySection,
  type PathLoss,
  type PathSection,
} from "./tpuPath";
import type { LeaderTurn, SlotWaterfall, Waterfall } from "./types";
import { waterfallRows } from "./waterfall";

/** Each of a turn's slots keyed to it, for grouping the block list. */
export function turnOf(turns: LeaderTurn[]): Map<number, LeaderTurn> {
  const map = new Map<number, LeaderTurn>();
  for (const turn of turns) {
    for (let slot = turn.first; slot <= turn.last; slot += 1) map.set(slot, turn);
  }
  return map;
}

/** The turn's slots, as a range where there is more than one. */
export function turnRangeLabel(turn: LeaderTurn): string {
  if (turn.first === turn.last) return count(turn.first);
  return `${count(turn.first)}–${count(turn.last)}`;
}

/** What the three differenced sections span. */
export function turnSpanLabel(turn: LeaderTurn): string {
  if (turn.since_millis === null) return "since the dashboard started";
  return `${duration(turn.drained_millis - turn.since_millis)} since the previous turn drained`;
}

/** The turn's per-slot scheduler counts as one, the newest slot's source
 *  standing for all. `null` where no slot of the turn has reported. */
export function sumWaterfalls(slots: SlotWaterfall[]): Waterfall | null {
  if (slots.length === 0) return null;
  const newest = slots.reduce((a, b) => (b.slot > a.slot ? b : a));
  const sum: Record<string, number | string | undefined> = { source: newest.source };
  for (const slot of slots) {
    for (const [key, value] of Object.entries(slot)) {
      if (key === "slot" || key === "source" || typeof value !== "number") continue;
      sum[key] = ((sum[key] as number | undefined) ?? 0) + value;
    }
  }
  return sum as unknown as Waterfall;
}

/** The scheduler's own counts in the TPU path card's shape: the intake losses
 *  against what arrived, and what was scheduled as the way through. */
export function schedulerSection(w: Waterfall): PathSection {
  const rows = waterfallRows(w);
  const batches = w.source === "bam";
  const total = batches ? w.buffered : w.received;
  const losses: PathLoss[] = rows
    .filter((row) => row.kind === "loss" && row.count > 0)
    .map((row) => ({
      key: row.key,
      label: row.label,
      count: row.count,
      share: total > 0 ? Math.min(1, row.count / total) : 0,
      warn: false,
      explain: row.explain,
    }))
    .sort((a, b) => b.count - a.count);
  const zeros = rows.filter((row) => row.kind === "loss").length - losses.length;
  const received = rows.find((row) => row.key === "received");
  return {
    key: "scheduler",
    title: "Scheduler",
    note: batches ? "BAM · the turn's slots' own counts" : "the turn's slots' own counts",
    explain: "The scheduler's own per-slot counts for the turn's slots, summed. Exact.",
    total,
    through: { label: "scheduled", count: w.scheduled },
    losses,
    detail: [],
    zeros,
    aside:
      batches && received
        ? {
            label: "batches received",
            count: received.count,
            unit: "",
            warn: false,
            explain: received.explain,
          }
        : null,
  };
}

/** The four sections of a turn's drawer. Three are differences of the running
 *  totals over the turn's span; the scheduler's is the slots' own counts. */
export function turnSections(turn: LeaderTurn, slots: SlotWaterfall[]): PathSection[] {
  const span = turnSpanLabel(turn);
  const sections: PathSection[] = [
    { ...listenerSection(turn.quic), note: `the validator's own TPU · ${span}` },
    { ...verifySection(turn.verify), note: `non-vote · ${span}` },
  ];
  const summed = sumWaterfalls(slots);
  if (summed) sections.push(schedulerSection(summed));
  sections.push({ ...executedSection(turn.executed, null), note: `workers · ${span}` });
  return sections;
}
