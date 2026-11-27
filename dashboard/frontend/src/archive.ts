/** What the validator recorded to disk, for moments older than the page's own ring. A segment is
 *  fetched a block at a time and replayed into a `Ring` of its own, the same code the live feed
 *  goes through. Times here are this browser's: recorded ones move by the clock offset. */

import { Ring } from "./ring";
import { Store } from "./store";
import type { Envelope } from "./types";

/** As `rewind.range` lists it, in the validator's milliseconds. */
export interface RecordedSegment {
  start: number;
  end: number;
  blocks: number;
}

export interface RangeReply {
  enabled: boolean;
  segments?: [number, number, number][];
}

export interface BlockReply {
  keyframe: boolean;
  first: number;
  last: number;
  records: [number, Envelope][];
}

export interface ArchiveRequests {
  range: () => Promise<RangeReply | null>;
  read: (segment: number, block: number) => Promise<BlockReply | null>;
}

/** Recording pauses shorter than this are not drawn as gaps. */
const GAP_MS = 5_000;

/** Segments kept loaded: the one shown and the next. */
const KEPT = 2;

/** After a fetch fails on the connection, the wait before asking again. */
const RETRY_MS = 2_000;

/** What a fetch came to: a block replayed, the segment gone or ended, or the connection failing. */
type Fetched = "block" | "gone" | "failed";

interface Loaded {
  segment: RecordedSegment;
  ring: Ring;
  scratch: Store;
  /** The next block to fetch. */
  next: number;
  /** The newest moment replayed so far, in this browser's time; null before the first block. */
  until: number | null;
  offset: number;
  loading: Promise<Fetched> | null;
  usedAt: number;
}

export class Archive {
  private segments: RecordedSegment[] = [];
  private enabled = false;
  private loaded = new Map<number, Loaded>();
  private uses = 0;
  private retryAt = 0;
  private listeners = new Set<() => void>();

  constructor(
    private readonly requests: ArchiveRequests,
    /** How far this clock runs ahead of the validator's. */
    private readonly offset: () => number,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isEnabled(): boolean {
    return this.enabled && this.segments.length > 0;
  }

  async refresh(): Promise<void> {
    const reply = await this.requests.range().catch(() => null);
    if (!reply) return;
    this.enabled = reply.enabled;
    this.segments = (reply.segments ?? []).map(([start, end, blocks]) => ({ start, end, blocks }));
    for (const [start, held] of this.loaded) {
      const listed = this.segments.find((segment) => segment.start === start);
      if (listed) held.segment = listed;
      else this.loaded.delete(start);
    }
    this.notify();
  }

  /** The earliest recorded moment. */
  start(): number | null {
    const first = this.segments[0];
    return first ? first.start + this.offset() : null;
  }

  /** The newest recorded moment listed. */
  end(): number | null {
    const last = this.segments.at(-1);
    return last ? last.end + this.offset() : null;
  }

  /** Stretches with nothing recorded, oldest first. */
  gaps(): [number, number][] {
    const offset = this.offset();
    const gaps: [number, number][] = [];
    this.segments.forEach((segment, index) => {
      const next = this.segments[index + 1];
      if (next && next.start - segment.end > GAP_MS) gaps.push([segment.end + offset, next.start + offset]);
    });
    return gaps;
  }

  /** The segment holding `at`, or null in a gap or outside what is recorded. */
  segmentAt(at: number): RecordedSegment | null {
    const offset = this.offset();
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      const segment = this.segments[index];
      if (segment && segment.start + offset <= at && at <= segment.end + offset + GAP_MS) return segment;
    }
    return null;
  }

  /** `at`, or the next recorded moment when `at` falls in a gap. */
  snap(at: number): number {
    if (this.segmentAt(at)) return at;
    const offset = this.offset();
    const next = this.segments.find((segment) => segment.start + offset > at);
    return next ? next.start + offset : at;
  }

  /** The ring replaying `at`, once loaded that far. */
  ringAt(at: number): Ring | null {
    const segment = this.segmentAt(at);
    const held = segment ? this.loaded.get(segment.start) : undefined;
    if (!held || held.until === null) return null;
    // Past the last block fetched only once every block is, when its state holds to the end.
    if (at > held.until && held.next < held.segment.blocks) return null;
    this.uses += 1;
    held.usedAt = this.uses;
    return held.ring;
  }

  /** Loads the segment holding `at` through `at`; resolves true once `ringAt(at)` answers. */
  async ensure(at: number): Promise<boolean> {
    if (!this.canFetch()) return false;
    const segment = this.segmentAt(at);
    if (!segment) return false;
    const held = this.hold(segment);
    while (held.until === null || at > held.until) {
      if (held.next >= held.segment.blocks) break;
      held.loading ??= this.fetchNext(held).finally(() => {
        held.loading = null;
      });
      const fetched = await held.loading;
      if (fetched === "failed" || this.loaded.get(segment.start) !== held) return false;
      if (fetched === "gone") break;
    }
    return held.until !== null && (at <= held.until || held.next >= held.segment.blocks);
  }

  /** False for a moment after a fetch failed on the connection. */
  canFetch(): boolean {
    return Date.now() >= this.retryAt;
  }

  /** When `slot` first arrived, in the segments loaded. */
  slotArrival(slot: number): number | null {
    for (const held of this.loaded.values()) {
      const found = held.ring.slotArrival(slot);
      if (found !== null) return found;
    }
    return null;
  }

  isLoading(): boolean {
    for (const held of this.loaded.values()) if (held.loading) return true;
    return false;
  }

  private hold(segment: RecordedSegment): Loaded {
    const found = this.loaded.get(segment.start);
    this.uses += 1;
    if (found) {
      found.usedAt = this.uses;
      return found;
    }
    while (this.loaded.size >= KEPT) {
      let oldest: Loaded | null = null;
      for (const held of this.loaded.values()) if (!oldest || held.usedAt < oldest.usedAt) oldest = held;
      if (!oldest) break;
      this.loaded.delete(oldest.segment.start);
    }
    const held: Loaded = {
      segment,
      ring: new Ring(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
      scratch: new Store(),
      next: 0,
      until: null,
      offset: this.offset(),
      loading: null,
      usedAt: this.uses,
    };
    this.loaded.set(segment.start, held);
    return held;
  }

  private async fetchNext(held: Loaded): Promise<Fetched> {
    let reply: BlockReply | null;
    try {
      reply = await this.requests.read(held.segment.start, held.next);
    } catch {
      // The connection, not the recording: the same block is asked for again later.
      this.retryAt = Date.now() + RETRY_MS;
      return "failed";
    }
    if (!reply) {
      if (held.next === 0) {
        // Deleted as it aged out: dropped until the next range says otherwise.
        this.segments = this.segments.filter((segment) => segment.start !== held.segment.start);
        this.loaded.delete(held.segment.start);
      } else {
        // Ends where it was cut off; nothing further is fetched for it.
        held.next = held.segment.blocks;
      }
      this.notify();
      return "gone";
    }
    for (const [at, envelope] of reply.records) {
      const moment = at + held.offset;
      held.ring.record(envelope, moment, 0, held.scratch);
      held.scratch.apply(envelope, moment);
    }
    held.next += 1;
    held.until = reply.last + held.offset;
    this.notify();
    return "block";
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
