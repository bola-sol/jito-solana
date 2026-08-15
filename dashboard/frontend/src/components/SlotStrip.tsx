import { useState } from "react";
import { count, shortKey, slotDelta } from "../format";
import type { SlotEntry, SlotLevel } from "../types";
import { useStore } from "../useStore";
import { Logo } from "./Logo";

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

  // The strip advances a whole bar every slot, so a pointer cannot stay on the
  // one it is aimed at. Entering the strip pins what is on screen; leaving
  // releases it and the view jumps forward to live.
  const [pinned, setPinned] = useState<SlotEntry[] | null>(null);
  const [hovered, setHovered] = useState<SlotEntry | null>(null);
  const live = store.getSlots().slice(-STRIP_LENGTH);
  const slots = pinned ?? live;
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

  return (
    <section className="card slot-strip">
      <div className="slot-strip-head">
        <h2 className="card-title">Slots</h2>
        <div className="slot-positions">
          {positions.map(([label, slot, explanation]) => (
            <div className="slot-position" key={label} title={explanation}>
              <div className="slot-position-label">
                {label}
                <span className="slot-position-delta">{slotDelta(slot, processed)}</span>
              </div>
              <div className="slot-position-value">{count(slot)}</div>
            </div>
          ))}
        </div>
      </div>

      <div
        className="slot-bars"
        onMouseEnter={() => setPinned(live)}
        onMouseLeave={() => {
          setPinned(null);
          setHovered(null);
        }}
      >
        {peakMs !== null && (
          <div
            className={`slot-bars-peak${barHeight(peakMs, nominalMs) > 88 ? " label-below" : ""}`}
            style={{ bottom: `${barHeight(peakMs, nominalMs)}%` }}
          >
            <span>{Math.round(peakMs)} ms peak</span>
          </div>
        )}
        {slots.map((entry) => (
          <SlotBar
            key={entry.slot}
            entry={entry}
            nominalMs={nominalMs}
            onHover={setHovered}
          />
        ))}
      </div>

      <div className="slot-key">
        {LEVELS.map(([level, label, explanation]) => (
          <span className="slot-key-item" key={level} title={explanation}>
            <i className={`slot-key-swatch level-${level}`} />
            {label}
          </span>
        ))}
        <span className="slot-key-item" title="A slot this validator was scheduled to lead">
          <i className="slot-key-swatch slot-key-mine" />
          Ours
        </span>
        {pinned !== null && <SlotDetail entry={hovered} />}
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
 */
function SlotDetail({ entry }: { entry: SlotEntry | null }) {
  if (!entry) {
    return <span className="slot-detail is-idle">paused · hover a slot</span>;
  }
  const durationMs = entry.duration_nanos === null ? null : entry.duration_nanos / 1e6;
  const leader = entry.leader_name ?? (entry.leader ? shortKey(entry.leader, 4, 4) : null);
  return (
    <span className="slot-detail">
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

/**
 * Bar height for a slot duration, as a percentage.
 *
 * Scaled by ratio to nominal rather than linearly: a nominal slot sits at half
 * height, each doubling adds a quarter, each halving takes one away. A linear
 * scale saturated at twice nominal, which made a one-slot gap and a three-slot
 * gap the same bar.
 */
function barHeight(durationMs: number | null, nominalMs: number): number {
  if (durationMs === null || durationMs <= 0) return 6;
  return Math.max(8, Math.min(100, 50 + 25 * Math.log2(durationMs / nominalMs)));
}

function SlotBar({
  entry,
  nominalMs,
  onHover,
}: {
  entry: SlotEntry;
  nominalMs: number;
  onHover: (entry: SlotEntry) => void;
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
      className={`slot-bar level-${entry.level}${entry.mine ? " mine" : ""}`}
      aria-label={title}
      onMouseEnter={() => onHover(entry)}
    >
      <div className="slot-bar-fill" style={{ height: `${height}%` }} />
    </div>
  );
}
