import type { ReactElement } from "react";
import { count } from "../format";
import { HOME, routeHash } from "../route";

export function SlotLink({ slot }: { slot: number }): ReactElement {
  return (
    <a className="slot-link" href={routeHash({ ...HOME, page: "slots", slot })} title="Open on the slot page">
      {count(slot)}
    </a>
  );
}
