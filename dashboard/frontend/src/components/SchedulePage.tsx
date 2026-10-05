import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { blockStamp, buildLabel, count, percent, shortKey, sol, solCompact } from "../format";
import {
  certificateAt,
  certificateText,
  certificateTitle,
  matchesQuery,
  rewardTitle,
  SLOTS_PER_TURN,
  type Certificate,
  type Turn,
  type TurnSlot,
} from "../schedule";
import type { SlotRange } from "../slotHistory";
import type { Store } from "../store";
import { timelineOf } from "../timeline";
import { jitoShare } from "../tips";
import { readScheduleColumns, SCHEDULE_COLUMNS, writeScheduleColumns, type ScheduleColumns } from "../layout";
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
const TURN_HEIGHT_GUESS = 170;

/** How long a failed fetch waits before scrolling may ask again. */
const RETRY_AFTER_MS = 5000;

/** A search is sent once typing pauses this long. */
const SEARCH_PAUSE_MS = 250;

const COLUMN_NAMES: Record<ScheduleColumns, string> = {
  status: "Status",
  fees: "Fees",
  timing: "Timing",
  load: "Load",
};

const NO_CERTIFICATES: readonly Certificate[] = [];

function fetchSpan(store: Store, first: number, count: number): Promise<SlotRange> {
  return store.request("slot.range", { first_slot: first, count });
}

