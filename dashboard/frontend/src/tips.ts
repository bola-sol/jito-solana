/**
 * The measured tip figure times the rates the validator sends. `jitoShare` is
 * what reached a distribution account, for any leader; `ourShare` is what a
 * turn earned us, for our own slots only. Both are estimates: label them
 * derived.
 */

import type { TipRates } from "./types";

/** Basis points in the whole. */
const BPS_WHOLE = 10_000;

/** `amount` scaled by `bps`, floored to match the validator's integer
 *  arithmetic. */
function scale(amount: number, bps: number): number {
  return Math.floor((amount * bps) / BPS_WHOLE);
}

/** What reached a distribution account, validator and stakers together. */
export function jitoShare(paid: number, rates: TipRates): number {
  return paid - scale(paid, rates.jito_cut_bps);
}

/** What a turn earned this validator, null without a commission. Our own
 *  slots only. */
export function ourShare(paid: number, rates: TipRates): number | null {
  if (rates.commission_bps === null) return null;
  return scale(jitoShare(paid, rates), rates.commission_bps);
}
