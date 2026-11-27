/** The rewind slider's spans and the jumps that go with each. */

export interface Jump {
  label: string;
  /** For the step buttons' names. */
  spoken: string;
  ms: number;
}

export interface Zoom {
  ms: number;
  /** The first is also the step. */
  jumps: Jump[];
}

export const SECONDS_10: Jump = { label: "10 s", spoken: "10 seconds", ms: 10_000 };
const MINUTE: Jump = { label: "1 m", spoken: "1 minute", ms: 60_000 };
const MINUTES_5: Jump = { label: "5 m", spoken: "5 minutes", ms: 300_000 };
export const MINUTES_15: Jump = { label: "15 m", spoken: "15 minutes", ms: 900_000 };
const HOUR: Jump = { label: "1 h", spoken: "1 hour", ms: 3_600_000 };
const HOURS_3: Jump = { label: "3 h", spoken: "3 hours", ms: 10_800_000 };
const HOURS_6: Jump = { label: "6 h", spoken: "6 hours", ms: 21_600_000 };
const DAY: Jump = { label: "1 d", spoken: "1 day", ms: 86_400_000 };
const DAYS_2: Jump = { label: "2 d", spoken: "2 days", ms: 172_800_000 };

/** How much the slider spans, with the jumps that fit it; the first jump is also the step. */
export const ZOOMS: Zoom[] = [
  { ms: MINUTES_15.ms, jumps: [SECONDS_10, MINUTE, MINUTES_5, MINUTES_15] },
  { ms: HOUR.ms, jumps: [MINUTE, MINUTES_5, MINUTES_15, HOUR] },
  { ms: HOURS_6.ms, jumps: [MINUTES_15, HOUR, HOURS_3, HOURS_6] },
  { ms: DAYS_2.ms, jumps: [HOUR, HOURS_6, DAY, DAYS_2] },
];

/** Spans worth offering for `held` of history: those it fills, and the first that holds it all. */
export function zoomsFor(held: number): Zoom[] {
  const fitting = ZOOMS.filter((zoom) => zoom.ms <= held);
  const covering = ZOOMS.find((zoom) => zoom.ms > held);
  const offered = covering ? [...fitting, covering] : fitting;
  return offered.length > 0 ? offered : ZOOMS.slice(0, 1);
}

/** The span chosen, or the widest offered when none is, widened when the moment shown lies before it. */
export function zoomFor(zooms: Zoom[], chosen: number | null, back: number): Zoom | undefined {
  const wanted = chosen ?? Number.POSITIVE_INFINITY;
  return zooms.find((option) => option.ms >= wanted && option.ms >= back) ?? zooms[zooms.length - 1] ?? ZOOMS[0];
}
