import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { count, shortKey, slotDelta } from "../format";
import { barHeight } from "../slotScale";
import type { SlotEntry, SlotLevel } from "../types";
import { useStore } from "../useStore";
import { Logo } from "./Logo";
import { Explain, PeakLine } from "./primitives";

/** Slots shown in the strip. Beyond this the bars are too thin to read. */
const STRIP_LENGTH = 64;

/**
 * What each bar colour means, in the order a slot passes through them.
 *
 * The names deliberately match the position readouts above the strip, so that
 * "Confirmed" in the header and a confirmed-coloured bar are recognisably the
 * same thing. Pending and Skipped have no position equivalent: a position is
 * one slot number, whereas these are states many slots can be in.
 */
const LEVELS: Array<[SlotLevel, string, string]> = [
  ["incomplete", "Pending", "Received but not yet replayed, or still arriving"],
  ["completed", "Processed", "Replayed and frozen by this validator"],
  ["optimistically_confirmed", "Confirmed", "Two thirds of stake has voted for it"],
  ["rooted", "Rooted", "This validator has rooted it"],
  ["finalized", "Finalized", "Rooted by a supermajority of stake"],
  ["skipped", "Skipped", "The leader produced no block, or it did not arrive in time"],
];

const LEVEL_NAMES = new Map<SlotLevel, string>(
  LEVELS.map(([level, label]) => [level, label]),
);

export function SlotStrip() {
  const store = useStore();
  const processed = store.get<number>("summary", "completed_slot");
  const observedSlotNanos = store.get<number | null>(
    "summary",
    "observed_slot_duration_nanos",
  );

  // The strip advances a whole bar every slot, so a pointer cannot stay on the
  // one it is aimed at. Entering the strip pins what is on screen; leaving
  // releases it and the view jumps forward to live.
  const [pinned, setPinned] = useState<SlotEntry[] | null>(null);
  // An index rather than the entry itself, so the pointer and the arrow keys
  // drive the same thing and only one of them can be in charge at a time.
  const [cursor, setCursor] = useState<number | null>(null);
  const live = store.getSlots().slice(-STRIP_LENGTH);
  const slots = pinned ?? live;
  const active = cursor === null ? null : (slots[cursor] ?? null);
  // Bars are drawn against what the cluster is configured for, so a nominal
  // slot lands at half height and anything at twice nominal fills the bar.
  const nominalMs =
    (store.get<number>("summary", "estimated_slot_duration_nanos") ?? 400_000_000) / 1e6;

  // Marked across the strip so the bars read as durations rather than as some
  // unlabelled quantity. Taken from the slots on screen, so it follows them.
  const peakMs = slots.reduce<number | null>((peak, entry) => {
    if (entry.duration_nanos === null) return peak;
    const ms = entry.duration_nanos / 1e6;
    return peak === null || ms > peak ? ms : peak;
  }, null);

  // Ordered from most settled to least, so the deltas read monotonically from
  // left to right. Deltas are relative to Processed, this validator's own tip.
  const positions: Array<[string, number | undefined, string]> = [
    [
      "Finalized",
      store.get<number>("summary", "finalized_slot"),
      "Highest root a supermajority of stake has also rooted",
    ],
    [
      "Root",
      store.get<number>("summary", "root_slot"),
      "Highest slot this validator has rooted. Rooting needs 32 slots built on top, so this sits about 32 behind",
    ],
    [
      "Confirmed",
      store.get<number>("summary", "optimistically_confirmed_slot"),
      "Highest slot two thirds of stake has voted for",
    ],
    [
      "Voted",
      store.get<number | null>("summary", "vote_slot") ?? undefined,
      "The slot this validator last voted on",
    ],
    ["Processed", processed, "Highest slot this validator has replayed and frozen"],
    [
      "Highest",
      store.get<number>("summary", "estimated_slot"),
      "Highest slot this validator holds a bank for, whether or not it has been replayed",
    ],
  ];

  const release = () => {
    setPinned(null);
    setCursor(null);
  };

  // The pointer leaving must not release a strip the keyboard is still holding,
  // which is what happens when a click both focuses the strip and moves the
  // pointer off it.
  const onMouseLeave = (event: MouseEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(document.activeElement)) return;
    release();
  };

  // One tab stop for the whole strip, with the arrows moving within it. Sixty
  // four focusable bars would be sixty four tab stops between the strip and
  // whatever follows it.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = slots.length - 1;
    if (last < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (cursor ?? last) - 1;
        break;
      case "ArrowRight":
        next = (cursor ?? last) + 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Escape":
        event.currentTarget.blur();
        return;
      default:
        return;
    }
    // Otherwise the arrows scroll the page out from under the strip.
    event.preventDefault();
    setCursor(Math.min(last, Math.max(0, next)));
  };

  return (
    <section className="card slot-strip">
      <div className="slot-strip-head">
        <h2 className="card-title">Slots</h2>
        {/* Shaped like a slot position rather than given a mark on the strip.
            The peak line describes the bars on screen, whereas a minute covers
            more slots than the strip holds, so drawn across them it would claim
            to be their level and would not be. */}
        <div className="slot-position slot-head-stat">
          <div className="slot-position-label">
            <Explain text="Mean time between slots arriving at this validator over the last minute. Slots come from every leader in turn, so this measures the cluster's rate as seen from here, not this validator's own block production. The minute covers more slots than the strip shows.">
              Slot time (1 min avg)
            </Explain>
          </div>
          <div className="slot-position-value">
            {observedSlotNanos === null || observedSlotNanos === undefined
              ? "—"
              : `${Math.round(observedSlotNanos / 1e6)} ms`}
          </div>
        </div>
        <div className="slot-positions">
          {positions.map(([label, slot, explanation]) => (
            <div className="slot-position" key={label}>
              <div className="slot-position-label">
                <Explain text={explanation}>{label}</Explain>
                <span className="slot-position-delta">{slotDelta(slot, processed)}</span>
              </div>
              <div className="slot-position-value">{count(slot)}</div>
            </div>
          ))}
        </div>
      </div>

      <div
        className="slot-bars"
        tabIndex={0}
        role="group"
        aria-label="Recent slots. Use the arrow keys to inspect them."
        onMouseEnter={() => setPinned(live)}
        onMouseLeave={onMouseLeave}
        onFocus={() => {
          setPinned((current) => current ?? live);
          // Only when nothing is chosen yet. A click focuses the strip as well
          // as hovering a bar, and the hovered bar is the one that was meant.
          setCursor((current) => current ?? slots.length - 1);
        }}
        onBlur={release}
        onKeyDown={onKeyDown}
      >
        {peakMs !== null && (
          <PeakLine
            fraction={barHeight(peakMs, nominalMs) / 100}
            label={`${Math.round(peakMs)} ms peak`}
          />
        )}
        {slots.map((entry, index) => (
          <SlotBar
            key={entry.slot}
            entry={entry}
            index={index}
            active={index === cursor}
            nominalMs={nominalMs}
            onPoint={setCursor}
          />
        ))}
      </div>

      <div className="slot-key">
        {LEVELS.map(([level, label, explanation]) => (
          <Explain className="slot-key-item" text={explanation} key={level}>
            <i className={`slot-key-swatch level-${level}`} />
            {label}
          </Explain>
        ))}
        <Explain className="slot-key-item" text="A slot this validator was scheduled to lead">
          <i className="slot-key-swatch slot-key-mine" />
          Ours
        </Explain>
        {pinned !== null && <SlotDetail entry={active} />}
      </div>
    </section>
  );
}

