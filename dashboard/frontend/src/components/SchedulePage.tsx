import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { blockStamp, buildLabel, clockTime, count, duration, percent, shortKey, sol, solCompact } from "../format";
import {
  aboutClock,
  EDGE_KEY,
  EPOCH_END_KEY,
  expectedAt,
  FUTURE_PAGE,
  futureNumbers,
  lastTurnOf,
  ourFutureNumbers,
  raiseTop,
} from "../future";
import {
  certificateAt,
  certificateText,
  certificateTitle,
  emptyTurn,
  matchesQuery,
  producingSlot,
  rewardTitle,
  SLOTS_PER_TURN,
  unheldSlots,
  type Certificate,
  type Turn,
  type TurnSlot,
} from "../schedule";
import type { SlotRange } from "../slotHistory";
import type { Store } from "../store";
import { Stripes } from "../stripes";
import { timelineOf } from "../timeline";
import { jitoShare } from "../tips";
import { readScheduleColumns, SCHEDULE_COLUMNS, writeScheduleColumns, type ScheduleColumns } from "../layout";
import {
  describeOnly,
  jumpStart,
  meets,
  ONLY,
  ONLY_COLUMNS,
  ONLY_LABELS,
  clampEntry,
  parseJump,
  type Held,
  type Jump,
  type Only,
} from "../scheduleFilters";
import {
  conditionHolds,
  conditionParts,
  describeCondition,
  FIELD_ORDER,
  FIELDS,
  hasRange,
  inRange,
  nameHolds,
  nextOp,
  rangeBounds,
  ready,
  toServer,
  type Condition,
  type LeaderFacts,
} from "../scheduleConditions";
import {
  readStartView,
  readViews,
  startHash,
  withoutView,
  withView,
  writeStartView,
  writeViews,
  type SavedView,
} from "../scheduleViews";
import { setFoldsOpen, useFoldOpen } from "../folds";
import type { ScanParams } from "../store";
import { FoundTurns, TurnIndex, turnNumberOf, type SearchAsk } from "../turnIndex";
import type { ScheduleSummary } from "../types";
import { browse, readSearch, valueText, withValue, type BrowseRow, type Offered } from "../scheduleSyntax";
import { ClientTable, heldText, ShareTools, SummaryLine, SyntaxSearch, ViewsMenu, type Pill } from "./ScheduleTools";
import type { Peer, Reward, SlotEntry, TipRates } from "../types";
import { useStore } from "../useStore";
import { useAlpenglow } from "../consensus";
import { useMedia } from "../useMedia";
import { delinquentTitle } from "../misses";
import { Copyable } from "./Copyable";
import { Logo } from "./Logo";
import { ScrollTop } from "./ScrollTop";
import { SlotLink } from "./SlotLink";
import { VirtualList } from "./VirtualList";
import type { EdgeSide } from "../virtual";

/** The most the validator answers at once, `MAX_RANGE_SLOTS` on its side. */
const SPAN_SLOTS = 4096;

/** A four-row turn's height on a desktop, used until one is measured. */
const TURN_HEIGHT_GUESS = 108;

/** How long a failed fetch waits before scrolling may ask again. */
const RETRY_AFTER_MS = 5000;

/** A search is sent once typing pauses this long. */
const SEARCH_PAUSE_MS = 250;

/** Room above a jump's turn for the top button, which floats there. */
const REVEAL_GAP = 40;

/** How often this epoch's figures are asked for again while nothing is filtered. */
const SUMMARY_EVERY_MS = 30_000;

/** By client is closed until opened and then remembered. */
const CLIENTS_FOLD = "schedule-by-client";

/** What both history scans are asked, apart from where they start. */
function scanParams(ask: SearchAsk): Omit<ScanParams, "before" | "slow"> {
  return { query: ask.query, ours: ask.ours, only: ask.only, where: ask.where, ...ask.range };
}

/** A validator older than the page answers the summary with an error, which is no summary. */
function asSummary(reply: unknown): ScheduleSummary | null {
  const summary = reply as ScheduleSummary | null;
  return summary !== null &&
    typeof summary === "object" &&
    typeof summary.figures === "object" &&
    summary.figures !== null &&
    Array.isArray(summary.clients)
    ? summary
    : null;
}

function asksAnything(ask: SearchAsk): boolean {
  return ask.query !== "" || ask.ours || ask.only.length > 0 || ask.where.length > 0 || hasRange(ask.range);
}

function leaderFacts(peer: Peer | undefined, delinquent: boolean): LeaderFacts | null {
  return peer ? { client: peer.client ?? null, country: peer.country ?? null, stake: peer.stake, delinquent } : null;
}

const NO_KEYS: readonly string[] = [];

const COLUMN_NAMES: Record<ScheduleColumns, string> = {
  status: "Status",
  fees: "Fees",
  timing: "Timing",
  load: "Load",
};

const NO_CERTIFICATES: readonly Certificate[] = [];

const NO_CONDITIONS: readonly Only[] = [];

const NO_NUMBERS: readonly number[] = [];

/** Where a jumped list starts, in its pill. */
function jumpText(jump: Jump): string {
  switch (jump.kind) {
    case "slot":
      return `slot ${count(jump.slot)}`;
    case "time":
      return blockStamp(jump.millis);
    case "epoch":
      return `the end of epoch ${jump.epoch}`;
  }
}

/** A slot's place in the turn being produced: the one in progress, or one still to come. */
type NowRow = "current" | "upcoming" | null;

function nowRowOf(slot: number, producing: number | null): NowRow {
  if (producing === null) return null;
  if (slot === producing) return "current";
  return slot > producing ? "upcoming" : null;
}

function fetchSpan(store: Store, first: number, count: number): Promise<SlotRange> {
  return store.request("slot.range", { first_slot: first, count });
}

function samePeer(a: Peer, b: Peer): boolean {
  return (
    a.stake === b.stake &&
    a.version === b.version &&
    a.client === b.client &&
    a.ip === b.ip &&
    a.country === b.country &&
    a.name === b.name &&
    a.icon === b.icon
  );
}

/** The peer table by identity, a peer keeping its object while unchanged, so a republished table
 *  redraws only the cards whose leader changed. */
function useStablePeers(peers: Peer[] | undefined): Map<string, Peer> {
  const held = useRef(new Map<string, Peer>());
  return useMemo(() => {
    const next = new Map<string, Peer>();
    for (const peer of peers ?? []) {
      const was = held.current.get(peer.identity);
      next.set(peer.identity, was && samePeer(was, peer) ? was : peer);
    }
    held.current = next;
    return next;
  }, [peers]);
}

export interface ScheduleFilter {
  query: string;
  ours: boolean;
  /** The jump, as typed. */
  from: string;
  only: readonly Only[];
  /** The range's ends, as typed. */
  since: string;
  until: string;
  where: readonly Condition[];
}

