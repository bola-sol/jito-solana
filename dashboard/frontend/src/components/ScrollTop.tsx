import { useEffect, useState, type RefObject, type ReactElement } from "react";

/** Within this of the top, a list follows new items in rather than holding its place. */
export const LIVE_EDGE_PX = 120;

export function ScrollTop({
  scroller,
  label = "Back to top",
  onPress,
  shown,
  below = false,
}: {
  scroller: RefObject<HTMLElement | null>;
  label?: string;
  /** In place of scrolling to the top, where the top is somewhere else to go back to. */
  onPress?: () => void;
  /** In place of showing once scrolled down, where the place to go back to is somewhere else. */
  shown?: boolean;
  /** Floats at the foot of the list, pointing down. */
  below?: boolean;
}): ReactElement {
  const [away, setAway] = useState(false);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;

    const follow = () => setAway(element.scrollTop > LIVE_EDGE_PX);
    element.addEventListener("scroll", follow, { passive: true });
    // The list may already be scrolled when this mounts, which is what happens
    // when the page is switched away from and back.
    follow();
    return () => element.removeEventListener("scroll", follow);
  }, [scroller]);

  return (
    <div className={`scroll-top-anchor${below ? " is-below" : ""}`}>
      {(shown ?? away) && (
        <button
          type="button"
          className="scroll-top"
          onClick={() => {
            if (onPress) {
              onPress();
              return;
            }
            scroller.current?.scrollTo({ top: 0, behavior: "auto" });
          }}
        >
          <span aria-hidden="true">{below ? "↓" : "↑"}</span> {label}
        </button>
      )}
    </div>
  );
}