/**
 * The hovered slot, shown in a fixed place rather than in a tooltip.
 *
 * A tooltip over a bar is clipped at the ends of the strip, waits on the
 * browser's hover delay, and covers the very bars it describes. This appears
 * at once and always in the same spot.
 *
 * `role="status"` so that arrowing along the strip is announced. The bars
 * themselves are not focusable, so their labels would otherwise never be read.
 */
function SlotDetail({ entry }: { entry: SlotEntry | null }) {
  if (!entry) {
    return (
      <span className="slot-detail is-idle" role="status">
        paused · tap or arrow to a slot
      </span>
    );
  }
  const durationMs = entry.duration_nanos === null ? null : entry.duration_nanos / 1e6;
  const leader = entry.leader_name ?? (entry.leader ? shortKey(entry.leader, 4, 4) : null);
  return (
    <span className="slot-detail" role="status">
      <b>{count(entry.slot)}</b>
      <span>{LEVEL_NAMES.get(entry.level) ?? entry.level}</span>
      {durationMs !== null && <span>{Math.round(durationMs)} ms</span>}
      {leader && (
        <span className="slot-detail-leader">
          <Logo url={entry.leader_icon} size={12} />
          {leader}
        </span>
      )}
      {entry.transactions !== null && <span>{count(entry.transactions)} txns</span>}
      {entry.mine && <span className="slot-detail-mine">ours</span>}
    </span>
  );
}

function SlotBar({
  entry,
  index,
  active,
  nominalMs,
  onPoint,
}: {
  entry: SlotEntry;
  index: number;
  active: boolean;
  nominalMs: number;
  onPoint: (index: number) => void;
}) {
  // Height carries how long the slot took and colour carries consensus level.
  // The duration comes from when the blockstore first saw a shred for the
  // slot, so a slot with none yet — or one that was skipped, which never gets
  // any — shows as a stub.
  const durationMs = entry.duration_nanos === null ? null : entry.duration_nanos / 1e6;
  const height = barHeight(durationMs, nominalMs);
  // Named the same way the sidebar names them, so the two agree on who a slot
  // belonged to.
  const leader = entry.leader_name ?? (entry.leader ? shortKey(entry.leader, 4, 4) : null);
  const title = [
    `slot ${entry.slot}`,
    LEVEL_NAMES.get(entry.level) ?? entry.level,
    durationMs === null ? null : `${Math.round(durationMs)} ms`,
    leader,
    entry.transactions === null ? null : `${count(entry.transactions)} txns`,
    entry.mine ? "our leader slot" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // Labelled rather than titled: the detail row carries this visually, and a
    // native tooltip on top of it would only repeat itself over the bars.
    <div
      className={`slot-bar level-${entry.level}${entry.mine ? " mine" : ""}${
        active ? " is-active" : ""
      }`}
      aria-label={title}
      onMouseEnter={() => onPoint(index)}
    >
      <div className="slot-bar-fill" style={{ height: `${height}%` }} />
    </div>
  );
}
