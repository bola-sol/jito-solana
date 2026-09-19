/** The one sentence at the top of the overview: what the validator is doing. */

import { count } from "./format";
import type { Health } from "./types";

export type Tone = "good" | "warn" | "bad" | "muted";

export interface Verdict {
  tone: Tone;
  headline: string;
}

/** Slots replay may trail the cluster by before the sentence says so: a slot
 *  or two is the ordinary lag of hearing about the tip. */
export const IN_STEP_SLOTS = 4;

/** Read from the health flags, worst first: a stalled replay outranks the
 *  vote, and delinquent outranks the rest. */
export function verdictOf(
  health: Health | undefined,
  behindCluster: number | null | undefined,
): Verdict {
  if (!health) return { tone: "muted", headline: "Waiting for the validator." };
  if (health.replay === "stalled") return { tone: "bad", headline: "Replay has stalled." };

  const behind = behindCluster ?? 0;
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
      return { tone: "warn", headline: "Running without voting." };
    case "not_started":
      return { tone: "muted", headline: "Running, not voting yet." };
    case "voting":
      return behind > IN_STEP_SLOTS
        ? { tone: "warn", headline: `Voting, ${count(behind)} slots behind the cluster.` }
        : { tone: "good", headline: "Voting, in step with the cluster." };
  }
}
