import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { blockStamp, buildLabel, clockTime, count, percent, shortKey, sol, solCompact } from "../format";
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
  ONLY_TITLES,
  parseJump,
  type Jump,
  type Only,
  type SlowCutOffs,
} from "../scheduleFilters";
import { FoundTurns, TurnIndex, turnNumberOf } from "../turnIndex";
import type { Peer, Reward, SlotEntry, TipRates } from "../types";
import { useStore } from "../useStore";
import { useAlpenglow } from "../consensus";
import { Copyable } from "./Copyable";
import { Logo } from "./Logo";
import { ScrollTop } from "./ScrollTop";
import { SlotLink } from "./SlotLink";
import { VirtualList } from "./VirtualList";

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

const COLUMN_NAMES: Record<ScheduleColumns, string> = {
  status: "Status",
  fees: "Fees",
  timing: "Timing",
  load: "Load",
};

const NO_CERTIFICATES: readonly Certificate[] = [];

const NO_CONDITIONS: readonly Only[] = [];

/** Where a jumped list starts, in the from line. */
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
}

export function SchedulePage({
  query,
  ours: oursOnly,
  from,
  only,
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
  const [chipsOpen, setChipsOpen] = useState(() => only.length > 0);

  // Filtering to ours counts as searching: only sixty-four of our own slots are pushed, the rest are
  // in the history. A jump is a search for every turn from where it lands.
  const searching = query.trim().length > 0 || oursOnly || conditions.length > 0 || jump !== null;

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
  const [asked, setAsked] = useState({ query: query.trim(), ours: oursOnly, only: conditions, jump });
  useEffect(() => {
    const timer = setTimeout(
      () => setAsked({ query: query.trim(), ours: oursOnly, only: conditions, jump }),
      SEARCH_PAUSE_MS,
    );
    return () => clearTimeout(timer);
  }, [query, oursOnly, conditions, jump]);

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
          query: results.query,
          ours: results.ours,
          before: results.next,
          forward: results.forward,
          only: results.only,
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
    if ((!asked.query && !asked.ours && asked.only.length === 0 && !asked.jump) || liveStartTurn === null) {
      setFound(null);
      return;
    }
    const top = ((index.numbers()[0] ?? liveStartTurn) + 1) * SLOTS_PER_TURN;
    const start = asked.jump
      ? jumpStart(asked.jump, epoch, top)
      : { before: liveStartTurn * SLOTS_PER_TURN, until: null };
    const results = new FoundTurns(asked.query, asked.ours, start.before, asked.only, start.until);
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
      const turns = new FoundTurns(
        found.query,
        found.ours,
        top === undefined ? found.start : (top + 1) * SLOTS_PER_TURN,
        found.only,
        null,
        true,
      );
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
  const filtered = query.trim().length > 0 || oursOnly || conditions.length > 0;

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

  const shown = useMemo(() => {
    const newest = ahead ? [ahead.number, ...numbers] : numbers;
    if (!searching) return newest;
    const liveMatches = (): number[] =>
      index.liveNumbers().filter((number) => {
        const turn = index.turn(number);
        return (
          turn !== undefined &&
          matchesQuery(turn, query) &&
          (!oursOnly || turn.mine) &&
          (conditions.length === 0 || turn.slots.some((slot) => meets(slot.slot, slot.entry, conditions, slow)))
        );
      });
    if (!jumping) return [...liveMatches(), ...(found?.numbers() ?? [])];
    // Around the landing: what was read upward, then down from it; the live turns join above once met.
    const around = [...(up?.numbers() ?? []), ...(found?.numbers() ?? [])];
    const top = around[0];
    if (top === undefined || !reachedLive) return around;
    return [...(filtered ? liveMatches() : newest).filter((number) => number > top), ...around];
    // `foundPages` stands for the results, which change in place.
  }, [index, numbers, ahead, found, up, foundPages, leaderRevision, searching, jumping, reachedLive, filtered, query, oursOnly, conditions, slow]);
  const nowShown = nowTurn !== null && shown[0] === nowTurn;

  const [stripes] = useState(() => new Stripes());
  const listed = searching ? `${oursOnly ? "ours" : "all"}:${query.trim()}:${conditionsKey}:${from.trim()}` : "";
  useMemo(() => stripes.update(listed, shown), [stripes, listed, shown]);

  // Where a turn is read from: the index for the live window and what it has loaded, else the search.
  // Around a jump the index wins above its lowest turn, which can be partial, as its rows keep
  // updating.
  const byIdentity = useStablePeers(peers);
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
      return index.turn(number) ?? (number === ahead?.number ? ahead.turn : undefined);
    },
    [sourceOf, found, up, index, leaderOf, ahead],
  );
  const entryOf = useCallback(
    (slot: number) => index.entry(slot) ?? found?.entry(slot) ?? up?.entry(slot),
    [index, found, up],
  );
  const sizeClass = useCallback(
    (number: number) => {
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

  const backToLive = (): void => {
    onFilter({ from: "" });
    list.current?.scrollTo({ top: 0 });
  };

  const renderTurn = (number: number): ReactElement | null => {
    const turn = turnOf(number);
    if (!turn) return null;
    const first = turn.slots.at(-1)?.slot ?? number * SLOTS_PER_TURN;
    return (
      <TurnCard
        turn={turn}
        peer={turn.leader ? byIdentity.get(turn.leader) : undefined}
        totalStake={stake?.total_stake}
        rates={rates}
        certificates={alpenglow ? turn.slots.map((slot) => certificateAt(slot.slot, entryOf)) : NO_CERTIFICATES}
        tinted={stripes.tinted(number)}
        now={number === nowTurn}
        producing={number === nowTurn ? producing : null}
        landed={landedSlot !== null && turnNumberOf(landedSlot) === turnNumberOf(first) ? landedSlot : null}
        only={conditions}
        slow={slow}
      />
    );
  };

  const nowLeader = nowShown ? turnOf(nowTurn) : undefined;
  const nowName = nowLeader
    ? (nowLeader.leader_name ?? (nowLeader.leader ? shortKey(nowLeader.leader, 6, 5) : null))
    : null;

  const toggle = (condition: Only): void => {
    const on = !conditions.includes(condition);
    onFilter({ only: ONLY.filter((held) => (held === condition ? on : conditions.includes(held))) });
    // Where the table shows one group of columns, the one with the condition's figure.
    if (on && columnBar.current && columnBar.current.offsetParent !== null) {
      setColumns(ONLY_COLUMNS[condition]);
      writeScheduleColumns(ONLY_COLUMNS[condition]);
    }
  };

  const reading = searching ? (found?.loading ?? false) : loading;
  const finished = searching ? found?.next === null : exhausted;

  return (
    <section className={`schedule columns-${columns}${rates ? " has-tips" : ""}`}>
      <div className="schedule-controls">
        <input
          type="search"
          className="schedule-search"
          value={query}
          placeholder="Name, pubkey or slot"
          aria-label="Filter the schedule by leader name, pubkey or slot"
          onChange={(event) => onFilter({ query: event.target.value })}
        />
        <input
          type="search"
          className={`schedule-jump${jump ? " is-set" : ""}`}
          value={from}
          placeholder="Jump to slot or time"
          title="A slot, a time such as 08:00 or Nov 2 08:00, or an epoch such as epoch 1071."
          aria-label="Jump to a slot, time or epoch"
          aria-invalid={from.trim() !== "" && jump === null}
          onChange={(event) => onFilter({ from: event.target.value })}
        />
        {/* Opens the conditions on a phone; elsewhere they are always shown. */}
        <button
          type="button"
          className={`schedule-only-toggle${conditions.length > 0 ? " is-on" : ""}`}
          aria-expanded={chipsOpen}
          onClick={() => setChipsOpen((open) => !open)}
        >
          Filter{conditions.length > 0 && <b>{conditions.length}</b>}
        </button>
        <div className={`schedule-only${chipsOpen ? " is-open" : ""}`} role="group" aria-label="Only slots that are">
          <span className="schedule-only-label">Only</span>
          {offered.map((condition) => (
            <button
              key={condition}
              type="button"
              className="schedule-chip"
              title={ONLY_TITLES[condition]}
              aria-pressed={conditions.includes(condition)}
              onClick={() => toggle(condition)}
            >
              {ONLY_LABELS[condition]}
            </button>
          ))}
        </div>
        <div className="toggle-group" role="group" aria-label="Which leaders to list">
          <button type="button" aria-pressed={!oursOnly} onClick={() => onFilter({ ours: false })}>
            All
          </button>
          <button type="button" aria-pressed={oursOnly} onClick={() => onFilter({ ours: true })}>
            Ours
          </button>
        </div>
      </div>
      {(jump || conditions.length > 0) && (
        <div className="schedule-from">
          {jump && <span>At {jumpText(jump)}</span>}
          {conditions.length > 0 && <span>{describeOnly(conditions, slow)}</span>}
          {jump && (
            <button type="button" onClick={backToLive}>
              Back to live
            </button>
          )}
        </div>
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
          label={jumping ? "Back to live" : nowName ? `${nowName} leading now` : undefined}
          onPress={jumping ? backToLive : undefined}
        />
        {shown.length === 0 && !reading && (searching ? found !== null : true) && (
          <div className="list-empty">{live.length === 0 ? "waiting for slots…" : "nothing matches that"}</div>
        )}
        {/* Mounted afresh for each jump, so each lands at its turn. */}
        <VirtualList
          key={asked.jump ? JSON.stringify(asked.jump) : "live"}
          keys={shown}
          sizeClass={sizeClass}
          fallback={TURN_HEIGHT_GUESS}
          render={renderTurn}
          scroller={list}
          onNearEnd={nearEnd}
          onNearStart={jumping ? nearStart : undefined}
          follow={!jumping}
          reveal={landingTurn}
          revealGap={REVEAL_GAP}
        />
        {reading && <div className="schedule-capped">reading back through what the validator has kept…</div>}
        {finished && (
          <div className="schedule-capped">
            {searching ? "Every match the validator keeps." : "As far back as the validator keeps."}
          </div>
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
    only,
    slow,
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
    /** The filters; rows meeting them are marked and the rest dimmed. */
    only: readonly Only[];
    slow: SlowCutOffs | null;
  }) {
    const alpenglow = useAlpenglow();
    return (
      <div className={`schedule-group${turn.mine ? " is-ours" : ""}${tinted ? " is-tinted" : ""}${now ? " is-now" : ""}`}>
        <TurnLeader turn={turn} peer={peer} totalStake={totalStake} now={now} />
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
              met={only.length === 0 ? null : meets(slot.slot, slot.entry, only, slow) ? only : NO_CONDITIONS}
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
    before.only === after.only &&
    before.slow === after.slow &&
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
}: {
  turn: Turn;
  peer: Peer | undefined;
  totalStake: number | undefined;
  now: boolean;
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
      <span className="schedule-leader-when">{began === null ? "" : blockStamp(began)}</span>
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
          <span className="schedule-leader-time" title={began === null ? undefined : blockStamp(began)}>
            {began === null ? "" : clockTime(began)}
          </span>
        </span>
      </div>
    </div>
  );
}

function Timeline({ entry }: { entry: SlotEntry | null }) {
  const timeline = timelineOf(entry);
  if (!timeline) {
    return (
      <span className="schedule-tl sc-timing">
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
    <span className="schedule-tl sc-timing" title={title}>
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
  met?: readonly Only[] | null;
}) {
  const alpenglow = useAlpenglow();
  const entry = slot.entry;
  const block = entry?.block ?? null;
  // Votes are the block less the rest, clamped since the two counters are differenced separately.
  const votes = block ? Math.max(0, block.transactions - block.non_vote_transactions) : null;
  const filled =
    block && block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null;
  const level = entry?.level ?? "scheduled";

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
      <span className={`sc-status${met?.includes("few_transactions") ? " is-met" : ""}`}>
        {block ? count(block.non_vote_transactions) : "—"}
      </span>
      <span className="sc-fees">{block ? sol(block.total_fees - block.priority_fees, 4) : "—"}</span>
      <span className="sc-fees">{block ? sol(block.priority_fees, 4) : "—"}</span>
      <span className={`sc-fees sc-tips${met?.includes("no_tips") ? " is-met" : ""}`}>
        {/* Absent where tips were never measured; nought is a real reading. */}
        {rates && block?.tips != null ? sol(jitoShare(block.tips, rates), 4) : "—"}
      </span>
      <span className={`sc-timing${met?.includes("slow") ? " is-met" : ""}`}>
        {entry?.duration_nanos == null ? "—" : `${Math.round(entry.duration_nanos / 1e6)} ms`}
      </span>
      <span className="sc-load">
        {entry?.shreds ? count(entry.shreds.count) : "—"}
        {entry?.shreds && entry.shreds.repaired > 0 && (
          <span className="schedule-repaired">
            <Heading wide={`${count(entry.shreds.repaired)} rep`} narrow={`+${count(entry.shreds.repaired)}r`} />
          </span>
        )}
      </span>
      <Timeline entry={entry} />
      <span className="sc-load">
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
