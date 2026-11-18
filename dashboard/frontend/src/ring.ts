/** The last minutes of the feed, held in the browser for rewinding: a copy of the store every
 *  `SEGMENT_MS` and the messages since, some thinned. */

import { Store } from "./store";
import type { Envelope } from "./types";

/** How far back the page can go. */
export const RING_SPAN_MS = 15 * 60_000;

/** Characters of message text the entries may hold before the oldest segment goes. Keyframes are not
 *  counted, and the ring may run a segment over. */
const RING_BUDGET_CHARS = 24_000_000;

const SEGMENT_MS = 30_000;

/** Kept whole: they add up into lists, rings and offsets, or come once. */
const WHOLE = new Set([
  "slot.update",
  "slot.overview",
  "summary.tps_sample",
  "summary.network_sample",
  "summary.threads_sample",
  "summary.tps_history",
  "summary.network_history",
  "summary.threads_history",
  "summary.produced_block",
  "summary.slot_waterfall",
  "summary.slot_cost",
  "summary.produced_floor",
  "summary.produced_blocks",
  "summary.slot_waterfalls",
  "summary.slot_costs",
  "summary.produced_turns",
  "summary.server_time_nanos",
  "epoch.new",
]);

/** Kept once a second, so the strip's markers keep up with its bars. */
const EVERY_SECOND = new Set([
  "summary.completed_slot",
  "summary.root_slot",
  "summary.finalized_slot",
  "summary.optimistically_confirmed_slot",
  "summary.estimated_slot",
  "summary.block_height",
  "summary.vote_slot",
  "summary.behind_cluster",
  "summary.observed_slot_duration_nanos",
  "summary.handoff_now",
]);

/** Everything else is kept once in this long. */
const THINNED_MS = 10_000;

/** Milliseconds between kept copies of a key; 0 keeps every one. */
export function keptEvery(name: string): number {
  if (WHOLE.has(name)) return 0;
  return EVERY_SECOND.has(name) ? 1_000 : THINNED_MS;
}

interface Entry {
  at: number;
  envelope: Envelope;
}

interface Segment {
  start: number;
  /** The live store as it stood at `start`, before the first entry. */
  keyframe: Store;
  entries: Entry[];
  chars: number;
}

/** Where a view stands in the ring: the next entry of `segment` it has not applied. */
export interface Cursor {
  segment: Segment;
  next: number;
}

interface Held {
  envelope: Envelope;
  chars: number;
}

export class Ring {
  private segments: Segment[] = [];
  private chars = 0;
  /** When each thinned key was last kept. */
  private keptAt = new Map<string, number>();
  /** The newest copy of a thinned key not yet kept, written once its interval has passed so a key
   *  that then goes quiet is not left stale. */
  private held = new Map<string, Held>();

  constructor(
    private readonly spanMs = RING_SPAN_MS,
    private readonly budgetChars = RING_BUDGET_CHARS,
    private readonly segmentMs = SEGMENT_MS,
  ) {}

  /** Called before `live` applies the envelope, so a keyframe taken here precedes it. */
  record(envelope: Envelope, at: number, chars: number, live: Store): void {
    if (envelope.id !== undefined) return;
    const name = `${envelope.topic}.${envelope.key}`;
    // The arriving copy is newer than any held one.
    this.held.delete(name);
    let segment = this.segments[this.segments.length - 1];
    if (!segment || at - segment.start >= this.segmentMs) {
      const keyframe = new Store();
      keyframe.copyFrom(live);
      segment = { start: at, keyframe, entries: [], chars: 0 };
      this.segments.push(segment);
      // The keyframe already holds whatever was waiting.
      this.held.clear();
      this.evict(at);
    } else {
      this.writeDue(segment, at);
    }

    const every = keptEvery(name);
    if (every === 0) {
      this.push(segment, { at, envelope }, chars);
      return;
    }
    const kept = this.keptAt.get(name);
    if (kept === undefined || at - kept >= every) {
      this.push(segment, { at, envelope }, chars);
      this.keptAt.set(name, at);
      this.held.delete(name);
    } else {
      this.held.set(name, { envelope, chars });
    }
  }

  private writeDue(segment: Segment, at: number): void {
    for (const [name, held] of this.held) {
      if (at - (this.keptAt.get(name) ?? 0) < keptEvery(name)) continue;
      this.push(segment, { at, envelope: held.envelope }, held.chars);
      this.keptAt.set(name, at);
      this.held.delete(name);
    }
  }

  private push(segment: Segment, entry: Entry, chars: number): void {
    segment.entries.push(entry);
    segment.chars += chars;
    this.chars += chars;
  }

  /** Whole segments go, oldest first, past the span or the budget. */
  private evict(at: number): void {
    while (this.segments.length > 1) {
      const second = this.segments[1];
      const pastSpan = second !== undefined && second.start <= at - this.spanMs;
      if (!pastSpan && this.chars <= this.budgetChars) break;
      const gone = this.segments.shift();
      if (gone) this.chars -= gone.chars;
    }
  }

  /** The earliest moment held, or null before anything arrives. */
  start(): number | null {
    return this.segments[0]?.start ?? null;
  }

  /** The moment of the newest entry. */
  end(): number | null {
    const last = this.segments[this.segments.length - 1];
    if (!last) return null;
    return last.entries[last.entries.length - 1]?.at ?? last.start;
  }

  /** A cursor past everything recorded so far, for a view copied straight from the live store. */
  tail(): Cursor | null {
    const last = this.segments[this.segments.length - 1];
    return last ? { segment: last, next: last.entries.length } : null;
  }

  /** Fills `view` with the state at `at`, clamped to what is held. */
  stateAt(at: number, view: Store): Cursor | null {
    const first = this.segments[0];
    if (!first) return null;
    let index = 0;
    for (let i = this.segments.length - 1; i > 0; i -= 1) {
      const segment = this.segments[i];
      if (segment && segment.start <= at) {
        index = i;
        break;
      }
    }
    const segment = this.segments[index] ?? first;
    view.copyFrom(segment.keyframe);
    return this.advance({ segment, next: 0 }, at, view);
  }

  /** Applies to `view` everything after `cursor` up to `at`. */
  advance(cursor: Cursor, at: number, view: Store): Cursor {
    let index = this.segments.indexOf(cursor.segment);
    if (index === -1) return this.stateAt(at, view) ?? cursor;
    let { segment, next } = cursor;
    // A later segment starting by `at` is taken from its keyframe, which is exact and skips the entries
    // before it.
    for (let later = this.segments[index + 1]; later !== undefined && later.start <= at; later = this.segments[index + 1]) {
      segment = later;
      index += 1;
      next = 0;
    }
    if (segment !== cursor.segment) view.copyFrom(segment.keyframe);
    const entries = segment.entries;
    for (let entry = entries[next]; entry !== undefined && entry.at <= at; entry = entries[next]) {
      view.apply(entry.envelope, entry.at);
      next += 1;
    }
    return { segment, next };
  }

  /** When `slot` first arrived, or the first slot after it; null for a slot that arrived before the ring
   *  began or has not arrived. */
  slotArrival(slot: number): number | null {
    const first = this.segments[0];
    const before = first?.keyframe.getSlots().at(-1)?.slot;
    if (before !== undefined && slot <= before) return null;
    for (const segment of this.segments) {
      for (const entry of segment.entries) {
        const { topic, key, value } = entry.envelope;
        if (topic === "slot" && key === "update" && (value as { slot: number }).slot >= slot) return entry.at;
      }
    }
    return null;
  }

  heldChars(): number {
    return this.chars;
  }
}
