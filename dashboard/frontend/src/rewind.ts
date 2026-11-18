/** Live or past: the live store always applies the feed and the ring records it; the page reads the
 *  past view while paused, rewound or playing. */

import { Ring, type Cursor } from "./ring";
import { Store } from "./store";
import type { Envelope } from "./types";

export const SPEEDS = [0.25, 0.5, 1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];

/** Playback this close to now drops back to live. */
const CATCH_UP_MS = 1_000;

const PLAY_TICK_MS = 50;

export interface RewindState {
  live: boolean;
  playing: boolean;
  speed: Speed;
  /** True until the first move after pausing, while the view still shows the moment of the pause. */
  justPaused: boolean;
}

export class Rewind {
  readonly live = new Store();
  readonly view = new Store();
  readonly ring: Ring;
  private state: RewindState = { live: true, playing: false, speed: 1, justPaused: false };
  /** The moment shown when not playing, and where playing started from. */
  private position = 0;
  /** `performance.now()` when playing started or last changed speed. */
  private playedAt = 0;
  private cursor: Cursor | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by a settled move backwards, for pages that gather rows as time moves forward. */
  private generation = 0;
  private movedBack = false;
  private listeners = new Set<() => void>();

  constructor(ring = new Ring()) {
    this.ring = ring;
    this.view.follow(this.live, this.at);
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
  }

  /** Shows `at`, clamped to what the ring holds and to now. */
  seek(at: number): void {
    const start = this.ring.start();
    const end = Date.now();
    const target = Math.min(end, Math.max(start ?? end, at));
    const from = this.state.live ? end : this.at();
    if (this.state.live) this.pause();
    if (target < from) this.movedBack = true;
    this.moveTo(target);
    if (this.state.playing) this.playedAt = performance.now();
    this.set({ justPaused: false });
  }

  /** A move is finished, as when the slider is let go. */
  settle(): void {
    if (!this.movedBack) return;
    this.movedBack = false;
    this.generation += 1;
    this.notify();
  }

  play(): void {
    if (this.state.live || this.state.playing) return;
    const start = this.ring.start();
    // A view left before what is still held starts from the earliest moment there is.
    if (start !== null && this.position < start) {
      this.movedBack = false;
      this.moveTo(start);
    }
    this.playedAt = performance.now();
    this.timer = setInterval(this.tick, PLAY_TICK_MS);
    this.set({ playing: true, justPaused: false });
  }

  stop(): void {
    if (!this.state.playing) return;
    this.position = this.at();
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
    this.movedBack = false;
    this.set({ live: true, playing: false, justPaused: false });
  }

  private tick = (): void => {
    let at = this.at();
    if (at >= Date.now() - CATCH_UP_MS) {
      this.goLive();
      return;
    }
    // Playback the ring has dropped from carries on from the earliest moment still held.
    const start = this.ring.start();
    if (start !== null && at < start) {
      this.position = start;
      this.playedAt = performance.now();
      at = start;
    }
    this.cursor = this.cursor ? this.ring.advance(this.cursor, at, this.view) : this.ring.stateAt(at, this.view);
  };

  private moveTo(target: number): void {
    const forward = this.cursor !== null && target >= this.at();
    this.cursor = forward && this.cursor
      ? this.ring.advance(this.cursor, target, this.view)
      : this.ring.stateAt(target, this.view);
    this.position = target;
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

/** A slot number, or a time of day today in this browser's zone; null where neither reads. */
export function readMoment(text: string, now: number, slotArrival: (slot: number) => number | null): number | null {
  const trimmed = text.trim();
  if (/^\d{5,}$/.test(trimmed)) return slotArrival(Number(trimmed));
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!clock) return null;
  const [hours, minutes, seconds] = [clock[1], clock[2], clock[3]].map((part) => Number(part ?? 0));
  if (hours === undefined || minutes === undefined || seconds === undefined) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, seconds, 0);
  // A time later than now is yesterday's.
  return at.getTime() > now ? at.getTime() - 86_400_000 : at.getTime();
}
