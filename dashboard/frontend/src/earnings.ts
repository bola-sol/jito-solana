import { sol } from "./format";
import type { EpochEarnings } from "./types";

/** Lamports our commission keeps. */
export function kept(lamports: number, commissionBps: number): number {
  return (lamports * commissionBps) / 10_000;
}

/** "4%", or "4.5%" for a commission set in finer steps. */
export function commissionText(commissionBps: number): string {
  const percent = commissionBps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0$/, "")}%`;
}

export interface BarParts {
  earned: number;
  lost: number;
}

/** Earned and lost as fractions of the epoch's most, never past its end together. */
export function barParts(earned: number, lost: number, max: number): BarParts {
  if (!(max > 0)) return { earned: 0, lost: 0 };
  const shown = Math.min(1, Math.max(0, earned / max));
  return { earned: shown, lost: Math.min(1 - shown, Math.max(0, lost / max)) };
}

/** The footnote's total: what we keep, then the commission and the gross it is of. */
export function earningsTotal(earnings: EpochEarnings): { kept: string; rest: string } {
  const gross = earnings.voting + earnings.bonus;
  return {
    kept: sol(kept(gross, earnings.commission_bps), 3),
    rest: `SOL, ${commissionText(earnings.commission_bps)} of ${sol(gross)}`,
  };
}
