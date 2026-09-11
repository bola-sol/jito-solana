/** Everything the websocket has told us. Notifications are coalesced to one
 *  per animation frame. */

import { leaderAt, NO_LEADER, type LeaderRef } from "./schedule";
import type {
  Displays,
  EpochInfo,
  Envelope,
  NetworkSample,
  Peer,
  SlotEntry,
  ThreadsSample,
  TpsSample,
} from "./types";

/** Slots kept for the strip and sidebar. Matches the server's overview length. */
const MAX_SLOTS = 512;

/** This validator's own leader slots kept beyond that window, for the
 *  sidebar rail. Matches `OWN_SLOTS_KEPT` on the server. */
const MAX_OWN_SLOTS = 64;

/** TPS samples kept for the chart. */
const MAX_TPS_SAMPLES = 300;

/** Thread samples kept: the minute the host card draws. */
const MAX_THREAD_SAMPLES = 60;

export type ConnectionState = "connecting" | "open" | "closed";

/** A request sent to the validator and not yet answered. The server answers
 *  every request, so one never settled means the connection went away. */
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
  private threads: ThreadsSample[] = [];
  private connection: ConnectionState = "connecting";
  private sender: ((frame: string) => void) | null = null;
  private pending = new Map<number, Pending>();
  private nextRequestId = 1;
  /** The peer list the index below was built from, to know when it is stale. */
  private peers: Peer[] | null = null;
  private peerIndex = new Map<string, Peer>();
  /** Resolved leaders by slot, so lookups return the same object and the
   *  memoised rows hold. Cleared when the epoch or peer table changes. */
  private leaderCache = new Map<number, LeaderRef>();
  /** Us, rebuilt only when one of the three values it is made of changes. */
  private ours: LeaderRef = NO_LEADER;
  private oursFrom = "";
  /** Names and icons for the whole cluster, empty until `loadDisplays`. */
  private displays = new Map<string, { name: string | null; icon: string | null }>();
  /** Epochs other than the current one, fetched on demand. `null` for one the
   *  validator no longer holds, remembered so it is asked once. */
  private epochs = new Map<number, EpochInfo | null>();
  /** Bumped whenever a leader could newly resolve, for memos over resolved
   *  leaders. */
  private leaderRevision = 0;

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

  /** True once enough has arrived for the dashboard to be worth looking at. */
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
      // A reply comes back only on the socket that carried the request, so
      // losing it ends every request in flight.
      this.sender = null;
      const inflight = [...this.pending.values()];
      this.pending.clear();
      for (const pending of inflight) pending.reject(new Error("connection lost"));
    }
    this.touch();
  }

  /** How to write to the current socket, installed by `connect`. */
  setSender(sender: (frame: string) => void): void {
    this.sender = sender;
  }

  /** Asks the validator for something too large or too rarely read to push.
   *  Rejects rather than queues without a connection. */
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

  /** Who leads a slot and what to call them: the key from the epoch's turn
   *  array, the name and icon from the peer table. */
  getLeaderRevision = (): number => this.leaderRevision;

  /** Fetches an epoch's schedule, once. Only the current one is pushed. */
  async loadEpoch(epoch: number): Promise<void> {
    if (this.epochs.has(epoch)) return;
    const record = await this.request<EpochInfo | null>("epoch", "query", { epoch });
    // Held even when nothing came back, so an epoch the validator has no
    // schedule for is asked about once rather than on every search.
    this.epochs.set(epoch, record ?? null);
    if (record) this.leadersChanged();
  }

  /** Every answer already given was given without whatever just arrived. */
  private leadersChanged(): void {
    this.leaderRevision += 1;
    this.leaderCache.clear();
    this.touch();
  }

  leaderOf(slot: number, mine: boolean): LeaderRef {
    // Ours takes no lookup: our own slots are kept past the reach of both
    // sources, and the validator says who we are directly.
    if (mine) return this.ourLeader();

    const cached = this.leaderCache.get(slot);
    if (cached) return cached;

    const key = this.leaderAtAny(slot);
    // The peer table first, being the fresher of the two: it is rebuilt every
    // few seconds where the display table is fetched once. Both hold the same
    // answer for a leader they both know.
    const shown = key === null ? undefined : (this.peersByIdentity().get(key) ?? this.displays.get(key));
    const leader: LeaderRef =
      key === null ? NO_LEADER : { key, name: shown?.name ?? null, icon: shown?.icon ?? null };
    this.leaderCache.set(slot, leader);
    return leader;
  }

  /** Who leads a slot, from whichever epoch's arrays cover it. */
  private leaderAtAny(slot: number): string | null {
    const here = leaderAt(this.values.get("epoch.new") as EpochInfo | undefined, slot);
    if (here !== null) return here;
    for (const past of this.epochs.values()) {
      if (past === null) continue;
      const there = leaderAt(past, slot);
      if (there !== null) return there;
    }
    return null;
  }

  /** Fetches the cluster's names and icons, once per session. */
  async loadDisplays(): Promise<void> {
    if (this.displays.size > 0) return;
    const table = await this.request<Displays>("summary", "displays", {});
    const next = new Map<string, { name: string | null; icon: string | null }>();
    table.keys.forEach((key, index) => {
      next.set(key, { name: table.names[index] ?? null, icon: table.icons[index] ?? null });
    });
    this.displays = next;
    this.leadersChanged();
  }

  /** This validator, from the same three values the header is drawn from. */
  private ourLeader(): LeaderRef {
    const key = (this.values.get("summary.identity_key") as string | undefined) ?? null;
    const name = (this.values.get("summary.identity_name") as string | undefined) ?? null;
    const icon = (this.values.get("summary.identity_icon") as string | undefined) ?? null;
    // Rebuilt on change rather than per call: the rows that draw a leader are
    // memoised on their props, and a fresh object each render would defeat it.
    const stamp = `${key} ${name} ${icon}`;
    if (this.oursFrom !== stamp) {
      this.oursFrom = stamp;
      this.ours = { key, name, icon };
    }
    return this.ours;
  }

  /** The peer table by identity, rebuilt when the array is replaced. */
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

  getThreads(): ThreadsSample[] {
    return this.threads;
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
    } else if (topic === "summary" && key === "threads_history") {
      this.threads = (value as ThreadsSample[]).slice(-MAX_THREAD_SAMPLES);
    } else if (topic === "summary" && key === "threads_sample") {
      const sample = value as ThreadsSample;
      const last = this.threads[this.threads.length - 1];
      if (!last || sample.timestamp_nanos > last.timestamp_nanos) {
        this.threads = [...this.threads, sample].slice(-MAX_THREAD_SAMPLES);
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
      if (topic === "epoch" || topic === "peers") this.leadersChanged();
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
