import type { ReactElement } from "react";
import { count } from "../format";
import { HOME, openAddress, plainClick, routeAddress } from "../route";

export function SlotLink({ slot }: { slot: number }): ReactElement {
  const address = routeAddress({ ...HOME, page: "slots", slot });
  return (
    <a
      className="slot-link"
      href={address}
      title="Open on the slot page"
      onClick={(event) => {
        if (!plainClick(event)) return;
        event.preventDefault();
        openAddress(address);
      }}
    >
      {count(slot)}
    </a>
  );
}
