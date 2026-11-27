/** Both are estimates, labelled derived. */

import type { TipRates } from "./types";

const BPS_WHOLE = 10_000;

function scale(amount: number, bps: number): number {
  return Math.floor((amount * bps) / BPS_WHOLE);
}

export function jitoShare(paid: number, rates: TipRates): number {
  return paid - scale(paid, rates.jito_cut_bps);
}

export function ourShare(paid: number, rates: TipRates): number | null {
  if (rates.commission_bps === null) return null;
  return scale(jitoShare(paid, rates), rates.commission_bps);
}
