import { memo, useEffect, useMemo, useRef, useState } from "react";
import { blockStamp, count, percent, shortKey, sol, solCompact } from "../format";
import { matchesQuery, rewardTitle, SLOTS_PER_TURN, turnKey, turnsOf, type Turn, type TurnSlot } from "../schedule";
import { entriesOf, type SlotRange } from "../slotHistory";
import { timelineOf } from "../timeline";
import { jitoShare } from "../tips";
import type { EpochInfo, Peer, Reward, SlotEntry, StakeSummary, TipRates } from "../types";
import { useStore } from "../useStore";
import { useAlpenglow } from "../consensus";
import { Copyable } from "./Copyable";
import { Logo } from "./Logo";
import { ScrollTop } from "./ScrollTop";

/** What each leader's turn at producing contained, newest first, each turn
 *  drawn whole from its first slot. */
/** Slots asked for each time the reader wants more: a few screenfuls, since
 *  the list is not virtualised. */
const OLDER_SPAN = 512;

/** Turns drawn at once: about fifty DOM elements each, and a thousand is
 *  thirty milliseconds of layout per scroll. Deeper is reached by search. */
const MAX_TURNS = 1000;

/** Slots reached back through when somebody searches: everything the
 *  validator retains, about five megabytes over twenty-five requests. */
const DEPTH_SLOTS = 100_000;

/** Slots per request, the most the validator will answer at once. */
const DEPTH_SPAN = 4096;

