import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import { clockTime, dateTimeText, dayText, duration } from "../format";
import { parseMoment, resolveMoment, SPEEDS, type Rewind, type Speed } from "../rewind";
import { MINUTES_15, SECONDS_10, ZOOMS, zoomFor, zoomsFor } from "../zoom";
import type { Page } from "../route";
import { useWallClock } from "../useNow";
import { useRewind, useRewindState } from "../useStore";
import { PauseIcon, PlayIcon } from "./RewindIcons";

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** Pages drawn in part from replies the feed does not carry, which are not rewound. */
const UNRECORDED: Partial<Record<Page, string>> = {
  schedule: "Searches read the validator's present history.",
  gossip: "The peer table and certificate lists are not recorded and hold their last reply.",
  cluster: "The cluster charts are not recorded and hold their last reply.",
};

function seekAndSettle(rewind: Rewind, at: number): void {
  rewind.seek(at);
  rewind.settle();
}

/** The moment shown, typed over to jump to a time, a slot or an epoch. */
function TimeField({ rewind, at, now }: { rewind: Rewind; at: number; now: number }): ReactElement {
  const [typed, setTyped] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Bumped by each entry and edit, so a lookup answered late changes nothing.
  const asked = useRef(0);
  useEffect(
    () => () => {
      asked.current += 1;
    },
    [],
  );
  const forget = () => {
    asked.current += 1;
    setBusy(false);
  };
  const submit = async (text: string) => {
    asked.current += 1;
    const token = asked.current;
    const source = rewind.momentSource();
    const from = rewind.at();
    const parsed = parseMoment(text, source.now);
    if (parsed.kind === "slot" || parsed.kind === "epoch") setBusy(true);
    const resolved = await resolveMoment(parsed, source);
    if (token !== asked.current) return;
    setBusy(false);
    // Another control moved the view meanwhile; playback moves it by itself.
    if (!rewind.getState().playing && rewind.at() !== from) {
      setTyped(null);
      return;
    }
    if ("refused" in resolved) {
      // A refusal for a field already left goes with what was typed.
      if (document.activeElement === input.current) setReason(resolved.refused);
      else setTyped(null);
      return;
    }
    seekAndSettle(rewind, resolved.at);
    setTyped(null);
    setReason(null);
    input.current?.blur();
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      forget();
      setTyped(null);
      setReason(null);
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter" && typed !== null) void submit(typed);
  };
  return (
    <span className="rw-field">
      <input
        ref={input}
        className="rw-time"
        aria-label="Time, slot or epoch"
        aria-invalid={reason !== null}
        aria-busy={busy}
        aria-describedby={reason !== null ? "rw-why" : undefined}
        title="A time, a date and time, a slot or an epoch (e1066), then Enter."
        value={typed ?? clockTime(at)}
        onFocus={(event) => {
          forget();
          setTyped(sameDay(at, now) ? clockTime(at) : dateTimeText(at));
          event.currentTarget.select();
        }}
        onBlur={() => {
          // A lookup already asked still lands; only what was typed and its refusal go.
          if (!busy) setTyped(null);
          setReason(null);
        }}
        onChange={(event) => {
          forget();
          setTyped(event.target.value);
          setReason(null);
        }}
        onKeyDown={onKey}
      />
      {reason !== null && (
        <span id="rw-why" className="rw-why" role="alert">
          {reason}
        </span>
      )}
    </span>
  );
}

/** The slider's span, chosen where the left end's label would be. */
function ZoomSelect({
  zooms,
  zoom,
  held,
  onChange,
}: {
  zooms: { ms: number }[];
  zoom: number;
  held: number;
  onChange: (ms: number) => void;
}): ReactElement {
  return (
    <span className="rw-tick rw-zoom">
      <select
        aria-label="Slider span"
        title="Slider span"
        value={zoom}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {zooms.map((option) => (
          <option key={option.ms} value={option.ms}>
            −{duration(Math.min(option.ms, held), 1)}
          </option>
        ))}
      </select>
    </span>
  );
}

/** The slider over the span shown, seeking once a frame while dragged; recording gaps are hatched. */
function Track({
  rewind,
  at,
  start,
  now,
  gaps,
  zoomSelect,
}: {
  rewind: Rewind;
  at: number;
  start: number;
  now: number;
  gaps: [number, number][];
  zoomSelect: ReactElement | null;
}): ReactElement {
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
      {span > 0 &&
        gaps
          .filter(([from, to]) => to > start && from < now)
          .map(([from, to]) => {
            const left = ((Math.max(from, start) - start) / span) * 100;
            const width = ((Math.min(to, now) - Math.max(from, start)) / span) * 100;
            return <span key={from} className="rw-gap" style={{ left: `${left}%`, width: `${width}%` }} />;
          })}
      {zoomSelect ?? (span >= 10_000 && <span className="rw-tick">−{duration(span, 1)}</span>)}
      {span >= 10_000 && <span className="rw-tick rw-tick-mid">−{duration(span / 2, 1)}</span>}
      <span className="rw-tick rw-tick-end">now</span>
    </div>
  );
}

/** Shown only while the page is paused, rewound or playing. */
export function TimeBar({ page }: { page: Page }): ReactElement | null {
  const rewind = useRewind();
  const { live, playing, speed, loading } = useRewindState();
  // Null until a span is picked: the widest offered, so the slider covers all that is held.
  const [chosen, setChosen] = useState<number | null>(null);
  // A quarter second while playing keeps the time and slider moving; a second otherwise ages "ago".
  const now = useWallClock(!live, playing ? 250 : 1_000);
  if (live) return null;

  const at = rewind.at();
  const earliest = rewind.earliest() ?? at;
  const held = Math.max(0, now - earliest);
  const recorded = rewind.archive.isEnabled();
  const zooms = recorded ? zoomsFor(held) : ZOOMS.slice(0, 1);
  const zoom = zoomFor(zooms, chosen, now - at);
  const zoomMs = zoom?.ms ?? MINUTES_15.ms;
  const jumps = zoom?.jumps ?? [];
  const step = jumps[0] ?? SECONDS_10;
  const start = Math.max(earliest, now - zoomMs);
  const note = UNRECORDED[page];

  return (
    <div className={loading ? "rw-bar is-loading" : "rw-bar"} aria-busy={loading}>
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
          aria-label={`Back ${step.spoken}`}
          onClick={() => seekAndSettle(rewind, at - step.ms)}
        >
          ‹
        </button>
        {!sameDay(at, now) && <span className="rw-day">{dayText(at)}</span>}
        <TimeField rewind={rewind} at={at} now={now} />
        <button
          type="button"
          className="rw-step"
          aria-label={`Forward ${step.spoken}`}
          onClick={() => seekAndSettle(rewind, at + step.ms)}
        >
          ›
        </button>
        <span className="rw-ago">{loading ? "fetching" : `${duration(Math.max(0, now - at), 2)} ago`}</span>
      </div>
      <Track
        rewind={rewind}
        at={at}
        start={start}
        now={now}
        gaps={recorded ? rewind.archive.gaps() : []}
        zoomSelect={
          zooms.length > 1 ? <ZoomSelect zooms={zooms} zoom={zoomMs} held={held} onChange={setChosen} /> : null
        }
      />
      <div className="rw-right">
        <div className="rw-chips">
          {jumps.map((jump) => (
            <button
              key={jump.label}
              type="button"
              className="rw-chip"
              disabled={jump.ms > held}
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
