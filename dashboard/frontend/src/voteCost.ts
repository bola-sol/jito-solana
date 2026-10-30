
import { sol } from "./format";
import type { VoteCost } from "./types";

export interface BalanceWarning {
  tone: "warn" | "bad";
  label: string;
  title?: string;
}

/** Under three days of votes warns, under a day is a fault; nothing on a node that is not the
 *  voter. */
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

/** Below the minimum the next epoch fails; one ticket above it, the one after. Delegators' pending
 *  rewards are held on top of the minimum. */
export function voteWarning(balance: number | undefined, cost: VoteCost | undefined): BalanceWarning | null {
  if (balance === undefined || cost === undefined || cost.kind !== "ticket") return null;
  const minimum = cost.minimum + cost.pending;
  if (balance >= minimum + cost.lamports) return null;
  if (balance < minimum) return { tone: "bad", label: "vote, below the admission ticket" };
  return { tone: "warn", label: "vote, one admission ticket left" };
}

export interface VoteRunway {
  ticket: number;
  pending: number;
  /** Tickets the balance pays at the turns still to come. */
  tickets: number;
  /** The last epoch with a seat paid for. */
  lastEpoch: number;
  /** To the end of that epoch at the current slot time. */
  millis: number | null;
}

/** Each turn the account must hold rent, the ticket and its delegators' pending rewards, then burns the
 *  ticket; the turn into this epoch already paid for the next. */
export function voteRunway(
  balance: number | undefined,
  cost: VoteCost | undefined,
  epoch: { epoch: number; slots_in_epoch: number } | undefined,
  remainingNanos: number | undefined,
  slotNanos: number | undefined,
): VoteRunway | null {
  if (balance === undefined || cost === undefined || cost.kind !== "ticket" || cost.lamports <= 0 || !epoch) {
    return null;
  }
  const rent = cost.minimum - cost.lamports;
  const tickets = Math.max(0, Math.floor((balance - rent - cost.pending) / cost.lamports));
  const epochs = tickets + 1;
  const millis =
    remainingNanos === undefined || !slotNanos
      ? null
      : (remainingNanos + epochs * epoch.slots_in_epoch * slotNanos) / 1e6;
  return { ticket: cost.lamports, pending: cost.pending, tickets, lastEpoch: epoch.epoch + epochs, millis };
}
