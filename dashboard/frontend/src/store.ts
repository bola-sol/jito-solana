/** Everything the websocket has told us. Notifications are coalesced to one
 *  per animation frame. */

import { leaderAt, NO_LEADER, type LeaderRef } from "./schedule";
import type {
  Displays,
  EpochInfo,
  Envelope,
  NetworkSample,
  Peer,
  Published,
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
/** Clock readings kept for the offset: a minute, so a clock step ages out. */
const CLOCK_READINGS = 60;

/** Thread samples kept: the minute the host card draws. */
const MAX_THREAD_SAMPLES = 60;

export type ConnectionState = "connecting" | "open" | "closed";

/** A request sent to the validator and not yet answered. The server answers
 *  every request, so one never settled means the connection went away. */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** `held` with `sample` appended where it is newer than the last, capped at
 *  `cap`. The retained history and the live samples overlap by design. */
function appendNewer<T>(held: T[], sample: T, stamp: (sample: T) => number, cap: number): T[] {
  const last = held[held.length - 1];
  return !last || stamp(sample) > stamp(last) ? [...held, sample].slice(-cap) : held;
}

export class Store {
  /** Latest value for each `topic.key`, exactly as published. */
  private values = new Map<string, unknown>();
  private slots = new Map<number, SlotEntry>();
  private tps: TpsSample[] = [];
  private network: NetworkSample[] = [];
  private threads: ThreadsSample[] = [];
  private connection: ConnectionState = "connecting";
  /** This clock less the validator's, per reading, newest last, and the
   *  smallest of them. */
  private clockOffsets: number[] = [];
  private clockOffset: number | null = null;
  /** The smallest offset this connection has seen, which the lag is measured from. */
  private quickestOffset: number | null = null;
  private feedLag: number | null = null;
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

  /** The latest value under a key, typed by `Published`. */
  get<T extends keyof Published, K extends keyof Published[T] & string>(
    topic: T,
    key: K,
  ): Published[T][K] | undefined {
    return this.values.get(`${topic}.${key}`) as Published[T][K] | undefined;
  }

  getConnection(): ConnectionState {
    return this.connection;
  }

  /** True once enough has arrived for the dashboard to be worth looking at. */
  isReady(): boolean {
    // A booting validator has no slots or identity yet, and the boot sequence is what the page
    // shows, so the splash stops waiting.
    const startup = this.get("summary", "startup_progress");
    if (startup && !startup.running) return true;

    return this.values.has("summary.identity_key") && this.slots.size > 0;
  }

  setConnection(state: ConnectionState): void {
    this.connection = state;
    if (state !== "open") {
      // A reply comes back only on the socket that carried the request, so
      // losing it ends every request in flight.
      this.sender = null;
      this.clockOffsets = [];
      this.clockOffset = null;
      this.quickestOffset = null;
      this.feedLag = null;
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

  /** Moves when an epoch schedule, the peer table or the name table arrives,
   *  which is when `leaderOf` can answer differently for other validators. */
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

  /** Who leads a slot and what to call them: the key from the epoch's turn
   *  array, the name and icon from the peer table. */
  leaderOf(slot: number, mine: boolean): LeaderRef {
    // Ours takes no lookup: our own slots are kept past the reach of both
    // sources, and the validator says who we are directly.
    if (mine) return this.ourLeader();

    const cached = this.leaderCache.get(slot);
    if (cached) return cached;

    const key = this.leaderAtAny(slot);
    // The peer table first, being rebuilt every few seconds where the display table is fetched
    // once.
    const shown = key === null ? undefined : (this.peersByIdentity().get(key) ?? this.displays.get(key));
    const leader: LeaderRef =
      key === null ? NO_LEADER : { key, name: shown?.name ?? null, icon: shown?.icon ?? null };
    this.leaderCache.set(slot, leader);
    return leader;
  }

  /** Who leads a slot, from whichever epoch's arrays cover it. */
  private leaderAtAny(slot: number): string | null {
    const here = leaderAt(this.get("epoch", "new"), slot);
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
    const key = this.get("summary", "identity_key") ?? null;
    const name = this.get("summary", "identity_name") ?? null;
    const icon = this.get("summary", "identity_icon") ?? null;
    // Rebuilt on change rather than per call: the rows that draw a leader are
    // memoised on their props, and a fresh object each render would defeat it.
    const ours = this.ours;
    if (ours.key !== key || ours.name !== name || ours.icon !== icon) {
      this.ours = { key, name, icon };
    }
    return this.ours;
  }

  /** The peer table by identity, rebuilt when the array is replaced. */
  private peersByIdentity(): Map<string, Peer> {
    const peers = this.get("peers", "all") ?? [];
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

  /** How far this clock runs ahead of the validator's, in milliseconds: the
   *  smallest recent reading, since delivery delay only adds. */
  getClockOffset(): number | null {
    return this.clockOffset;
  }

  /** How much later than this connection's quickest delivery the newest server
   *  clock arrived, in milliseconds: the backlog between here and the validator. */
  getFeedLag(): number | null {
    return this.feedLag;
  }

  getThreads(): ThreadsSample[] {
    return this.threads;
  }

  apply(envelope: Envelope): void {
    const { topic, key, value } = envelope;

    // Replies to our own requests carry an id and are not state; one nobody is waiting on, as after
    // a reconnect, is dropped.
    if (envelope.id !== undefined) {
      const pending = this.pending.get(envelope.id);
      if (pending) {
        this.pending.delete(envelope.id);
        pending.resolve(value);
      }
      return;
    }

    // The histories are lists; a frame that is not one is a server bug and is
    // dropped whole rather than applied part way.
    const stamp = (sample: { timestamp_nanos: number }) => sample.timestamp_nanos;
    if (topic === "slot" && key === "overview") {
      if (!Array.isArray(value)) return;
      this.slots.clear();
      for (const entry of value as SlotEntry[]) this.slots.set(entry.slot, entry);
      this.trimSlots();
    } else if (topic === "slot" && key === "update") {
      const entry = value as SlotEntry;
      this.slots.set(entry.slot, entry);
      this.trimSlots();
    } else if (topic === "summary" && key === "network_history") {
      if (!Array.isArray(value)) return;
      this.network = (value as NetworkSample[]).slice(-MAX_TPS_SAMPLES);
    } else if (topic === "summary" && key === "network_sample") {
      this.network = appendNewer(this.network, value as NetworkSample, stamp, MAX_TPS_SAMPLES);
    } else if (topic === "summary" && key === "threads_history") {
      if (!Array.isArray(value)) return;
      this.threads = (value as ThreadsSample[]).slice(-MAX_THREAD_SAMPLES);
    } else if (topic === "summary" && key === "threads_sample") {
      this.threads = appendNewer(this.threads, value as ThreadsSample, stamp, MAX_THREAD_SAMPLES);
    } else if (topic === "summary" && key === "tps_history") {
      if (!Array.isArray(value)) return;
      this.tps = (value as TpsSample[]).slice(-MAX_TPS_SAMPLES);
    } else if (topic === "summary" && key === "tps_sample") {
      this.tps = appendNewer(this.tps, value as TpsSample, (sample) => sample.slot, MAX_TPS_SAMPLES);
    } else {
      const serverTime = topic === "summary" && key === "server_time_nanos";
      if (serverTime && typeof value === "number") {
        const offset = Date.now() - value / 1e6;
        this.clockOffsets = [...this.clockOffsets, offset].slice(-CLOCK_READINGS);
        this.clockOffset = Math.min(...this.clockOffsets);
        this.quickestOffset =
          this.quickestOffset === null ? offset : Math.min(this.quickestOffset, offset);
        this.feedLag = offset - this.quickestOffset;
      }
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
    // Split rather than walked oldest first, because our own slots are kept to a separate depth.
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
