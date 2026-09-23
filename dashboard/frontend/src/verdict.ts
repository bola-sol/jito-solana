/** The one sentence at the top of the overview: what the validator is doing. */

import { count, duration } from "./format";
import type { Health } from "./types";

export type Tone = "good" | "warn" | "bad" | "muted";

export interface Verdict {
  tone: Tone;
  headline: string;
}

/** Slots replay may trail the cluster by before the sentence says so: a slot
 *  or two is the ordinary lag of hearing about the tip. */
export const IN_STEP_SLOTS = 4;

/** Read from the health flags, worst first: a stalled replay outranks the vote, and delinquent the
 *  rest. Each branch carries the distance once past the allowance. */
export function verdictOf(
  health: Health | undefined,
  behindCluster: number | null | undefined,
  completedSlot?: number,
): Verdict {
  if (!health) return { tone: "muted", headline: "Waiting for the validator." };

  const behind = behindCluster ?? 0;
  const distance = behind > IN_STEP_SLOTS ? `, ${count(behind)} slots behind the cluster` : "";
  if (health.replay === "stalled") {
    const at = completedSlot === undefined ? "" : ` at slot ${count(completedSlot)}`;
    return { tone: "bad", headline: `Replay has stalled${at}${distance}.` };
  }

  switch (health.vote) {
    case "delinquent":
      return {
        tone: "bad",
        headline:
          behind > 0
            ? `Delinquent, ${count(behind)} slots behind the cluster.`
            : "Delinquent.",
      };
    case "not_voting":
      return { tone: "warn", headline: `Running without voting${distance}.` };
    case "not_started":
      return { tone: "muted", headline: `Running, not voting yet${distance}.` };
    case "voting":
      return behind > IN_STEP_SLOTS
        ? { tone: "warn", headline: `Voting, ${count(behind)} slots behind the cluster.` }
        : { tone: "good", headline: "Voting, in step with the cluster." };
  }
}

/** The replay rate while trailing, and the time to close the gap at the net gain over the cluster.
 *  Null in step and until both rates are known. */
export function catchUpClause(
  behindCluster: number | null | undefined,
  replayRate: number | null | undefined,
  slotDurationNanos: number | undefined,
): string | null {
  if (behindCluster === null || behindCluster === undefined || behindCluster <= IN_STEP_SLOTS) return null;
  if (replayRate === null || replayRate === undefined || !slotDurationNanos) return null;
  const clusterRate = 1e9 / slotDurationNanos;
  const gain = replayRate - clusterRate;
  if (gain <= 0) return "Not gaining on the cluster.";
  const toGoMs = (behindCluster / gain) * 1000;
  return `Catching up at ${count(Math.round(replayRate))} slots/s, about ${duration(toGoMs)} to go.`;
}