export function SchedulePage() {
  const store = useStore();
  const [query, setQuery] = useState("");
  const [oursOnly, setOursOnly] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const stake = store.get<StakeSummary>("summary", "stake");
  const peers = store.get<Peer[]>("peers", "all");
  const epoch = store.get<EpochInfo>("epoch", "new");
  const identity = store.get<string>("summary", "identity_key");
  // Absent on a validator with no tip payment program, and then the tips column
  // shows nothing for anybody rather than a column of noughts.
  const rates = store.get<TipRates>("summary", "tip_rates");
  const live = store.getSlots();

  // Filtering to ours counts as searching: only sixty-four of our own slots
  // are pushed, the rest are in the packed history.
  const searching = query.trim().length > 0 || oursOnly;

  // Everything the validator holds, fetched on the first search and kept
  // apart from the live list so `turnsOf` over it runs once.
  const [deep, setDeep] = useState<SlotEntry[] | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  // Moves whenever a leader could newly resolve, so the memo below re-runs.
  const leaderRevision = store.getLeaderRevision();

  const [older, setOlder] = useState<SlotEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const slots = useMemo(() => [...older, ...live], [older, live]);

  const loadDepth = async () => {
    if (deep !== null || deepLoading) return;
    const newest = live[live.length - 1]?.slot;
    if (newest === undefined) return;
    setDeepLoading(true);
    try {
      const spans: SlotEntry[][] = [];
      const floor = Math.max(0, newest - DEPTH_SLOTS);
      let end = newest;
      while (end > floor) {
        const first = Math.max(floor, end - DEPTH_SPAN);
        const range = await store.request<SlotRange>("slot", "range", {
          first_slot: first,
          count: end - first,
        });
        const got = entriesOf(range, epoch, identity);
        // An empty span is older than the validator has kept, and so is
        // everything below it.
        if (got.length === 0) break;
        spans.unshift(got);
        end = first;
      }
      const all = spans.flat();
      setDeep(all);

      // The history crosses an epoch boundary about a quarter of the time,
      // and the far side needs the previous epoch to name its leaders.
      const oldest = all[0]?.slot;
      if (oldest !== undefined && epoch && oldest < epoch.start_slot) {
        await store.loadEpoch(epoch.epoch - 1);
      }
    } catch {
      // Left unset, so the next search tries again rather than searching a
      // window it cannot see the end of and calling that the answer.
    } finally {
      setDeepLoading(false);
    }
  };

  useEffect(() => {
    if (!searching) return;
    void store.loadDisplays().catch(() => {});
    void loadDepth();
    // Deliberately only the flag: this runs on the first keystroke and not on
    // every one after it, and `loadDepth` guards itself besides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  const loadOlder = async () => {
    if (loading) return;
    const earliest = slots[0]?.slot;
    if (earliest === undefined) return;
    setLoading(true);
    try {
      // Aligned down to a turn boundary so a span never begins mid-turn, and
      // clamped at nought for a cluster young enough that it could go below.
      const first = Math.max(0, Math.floor((earliest - OLDER_SPAN) / SLOTS_PER_TURN) * SLOTS_PER_TURN);
      const range = await store.request<SlotRange>("slot", "range", {
        first_slot: first,
        count: earliest - first,
      });
      const fetched = entriesOf(range, epoch, identity);
      // Nothing came back for any of it, so there is nothing older to ask for
      // and the control stops offering.
      if (fetched.length === 0) setExhausted(true);
      else setOlder((held) => [...fetched, ...held]);
    } catch {
      // A refused or lost request leaves the page as it was. The control stays,
      // so trying again is a click rather than a reload.
    } finally {
      setLoading(false);
    }
  };

  const byIdentity = useMemo(
    () => new Map((peers ?? []).map((peer) => [peer.identity, peer])),
    [peers],
  );

  // Built once when the depth lands, rather than with the list. Its own slots
  // do not change as the chain moves, so this survives every arrival that
  // rebuilds the list below it.
  const deepTurns = useMemo(
    () => (deep === null ? [] : turnsOf(deep, (slot, mine) => store.leaderOf(slot, mine))),
    // The peer table is left out: it changes every few seconds and would
    // rebuild a hundred thousand entries for a handful of names.
    [deep, store, leaderRevision],
  );

  const matched = useMemo(() => {
    const wanted = (turn: Turn) => matchesQuery(turn, query) && (!oursOnly || turn.mine);
    const near = turnsOf(slots, (slot, mine) => store.leaderOf(slot, mine)).filter(wanted);
    if (!searching || deep === null) return near;

    // The list's own turns first, then everything older that matches and is not
    // already among them. The two overlap: the depth reaches up to the live
    // window, and the list has usually loaded some way into it.
    const seen = new Set(near.map(turnKey));
    const far = deepTurns.filter((turn) => !seen.has(turnKey(turn)) && wanted(turn));
    return [...near, ...far].sort(
      (a, b) => (b.slots[0]?.slot ?? 0) - (a.slots[0]?.slot ?? 0),
    );
    // `slots` is a fresh array every render, so this recomputes with the
    // page. Affordable here because the cap bounds it.
  }, [store, slots, deep, deepTurns, searching, query, oursOnly]);

  // Newest first, so the cap keeps the newest and drops the tail. A search that
  // matches more than the page will draw says so rather than quietly showing
  // some of its answer.
  const turns = matched.slice(0, MAX_TURNS);
  const beyondCap = matched.length - turns.length;
  // Counted in slots because that is what a span is asked for in. The live
  // window is part of the total: it is drawn from the same list.
  const atCeiling = slots.length >= MAX_TURNS * SLOTS_PER_TURN;

  return (
    <section className="schedule">
      <div className="schedule-controls">
        <input
          type="search"
          className="schedule-search"
          value={query}
          placeholder="Name, pubkey or slot"
          aria-label="Filter the schedule by leader name, pubkey or slot"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="sidebar-filter" role="group" aria-label="Which leaders to list">
          <button type="button" aria-pressed={!oursOnly} onClick={() => setOursOnly(false)}>
            All
          </button>
          <button type="button" aria-pressed={oursOnly} onClick={() => setOursOnly(true)}>
            Ours
          </button>
        </div>
      </div>

      <div className="schedule-list" ref={list}>
        <ScrollTop scroller={list} />
        {turns.length === 0 && (
          <div className="sidebar-empty">
            {slots.length === 0 ? "waiting for slots…" : "nothing matches that"}
          </div>
        )}
        {turns.map((turn) => (
          <TurnCard
            key={turnKey(turn)}
            turn={turn}
            peer={turn.leader ? byIdentity.get(turn.leader) : undefined}
            totalStake={stake?.total_stake}
            rates={rates}
          />
        ))}
        {deepLoading && (
          <div className="schedule-capped">
            reading back through what the validator has kept…
          </div>
        )}
        {beyondCap > 0 && (
          <div className="schedule-capped">
            {count(turns.length)} of {count(matched.length)} matching turns shown.
            Narrow the search to see the rest.
          </div>
        )}
        {slots.length > 0 && !exhausted && !atCeiling && (
          <button
            type="button"
            className="schedule-older"
            disabled={loading}
            onClick={() => void loadOlder()}
          >
            {loading ? "loading…" : "load earlier turns"}
          </button>
        )}
        {atCeiling && beyondCap === 0 && !searching && (
          <div className="schedule-capped">
            As far back as this list goes. The validator keeps a great deal more;
            search a name, a key or a slot number to reach it.
          </div>
        )}
      </div>
    </section>
  );
}

/** One leader's turn, memoised on its slot entries so a settled turn is
 *  skipped. */
const TurnCard = memo(
  function TurnCard({
    turn,
    peer,
    totalStake,
    rates,
  }: {
    turn: Turn;
    peer: Peer | undefined;
    totalStake: number | undefined;
    rates: TipRates | undefined;
  }) {
    const alpenglow = useAlpenglow();
    return (
      <div className="schedule-group">
        <TurnLeader turn={turn} peer={peer} totalStake={totalStake} />
        <div className="schedule-slots">
          <div className="schedule-row schedule-head">
            <span className="schedule-slot">Slot</span>
            <span>{alpenglow ? "Voted" : "Votes"}</span>
            <span>{alpenglow ? "Transactions" : "Non-votes"}</span>
            <span>Base</span>
            <span>Priority</span>
            <span title="Reaching the distribution account, after jito's cut. Derived, not measured.">
              Tips
            </span>
            <span>Duration</span>
            <span title="Data shreds in the block, and how many were repaired.">
              Shreds
            </span>
            <span title="First shred to block full, then to replay finishing, drawn against one second.">
              Received → replayed
            </span>
            <span>Compute</span>
          </div>
          {turn.slots.map((slot) => (
            <SlotRow key={slot.slot} slot={slot} rates={rates} />
          ))}
        </div>
      </div>
    );
  },
  (before, after) =>
    before.peer === after.peer &&
    before.totalStake === after.totalStake &&
    before.rates === after.rates &&
    before.turn.slots.length === after.turn.slots.length &&
    before.turn.slots.every((slot, index) => slot.entry === after.turn.slots[index]?.entry),
);

/** Leader, name and key, with what is known about the validator behind them. */
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
  // Slots are newest first, so the turn's own first slot is the last one.
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
      {/* Both always drawn, empty or not: the stamp lands once the first slot
          is timed and the peer table on the slow tier, and a turn that grew a
          line when either did would be measured twice. */}
      <span className="schedule-leader-when">{began === null ? "" : blockStamp(began)}</span>
      <div className="schedule-leader-meta">
        {peer?.version && <span className="schedule-version">{peer.version}</span>}
        {peer && peer.stake > 0 && (
          <span>
            {solCompact(peer.stake)} SOL
            {share !== null && <span className="schedule-share">{percent(share, 3)}</span>}
          </span>
        )}
        {peer?.ip && <span className="schedule-ip">{peer.ip}</span>}
      </div>
    </div>
  );
}

