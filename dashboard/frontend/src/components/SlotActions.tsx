import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { slotAddress } from "../route";
import { useCopied } from "./Copyable";

/** What the menu needs below its button; short of it, the menu opens above. */
const MENU_HEIGHT_PX = 84;

function CopyIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M10.6 3.4v-.2a1.2 1.2 0 0 0-1.2-1.2H3.2A1.2 1.2 0 0 0 2 3.2v6.2a1.2 1.2 0 0 0 1.2 1.2h.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

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

function MoreIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <circle cx="3" cy="8" r="1.4" fill="currentColor" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="13" cy="8" r="1.4" fill="currentColor" />
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

/** One button and larger targets, where two icons have no room. */
function SlotMenu({ slot, link }: { slot: string; link: string | null }): ReactElement {
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [copied, copy] = useCopied();
  const button = useRef<HTMLButtonElement>(null);
  const open = place !== null;

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".slot-actions-menu")) return;
      setPlace(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPlace(null);
      button.current?.focus();
    };
    // Not on scroll: the live list moves its own position as turns arrive.
    window.addEventListener("pointerdown", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("touchmove", close, { passive: true });
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("touchmove", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const toggle = (): void => {
    const box = button.current?.getBoundingClientRect();
    if (open || !box) {
      setPlace(null);
      return;
    }
    const fits = box.bottom + MENU_HEIGHT_PX <= window.innerHeight;
    setPlace(fits ? { left: box.left, top: box.bottom + 4 } : { left: box.left, bottom: window.innerHeight - box.top + 4 });
  };
  const choose = (text: string): void => {
    void copy(text);
    setPlace(null);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`slot-action${copied ? " is-done" : ""}`}
        title={copied ? "Copied" : "Copy slot or link"}
        aria-label="Copy slot or link"
        aria-expanded={open}
        onClick={toggle}
      >
        {copied ? <CheckIcon /> : <MoreIcon />}
      </button>
      {place &&
        createPortal(
          <div className="slot-actions-menu" style={place}>
            <button type="button" autoFocus onClick={() => choose(slot)}>
              <CopyIcon /> Copy slot
            </button>
            {link !== null && (
              <button type="button" onClick={() => choose(link)}>
                <LinkIcon /> Copy link
              </button>
            )}
          </div>,
          // A turn's slots scroll sideways, which would clip it.
          document.body,
        )}
    </>
  );
}

/** Copying a slot, and a link to it once it has happened, beside its number. */
export function SlotActions({ slot, held }: { slot: number; held: boolean }): ReactElement {
  const digits = String(slot);
  const link = held ? `${window.location.origin}${slotAddress(slot)}` : null;
  return (
    <span className="slot-actions">
      <span className="slot-actions-pair">
        <CopyButton text={digits} name="Copy slot" icon={<CopyIcon />} />
        {link !== null && <CopyButton text={link} name="Copy link to this slot" icon={<LinkIcon />} />}
      </span>
      <span className="slot-actions-one">
        <SlotMenu slot={digits} link={link} />
      </span>
    </span>
  );
}
