/** What to say about a vote account with no seat in the admitted set. */

import { sol } from "./format";
import type { Admission } from "./types";

/** The header's label beside "no seat". */
export function noSeatLabel(admission: Admission): string {
  if (admission.next_seat === null) return "this epoch";
  return admission.next_seat ? "this epoch, the next is covered" : "this epoch, nor the next";
}

/** The epoch card's line under "no seat": the next epoch's seat, or what
 *  stands in its way. */
export function noSeatDetail(admission: Admission): string | undefined {
  if (admission.next_seat) return "a seat next epoch";
  if (admission.ticket_short !== null) {
    return `${sol(admission.ticket_short)} SOL short of the next epoch's ticket`;
  }
  return admission.next_seat === null ? undefined : "no seat next epoch";
}