/** First shred to full, then to replayed, on a fixed track. Replay's own
 *  thread time is on the hover. */
function Timeline({ entry }: { entry: SlotEntry | null }) {
  const timeline = timelineOf(entry);
  if (!timeline) {
    return (
      <span className="schedule-tl">
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
    <span className="schedule-tl" title={title}>
      <span className="schedule-tl-track" aria-hidden="true">
        <i className="is-wait" style={{ left: 0, width: `${timeline.waitShare * 100}%` }} />
        {timeline.run !== null && (
          <i
            className="is-run"
            style={{ left: `${timeline.waitShare * 100}%`, width: `${timeline.runShare * 100}%` }}
          />
        )}
      </span>
      <span className="schedule-tl-text">{timeline.label}</span>
    </span>
  );
}

/** One slot, empty until it has been produced. */
function SlotRow({ slot, rates }: { slot: TurnSlot; rates: TipRates | undefined }) {
  const alpenglow = useAlpenglow();
  const entry = slot.entry;
  const block = entry?.block ?? null;
  // Votes are what is left of the block once the rest is taken out. Clamped
  // because the two counters are differenced independently and a bank whose
  // parent has gone reports neither.
  const votes = block ? Math.max(0, block.transactions - block.non_vote_transactions) : null;
  const filled =
    block && block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : null;
  const level = entry?.level ?? "scheduled";

  return (
    <div className={`schedule-row level-${level}`}>
      <span className="schedule-slot">
        {count(slot.slot)}
        <span className={`schedule-level level-${level}`} title={level.replace(/_/g, " ")} />
      </span>
      {alpenglow ? (
        <VoteMark reward={entry?.reward ?? null} />
      ) : (
        <span>{votes === null ? "—" : count(votes)}</span>
      )}
      <span>{block ? count(block.non_vote_transactions) : "—"}</span>
      <span>{block ? sol(block.total_fees - block.priority_fees, 4) : "—"}</span>
      <span>{block ? sol(block.priority_fees, 4) : "—"}</span>
      <span>
        {/* Absent where the tip program is not configured or the slot was never
            measured. Nought is a real reading and draws as nought: it says the
            searchers passed that leader by. */}
        {rates && block?.tips != null ? sol(jitoShare(block.tips, rates), 4) : "—"}
      </span>
      <span>
        {entry?.duration_nanos == null ? "—" : `${Math.round(entry.duration_nanos / 1e6)} ms`}
      </span>
      <span>
        {entry?.shreds ? count(entry.shreds.count) : "—"}
        {entry?.shreds && entry.shreds.repaired > 0 && (
          <span className="schedule-repaired">{count(entry.shreds.repaired)} rep</span>
        )}
      </span>
      <Timeline entry={entry} />
      <span>
        {block ? count(block.block_cost) : "—"}
        {filled !== null && <span className="schedule-fill">{percent(filled, 0)}</span>}
      </span>
    </div>
  );
}

/** Under alpenglow, whether this node's vote was paid for the slot. */
function VoteMark({ reward }: { reward: Reward | null }) {
  const [glyph, tone] =
    reward === "paid"
      ? ["✓", "is-yes"]
      : reward === "unpaid"
        ? ["✗", "is-no"]
        : reward === "no_certificate"
          ? ["○", "is-none"]
          : ["–", "is-unknown"];
  return (
    <span className="vote-marks" title={rewardTitle(reward)}>
      <i className={`vote-mark ${tone}`}>{glyph}</i>
    </span>
  );
}
