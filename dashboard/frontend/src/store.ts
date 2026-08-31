/**
 * Holds everything the websocket has told us, and notifies React when it
 * changes.
 *
 * Updates arrive far faster than a person can read, so notifications are
 * coalesced to one per animation frame. Without that, a busy validator would
 * re-render the tree several hundred times a second to no visible effect.
 */

import { leaderAt, NO_LEADER, type LeaderRef } from "./schedule";
import type { EpochInfo, Envelope, NetworkSample, Peer, SlotEntry, TpsSample } from "./types";

/** Slots kept for the strip and sidebar. Matches the server's overview length. */
const MAX_SLOTS = 512;

/**
 * This validator's own leader slots kept beyond that window.
 *
 * A validator leads about four slots in every eight hundred, so five hundred
 * slots of history usually contains none of its own. Kept separately, the
 * sidebar's own-slots view has something to show; pruned with everything else
 * it would be empty almost all the time.
 *
 * Five hundred of them, which at that share is about eleven hours of cluster
 * history. Matches `OWN_SLOTS_KEPT` on the server, so a reload restores what
 * was on screen rather than some other depth; the two are one figure split
 * across the wire and only agree by being kept the same.
 */
const MAX_OWN_SLOTS = 500;

/** TPS samples kept for the chart. */
const MAX_TPS_SAMPLES = 300;

export type ConnectionState = "connecting" | "open" | "closed";

/**
 * A request sent to the validator and not yet answered.
 *
 * The server answers everything it can parse as a request, including keys it
 * does not recognise, so an entry that is never settled means the connection
 * went away rather than the request being ignored.
 */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class Store {
  /** Latest value for each `topic.key`, exactly as published. */
  private values = new Map<string, unknown>();
  private slots = new Map<number, SlotEntry>();
  private tps: TpsSample[] = [];
  private network: NetworkSample[] = [];
  private connection: ConnectionState = "connecting";
  private sender: ((frame: string) => void) | null = null;
  private pending = new Map<number, Pending>();
  private nextRequestId = 1;
  /** The peer list the index below was built from, to know when it is stale. */
  private peers: Peer[] | null = null;
  private peerIndex = new Map<string, Peer>();
  /**
   * Resolved leaders by slot, so that repeated lookups return the same object.
   *
   * Not for speed. The rows that show a leader are memoised on their props, and
   * a freshly built object every render would defeat that and rebuild the whole
   * list on every meter sample. Cleared whenever the epoch or the peer table
   * changes, which is the only way an answer here can change.
   */
  private leaderCache = new Map<number, LeaderRef>();

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
    if (state !== "open") {
      // A reply can only come back on the socket that carried the request, so
      // losing one ends every request in flight. Left pending they would be
      // promises that never settle, and a caller waiting on one shows a
      // loading state that never resolves.
      this.sender = null;
      const inflight = [...this.pending.values()];
      this.pending.clear();
      for (const pending of inflight) pending.reject(new Error("connection lost"));
    }
    this.touch();
  }

  /**
   * How to write to the current socket, installed by `connect` when one opens.
   *
   * Held rather than reached for, because the store is what callers have and
   * the socket is replaced on every reconnect.
   */
  setSender(sender: (frame: string) => void): void {
    this.sender = sender;
  }

  /**
   * Asks the validator for something, rather than waiting for it to be pushed.
   *
   * For data too large to send to every client on connect and too rarely read
   * to send at all: a span of slot history is the first of it. Rejects rather
   * than queues when there is no connection, since a request made now and
   * answered after the next reconnect would arrive against a page that has
   * moved on.
   */
  request<T>(topic: string, key: string, params: unknown): Promise<T> {
    const sender = this.sender;
    if (sender === null) return Promise.reject(new Error("not connected"));

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        sender(JSON.stringify({ topic, key, id, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Who leads a slot, and what to call them.
   *
   * The one place that knows how a leader is put back together, because it is
   * no longer in one place on the wire: the key comes from the epoch's turn
   * array and the name and icon from the peer table. A slot carries neither.
   *
   * The peer table covers the leaders of the window a client holds and the ones
   * about to lead, so a live turn is named before it is drawn. A turn from
   * further back than that, or from an epoch whose schedule the page does not
   * have, resolves to a key with no name or to nothing at all, and the callers
   * fall back in that order.
   */
  leaderOf(slot: number): LeaderRef {
    const cached = this.leaderCache.get(slot);
    if (cached) return cached;

    const key = leaderAt(this.values.get("epoch.new") as EpochInfo | undefined, slot);
    const peer = key === null ? undefined : this.peersByIdentity().get(key);
    const leader: LeaderRef =
      key === null ? NO_LEADER : { key, name: peer?.name ?? null, icon: peer?.icon ?? null };
    this.leaderCache.set(slot, leader);
    return leader;
  }

  /**
   * The peer table by identity, rebuilt only when the table itself changes.
   *
   * Compared by reference: the store replaces the whole array when a new one is
   * published and never mutates it, so a different array is a different table.
   */
  private peersByIdentity(): Map<string, Peer> {
    const peers = (this.values.get("peers.all") as Peer[] | undefined) ?? [];
    if (this.peers !== peers) {
      this.peers = peers;
      this.peerIndex = new Map(peers.map((peer) => [peer.identity, peer]));
    }
    return this.peerIndex;
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

    // Replies to our own requests carry an id and are not state. An id we are
    // not waiting on is dropped: a reply that outlived its caller is the
    // ordinary result of a reconnect, not something to act on.
    if (envelope.id !== undefined) {
      const pending = this.pending.get(envelope.id);
      if (pending) {
        this.pending.delete(envelope.id);
        pending.resolve(value);
      }
      return;
    }

    if (topic === "slot" && key === "overview") {
      this.slots.clear();
      for (const entry of value as SlotEntry[]) this.slots.set(entry.slot, entry);
      this.trimSlots();
    } else if (topic === "slot" && key === "own") {
      // Merged, not cleared. This is the second half of the connect snapshot:
      // our own leader slots from before the recent window, sent separately
      // because the two together pass the frame ceiling. The server's retained
      // map is ordered by key, so "overview" always lands first and has done
      // the clearing by the time this arrives.
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
      // The two things a resolved leader is made of. Either changing makes
      // every answer already given potentially wrong.
      if (topic === "epoch" || topic === "peers") this.leaderCache.clear();
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
