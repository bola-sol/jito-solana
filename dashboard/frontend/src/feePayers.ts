import { count, percent, sol } from "./format";
import type { FeePayerRow, FeePayerSummary } from "./types";

/** The server's rule, for the wording and the ratio's colour. */
export const MIN_AWAY_TRANSACTIONS = 100;
export const ESCALATE_RATIO = 3;

export function failedShare(failed: number, transactions: number): number | null {
  return transactions > 0 ? failed / transactions : null;
}

/** Our rate over the rate elsewhere; infinite where nothing failed elsewhere. */
export function failedRatio(row: FeePayerRow): number | null {
  const here = failedShare(row.failed, row.transactions);
  const away = failedShare(row.away_failed, row.away_transactions);
  if (here === null || away === null) return null;
  if (away === 0) return here > 0 ? Infinity : null;
  return here / away;
}

export function shareLabel(failed: number, transactions: number): string {
  return percent(failedShare(failed, transactions), 1);
}

export function ratioLabel(row: FeePayerRow): string {
  const ratio = failedRatio(row);
  if (ratio === null) return "—";
  return ratio === Infinity ? "∞" : `${ratio.toFixed(1)}×`;
}

export function priorityLabel(lamports: number): string {
  return `${sol(lamports, 4)} SOL`;
}

/** The newest epoch's alerts. */
export function alertCounts(summary: FeePayerSummary): { escalated: number; flagged: number } {
  const newest = summary.epochs[0]?.epoch;
  const current = summary.alerts.filter((row) => row.epoch === newest);
  return {
    escalated: current.filter((row) => row.alert === "escalated").length,
    flagged: current.filter((row) => row.alert === "flagged").length,
  };
}

export function alertText(row: FeePayerRow, newest: number): string {
  const here = shareLabel(row.failed, row.transactions);
  const away = shareLabel(row.away_failed, row.away_transactions);
  const lead = row.epoch === newest ? "" : `Epoch ${count(row.epoch)}: `;
  const since = row.flagged_slot === null ? "" : ` Since slot ${count(row.flagged_slot)}.`;
  if (row.alert === "escalated") {
    return `${lead}${here} failed in our slots against ${away} in other leaders' (${ratioLabel(row)}), ${priorityLabel(row.priority_failed)} priority on failed.${since}`;
  }
  if (row.away_transactions < MIN_AWAY_TRANSACTIONS) {
    return `${lead}${here} failed in our slots; ${count(row.away_transactions)} of its txns seen elsewhere, too few to compare.${since}`;
  }
  return `${lead}${here} failed in our slots and ${away} elsewhere, so it is not escalated.${since}`;
}