export function SchedulePage({
  query,
  ours: oursOnly,
  from,
  only,
  since,
  until,
  where,
  onFilter,
}: ScheduleFilter & { onFilter: (next: Partial<ScheduleFilter>) => void }): ReactElement {
  const store = useStore();
  const alpenglow = useAlpenglow();
  const list = useRef<HTMLDivElement>(null);
  const columnBar = useRef<HTMLDivElement>(null);

  const stake = store.get("summary", "stake");
  const peers = store.get("peers", "all");
  const epoch = store.get("epoch", "new");
  const identity = store.get("summary", "identity_key");
  const rates = store.get("summary", "tip_rates");
  const [columns, setColumns] = useState(readScheduleColumns);
  const live = store.getSlots();
  // Moves whenever a leader could newly resolve.
  const leaderRevision = store.getLeaderRevision();

  // Offered only where the figure exists: certificates under alpenglow, tips where they are read.
  const hasTips = rates != null;
  const offered = useMemo(
    () => ONLY.filter((condition) => (condition !== "left_out" || alpenglow) && (condition !== "no_tips" || hasTips)),
    [alpenglow, hasTips],
  );
  const conditions = useMemo(() => {
    const kept = only.filter((condition) => offered.includes(condition));
    return kept.length === 0 ? NO_CONDITIONS : kept;
  }, [only, offered]);
  const conditionsKey = conditions.join(",");
  // Read when the text changes, so a bare time keeps the day it meant when typed.
  const jump = useMemo(() => parseJump(from, Date.now()), [from]);

  // The column conditions and range in the validator's terms; tips there are before jito's cut.
  const tipCut = rates?.jito_cut_bps ?? null;
  const fields = useMemo(
    () =>
      FIELD_ORDER.filter(
        (field) => (field !== "tips" || hasTips) && ((field !== "voted" && field !== "left_out") || alpenglow),
      ),
    [hasTips, alpenglow],
  );
  const columnConds = useMemo(
    () => where.filter((condition) => fields.includes(condition.field) && ready(condition)),
    [where, fields],
  );
  // Matched on the turn's leader, which names the turn.
  const nameConds = useMemo(() => columnConds.filter((condition) => condition.field === "name"), [columnConds]);
  // `tipCut` stands for the rates, whose object is republished unchanged.
  const serverWhere = useMemo(() => columnConds.map((condition) => toServer(condition, rates)), [columnConds, tipCut]);
  const epochKey = epoch ? `${epoch.epoch}:${epoch.start_slot}:${epoch.slots_in_epoch}` : "";
  const range = useMemo(() => rangeBounds(since, until, epoch, Date.now()), [since, until, epochKey]);
  const ranged = hasRange(range);
  const filterActive = conditions.length > 0 || columnConds.length > 0 || ranged;
  const filtered = query.trim().length > 0 || oursOnly || filterActive;

  // Filtering to ours counts as searching: only sixty-four of our own slots are pushed, the rest are
  // in the history. A jump is a search for every turn from where it lands.
  const searching = filtered || jump !== null;

  const [index] = useState(() => new TurnIndex());
  const [fetched, setFetched] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const busy = useRef(false);
  const failedAt = useRef(0);
  const leaderOf = useCallback((slot: number, mine: boolean) => store.leaderOf(slot, mine), [store]);

  // The index and its turns are changed here rather than in effects, which would cost a second
  // render per update; repeating any of them with the same inputs changes nothing.
  useMemo(() => index.setContext(epoch, identity, leaderOf), [index, epoch, identity, leaderOf]);
  const numbers = useMemo(() => {
    index.mergeLive(live);
    return index.numbers();
    // `fetched` re-reads the numbers after a span lands.
  }, [index, live, fetched]);

  // An index started again, as after a reconnect, has its history still to read.
  const generation = index.generation;
  useEffect(() => {
    setExhausted(false);
    failedAt.current = 0;
  }, [generation]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const floor = index.floor();
    if (busy.current || exhausted || floor === null) return;
    if (Date.now() - failedAt.current < RETRY_AFTER_MS) return;
    if (floor <= 0) {
      setExhausted(true);
      return;
    }
    busy.current = true;
    setLoading(true);
    const started = index.generation;
    try {
      // Aligned down to a turn boundary so a span never begins mid-turn.
      const first = Math.max(0, Math.floor((floor - SPAN_SLOTS) / SLOTS_PER_TURN) * SLOTS_PER_TURN);
      const range = await fetchSpan(store, first, floor - first);
      if (started !== index.generation) return;
      // A span with nothing in it is older than the validator keeps.
      if (range.rows.every((row) => row === null)) {
        setExhausted(true);
        return;
      }
      index.addHistory(first, range.rows);
      setFetched((was) => was + 1);
      // The far side of an epoch boundary needs the previous schedule to name its leaders.
      if (epoch && first < epoch.start_slot) await store.loadEpoch(epoch.epoch - 1);
    } catch {
      failedAt.current = Date.now();
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [index, exhausted, store, epoch]);

  // What the validator is asked, once typing pauses; the live window is matched here as typed.
  const ask = useMemo(
    (): SearchAsk => ({ query: query.trim(), ours: oursOnly, only: conditions, where: serverWhere, range }),
    [query, oursOnly, conditions, serverWhere, range],
  );
  const [asked, setAsked] = useState({ ask, jump });
  useEffect(() => {
    const timer = setTimeout(() => setAsked({ ask, jump }), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [ask, jump]);

  useEffect(() => {
    if (!searching) return;
    void store.loadDisplays().catch(() => {});
  }, [searching, store]);

  const [found, setFound] = useState<FoundTurns | null>(null);
  const [foundPages, setFoundPages] = useState(0);
  const liveStart = index.liveStart();
  const liveStartTurn = liveStart === null ? null : turnNumberOf(liveStart);

  const loadFound = useCallback(
    async (results: FoundTurns): Promise<void> => {
      if (results.loading || results.next === null) return;
      if (Date.now() - failedAt.current < RETRY_AFTER_MS) return;
      results.loading = true;
      setFoundPages((was) => was + 1);
      try {
        const reply = await store.request("slot.search", {
          ...scanParams(results.ask),
          before: results.next,
          forward: results.forward,
          until_millis: results.until,
          slow: results.slow,
        });
        results.add(reply.turns, reply.next, epoch, identity, reply.slow);
        // Turns from the previous epoch need its schedule to name their leaders.
        const oldest = reply.turns.at(results.forward ? 0 : -1)?.first_slot;
        if (epoch && oldest !== undefined && oldest < epoch.start_slot) await store.loadEpoch(epoch.epoch - 1);
      } catch {
        failedAt.current = Date.now();
      } finally {
        results.loading = false;
        setFoundPages((was) => was + 1);
      }
    },
    [store, epoch, identity],
  );

  // A new search starts below the live window's first turn, or where a jump lands, and reads down a
  // page at a time.
  useEffect(() => {
    if ((!asksAnything(asked.ask) && !asked.jump) || liveStartTurn === null) {
      setFound(null);
      return;
    }
    const top = ((index.numbers()[0] ?? liveStartTurn) + 1) * SLOTS_PER_TURN;
    const start = asked.jump
      ? jumpStart(asked.jump, epoch, top)
      : { before: liveStartTurn * SLOTS_PER_TURN, until: null };
    const results = new FoundTurns(asked.ask, start.before, start.until);
    setFound(results);
    void loadFound(results);
    // The newest turn is read as the search starts; a new one arriving does not restart it.
  }, [asked, liveStartTurn, loadFound, index, epoch]);

  // Once a jump has landed, the turns above it, read upward as the list is scrolled up. They carry
  // the first page's slow cut-offs so both directions keep to the same.
  const jumping = asked.jump !== null;
  const [above, setAbove] = useState<{ below: FoundTurns; turns: FoundTurns } | null>(null);
  const hasLanded = jumping && found !== null && found.pages > 0;
  useEffect(() => {
    setAbove((was) => {
      if (!hasLanded || !found) return null;
      if (was?.below === found) return was;
      const top = found.numbers()[0];
      const turns = new FoundTurns(found.ask, top === undefined ? found.start : (top + 1) * SLOTS_PER_TURN, null, true);
      turns.slow = found.slow;
      return { below: found, turns };
    });
  }, [hasLanded, found]);
  const up = above?.below === found ? above.turns : null;

  // Turns keep their objects while their leader answers the same.
  useMemo(() => {
    index.relabel();
    found?.relabel(leaderOf);
    up?.relabel(leaderOf);
  }, [index, found, up, leaderOf, leaderRevision]);

  const slow = found?.slow ?? null;

  // The matches summed up by the validator, or this epoch's slots when nothing is filtered, asked
  // for again now and then since every slot moves them.
  const [summary, setSummary] = useState<ScheduleSummary | null>(null);
  // This epoch's slots by client, from the last summary nothing filtered, for the search's suggestions.
  const [epochClients, setEpochClients] = useState<ScheduleSummary["clients"] | null>(null);
  const hasLive = liveStartTurn !== null;
  useEffect(() => {
    if (!hasLive) return;
    let current = true;
    const read = (): void => {
      const top = ((index.numbers()[0] ?? 0) + 1) * SLOTS_PER_TURN;
      store.request("slot.summary", { ...scanParams(asked.ask), before: top, slow: null }).then(
        (reply) => {
          if (!current) return;
          const read = asSummary(reply);
          setSummary(read);
          if (read && !asksAnything(asked.ask)) setEpochClients(read.clients);
        },
        () => {},
      );
    };
    read();
    const timer = setInterval(read, SUMMARY_EVERY_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [asked.ask, hasLive, index, store]);
  const held: Held | null = summary?.held_from ?? null;
  const summaryFiltered = asksAnything(asked.ask);
  // An epoch the validator does not hold whole yet: since when it does.
  const heldSince =
    !summaryFiltered && held?.millis != null && epoch !== undefined && held.slot > epoch.start_slot ? held.millis : null;
  const [jumpMoved, setJumpMoved] = useState<"older" | "newer" | null>(null);
  // Leaders not voting now, by their last vote; tagged wherever their turns show.
  const delinquentVotes = useMemo(
    () => new Map((summary?.delinquent ?? []).map((leader) => [leader.identity, leader.last_vote])),
    [summary],
  );
  const slotNanos =
    store.get("summary", "observed_slot_duration_nanos") ?? store.get("summary", "estimated_slot_duration_nanos");

  // A jumped list meets the live one once the turns read upward reach it: the validator has nothing
  // newer, or, unfiltered, the index already holds the turn above.
  const landedTop = up?.numbers()[0] ?? found?.numbers()[0];
  const lowest = numbers.at(-1);
  const reachedLive =
    jumping &&
    landedTop !== undefined &&
    (up?.next === null || (!filtered && lowest !== undefined && lowest <= landedTop + 1));

  // The turn being produced, while the list runs from now. Before its first shred arrives it is not
  // held, and is drawn empty at the top.
  const producing = jumping && !reachedLive ? null : producingSlot(live);
  const nowTurn = producing === null ? null : turnNumberOf(producing);
  const nowHeld = nowTurn !== null && index.turn(nowTurn) !== undefined;
  const ahead = useMemo(
    () => (nowTurn === null || nowHeld ? null : { number: nowTurn, turn: emptyTurn(nowTurn, leaderOf, identity) }),
    [nowTurn, nowHeld, leaderOf, identity, leaderRevision],
  );

  // The epoch's turns to come, above the live edge: all of them a page at a time, or ours. Not under a
  // search, a filter or a jump, none of which a turn to come could meet.
  const futureMode = jumping || filterActive || query.trim() !== "" ? null : oursOnly ? "ours" : "all";
  const newestTurn = Math.max(nowTurn ?? -1, numbers[0] ?? -1);
  const liveTurn = newestTurn < 0 ? null : newestTurn;
  const lastTurn = epoch ? lastTurnOf(epoch) : null;
  const [futureTop, setFutureTop] = useState<number | null>(null);
  const aheadTop =
    futureMode === "all" && liveTurn !== null && lastTurn !== null ? raiseTop(futureTop, liveTurn, lastTurn) : null;
  const future = useMemo((): readonly number[] => {
    if (futureMode === null || liveTurn === null || !epoch) return NO_NUMBERS;
    if (futureMode === "ours") return ourFutureNumbers(epoch, liveTurn);
    return aheadTop === null ? NO_NUMBERS : futureNumbers(liveTurn, aheadTop);
  }, [futureMode, liveTurn, epoch, aheadTop]);
  const reachesEpochEnd = futureMode === "ours" || (aheadTop !== null && aheadTop === lastTurn);
  const moreAhead = useCallback(() => {
    if (aheadTop === null || lastTurn === null || aheadTop >= lastTurn) return;
    setFutureTop(Math.min(lastTurn, aheadTop + FUTURE_PAGE));
  }, [aheadTop, lastTurn]);
  // Built when first drawn and kept while their leaders answer the same.
  const futureTurns = useMemo(() => new Map<number, Turn>(), [leaderOf, identity, leaderRevision, epochKey]);
  const futureTurnOf = useCallback(
    (number: number): Turn | undefined => {
      if (liveTurn === null || number <= liveTurn) return undefined;
      let turn = futureTurns.get(number);
      if (!turn) {
        turn = emptyTurn(number, leaderOf, identity);
        futureTurns.set(number, turn);
      }
      return turn;
    },
    [futureTurns, liveTurn, leaderOf, identity],
  );
  const ourToCome = useMemo(
    () => (futureMode === "ours" ? future.length : epoch && liveTurn !== null ? ourFutureNumbers(epoch, liveTurn).length : 0),
    [futureMode, future, epoch, liveTurn],
  );
  const [edge, setEdge] = useState<EdgeSide>("in");

  const byIdentity = useStablePeers(peers);

  // A slot meets the chips, the column conditions and the range; a turn the validator returned has
  // already met its leader's conditions.
  const slotMatches = useCallback(
    (slot: TurnSlot, leader: LeaderFacts | null | "matched"): boolean =>
      (conditions.length === 0 ? slot.entry != null : meets(slot.slot, slot.entry, conditions, slow)) &&
      columnConds.every((condition) => conditionHolds(condition, slot.entry, leader, rates)) &&
      (!ranged || (slot.entry != null && inRange(range, slot.entry))),
    // `tipCut` stands for the rates.
    [conditions, slow, columnConds, tipCut, ranged, range],
  );

  const pastShown = useMemo(() => {
    const newest = ahead ? [ahead.number, ...numbers] : numbers;
    if (!searching) return newest;
    const liveMatches = (): number[] =>
      index.liveNumbers().filter((number) => {
        const turn = index.turn(number);
        return (
          turn !== undefined &&
          matchesQuery(turn, query) &&
          (!oursOnly || turn.mine) &&
          nameConds.every((condition) => nameHolds(condition, turn.leader_name, turn.leader)) &&
          (!filterActive ||
            turn.slots.some((slot) =>
              slotMatches(
                slot,
                leaderFacts(
                  turn.leader ? byIdentity.get(turn.leader) : undefined,
                  turn.leader ? delinquentVotes.has(turn.leader) : false,
                ),
              ),
            ))
        );
      });
    if (!jumping) return [...liveMatches(), ...(found?.numbers() ?? [])];
    // Around the landing: what was read upward, then down from it; the live turns join above once met.
    const around = [...(up?.numbers() ?? []), ...(found?.numbers() ?? [])];
    const top = around[0];
    if (top === undefined || !reachedLive) return around;
    return [...(filtered ? liveMatches() : newest).filter((number) => number > top), ...around];
    // `foundPages` stands for the results, which change in place.
  }, [index, numbers, ahead, found, up, foundPages, leaderRevision, searching, jumping, reachedLive, filtered, query, oursOnly, nameConds, filterActive, slotMatches, byIdentity, delinquentVotes]);
  const nowShown = nowTurn !== null && pastShown[0] === nowTurn;
  const shown = useMemo(
    (): readonly number[] =>
      futureMode === null || liveTurn === null
        ? pastShown
        : [...(reachesEpochEnd ? [EPOCH_END_KEY] : []), ...future, EDGE_KEY, ...pastShown],
    [futureMode, liveTurn, reachesEpochEnd, future, pastShown],
  );
  const striped = useMemo(() => (shown === pastShown ? shown : [...future, ...pastShown]), [shown, pastShown, future]);

  const [stripes] = useState(() => new Stripes());
  const listed = searching
    ? `${oursOnly ? "ours" : "all"}:${query.trim()}:${conditionsKey}:${from.trim()}:${JSON.stringify(serverWhere)}:${JSON.stringify(range)}`
    : "";
  useMemo(() => stripes.update(listed, striped), [stripes, listed, striped]);

  // Where a turn is read from: the index for the live window and what it has loaded, else the search.
  // Around a jump the index wins above its lowest turn, which can be partial, as its rows keep
  // updating.
  const sourceOf = useCallback(
    (number: number): "index" | "found" | "up" => {
      if (!searching || !found) return "index";
      if (!jumping) return liveStartTurn !== null && number < liveStartTurn ? "found" : "index";
      if (lowest !== undefined && number > lowest && index.turn(number) !== undefined) return "index";
      if (up?.holds(number)) return "up";
      return found.holds(number) ? "found" : "index";
    },
    [searching, found, up, jumping, liveStartTurn, lowest, index],
  );
  const turnOf = useCallback(
    (number: number) => {
      const source = sourceOf(number);
      if (source === "found") return found?.turn(number, leaderOf);
      if (source === "up") return up?.turn(number, leaderOf);
      return index.turn(number) ?? (number === ahead?.number ? ahead.turn : futureTurnOf(number));
    },
    [sourceOf, found, up, index, leaderOf, ahead, futureTurnOf],
  );
  const entryOf = useCallback(
    (slot: number) => index.entry(slot) ?? found?.entry(slot) ?? up?.entry(slot),
    [index, found, up],
  );
  const sizeClass = useCallback(
    (number: number) => {
      // The lines between turns are sized apart from them.
      if (number < 0) return number;
      const source = sourceOf(number);
      if (source === "found" && found) return found.rowCount(number);
      if (source === "up" && up) return up.rowCount(number);
      return index.rowCount(number);
    },
    [sourceOf, found, up, index],
  );
  const nearEnd = useCallback(() => {
    if (searching) {
      if (found) void loadFound(found);
    } else {
      void loadOlder();
    }
  }, [searching, found, loadFound, loadOlder]);
  const nearStart = useCallback(() => {
    if (up && !reachedLive) void loadFound(up);
  }, [up, reachedLive, loadFound]);

  // The slot a jump asked for, marked where it is drawn.
  const landingTurn = jumping ? (found?.numbers()[0] ?? null) : null;
  const landedSlot = useMemo((): number | null => {
    const target = asked.jump;
    if (!target) return null;
    if (target.kind === "slot") return target.slot;
    if (target.kind === "epoch") return epoch ? jumpStart(target, epoch, Number.MAX_SAFE_INTEGER).before - 1 : null;
    if (landingTurn === null) return null;
    // The newest of the landing turn's slots begun by the time asked for.
    const turn = turnOf(landingTurn);
    return turn?.slots.find((slot) => slot.entry?.time_millis != null && slot.entry.time_millis <= target.millis)?.slot ?? null;
  }, [asked.jump, epoch, landingTurn, turnOf]);

  // The live edge is brought back by drawing the list afresh, which brings it to the top again.
  const [returns, setReturns] = useState(0);
  const toLive = (): void => {
    if (futureMode === null) list.current?.scrollTo({ top: 0 });
    else setReturns((was) => was + 1);
  };
  const backToLive = (): void => {
    setJumpMoved(null);
    onFilter({ from: "" });
    toLive();
  };
  // A list without turns to come starts at its top, not where the live edge was.
  const hadFuture = useRef(futureMode !== null);
  useEffect(() => {
    if (hadFuture.current && futureMode === null && !jumping) list.current?.scrollTo({ top: 0 });
    hadFuture.current = futureMode !== null;
  }, [futureMode, jumping]);

  // The figures a row was kept for, toned where it matched: the chips' and the conditions' columns.
  const whyKeys = useMemo(
    (): readonly string[] => [...conditions, ...columnConds.map((condition) => condition.field)],
    [conditions, columnConds],
  );

  const completedSlot = store.get("summary", "completed_slot");
  const estimatedNanos = store.get("summary", "estimated_slot_duration_nanos");
  const nextLeader = store.get("summary", "next_leader_slot");

  const renderTurn = (number: number): ReactElement | null => {
    if (number === EDGE_KEY) {
      return (
        <LiveEdge
          ours={futureMode === "ours"}
          toCome={futureMode === "ours" ? future.length : lastTurn === null || liveTurn === null ? 0 : lastTurn - liveTurn}
          ourToCome={ourToCome}
          epoch={epoch?.epoch ?? null}
          nextLeader={nextLeader}
          completed={completedSlot}
          slotNanos={estimatedNanos}
        />
      );
    }
    if (number === EPOCH_END_KEY) {
      return epoch ? <EpochEnd epoch={epoch.epoch} last={epoch.end_slot} completed={completedSlot} slotNanos={estimatedNanos} /> : null;
    }
    const turn = turnOf(number);
    if (!turn) return null;
    const first = turn.slots.at(-1)?.slot ?? number * SLOTS_PER_TURN;
    const toCome = liveTurn !== null && number > liveTurn;
    const now = Date.now();
    const expected =
      toCome && completedSlot !== undefined && estimatedNanos
        ? aboutClock(expectedAt(first, completedSlot, now, estimatedNanos), now)
        : null;
    const peer = turn.leader ? byIdentity.get(turn.leader) : undefined;
    const lastVote = turn.leader ? delinquentVotes.get(turn.leader) : undefined;
    const leader = sourceOf(number) === "index" ? leaderFacts(peer, lastVote !== undefined) : "matched";
    const tip = live.at(-1)?.slot;
    const delinquent =
      lastVote === undefined
        ? null
        : delinquentTitle(lastVote === null || tip === undefined ? null : Math.max(0, tip - lastVote), slotNanos);
    return (
      <TurnCard
        turn={turn}
        peer={peer}
        totalStake={stake?.total_stake}
        rates={rates}
        certificates={alpenglow ? turn.slots.map((slot) => certificateAt(slot.slot, entryOf)) : NO_CERTIFICATES}
        tinted={stripes.tinted(number)}
        now={number === nowTurn}
        producing={number === nowTurn ? producing : toCome ? first - 1 : null}
        future={toCome}
        expected={expected}
        landed={landedSlot !== null && turnNumberOf(landedSlot) === turnNumberOf(first) ? landedSlot : null}
        marks={filterActive ? turn.slots.map((slot) => slotMatches(slot, leader)) : null}
        delinquent={delinquent}
        whyKeys={whyKeys}
      />
    );
  };

  const nowLeader = nowShown ? turnOf(nowTurn) : undefined;
  const nowName = nowLeader
    ? (nowLeader.leader_name ?? (nowLeader.leader ? shortKey(nowLeader.leader, 6, 5) : null))
    : null;

  // Where the table shows one group of columns, the one with a figure just filtered on.
  const showColumns = (group: ScheduleColumns): void => {
    if (!columnBar.current || columnBar.current.offsetParent === null) return;
    setColumns(group);
    writeScheduleColumns(group);
  };

  const toggle = (condition: Only): void => {
    const on = !conditions.includes(condition);
    onFilter({ only: ONLY.filter((held) => (held === condition ? on : conditions.includes(held))) });
    if (on) showColumns(ONLY_COLUMNS[condition]);
  };

  const phone = useMedia("(max-width: 700px)");
  const newestSlot = live.at(-1)?.slot ?? null;

  // The box: its words are the name search, its expressions filters once added.
  const searchBox = useRef<HTMLInputElement>(null);
  const [boxText, setBoxText] = useState(query);
  const [syntaxError, setSyntaxError] = useState<string | null>(null);
  const choices = summary?.choices;
  const clientSlots = epochClients;
  const syntaxOffered = useMemo((): Offered => {
    const slots = new Map((clientSlots ?? []).map((row) => [row.client, row.slots]));
    const clients = (choices?.clients ?? [])
      .map((client) => [client, slots.get(client) ?? 0] as const)
      .sort((a, b) => b[1] - a[1]);
    const names = (peers ?? [])
      .filter((peer) => peer.name && peer.stake > 0)
      .sort((a, b) => b.stake - a.stake)
      .map((peer) => peer.name ?? "");
    return { fields, only: offered, clients, countries: choices?.countries ?? [], names };
  }, [fields, offered, choices, clientSlots, peers]);
  // A search set elsewhere, by a view or the address, replaces what the box holds.
  useEffect(() => {
    setBoxText((was) => (readSearch(was, syntaxOffered, Date.now()).words === query ? was : query));
    // Only a new search does this, not new choices.
  }, [query]);
  const typeInBox = (text: string): void => {
    setBoxText(text);
    setSyntaxError(null);
    const words = readSearch(text, syntaxOffered, Date.now()).words;
    if (words !== query) onFilter({ query: words });
  };

  // What Enter takes from the box, leaving its words: conditions replace any on the same figure and
  // comparison, and a range or jump is moved inside what the validator holds.
  const addFromBox = (): void => {
    const now = Date.now();
    const read = readSearch(boxText, syntaxOffered, now);
    const [error] = read.errors;
    if (error) {
      setSyntaxError(error);
      return;
    }
    if (read.filters.length === 0) return;
    const nextWhere = where.filter(ready);
    const nextOnly = new Set(conditions);
    const next: Partial<ScheduleFilter> = { query: read.words };
    let group: ScheduleColumns | null = null;
    for (const filter of read.filters) {
      switch (filter.kind) {
        case "condition": {
          const { field, op } = filter.condition;
          const at = nextWhere.findIndex((held) => held.field === field && held.op === op);
          if (at === -1) nextWhere.push(filter.condition);
          else nextWhere[at] = filter.condition;
          group = FIELDS[field].group;
          break;
        }
        case "only":
          nextOnly.add(filter.only);
          group = ONLY_COLUMNS[filter.only];
          break;
        case "range":
          next.since = clampEntry(filter.since, held, newestSlot, epoch, now).text;
          next.until = clampEntry(filter.until, held, newestSlot, epoch, now).text;
          break;
        case "at": {
          const clamped = clampEntry(filter.text, held, newestSlot, epoch, now);
          setJumpMoved(clamped.moved);
          next.from = clamped.text;
          if (!clamped.text) toLive();
          break;
        }
      }
    }
    next.where = nextWhere;
    next.only = ONLY.filter((condition) => nextOnly.has(condition));
    onFilter(next);
    setBoxText(read.words);
    if (group) showColumns(group);
  };

  // The pill whose value is being typed, by its key.
  const [editing, setEditing] = useState<string | null>(null);
  const editPill = (key: string | null): void => {
    setEditing(key);
    setSyntaxError(null);
  };
  const putCondition = (at: number, condition: Condition): void => {
    onFilter({ where: where.map((held, index) => (index === at ? condition : held)) });
    showColumns(FIELDS[condition.field].group);
  };
  const typeValue = (at: number, text: string): string | null => {
    const held = where[at];
    if (!held) return null;
    const read = withValue(held, text, syntaxOffered);
    if (typeof read === "string") {
      setSyntaxError(read);
      return read;
    }
    editPill(null);
    putCondition(at, read);
    return null;
  };
  // A picked condition replaces any on the same figure and comparison, its value open to type.
  const pickRow = (row: BrowseRow): void => {
    if (row.action.kind === "only") {
      toggle(row.action.only);
      return;
    }
    if (row.action.kind !== "condition") return;
    const condition = row.action.condition;
    const held = where.findIndex((was) => was.field === condition.field && was.op === condition.op);
    const at = held === -1 ? where.length : held;
    onFilter({ where: held === -1 ? [...where, condition] : where.map((was, index) => (index === at ? condition : was)) });
    showColumns(FIELDS[condition.field].group);
    editPill(`where:${at}`);
  };
  const exampleSlot = newestSlot === null ? null : Math.floor((newestSlot - 20_000) / 1000) * 1000;
  const rows = useMemo(
    () =>
      browse(syntaxOffered, exampleSlot, epoch?.epoch ?? null).filter(
        (row) => row.action.kind !== "only" || !conditions.includes(row.action.only),
      ),
    [syntaxOffered, exampleSlot, epoch?.epoch, conditions],
  );
  const clearAll = (): void => {
    setJumpMoved(null);
    editPill(null);
    setBoxText("");
    onFilter({ query: "", since: "", until: "", where: [], from: "", only: [] });
  };

  const rangeText = since && until ? `From ${since} to ${until}` : since ? `From ${since} to now` : until ? `Up to ${until}` : "";
  const pills: Pill[] = [
    ...(jump ? [{ kind: "plain", key: "at", label: `At ${jumpText(jump)}`, onRemove: backToLive } as const] : []),
    ...(rangeText
      ? [{ kind: "plain", key: "range", label: rangeText, onRemove: () => onFilter({ since: "", until: "" }) } as const]
      : []),
    ...conditions.map((condition) => ({
      kind: "plain" as const,
      key: `only:${condition}`,
      label: ONLY_LABELS[condition],
      onRemove: () => toggle(condition),
    })),
    ...where.flatMap((condition, at): Pill[] =>
      ready(condition) && fields.includes(condition.field)
        ? [
            {
              kind: "condition",
              key: `where:${at}`,
              ...conditionParts(condition),
              draft: valueText(condition),
              onCycle: () => putCondition(at, { ...condition, op: nextOp(condition) }),
              onValue: (text) => typeValue(at, text),
              onRemove: () => {
                editPill(null);
                onFilter({ where: where.filter((_, index) => index !== at) });
              },
            },
          ]
        : [],
    ),
  ];

  const [views, setViews] = useState(readViews);
  const [viewsOpen, setViewsOpen] = useState(false);
  const keepViews = (next: SavedView[]): void => {
    setViews(next);
    writeViews(next);
  };
  const [startView, setStartView] = useState(readStartView);
  const keepStart = (name: string | null): void => {
    setStartView(name);
    writeStartView(name);
  };
  // Arriving with nothing asked, the schedule takes the start view; clearing filters later does not.
  useEffect(() => {
    const hash = startHash(views, startView);
    const bare = !query && !oursOnly && !from && only.length === 0 && !since && !until && where.length === 0;
    if (hash && bare) window.location.replace(`${window.location.pathname}${window.location.search}${hash}`);
  }, []);
  // The view keeps the filters, not where a jump landed.
  const saveView = (name: string): void => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    params.delete("from");
    const search = params.toString();
    const parts = [
      query.trim() && `"${query.trim()}"`,
      oursOnly && "Ours",
      ...conditions.map((condition) => ONLY_LABELS[condition]),
      rangeText,
      ...columnConds.map(describeCondition),
    ].filter(Boolean);
    keepViews(
      withView(views, {
        name,
        hash: search ? `#/schedule?${search}` : "#/schedule",
        summary: parts.join(" · ") || "Everything",
      }),
    );
  };

  const clientsOpen = useFoldOpen(CLIENTS_FOLD);

  const reading = searching ? (found?.loading ?? false) : loading;
  const finished = searching ? found?.next === null : exhausted;

  return (
    <section className={`schedule columns-${columns}${rates ? " has-tips" : ""}`}>
      <div className={`schedule-controls${searching ? " has-share" : ""}`}>
        <SyntaxSearch
          text={boxText}
          placeholder={
            pills.length > 0
              ? phone
                ? "Filter or search…"
                : "Add another filter or search…"
              : phone
                ? "Search or filter, e.g. duration>240"
                : "Search or filter: name, duration>240, client:Agave, time:08:00..09:30"
          }
          offered={syntaxOffered}
          rows={rows}
          foot={held ? `Fees in SOL, times in ms and local. Held from ${heldText(held)} to now.` : ""}
          pills={pills}
          editing={editing}
          inputRef={searchBox}
          onText={typeInBox}
          onAdd={addFromBox}
          onBrowse={pickRow}
          onEdit={editPill}
          onClear={clearAll}
        />
        <ViewsMenu
          open={viewsOpen}
          views={views}
          onToggle={() => setViewsOpen((open) => !open)}
          onApply={(view) => {
            setViewsOpen(false);
            window.location.hash = view.hash;
          }}
          start={startView}
          onStart={keepStart}
          onDelete={(name) => {
            keepViews(withoutView(views, name));
            if (name === startView) keepStart(null);
          }}
          onSave={saveView}
        />
        {searching && (
          <ShareTools onSave={() => setViewsOpen(true)} />
        )}
        <div className="toggle-group" role="group" aria-label="Which leaders to list">
          <button type="button" aria-pressed={!oursOnly} onClick={() => onFilter({ ours: false })}>
            All
          </button>
          <button type="button" aria-pressed={oursOnly} onClick={() => onFilter({ ours: true })}>
            Ours
          </button>
        </div>
      </div>
      {(syntaxError || editing || conditions.length > 0 || jumpMoved) && (
        <div className="schedule-from">
          {syntaxError && <span className="schedule-warn">{syntaxError}</span>}
          {editing && <span className="schedule-from-hint">Enter applies, Esc cancels.</span>}
          {jumpMoved === "older" && held && (
            <span>
              <span className="schedule-warn">Older than held,</span> moved to the oldest.
            </span>
          )}
          {jumpMoved === "newer" && <span>Newer than the validator holds, back to live.</span>}
          {conditions.length > 0 && <span>{describeOnly(conditions, slow)}</span>}
        </div>
      )}
      {summary && (
        <>
          <SummaryLine
            summary={summary}
            filtered={summaryFiltered}
            since={heldSince}
            rates={rates}
            open={clientsOpen}
            onToggle={() => setFoldsOpen([CLIENTS_FOLD], !clientsOpen)}
          />
          {clientsOpen && <ClientTable summary={summary} rates={rates} />}
        </>
      )}
      {/* Shown only where the table is too wide to fit, which the stylesheet decides. */}
      <div className="schedule-columns" ref={columnBar} role="group" aria-label="Which columns to show">
        {SCHEDULE_COLUMNS.map((group) => (
          <button
            key={group}
            type="button"
            aria-pressed={columns === group}
            onClick={() => {
              setColumns(group);
              writeScheduleColumns(group);
            }}
          >
            {COLUMN_NAMES[group]}
          </button>
        ))}
      </div>

      {/* The table's one header where every column fits; elsewhere each turn carries its own. */}
      <div className="schedule-table-head">
        <span>Leader</span>
        <div className={`schedule-slots${alpenglow ? " has-certificate" : ""}`}>
          <SlotHeadings alpenglow={alpenglow} />
        </div>
      </div>
      <div className="schedule-list" ref={list}>
        <ScrollTop
          scroller={list}
          hold={false}
          label={jumping || (futureMode !== null && !nowName) ? "Back to live" : nowName ? `${nowName} leading now` : undefined}
          onPress={jumping ? backToLive : futureMode !== null ? toLive : undefined}
          shown={futureMode !== null ? edge === "above" : undefined}
        />
        {shown.length === 0 && !reading && (searching ? found !== null : true) && (
          <div className="list-empty">{live.length === 0 ? "waiting for slots…" : "nothing matches that"}</div>
        )}
        {/* Mounted afresh for each jump, so each lands at its turn. */}
        <VirtualList
          key={asked.jump ? JSON.stringify(asked.jump) : `live:${futureMode ?? "none"}:${returns}`}
          keys={shown}
          sizeClass={sizeClass}
          fallback={TURN_HEIGHT_GUESS}
          render={renderTurn}
          scroller={list}
          onNearEnd={nearEnd}
          onNearStart={jumping ? nearStart : futureMode === "all" ? moreAhead : undefined}
          follow={!jumping && futureMode === null}
          reveal={jumping ? landingTurn : futureMode !== null ? EDGE_KEY : undefined}
          revealGap={jumping ? REVEAL_GAP : 0}
          marker={futureMode !== null ? EDGE_KEY : undefined}
          onMarker={setEdge}
        />
        {reading && <div className="schedule-capped">reading back through what the validator has kept…</div>}
        {finished && (
          <div className="schedule-capped">
            {searching ? "Every match the validator keeps." : "As far back as the validator keeps."}
          </div>
        )}
        {futureMode !== null && (
          <ScrollTop scroller={list} hold={false} below shown={edge === "below"} label="Back to live" onPress={toLive} />
        )}
      </div>
    </section>
  );
}

const TurnCard = memo(
  function TurnCard({
    turn,
    peer,
    totalStake,
    rates,
    certificates,
    tinted,
    now,
    producing,
    landed,
    marks,
    whyKeys,
    delinquent,
    future,
    expected,
  }: {
    turn: Turn;
    peer: Peer | undefined;
    totalStake: number | undefined;
    rates: TipRates | undefined;
    /** Each row's certificate, in the rows' order; empty before alpenglow. */
    certificates: readonly Certificate[];
    tinted: boolean;
    /** The turn being produced. */
    now: boolean;
    /** The slot being produced, in this turn; null in every other. */
    producing: number | null;
    /** The slot a jump asked for, in this turn. */
    landed: number | null;
    /** Under filters, whether each row matched, in the rows' order; null without filters. */
    marks: readonly boolean[] | null;
    /** The figures a matching row is toned for. */
    whyKeys: readonly string[];
    /** The delinquent tag's title, where the leader is not voting now. */
    delinquent: string | null;
    /** A turn still to come. */
    future: boolean;
    /** When a turn to come should start. */
    expected: string | null;
  }) {
    const alpenglow = useAlpenglow();
    return (
      <div
        className={`schedule-group${turn.mine ? " is-ours" : ""}${tinted ? " is-tinted" : ""}${now ? " is-now" : ""}${future ? " is-future" : ""}`}
      >
        <TurnLeader
          turn={turn}
          peer={peer}
          totalStake={totalStake}
          now={now}
          delinquent={delinquent}
          expected={expected}
        />
        <div className={`schedule-slots${alpenglow ? " has-certificate" : ""}`}>
          <SlotHeadings alpenglow={alpenglow} />
          {turn.slots.map((slot, row) => (
            <SlotRow
              key={slot.slot}
              slot={slot}
              rates={rates}
              certificate={certificates[row]}
              now={nowRowOf(slot.slot, producing)}
              landed={slot.slot === landed}
              met={marks === null ? null : marks[row] ? whyKeys : NO_KEYS}
            />
          ))}
          {unheldSlots(turn).map((slot) => (
            <SlotRow key={slot} slot={{ slot, entry: null }} rates={rates} certificate={undefined} unheld />
          ))}
        </div>
      </div>
    );
  },
  // A turn keeps its object until one of its slots changes; a slot's certificate sits on another
  // turn's entry, so it is compared apart.
  (before, after) =>
    before.turn === after.turn &&
    before.peer === after.peer &&
    before.totalStake === after.totalStake &&
    before.rates === after.rates &&
    before.tinted === after.tinted &&
    before.now === after.now &&
    before.producing === after.producing &&
    before.landed === after.landed &&
    before.whyKeys === after.whyKeys &&
    before.delinquent === after.delinquent &&
    before.future === after.future &&
    before.expected === after.expected &&
    (before.marks === after.marks ||
      (before.marks !== null &&
        after.marks !== null &&
        before.marks.length === after.marks.length &&
        before.marks.every((mark, row) => mark === after.marks?.[row]))) &&
    before.certificates.length === after.certificates.length &&
    before.certificates.every((certificate, row) => certificate === after.certificates[row]),
);

function SlotHeadings({ alpenglow }: { alpenglow: boolean }) {
  return (
    <div className="schedule-row schedule-head">
      <span className="schedule-slot">Slot</span>
      <span className="sc-status">{alpenglow ? "Voted" : "Votes"}</span>
      {alpenglow && (
        <span
          className="sc-status"
          title="Who the reward certificate written in this slot left out, of the validators certificates usually pay."
        >
          <Heading wide="Certificate" narrow="Cert" />
        </span>
      )}
      <span className="sc-status">
        {alpenglow ? <Heading wide="Transactions" narrow="Txns" /> : "Non-votes"}
      </span>
      <span className="sc-fees">
        <Heading wide="Base fee" narrow="Base" />
      </span>
      <span className="sc-fees">Priority</span>
      <span
        className="sc-fees sc-tips"
        title="Reaching the distribution account, after jito's cut. Derived, not measured."
      >
        Tips
      </span>
      <span className="sc-timing" title="From the previous block filling here to this one filling.">
        Duration
      </span>
      <span className="sc-load" title="Data shreds in the block, and how many were repaired.">
        Shreds
      </span>
      <span
        className="sc-timing"
        title="First shred to block full, then to replay finishing, drawn against one second."
      >
        <Heading wide="Received to replayed" narrow="Recv + replay" />
      </span>
      <span className="sc-load">Compute</span>
    </div>
  );
}

function TurnLeader({
  turn,
  peer,
  totalStake,
  now,
  delinquent,
  expected,
}: {
  turn: Turn;
  peer: Peer | undefined;
  totalStake: number | undefined;
  now: boolean;
  delinquent: string | null;
  expected: string | null;
}) {
  // Missing rather than zero when the table has not caught up with a leader
  // that has only just come into view.
  const share = peer && totalStake ? peer.stake / totalStake : null;
  const began = turn.slots[turn.slots.length - 1]?.entry?.time_millis ?? null;
  const version = peer?.version ? buildLabel(peer.client ?? undefined, peer.version) : "";
  const name = turn.leader_name ?? (turn.leader ? shortKey(turn.leader, 6, 5) : "unknown");

  return (
    <div className="schedule-leader">
      <div className="schedule-leader-name">
        <Logo url={turn.leader_icon} size={16} name={turn.leader_name} />
        <span className="schedule-leader-title" title={turn.leader_name ?? turn.leader ?? undefined}>
          {name}
        </span>
        {turn.mine && <span className="schedule-mine">ours</span>}
        {now && <span className="schedule-now">leading now</span>}
        {delinquent && (
          <span className="tag-delinquent" title={delinquent}>
            delinquent
          </span>
        )}
      </div>
      {turn.leader && (
        <Copyable
          text={turn.leader}
          label={shortKey(turn.leader, 8, 8)}
          className="schedule-leader-key"
        />
      )}
      {/* Both always drawn, empty or not, so a turn does not grow a line when the stamp or the peer
          table lands. */}
      <span className="schedule-leader-when" title={expected === null ? undefined : EXPECTED_TITLE}>
        {expected ?? (began === null ? "" : blockStamp(began))}
      </span>
      {/* Where every column fits, two lines: version and stake, then address and time of day. */}
      <div className="schedule-leader-meta">
        <span className="schedule-leader-client">
          <span className="schedule-version" title={version || undefined}>
            {version}
          </span>
          <span className="schedule-stake">
            {peer && peer.stake > 0 && (
              <>
                {solCompact(peer.stake)} SOL
                {share !== null && <span className="schedule-share">{percent(share, 3)}</span>}
              </>
            )}
          </span>
        </span>
        <span className="schedule-leader-where">
          <span className="schedule-ip" title={peer?.ip ?? undefined}>
            {peer?.ip ?? ""}
            {peer?.country && <span className="country-code">{peer.country}</span>}
          </span>
          <span
            className="schedule-leader-time"
            title={expected !== null ? EXPECTED_TITLE : began === null ? undefined : blockStamp(began)}
          >
            {expected ?? (began === null ? "" : clockTime(began))}
          </span>
        </span>
      </div>
    </div>
  );
}

const EXPECTED_TITLE = "When the turn should start, at the measured slot time.";

/** Between the turns to come and the live one: how many are left, and when ours is next. */
function LiveEdge({
  ours,
  toCome,
  ourToCome,
  epoch,
  nextLeader,
  completed,
  slotNanos,
}: {
  /** Listing our turns alone. */
  ours: boolean;
  toCome: number;
  ourToCome: number;
  epoch: number | null;
  nextLeader: number | null | undefined;
  completed: number | undefined;
  slotNanos: number | undefined;
}) {
  const now = Date.now();
  const until =
    nextLeader == null || completed === undefined || !slotNanos
      ? null
      : Math.max(0, expectedAt(nextLeader, completed, now, slotNanos) - now);
  return (
    <div className="schedule-edge">
      <b>
        <span aria-hidden="true">▲</span>{" "}
        {ours
          ? `${count(ourToCome)} of our turns to come`
          : toCome === 0
            ? `Last turn of epoch ${epoch ?? ""}`.trim()
            : `${count(toCome)} turns to come`}
      </b>
      {nextLeader === null ? (
        <span className="schedule-edge-dim">none of our turns left this epoch</span>
      ) : nextLeader !== undefined && until !== null ? (
        <>
          <span className="schedule-edge-next">
            our next <span className="schedule-edge-wide">at slot {count(nextLeader)}, </span>
            {aboutClock(now + until, now)}
          </span>
          <span className="schedule-edge-dim">
            {until === 0 ? "now" : `in ${duration(until, 2)}`}
            {!ours && <span className="schedule-edge-wide"> · {count(ourToCome)} of our turns to come</span>}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** Above the epoch's last turn. */
function EpochEnd({
  epoch,
  last,
  completed,
  slotNanos,
}: {
  epoch: number;
  last: number;
  completed: number | undefined;
  slotNanos: number | undefined;
}) {
  const now = Date.now();
  const at = completed === undefined || !slotNanos ? null : expectedAt(last + 1, completed, now, slotNanos);
  return (
    <div className="schedule-epoch-end">
      <b>Epoch {epoch} ends</b>
      <span>after slot {count(last)}</span>
      {at !== null && (
        <span>
          {aboutClock(at, now)} · in {duration(Math.max(0, at - now), 2)}
        </span>
      )}
    </div>
  );
}

function Timeline({ entry, toned = "" }: { entry: SlotEntry | null; toned?: string }) {
  const timeline = timelineOf(entry);
  if (!timeline) {
    return (
      <span className={`schedule-tl sc-timing${toned}`}>
        <span className="schedule-tl-text">—</span>
      </span>
    );
  }
  const spent =
    entry?.block?.replay_micros == null
      ? ""
      : ` Replay's own thread spent ${Math.round(entry.block.replay_micros / 1000)} ms on it.`;
  const title = entry?.mine
    ? `Produced here: ${timeline.wait} ms from the first shred to the last. Nothing to wait for and nothing to replay.`
    : timeline.run === null
      ? `Block full ${timeline.wait} ms after its first shred. Replay's finish was not seen.`
      : `Block full ${timeline.wait} ms after its first shred, replayed ${timeline.run} ms after that.${spent}`;
  return (
    <span className={`schedule-tl sc-timing${toned}`} title={title}>
      <span className="schedule-tl-track" aria-hidden="true">
        <i className="is-wait" style={{ left: 0, width: `${timeline.waitShare * 100}%` }} />
        {timeline.run !== null && (
          <i
            className="is-run"
            style={{ left: `${timeline.waitShare * 100}%`, width: `${timeline.runShare * 100}%` }}
          />
        )}
      </span>
      <span className="schedule-tl-text">
        <Heading wide={timeline.label} narrow={timeline.short} />
      </span>
    </span>
  );
}

function SlotRow({
  slot,
  rates,
  certificate,
  unheld = false,
  now = null,
  landed = false,
  met = null,
}: {
  slot: TurnSlot;
  rates: TipRates | undefined;
  certificate: Certificate;
  /** Below what is held, drawn so the turn keeps four rows. */
  unheld?: boolean;
  now?: NowRow;
  landed?: boolean;
  /** Under filters, the conditions this slot meets, empty where it misses; null without filters. */
  met?: readonly string[] | null;
}) {
  const alpenglow = useAlpenglow();
  const entry = slot.entry;
  const block = entry?.block ?? null;
  // Votes are the block less the rest, clamped since the two counters are differenced separately.
  const votes = block ? Math.max(0, block.transactions - block.non_vote_transactions) : null;
  const filled =
    block && block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null;
  const level = entry?.level ?? "scheduled";
  const toned = (...keys: string[]): string => (keys.some((key) => met?.includes(key)) ? " is-met" : "");

  return (
    <div
      className={`schedule-row level-${level}${unheld ? " is-unheld" : ""}${now ? ` is-${now}` : ""}${landed ? " is-landed" : ""}${met?.length === 0 ? " is-miss" : ""}`}
    >
      <span className="schedule-slot" title={unheld ? "Not read yet, or older than the validator keeps." : undefined}>
        {entry?.mine ? <SlotLink slot={slot.slot} /> : count(slot.slot)}
        {!unheld && <span className={`schedule-level level-${level}`} title={level.replace(/_/g, " ")} />}
      </span>
      {alpenglow ? (
        <VoteMark reward={entry?.reward ?? null} />
      ) : (
        <span className="sc-status">{votes === null ? "—" : count(votes)}</span>
      )}
      {alpenglow && <CertificateCell certificate={certificate} />}
      <span className={`sc-status${toned("few_transactions", "transactions")}`}>
        {block ? count(block.non_vote_transactions) : "—"}
      </span>
      <span className={`sc-fees${toned("base_fee")}`}>{block ? sol(block.total_fees - block.priority_fees, 4) : "—"}</span>
      <span className={`sc-fees${toned("priority")}`}>{block ? sol(block.priority_fees, 4) : "—"}</span>
      <span className={`sc-fees sc-tips${toned("no_tips", "tips")}`}>
        {/* Absent where tips were never measured; nought is a real reading. */}
        {rates && block?.tips != null ? sol(jitoShare(block.tips, rates), 4) : "—"}
      </span>
      <span className={`sc-timing${toned("slow", "duration")}`}>
        {entry?.duration_nanos == null ? "—" : `${Math.round(entry.duration_nanos / 1e6)} ms`}
      </span>
      <span className={`sc-load${toned("shreds", "repaired")}`}>
        {entry?.shreds ? count(entry.shreds.count) : "—"}
        {entry?.shreds && entry.shreds.repaired > 0 && (
          <span className="schedule-repaired">
            <Heading wide={`${count(entry.shreds.repaired)} rep`} narrow={`+${count(entry.shreds.repaired)}r`} />
          </span>
        )}
      </span>
      <Timeline entry={entry} toned={toned("received", "replay")} />
      <span className={`sc-load${toned("compute", "block_fill")}`}>
        {block ? count(block.block_cost) : "—"}
        {filled !== null && <span className="schedule-fill">{percent(filled, 0)}</span>}
      </span>
    </div>
  );
}

const MARKS: Record<Reward, [glyph: string, tone: string]> = {
  paid: ["✓", "is-yes"],
  unpaid: ["✗", "is-no"],
  no_certificate: ["○", "is-none"],
};

function CertificateCell({ certificate }: { certificate: Certificate }) {
  const [text, tone] = certificateText(certificate);
  return (
    <span className={`schedule-cert sc-status is-${tone}`} title={certificateTitle(certificate)}>
      {text}
    </span>
  );
}

function VoteMark({ reward }: { reward: Reward | null }) {
  const [glyph, tone] = reward === null ? ["–", "is-unknown"] : MARKS[reward];
  return (
    <span className="vote-marks sc-status" title={rewardTitle(reward)}>
      <i className={`vote-mark ${tone}`}>{glyph}</i>
    </span>
  );
}

/** Text in two lengths: the table's own, and a shorter one for when it shows one group of columns. */
function Heading({ wide, narrow }: { wide: string; narrow: string }) {
  return (
    <>
      <span className="schedule-wide">{wide}</span>
      <span className="schedule-narrow">{narrow}</span>
    </>
  );
}
