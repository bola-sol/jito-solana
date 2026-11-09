import type { ReactElement } from "react";
import { HOME, openAddress, plainClick, routeAddress, slotAddress } from "../route";
import { useCopied } from "./Copyable";

function LinkIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M6.6 9.4a2.8 2.8 0 0 0 4 0l2.4-2.4a2.8 2.8 0 0 0-4-4l-.9.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M9.4 6.6a2.8 2.8 0 0 0-4 0L3 9a2.8 2.8 0 0 0 4 4l.9-.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M3 8.5l3.2 3.2L13 4.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M2.8 8h10M9 4.2 12.8 8 9 11.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyButton({ text, name, icon }: { text: string; name: string; icon: ReactElement }): ReactElement {
  const [copied, copy] = useCopied();
  return (
    <button
      type="button"
      className={`slot-action${copied ? " is-done" : ""}`}
      title={copied ? "Copied" : name}
      aria-label={name}
      onClick={() => void copy(text)}
    >
      {copied ? <CheckIcon /> : icon}
    </button>
  );
}

function SlotOpen({ slot }: { slot: number }): ReactElement {
  const address = routeAddress({ ...HOME, page: "slots", slot });
  return (
    <a
      className="slot-action slot-open"
      href={address}
      title="Slot details"
      aria-label="Slot details"
      onClick={(event) => {
        if (!plainClick(event)) return;
        event.preventDefault();
        openAddress(address);
      }}
    >
      <ArrowIcon />
    </a>
  );
}

/** A link to a slot once it has happened, and on our own slots the way to their details. */
export function SlotActions({ slot, held, mine }: { slot: number; held: boolean; mine: boolean }): ReactElement {
  return (
    <span className="slot-actions">
      {held && (
        <CopyButton
          text={`${window.location.origin}${slotAddress(slot)}`}
          name="Copy link to this slot"
          icon={<LinkIcon />}
        />
      )}
      {mine && <SlotOpen slot={slot} />}
    </span>
  );
}
