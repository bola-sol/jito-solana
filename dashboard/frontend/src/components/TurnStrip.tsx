import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { count, duration } from "../format";
import { aboutClock, expectedAt, nearestTurn, timeUntil } from "../future";
import { SLOTS_PER_TURN } from "../schedule";
import { useMedia } from "../useMedia";

const TILE_WIDTH = 170;
const TILE_WIDTH_PHONE = 150;
const TILE_GAP = 6;

/** Tiles drawn past each side of the view. */
const OVERSCAN = 3;

/** The ruler redraws its ticks each time the live edge passes this many slots. */
const RULER_STEP_SLOTS = 256;

/** One tick per column of the ruler, as one `M…V10` path. */
function ticks(turns: readonly number[], from: number, span: number, width: number): string {
  const columns = new Set<number>();
  for (const turn of turns) {
    columns.add(Math.round(((turn * SLOTS_PER_TURN - from) / span) * width));
  }
  return [...columns].map((column) => `M${column + 0.5} 0V10`).join("");
}

/**
 * One validator's turns to come as tiles, left to right, with a ruler of the epoch to come. Tiles are
 * a fixed width and only those in view are drawn, as a validator can hold thousands.
 */
export function TurnStrip({
  name,
  filtered,
  turns,
  others,
  gapSlots,
  lastSlot,
  completed,
  slotNanos,
  producing,
}: {
  /** Null for ours. */
  name: string | null;
  filtered: boolean;
  /** The turn numbers listed, oldest first. */
  turns: readonly number[];
  /** All the validator's turns to come, drawn faintly where a filter leaves out some. */
  others: readonly number[];
  gapSlots: (turn: number) => number | null;
  lastSlot: number;
  completed: number | undefined;
  slotNanos: number | undefined;
  producing: number | null;
}): ReactElement {
  const phone = useMedia("(max-width: 700px)");
  const step = (phone ? TILE_WIDTH_PHONE : TILE_WIDTH) + TILE_GAP;
  const row = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLButtonElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [rowWidth, setRowWidth] = useState(0);
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      setRowWidth(row.current?.clientWidth ?? 0);
      setTrackWidth(track.current?.clientWidth ?? 0);
    });
    if (row.current) observer.observe(row.current);
    if (track.current) observer.observe(track.current);
    return () => observer.disconnect();
  }, [turns.length > 0]);

  // A turn passing takes a tile off the front; a reader scrolled along keeps their place.
  const heldTurns = useRef(turns);
  useLayoutEffect(() => {
    const element = row.current;
    const was = heldTurns.current;
    heldTurns.current = turns;
    const gone = turns[0] === undefined ? 0 : was.indexOf(turns[0]);
    if (element && gone > 0 && element.scrollLeft > 0) element.scrollLeft = Math.max(0, element.scrollLeft - gone * step);
  }, [turns]);

  const from = Math.floor((completed ?? turns[0] ?? 0) / RULER_STEP_SLOTS) * RULER_STEP_SLOTS;
  const span = Math.max(1, lastSlot - from);
  const paths = useMemo(
    () => ({ held: ticks(turns, from, span, trackWidth), others: filtered ? ticks(others, from, span, trackWidth) : "" }),
    [turns.length, others.length, filtered, from, span, trackWidth],
  );

  if (turns.length === 0) {
    return (
      <div className="schedule-strip">
        <div className="schedule-strip-head">
          <span className="schedule-strip-title">
            <span className="schedule-strip-who">
              <b>{filtered ? "No matching turns to come" : name === null ? "None of our turns left this epoch" : `No turns left this epoch for ${name}`}</b>
            </span>
          </span>
        </div>
      </div>
    );
  }

  const total = turns.length;
  const shown = Math.max(1, Math.floor((rowWidth + TILE_GAP) / step));
  const width = total * step - TILE_GAP;
  const fits = rowWidth > 0 && width <= rowWidth + 2;
  const atStart = scrollLeft <= 1;
  const atEnd = scrollLeft + rowWidth >= width - 2;
  const first = Math.min(total - 1, Math.round(scrollLeft / step));
  const last = atEnd ? total - 1 : Math.min(total - 1, first + shown - 1);
  const words = first === last ? "turn" : "turns";
  const position = first === last ? `${count(first + 1)} of ${count(total)}` : `${count(first + 1)}–${count(last + 1)} of ${count(total)}`;
  const drawFrom = Math.max(0, Math.floor(scrollLeft / step) - OVERSCAN);
  const drawTo = Math.min(total - 1, drawFrom + shown + OVERSCAN * 2);
  const now = Date.now();
  const gapText = (slots: number): string => {
    if (slots === 0) return "none";
    if (!slotNanos) return "—";
    const millis = (slots * slotNanos) / 1e6;
    return millis < 1000 ? "<1s" : duration(millis, 2);
  };
  const at = (slot: number): number | null => (completed !== undefined && slotNanos ? expectedAt(slot, completed, now, slotNanos) : null);
  const place = (slot: number): number => Math.min(1, Math.max(0, (slot - from) / span)) * trackWidth;
  const viewLeft = place((turns[first] ?? 0) * SLOTS_PER_TURN);
  const viewRight = place((turns[last] ?? 0) * SLOTS_PER_TURN + SLOTS_PER_TURN);
  const go = (left: number, smooth: boolean): void => {
    row.current?.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
  };
  // Whole tiles, keeping one in view from the screen before.
  const page = Math.max(1, shown - 1) * step;
  const aligned = Math.round(scrollLeft / step) * step;
  const end = at(lastSlot);

  return (
    <div className="schedule-strip" role="group" aria-label="Turns to come">
      <div className="schedule-strip-head">
        <span className="schedule-strip-title">
          <b>Upcoming:</b>
          <span className="schedule-strip-who">
            {name === null ? `our ${words}` : name}
            {name !== null && <span className="schedule-strip-wide">, {words}</span>}
          </span>
          <span className="schedule-strip-position">{position}</span>
        </span>
        {!fits && (
          <span className="schedule-strip-arrows">
            <StripArrow path="M9.5 2.5 4.5 6l5 3.5M2 2v8" label="Back to the next turn" off={atStart} onPress={() => go(0, false)} />
            <StripArrow path="M8 2 4 6l4 4" label="Earlier turns" step off={atStart} onPress={() => go(aligned - page, true)} />
            <StripArrow path="M4 2l4 4-4 4" label="Later turns" step off={atEnd} onPress={() => go(aligned + page, true)} />
            <StripArrow path="M2.5 2.5 7.5 6l-5 3.5M10 2v8" label="To the last turn this epoch" off={atEnd} onPress={() => go(width, false)} />
          </span>
        )}
      </div>
      <div className="schedule-strip-ruler">
        <span>now</span>
        <button
          type="button"
          ref={track}
          className="schedule-strip-track"
          aria-label="Go to a point in the epoch"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const slot = from + ((event.clientX - box.left) / box.width) * span;
            go(nearestTurn(turns, slot / SLOTS_PER_TURN) * step, false);
          }}
        >
          <svg viewBox={`0 0 ${Math.max(1, trackWidth)} 10`} preserveAspectRatio="none" aria-hidden="true">
            {paths.others && <path className="is-other" d={paths.others} />}
            <path d={paths.held} />
            <path className="is-next" d={`M${Math.round(place((turns[0] ?? 0) * SLOTS_PER_TURN)) + 1} 0V10`} />
          </svg>
          <span className="schedule-strip-view" style={{ left: viewLeft - 1, width: Math.max(4, viewRight - viewLeft + 2) }} />
        </button>
        <span>{end === null ? "" : aboutClock(end, now)}</span>
      </div>
      <div
        ref={row}
        className={`schedule-strip-row${!fits && !atEnd ? " has-more" : ""}`}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      >
        <div className="schedule-strip-tiles" style={{ width }}>
          {turns.slice(drawFrom, drawTo + 1).map((turn, offset) => {
            const index = drawFrom + offset;
            const start = turn * SLOTS_PER_TURN;
            const leading = index === 0 && producing !== null && producing >= start && producing < start + SLOTS_PER_TURN;
            const when = at(start);
            const gap = gapSlots(turn);
            const isLast = others.at(-1) === turn;
            return (
              <div key={turn} className={`schedule-strip-tile${index === 0 ? " is-next" : ""}`} style={{ left: index * step }}>
                <div className="schedule-strip-top">
                  {leading ? (
                    <>
                      <span className="schedule-strip-now">
                        <i />
                        Leading now
                      </span>
                      <span className="schedule-strip-count">
                        {(producing ?? start) - start + 1} of {SLOTS_PER_TURN}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="schedule-strip-when">{when === null ? "—" : aboutClock(when, now)}</span>
                      <span className="schedule-strip-count">{when === null ? "" : timeUntil(when, now)}</span>
                    </>
                  )}
                </div>
                <div className="schedule-strip-slot">{count(leading ? (producing ?? start) : start)}</div>
                <div className="schedule-strip-gap">
                  <span>{isLast ? "To epoch end" : "Next gap"}</span>
                  <b>{gap === null ? "—" : gapText(gap)}</b>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StripArrow({
  path,
  label,
  step,
  off,
  onPress,
}: {
  path: string;
  label: string;
  /** Phones swipe for these. */
  step?: boolean;
  off: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <button type="button" className={`schedule-strip-arrow${step ? " is-step" : ""}`} aria-label={label} title={label} disabled={off} onClick={onPress}>
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d={path} />
      </svg>
    </button>
  );
}
