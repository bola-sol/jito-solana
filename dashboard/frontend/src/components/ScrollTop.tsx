import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { heldScrollTop } from "../scroll";

/** How far a list must be scrolled before the way back is offered. */
const LIVE_EDGE_PX = 120;

/** A pill that returns a list to the top, hanging over the rows rather
 *  than moving them. */
export function ScrollTop({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const [away, setAway] = useState(false);
  // Shared with the hook below: it needs to know where the list was left, to
  // tell its own correction apart from one the browser already made.
  const top = useRef(0);
  useHeldScroll(scroller, top);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;

    const follow = () => {
      top.current = element.scrollTop;
      setAway(element.scrollTop > LIVE_EDGE_PX);
    };
    element.addEventListener("scroll", follow, { passive: true });
    // The list may already be scrolled when this mounts, which is what happens
    // when the page is switched away from and back.
    follow();
    return () => element.removeEventListener("scroll", follow);
  }, [scroller]);

  return (
    <div className="scroll-top-anchor">
      {away && (
        <button
          type="button"
          className="scroll-top"
          onClick={() =>
            scroller.current?.scrollTo({
              top: 0,
              // Not `scroll-behavior` on the list, which would animate the
              // corrections below too.
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "auto"
                : "smooth",
            })
          }
        >
          Top <span aria-hidden="true">↑</span>
        </button>
      )}
    </div>
  );
}

/** Keeps what is on screen still while rows arrive above it. Browser scroll
 *  anchoring cannot be relied on; corrections are instant. */
function useHeldScroll(
  scroller: RefObject<HTMLElement | null>,
  // A plain box rather than `RefObject`, whose `current` React types as
  // read-only; this one is written on both sides.
  top: { current: number },
): void {
  // Undefined until the first measurement rather than zero, which would read as
  // the list having grown its whole length on the first render.
  const height = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;

    const previous = height.current;
    height.current = element.scrollHeight;

    if (previous === undefined) {
      top.current = element.scrollTop;
      return;
    }

    // Compared before `top` is refreshed, or the check for a position something
    // else has already moved could never fire.
    const next = heldScrollTop(element.scrollTop, top.current, previous, element.scrollHeight);
    if (next !== element.scrollTop) {
      element.scrollTop = next;
    }
    top.current = element.scrollTop;
  });
}
