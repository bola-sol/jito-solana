/** Live or past: the live store always applies the feed and the ring records it; the page reads the
 *  past view while paused, rewound or playing. */

import { Archive, type ArchiveRequests } from "./archive";
import { Ring, type Cursor } from "./ring";
import { Store } from "./store";
import type { Envelope } from "./types";

export const SPEEDS = [0.25, 0.5, 1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/** Playback this close to now drops back to live. */
const CATCH_UP_MS = 1_000;

const PLAY_TICK_MS = 50;

/** How often the recorded range is asked for again while the page is not live. */
const RANGE_EVERY_MS = 30_000;

/** A paused fetch that failed on the connection is asked again after this. */
const RETRY_AFTER_MS = 2_100;

/** Playback loads what it will show this far ahead, at one times. */
const LOOKAHEAD_MS = 15_000;

export interface RewindState {
  live: boolean;
  playing: boolean;
  speed: Speed;
  /** True until the first move after pausing, while the view still shows the moment of the pause. */
  justPaused: boolean;
  /** A recorded segment is being fetched for the moment shown. */
  loading: boolean;
}

export class Rewind {
  readonly live = new Store();
  readonly view = new Store();
  readonly ring: Ring;
  readonly archive: Archive;
  private state: RewindState = { live: true, playing: false, speed: 1, justPaused: false, loading: false };
  /** The moment shown when not playing, and where playing started from. */
  private position = 0;
  /** `performance.now()` when playing started or last changed speed. */
  private playedAt = 0;
  private cursor: Cursor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by a settled move backwards, for pages that gather rows as time moves forward. */
  private generation = 0;
  private movedBack = false;
  /** The view waits on a recorded segment for the moment shown. */
  private wanted = false;
  /** A settled move back is still waiting on its segment; the generation moves once it shows. */
  private bumpOnShow = false;
  /** Where the clock stands still while playback waits on a segment. */
  private heldAt = 0;
  /** Stops a load finishing late from moving a view that has moved on. */
  private loadToken = 0;
  private rangeTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();

  constructor(ring = new Ring(), requests?: ArchiveRequests) {
    this.ring = ring;
    this.view.follow(this.live, this.at);
    this.archive = new Archive(
      requests ?? {
        range: () => this.live.request("rewind.range", {}),
        read: (segment, block) => this.live.request("rewind.read", { segment, block }),
      },
      () => this.live.getClockOffset() ?? 0,
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): RewindState => this.state;

  getGeneration = (): number => this.generation;

  /** The moment the view shows. */
  at = (): number => {
    if (!this.state.playing) return this.position;
    return this.position + (performance.now() - this.playedAt) * this.state.speed;
  };

  /** Every frame of the feed, recorded before the live store applies it. */
  deliver(envelope: Envelope, chars: number): void {
    const at = Date.now();
    this.ring.record(envelope, at, chars, this.live);
    this.live.apply(envelope, at);
  }

  pause(): void {
    if (!this.state.live) {
      this.stop();
      return;
    }
    this.view.copyFrom(this.live);
    this.cursor = this.ring.tail();
    this.position = Date.now();
    this.set({ live: false, playing: false, justPaused: true });
    void this.archive.refresh();
    this.rangeTimer ??= setInterval(() => void this.archive.refresh(), RANGE_EVERY_MS);
  }

  /** The earliest moment the page can show: recorded on the validator, or held here. */
  earliest(): number | null {
    const held = this.ring.start();
    const recorded = this.archive.isEnabled() ? this.archive.start() : null;
    if (recorded === null) return held;
    return held === null ? recorded : Math.min(held, recorded);
  }

  /** When `slot` first arrived, from what is held here or loaded from the recording. */
  slotArrival(slot: number): number | null {
    return this.ring.slotArrival(slot) ?? this.archive.slotArrival(slot);
  }

  /** Shows `at`, clamped to what is held or recorded and to now; a gap snaps to what follows it. */
  seek(at: number): void {
    const end = Date.now();
    const target = this.reachable(Math.min(end, Math.max(this.earliest() ?? end, at)));
    const from = this.state.live ? end : this.at();
    if (this.state.live) this.pause();
    if (target < from) this.movedBack = true;
    this.moveTo(target);
    if (this.state.playing) this.playedAt = performance.now();
    // A load still running for where the view was no longer matters.
    if (!this.wanted && this.state.loading) this.loadToken += 1;
    this.set({ justPaused: false, loading: this.wanted ? this.state.loading : false });
  }

  /** A move is finished, as when the slider is let go; a recorded segment it needs is fetched now. */
  settle(): void {
    const waiting = this.wanted;
    if (waiting) void this.load();
    if (!this.movedBack) return;
    this.movedBack = false;
    if (waiting) {
      this.bumpOnShow = true;
      return;
    }
    this.generation += 1;
    this.notify();
  }

  play(): void {
    if (this.state.live || this.state.playing) return;
    const start = this.earliest();
    // A view left before what is still held starts from the earliest moment there is.
    if (start !== null && this.position < start) {
      this.movedBack = false;
      this.moveTo(this.reachable(start));
    }
    this.playedAt = performance.now();
    this.timer = setInterval(this.tick, PLAY_TICK_MS);
    this.set({ playing: true, justPaused: false });
  }

  stop(): void {
    if (!this.state.playing) return;
    this.position = this.at();
    this.heldAt = this.position;
    this.clearTimer();
    this.set({ playing: false });
  }

  setSpeed(speed: Speed): void {
    if (this.state.playing) {
      this.position = this.at();
      this.playedAt = performance.now();
    }
    this.set({ speed });
  }

  goLive(): void {
    this.clearTimer();
    if (this.rangeTimer !== null) clearInterval(this.rangeTimer);
    this.rangeTimer = null;
    this.movedBack = false;
    this.wanted = false;
    this.bumpOnShow = false;
    this.loadToken += 1;
    this.set({ live: true, playing: false, justPaused: false, loading: false });
  }

  private tick = (): void => {
    let at = this.at();
    if (at >= Date.now() - CATCH_UP_MS) {
      this.goLive();
      return;
    }
    const start = this.ring.start();
    if (start !== null && at < start && this.archive.isEnabled()) {
      // Over a gap in the recording, playback goes on from what follows it.
      const reachable = this.reachable(at);
      if (reachable !== at) {
        this.position = reachable;
        this.playedAt = performance.now();
        at = reachable;
      }
    }
    const source = this.sourceFor(at);
    if (source === null) {
      // The clock holds where it last stood while the segment it needs is fetched.
      this.position = this.heldAt;
      this.playedAt = performance.now();
      if (!this.archive.isLoading() && this.archive.canFetch()) void this.load(at);
      return;
    }
    if (source === this.ring && start !== null && at < start) {
      // Playback the ring has dropped from carries on from the earliest moment still held.
      this.position = start;
      this.playedAt = performance.now();
      at = start;
    }
    if (source !== this.ring && !this.archive.isLoading()) {
      // Only what the recording will show; the page's own ring needs nothing fetched.
      const ahead = this.reachable(at + LOOKAHEAD_MS * this.state.speed);
      if (start === null || ahead < start) void this.archive.ensure(ahead);
    }
    this.cursor = this.cursor ? source.advance(this.cursor, at, this.view) : source.stateAt(at, this.view);
    this.heldAt = at;
    this.shown();
  };

  /** The view now shows the position; a move back that waited on a fetch counts from here. */
  private shown(): void {
    if (!this.bumpOnShow) return;
    this.bumpOnShow = false;
    this.generation += 1;
    this.notify();
  }

  /** The ring that can show `at`: the page's own from its start, otherwise a loaded recorded segment,
   *  or null while that is still to be fetched. Without a recording the page's own ring clamps. */
  private sourceFor(at: number): Ring | null {
    const start = this.ring.start();
    if (start !== null && at >= start) return this.ring;
    if (!this.archive.isEnabled()) return this.ring;
    return this.archive.ringAt(at) ?? (this.archive.segmentAt(at) ? null : this.ring);
  }

  /** `at` if something can show it, else the next moment that can: over a gap in the recording, or
   *  the stretch between the recording's newest block and the page's own ring. */
  private reachable(at: number): number {
    const start = this.ring.start();
    if (start === null || at >= start || !this.archive.isEnabled()) return at;
    const snapped = this.archive.snap(at);
    return this.archive.segmentAt(snapped) ? Math.min(snapped, start) : start;
  }

  private moveTo(target: number): void {
    const forward = this.cursor !== null && target >= this.at();
    const source = this.sourceFor(target);
    this.position = target;
    this.heldAt = target;
    if (source === null) {
      // The view still shows where it was, so the next move rebuilds rather than advances it.
      this.wanted = true;
      this.cursor = null;
      return;
    }
    this.wanted = false;
    this.cursor = forward && this.cursor
      ? source.advance(this.cursor, target, this.view)
      : source.stateAt(target, this.view);
    this.shown();
  }

  /** Fetches the recorded segment for the moment shown, then shows it if nothing moved meanwhile. */
  private async load(target = this.position): Promise<void> {
    this.wanted = false;
    this.loadToken += 1;
    const token = this.loadToken;
    this.set({ loading: true });
    const ok = await this.archive.ensure(target);
    if (token !== this.loadToken) return;
    this.set({ loading: false });
    if (this.state.live || this.state.playing) return;
    if (ok) {
      this.moveTo(this.position);
      return;
    }
    if (!this.archive.canFetch()) {
      // Failed on the connection: asked again once the archive allows, unless the view has moved on.
      this.wanted = true;
      setTimeout(() => {
        if (token === this.loadToken && this.wanted && !this.state.live) void this.load();
      }, RETRY_AFTER_MS);
      return;
    }
    // A segment deleted as it aged out moves the view on to the next moment recorded.
    const next = this.reachable(this.position);
    if (next === this.position) return;
    this.moveTo(next);
    if (this.wanted) void this.load();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private set(change: Partial<RewindState>): void {
    this.state = { ...this.state, ...change };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** A slot number, a time of day, or a date and time, in this browser's zone; null where none reads.
 *  A time of day later than now is yesterday's. */
export function readMoment(text: string, now: number, slotArrival: (slot: number) => number | null): number | null {
  const trimmed = text.trim();
  if (/^\d{5,}$/.test(trimmed)) return slotArrival(Number(trimmed));
  const moment = /^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!moment) return null;
  const [year, month, day, hours, minutes, seconds] = [1, 2, 3, 4, 5, 6].map((index) => {
    const part = moment[index];
    return part === undefined ? null : Number(part);
  });
  if (hours === null || minutes === null || hours === undefined || minutes === undefined) return null;
  const second = seconds ?? 0;
  if (hours > 23 || minutes > 59 || second > 59) return null;
  const at = new Date(now);
  if (year !== null && year !== undefined && month !== null && month !== undefined && day !== null && day !== undefined) {
    at.setFullYear(year, month - 1, day);
    // A day the month does not have rolls over; refuse it rather than land elsewhere.
    if (at.getDate() !== day || at.getMonth() !== month - 1) return null;
    at.setHours(hours, minutes, second, 0);
    return at.getTime();
  }
  at.setHours(hours, minutes, second, 0);
  return at.getTime() > now ? at.getTime() - 86_400_000 : at.getTime();
}
