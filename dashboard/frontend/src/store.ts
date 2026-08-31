/**
 * Holds everything the websocket has told us, and notifies React when it
 * changes.
 *
 * Updates arrive far faster than a person can read, so notifications are
 * coalesced to one per animation frame. Without that, a busy validator would
 * re-render the tree several hundred times a second to no visible effect.
 */

import type { Envelope, NetworkSample, SlotEntry, TpsSample } from "./types";

/** Slots kept for the strip and sidebar. Matches the server's overview length. */
const MAX_SLOTS = 512;

/**
 * This validator's own leader slots kept beyond that window.
 *
 * A validator leads about four slots in every eight hundred, so five hundred
 * slots of history usually contains none of its own. Kept separately, the
 * sidebar's own-slots view has something to show; pruned with everything else
 * it would be empty almost all the time.
 */
const MAX_OWN_SLOTS = 64;

/** TPS samples kept for the chart. */
const MAX_TPS_SAMPLES = 300;

export type ConnectionState = "connecting" | "open" | "closed";

export class Store {
  /** Latest value for each `topic.key`, exactly as published. */
  private values = new Map<string, unknown>();
  private slots = new Map<number, SlotEntry>();
  private tps: TpsSample[] = [];
  private network: NetworkSample[] = [];
  private connection: ConnectionState = "connecting";

  private listeners = new Set<() => void>();
  private frame: number | null = null;
  /** Bumped on every change so `useSyncExternalStore` sees a new snapshot. */
  private revision = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRevision = (): number => this.revision;

  get<T>(topic: string, key: string): T | undefined {
    return this.values.get(`${topic}.${key}`) as T | undefined;
  }

  getConnection(): ConnectionState {
    return this.connection;
  }

  /**
   * True once enough has arrived for the dashboard to be worth looking at.
   * The identity comes from the static publish on connect and the slots from
   * the retained overview, so both land in the first burst of messages.
   */
  isReady(): boolean {
    // A validator that is still booting has no slots and no identity to report,
    // but the boot sequence is exactly what should be on screen then, so the
    // splash has nothing left to wait for.
    const startup = this.values.get("summary.startup_progress") as
      | { running: boolean }
      | undefined;
    if (startup && !startup.running) return true;

    return this.values.has("summary.identity_key") && this.slots.size > 0;
  }

  setConnection(state: ConnectionState): void {
    this.connection = state;
    this.touch();
  }

  /** Slots in ascending order. */
  getSlots(): SlotEntry[] {
    return [...this.slots.values()].sort((a, b) => a.slot - b.slot);
  }

  getSlot(slot: number): SlotEntry | undefined {
    return this.slots.get(slot);
  }

  getTps(): TpsSample[] {
    return this.tps;
  }

  getNetwork(): NetworkSample[] {
    return this.network;
  }

  apply(envelope: Envelope): void {
    const { topic, key, value } = envelope;

    // Replies to our own requests carry an id and are not state.
    if (envelope.id !== undefined) return;

    if (topic === "slot" && key === "overview") {
      this.slots.clear();
      for (const entry of value as SlotEntry[]) this.slots.set(entry.slot, entry);
      this.trimSlots();
    } else if (topic === "slot" && key === "update") {
      const entry = value as SlotEntry;
      this.slots.set(entry.slot, entry);
      this.trimSlots();
    } else if (topic === "summary" && key === "network_history") {
      this.network = (value as NetworkSample[]).slice(-MAX_TPS_SAMPLES);
    } else if (topic === "summary" && key === "network_sample") {
      const sample = value as NetworkSample;
      const last = this.network[this.network.length - 1];
      if (!last || sample.timestamp_nanos > last.timestamp_nanos) {
        this.network = [...this.network, sample].slice(-MAX_TPS_SAMPLES);
      }
    } else if (topic === "summary" && key === "tps_history") {
      this.tps = (value as TpsSample[]).slice(-MAX_TPS_SAMPLES);
    } else if (topic === "summary" && key === "tps_sample") {
      const sample = value as TpsSample;
      // The retained history and the live samples overlap by design, so keep
      // the series strictly increasing instead of trusting arrival order.
      if (this.tps.length === 0 || sample.slot > this.tps[this.tps.length - 1].slot) {
        this.tps = [...this.tps, sample].slice(-MAX_TPS_SAMPLES);
      }
    } else {
      this.values.set(`${topic}.${key}`, value);
    }

    this.touch();
  }

  private trimSlots(): void {
    if (this.slots.size <= MAX_SLOTS) return;
    const ordered = [...this.slots.values()].sort((a, b) => a.slot - b.slot);
    // Split rather than walked oldest-first, because our own slots are kept to
    // a separate depth. Walking one list and skipping ours would have deleted
    // newer slots to make room for the ones it skipped.
    const own = ordered.filter((entry) => entry.mine).slice(-MAX_OWN_SLOTS);
    const rest = ordered.filter((entry) => !entry.mine).slice(-MAX_SLOTS);
    this.slots = new Map([...rest, ...own].map((entry) => [entry.slot, entry]));
  }

  private touch(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.revision += 1;
      for (const listener of this.listeners) listener();
    });
  }
}
