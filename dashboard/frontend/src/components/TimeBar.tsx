import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import { clockTime, duration } from "../format";
import { readMoment, SPEEDS, type Rewind, type Speed } from "../rewind";
import type { Page } from "../route";
import { useWallClock } from "../useNow";
import { useRewind, useRewindState } from "../useStore";
import { PauseIcon, PlayIcon } from "./RewindIcons";

const STEP_MS = 10_000;

const JUMPS: { label: string; ms: number }[] = [
  { label: "10 s", ms: 10_000 },
  { label: "1 m", ms: 60_000 },
  { label: "5 m", ms: 300_000 },
  { label: "15 m", ms: 900_000 },
];

/** Pages drawn in part from replies the feed does not carry, which are not rewound. */
const UNRECORDED: Partial<Record<Page, string>> = {
  slots: "The block list is not rewound.",
  schedule: "Searches read the validator's present history.",
  gossip: "The peer table and certificate lists are not recorded and hold their last reply.",
  cluster: "The cluster charts are not recorded and hold their last reply.",
};

function seekAndSettle(rewind: Rewind, at: number): void {
  rewind.seek(at);
  rewind.settle();
}

/** The moment shown, typed over to jump to a time or a slot. */
function TimeField({ rewind, at, now }: { rewind: Rewind; at: number; now: number }): ReactElement {
  const [typed, setTyped] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setTyped(null);
      setWrong(false);
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "Enter" || typed === null) return;
    const moment = readMoment(typed, now, (slot) => rewind.ring.slotArrival(slot));
    const start = rewind.ring.start();
    if (moment === null || start === null || moment < start || moment > now) {
      setWrong(true);
      return;
    }
    seekAndSettle(rewind, moment);
    setTyped(null);
    setWrong(false);
    event.currentTarget.blur();
  };
  return (
    <input
      className="rw-time"
      aria-label="Time or slot"
      aria-invalid={wrong}
      title="A time of day or a slot number, then Enter."
      value={typed ?? clockTime(at)}
      onFocus={(event) => {
        setTyped(clockTime(at));
        event.currentTarget.select();
      }}
      onBlur={() => {
        setTyped(null);
        setWrong(false);
      }}
      onChange={(event) => {
        setTyped(event.target.value);
        setWrong(false);
      }}
      onKeyDown={onKey}
    />
  );
}

/** The slider over what the ring holds, seeking once a frame while dragged. */
function Track({ rewind, at, start, now }: { rewind: Rewind; at: number; start: number; now: number }): ReactElement {
  const [dragged, setDragged] = useState<number | null>(null);
  const frame = useRef<number | null>(null);
  const wanted = useRef(0);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const span = Math.max(0, now - start);
  const value = dragged ?? at;
  const fill = span > 0 ? ((value - start) / span) * 100 : 100;
  const release = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
      rewind.seek(wanted.current);
    }
    setDragged(null);
    rewind.settle();
  };
  return (
    <div className="rw-track">
      <input
        type="range"
        className="rw-range"
        aria-label="Moment shown"
        min={start}
        max={Math.max(start, now)}
        step={1000}
        value={Math.min(Math.max(value, start), now)}
        style={{ "--rw-fill": `${Math.min(100, Math.max(0, fill))}%` } as CSSProperties}
        onChange={(event) => {
          const next = Number(event.target.value);
          wanted.current = next;
          setDragged(next);
          frame.current ??= requestAnimationFrame(() => {
            frame.current = null;
            rewind.seek(wanted.current);
          });
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onKeyUp={release}
        onBlur={release}
      />
      {span >= 10_000 && (
        <>
          <span className="rw-tick">−{duration(span, 1)}</span>
          <span className="rw-tick rw-tick-mid">−{duration(span / 2, 1)}</span>
        </>
      )}
      <span className="rw-tick rw-tick-end">now</span>
    </div>
  );
}

/** Shown only while the page is paused, rewound or playing. */
export function TimeBar({ page }: { page: Page }): ReactElement | null {
  const rewind = useRewind();
  const { live, playing, speed } = useRewindState();
  // A quarter second while playing keeps the time and slider moving; a second otherwise ages "ago".
  const now = useWallClock(!live, playing ? 250 : 1_000);
  if (live) return null;

  const at = rewind.at();
  const start = rewind.ring.start() ?? at;
  const span = Math.max(0, now - start);
  const note = UNRECORDED[page];

  return (
    <div className="rw-bar">
      <div className="rw-when">
        <button
          type="button"
          className="rw-step rw-play"
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play from here"}
          onClick={() => (playing ? rewind.stop() : rewind.play())}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="rw-speed">
          <select
            className="rw-chip"
            aria-label="Playback speed"
            title="Playback speed"
            value={speed}
            onChange={(event) => {
              const chosen = SPEEDS.find((option) => option === Number(event.target.value));
              if (chosen !== undefined) rewind.setSpeed(chosen);
            }}
          >
            {SPEEDS.map((option: Speed) => (
              <option key={option} value={option}>
                {option}×
              </option>
            ))}
          </select>
        </span>
        <button
          type="button"
          className="rw-step"
          aria-label="Back 10 seconds"
          onClick={() => seekAndSettle(rewind, at - STEP_MS)}
        >
          ‹
        </button>
        <TimeField rewind={rewind} at={at} now={now} />
        <button
          type="button"
          className="rw-step"
          aria-label="Forward 10 seconds"
          onClick={() => seekAndSettle(rewind, at + STEP_MS)}
        >
          ›
        </button>
        <span className="rw-ago">{duration(Math.max(0, now - at), 2)} ago</span>
      </div>
      <Track rewind={rewind} at={at} start={start} now={now} />
      <div className="rw-right">
        <div className="rw-chips">
          {JUMPS.map((jump) => (
            <button
              key={jump.label}
              type="button"
              className="rw-chip"
              disabled={jump.ms > span}
              onClick={() => seekAndSettle(rewind, Date.now() - jump.ms)}
            >
              {jump.label}
            </button>
          ))}
        </div>
        <button type="button" className="rw-live" onClick={() => rewind.goLive()}>
          <span className="connection-dot" />
          <span>
            <span className="rw-live-long">Back to </span>live
          </span>
        </button>
      </div>
      {note && <p className="rw-note">{note}</p>}
    </div>
  );
}
