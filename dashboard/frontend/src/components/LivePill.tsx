import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { duration } from "../format";
import { useWallClock } from "../useNow";
import { useRewind, useRewindState } from "../useStore";
import { PauseIcon, PlayIcon } from "./RewindIcons";

/** Lag under this is delivery jitter, not worth a word. */
const LAG_SHOWN_MS = 3_000;

/** The nearest earlier sibling on the same line; in a stacked header it is not the previous one. */
function lineBefore(element: Element): Element | null {
  const box = element.getBoundingClientRect();
  for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    const other = sibling.getBoundingClientRect();
    if (other.top < box.bottom && other.bottom > box.top) return sibling;
  }
  return null;
}

/** The connection while live, and pauses the page; the moment shown otherwise, and goes back to live. */
export function LivePill(): ReactElement {
  const rewind = useRewind();
  const { live: isLive, playing, justPaused } = useRewindState();
  // The connection and lag are the live store's, whichever store the page reads.
  const live = rewind.live;
  useSyncExternalStore(live.subscribe, live.getRevision);
  const state = live.getConnection();
  const lagMs = live.getFeedLag();
  const wall = useWallClock(!isLive);

  const pillRef = useRef<HTMLButtonElement>(null);
  const pageRef = useRef<HTMLSpanElement>(null);
  const pageWidth = useRef(0);
  const [roomy, setRoomy] = useState(true);
  const behind = isLive && state === "open" && lagMs !== null && lagMs >= LAG_SHOWN_MS;
  const seconds = Math.round((lagMs ?? 0) / 1000);

  // "page" is shown only where it fits on the pill's line.
  useLayoutEffect(() => {
    const right = pillRef.current?.parentElement;
    const row = right?.parentElement;
    if (!behind || !right || !row) return;
    const before = lineBefore(right);
    if (!before) return;
    if (pageRef.current) pageWidth.current = pageRef.current.getBoundingClientRect().width;
    const shown = pageRef.current ? 0 : pageWidth.current;
    // A cut name counts at its full width, so "page" never cuts it.
    const cut = row.querySelector(".who-name-text");
    const hidden = cut ? cut.scrollWidth - cut.clientWidth : 0;
    const start = before.getBoundingClientRect().right + hidden + parseFloat(getComputedStyle(row).columnGap);
    const end = start + right.getBoundingClientRect().width + shown;
    const rowEnd = row.getBoundingClientRect().right;
    const next = end <= rowEnd;
    if (next !== roomy) setRoomy(next);
  });

  if (!isLive) {
    const ago = duration(Math.max(0, wall - rewind.at()), 2);
    return (
      <button
        ref={pillRef}
        type="button"
        className="connection rw-pill is-past"
        title="Back to live"
        onClick={() => rewind.goLive()}
      >
        {playing ? <PlayIcon /> : <PauseIcon />}
        {justPaused ? (
          "paused"
        ) : (
          <span>
            {ago}
            <span className="rw-word-long"> ago</span>
          </span>
        )}
      </button>
    );
  }

  const word = behind ? (
    <span>
      {roomy && <span ref={pageRef}>page </span>}
      {seconds} s behind
    </span>
  ) : state === "open" ? (
    "live"
  ) : (
    state
  );
  return (
    <button
      ref={pillRef}
      type="button"
      className={`connection rw-pill connection-${state}${behind ? " is-behind" : ""}`}
      title={behind ? "Updates are reaching this page late." : state === "open" ? "Pause the page." : `websocket ${state}`}
      onClick={() => rewind.pause()}
    >
      <span className="connection-dot" />
      {word}
      <PauseIcon />
    </button>
  );
}
