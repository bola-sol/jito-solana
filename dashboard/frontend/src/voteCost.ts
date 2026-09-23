/** The header's balance warnings, from what voting costs. */

import { sol } from "./format";
import type { VoteCost } from "./types";

export interface BalanceWarning {
  tone: "warn" | "bad";
  label: string;
  /** One sentence for the hover. */
  title: string;
}

/** Under TowerBFT the identity pays each vote: under three days of them warns, under a day is a
 *  fault. Nothing on a node that is not the voter. */
export function identityWarning(
  balance: number | undefined,
  cost: VoteCost | undefined,
  voting: boolean | undefined,
): BalanceWarning | null {
  if (!voting || balance === undefined || cost === undefined || cost.kind !== "fees" || cost.per_day <= 0) {
    return null;
  }
  const days = balance / cost.per_day;
  if (days >= 3) return null;
  const title = `${days.toFixed(1)} days of votes at ${sol(cost.per_day)} SOL a day.`;
  if (days < 1) return { tone: "bad", label: "identity, under a day of votes", title };
  return { tone: "warn", label: "identity, under three days of votes", title };
}

/** Under alpenglow each epoch burns the admission ticket from the vote account: below the minimum
 *  the next fails, one ticket above it the one after. */
export function voteWarning(balance: number | undefined, cost: VoteCost | undefined): BalanceWarning | null {
  if (balance === undefined || cost === undefined || cost.kind !== "ticket") return null;
  if (balance >= cost.minimum + cost.lamports) return null;
  const title = `The epoch's turn burns ${sol(cost.lamports)} SOL from the vote account, which must hold ${sol(cost.minimum)} SOL to stay in.`;
  if (balance < cost.minimum) return { tone: "bad", label: "vote, below the admission ticket", title };
  return { tone: "warn", label: "vote, one admission ticket left", title };
}