function samePeer(a: Peer, b: Peer): boolean {
  return (
    a.stake === b.stake &&
    a.version === b.version &&
    a.client === b.client &&
    a.ip === b.ip &&
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

export function SchedulePage({
  query,
  ours: oursOnly,
  onFilter,
}: {
  query: string;
  ours: boolean;
  onFilter: (query: string, ours: boolean) => void;
}): ReactElement {
  const store = useStore();
  const alpenglow = useAlpenglow();
  const list = useRef<HTMLDivElement>(null);

  const stake = store.get("summary", "stake");
  const peers = store.get("peers", "all");
  const epoch = store.get("epoch", "new");
  const identity = store.get("summary", "identity_key");
  const rates = store.get("summary", "tip_rates");
  const [columns, setColumns] = useState(readScheduleColumns);
  const live = store.getSlots();
  // Moves whenever a leader could newly resolve.
  const leaderRevision = store.getLeaderRevision();

  // Filtering to ours counts as searching: only sixty-four of our own slots are pushed, the rest are
  // in the history.
  const searching = query.trim().length > 0 || oursOnly;

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
  const [asked, setAsked] = useState({ query: query.trim(), ours: oursOnly });
  useEffect(() => {
    const timer = setTimeout(() => setAsked({ query: query.trim(), ours: oursOnly }), SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [query, oursOnly]);

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
        });
        results.add(reply.turns, reply.next, epoch, identity);
      } catch {
        failedAt.current = Date.now();
      } finally {
        results.loading = false;
        setFoundPages((was) => was + 1);
      }
    },
    [store, epoch, identity],
  );

  // A new search starts below the live window's first turn and reads down a page at a time.
  useEffect(() => {
    if ((!asked.query && !asked.ours) || liveStartTurn === null) {
      setFound(null);
      return;
    }
    const results = new FoundTurns(asked.query, asked.ours, liveStartTurn * SLOTS_PER_TURN);
    setFound(results);
    void loadFound(results);
  }, [asked, liveStartTurn, loadFound]);

  // Turns keep their objects while their leader answers the same.
  useMemo(() => {
    index.relabel();
    found?.relabel(leaderOf);
  }, [index, found, leaderOf, leaderRevision]);

  const shown = useMemo(() => {
    if (!searching) return numbers;
    const live = index.liveNumbers().filter((number) => {
      const turn = index.turn(number);
      return turn !== undefined && matchesQuery(turn, query) && (!oursOnly || turn.mine);
    });
    return [...live, ...(found?.numbers() ?? [])];
    // `foundPages` stands for the results, which change in place.
  }, [index, numbers, found, foundPages, leaderRevision, searching, query, oursOnly]);

  const byIdentity = useStablePeers(peers);
  const turnOf = useCallback(
    (number: number) =>
      searching && found && liveStartTurn !== null && number < liveStartTurn
        ? found.turn(number, leaderOf)
        : index.turn(number),
    [searching, found, liveStartTurn, index, leaderOf],
  );
  const entryOf = useCallback((slot: number) => index.entry(slot) ?? found?.entry(slot), [index, found]);
  const sizeClass = useCallback(
    (number: number) =>
      searching && found && liveStartTurn !== null && number < liveStartTurn ? found.rowCount(number) : index.rowCount(number),
    [searching, found, liveStartTurn, index],
  );
  const nearEnd = useCallback(() => {
    if (searching) {
      if (found) void loadFound(found);
    } else {
      void loadOlder();
    }
  }, [searching, found, loadFound, loadOlder]);

  const renderTurn = (number: number): ReactElement | null => {
    const turn = turnOf(number);
    if (!turn) return null;
    return (
      <TurnCard
        turn={turn}
        peer={turn.leader ? byIdentity.get(turn.leader) : undefined}
        totalStake={stake?.total_stake}
        rates={rates}
        certificates={alpenglow ? turn.slots.map((slot) => certificateAt(slot.slot, entryOf)) : NO_CERTIFICATES}
      />
    );
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
          onChange={(event) => onFilter(event.target.value, oursOnly)}
        />
        <div className="sidebar-filter" role="group" aria-label="Which leaders to list">
          <button type="button" aria-pressed={!oursOnly} onClick={() => onFilter(query, false)}>
            All
          </button>
          <button type="button" aria-pressed={oursOnly} onClick={() => onFilter(query, true)}>
            Ours
          </button>
        </div>
      </div>
      {/* Shown only where the table is too wide to fit, which the stylesheet decides. */}
      <div className="schedule-columns" role="group" aria-label="Which columns to show">
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

      <div className="schedule-list" ref={list}>
        <ScrollTop scroller={list} hold={false} />
        {shown.length === 0 && !reading && (searching ? found !== null : true) && (
          <div className="sidebar-empty">{live.length === 0 ? "waiting for slots…" : "nothing matches that"}</div>
        )}
        <VirtualList
          keys={shown}
          sizeClass={sizeClass}
          fallback={TURN_HEIGHT_GUESS}
          render={renderTurn}
          scroller={list}
          onNearEnd={nearEnd}
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
  }: {
    turn: Turn;
    peer: Peer | undefined;
    totalStake: number | undefined;
    rates: TipRates | undefined;
    /** Each row's certificate, in the rows' order; empty before alpenglow. */
    certificates: readonly Certificate[];
  }) {
    const alpenglow = useAlpenglow();
    return (
      <div className={`schedule-group${turn.mine ? " is-ours" : ""}`}>
        <TurnLeader turn={turn} peer={peer} totalStake={totalStake} />
        <div className={`schedule-slots${alpenglow ? " has-certificate" : ""}`}>
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
            <span className="sc-timing">Duration</span>
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
          {turn.slots.map((slot, row) => (
            <SlotRow key={slot.slot} slot={slot} rates={rates} certificate={certificates[row]} />
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
    before.certificates.length === after.certificates.length &&
    before.certificates.every((certificate, row) => certificate === after.certificates[row]),
);

function TurnLeader({
  turn,
  peer,
  totalStake,
}: {
  turn: Turn;
  peer: Peer | undefined;
  totalStake: number | undefined;
}) {
  // Missing rather than zero when the table has not caught up with a leader
  // that has only just come into view.
  const share = peer && totalStake ? peer.stake / totalStake : null;
  const began = turn.slots[turn.slots.length - 1]?.entry?.time_millis ?? null;

  return (
    <div className="schedule-leader">
      <div className="schedule-leader-name">
        <Logo url={turn.leader_icon} size={16} />
        {turn.leader_name ?? (turn.leader ? shortKey(turn.leader, 6, 5) : "unknown")}
        {turn.mine && <span className="schedule-mine">ours</span>}
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
      <div className="schedule-leader-meta">
        <span className="schedule-version">
          {peer?.version ? buildLabel(peer.client ?? undefined, peer.version) : ""}
        </span>
        <span>
          {peer && peer.stake > 0 && (
            <>
              {solCompact(peer.stake)} SOL
              {share !== null && <span className="schedule-share">{percent(share, 3)}</span>}
            </>
          )}
        </span>
        <span className="schedule-ip" title={peer?.ip ?? undefined}>
          {peer?.ip ?? ""}
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
}: {
  slot: TurnSlot;
  rates: TipRates | undefined;
  certificate: Certificate;
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
    <div className={`schedule-row level-${level}`}>
      <span className="schedule-slot">
        {entry?.mine ? <SlotLink slot={slot.slot} /> : count(slot.slot)}
        <span className={`schedule-level level-${level}`} title={level.replace(/_/g, " ")} />
      </span>
      {alpenglow ? (
        <VoteMark reward={entry?.reward ?? null} />
      ) : (
        <span className="sc-status">{votes === null ? "—" : count(votes)}</span>
      )}
      {alpenglow && <CertificateCell certificate={certificate} />}
      <span className="sc-status">{block ? count(block.non_vote_transactions) : "—"}</span>
      <span className="sc-fees">{block ? sol(block.total_fees - block.priority_fees, 4) : "—"}</span>
      <span className="sc-fees">{block ? sol(block.priority_fees, 4) : "—"}</span>
      <span className="sc-fees sc-tips">
        {/* Absent where tips were never measured; nought is a real reading. */}
        {rates && block?.tips != null ? sol(jitoShare(block.tips, rates), 4) : "—"}
      </span>
      <span className="sc-timing">
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
