
import { count, duration } from "./format";
import type { Health } from "./types";

export type Tone = "good" | "warn" | "bad" | "muted";

export interface Verdict {
  tone: Tone;
  headline: string;
}

/** A slot or two is the ordinary lag of hearing about the tip. */
export const IN_STEP_SLOTS = 4;

/** A stalled replay outranks the vote, and delinquent the rest. Kept short enough for one line
 *  beside the cluster figures. */
export function verdictOf(
  health: Health | undefined,
  behindCluster: number | null | undefined,
  completedSlot?: number,
): Verdict {
  if (!health) return { tone: "muted", headline: "Waiting for the validator." };

  const behind = behindCluster ?? 0;
  const distance = behind > IN_STEP_SLOTS ? `, ${count(behind)} behind` : "";
  if (health.replay === "stalled") {
    return {
      tone: "bad",
      headline:
        completedSlot === undefined
          ? `Replay stalled${distance}.`
          : `Replay stalled at ${count(completedSlot)}.`,
    };
  }

  switch (health.vote) {
    case "delinquent":
      return { tone: "bad", headline: behind > 0 ? `Delinquent, ${count(behind)} behind.` : "Delinquent." };
    case "not_voting":
      return { tone: "warn", headline: distance ? `Not voting${distance}.` : "Running without voting." };
    case "not_started":
      return { tone: "muted", headline: distance ? `Not voting${distance}.` : "Running, not voting yet." };
    case "voting":
      return behind > IN_STEP_SLOTS
        ? { tone: "warn", headline: `Voting, ${count(behind)} behind.` }
        : { tone: "good", headline: "Voting, in step with the cluster." };
  }
}

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
  return `Catching up, ${duration(toGoMs, 2)} to go.`;
}
