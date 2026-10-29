import type { ReactElement, ReactNode } from "react";
import { count, duration, percent } from "../format";
import { followingRun } from "../schedule";
import { agoLabel, snapshotLine } from "../snapshot";
import { catchUpClause, verdictOf } from "../verdict";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";
import { StartupPhases } from "./StartupPhases";

/** A catch-up clause short of an hour, held in reserve on phones so a moment behind does not push
 *  the page down. */
const CATCH_UP_ROOM = `Catching up, ${duration(3_599_000, 2)} to go.`;

/** The reserve draws each changing figure at its widest, so a countdown or an age growing does not
 *  push the page down either. The figures are monospaced, so any value up to these fits. */
const ROOM_COUNTDOWN = duration(86_399_000, 2);
const ROOM_AGE = agoLabel(3_540_000);
const ROOM_PERCENT = percent(0.1);

export function Verdict(): ReactElement {
  const store = useStore();
  const startup = store.get("summary", "startup_progress");
  const gossipStake = store.get("summary", "gossip_stake");

  // Nothing to say until the validator is running. The wait's own card
  // carries the stake figure where the validator hands over its handles.
  if (startup && !startup.running) {
    return (
      <Card title="Starting up" lit>
        <StartupPhases startup={startup} withStake={!gossipStake} />
      </Card>
    );
  }

  const health = store.get("summary", "health");
  const behindCluster = store.get("summary", "behind_cluster");
  const verdict = verdictOf(health, behindCluster, store.get("summary", "completed_slot"));

  return (
    <div className="verdict-hero">
      <h1 className="verdict">
        <span className={`verdict-dot tone-${verdict.tone}`} aria-hidden="true" />
        {verdict.headline}
      </h1>
      <p className="verdict-sub">
        <span>
          <CatchUp />
          <Clauses />
        </span>
        <span className="verdict-sub-room" aria-hidden="true">
          <Clause>{CATCH_UP_ROOM}</Clause>
          <Clauses room />
        </span>
      </p>
    </div>
  );
}

/** Kept whole, so the line breaks only between clauses and grows only when one gets wider, which
 *  is what lets the reserve bound it. */
function Clause({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="verdict-clause">{children}</span>{" "}
    </>
  );
}

/** Everything on the line after the catch-up clause; `room` draws the reserve. */
function Clauses({ room = false }: { room?: boolean }) {
  return (
    <>
      <Leader room={room} />
      <Skips room={room} />
      <Repair room={room} />
      <Snapshot room={room} />
    </>
  );
}

function CatchUp() {
  const store = useStore();
  const clause = catchUpClause(
    store.get("summary", "behind_cluster"),
    store.get("summary", "replay_rate"),
    store.get("summary", "estimated_slot_duration_nanos"),
  );
  if (clause === null) return null;
  return <Clause>{clause}</Clause>;
}

function Leader({ room }: { room: boolean }) {
  const store = useStore();
  const slot = store.get("summary", "completed_slot");
  const nextLeader = store.get("summary", "next_leader_slot");
  const slotDurationNanos = store.get("summary", "estimated_slot_duration_nanos");
  const epoch = store.get("epoch", "new");

  if (nextLeader === null) return <Clause>No leader slots left this epoch.</Clause>;
  if (nextLeader === undefined || slot === undefined || !slotDurationNanos) return null;
  const untilMs = Math.max(0, (nextLeader - slot) * (slotDurationNanos / 1e6));
  if (untilMs === 0 && !room) return <Clause>Leader now.</Clause>;
  const following = epoch ? followingRun(epoch.my_leader_slots, nextLeader) : null;
  const then =
    following === null
      ? epoch
        ? " The last this epoch."
        : ""
      : ` Following turn in ${duration((following - slot) * (slotDurationNanos / 1e6), 2)}, slot ${count(following)}.`;
  return (
    <Clause>
      <Explain text={`Slot ${count(nextLeader)}.${then}`}>Leading</Explain> in{" "}
      <b>{room ? ROOM_COUNTDOWN : duration(untilMs, 2)}</b>.
    </Clause>
  );
}

function Skips({ room }: { room: boolean }) {
  const skip = useStore().get("summary", "skip_rate");
  if (!skip || skip.rate === null) return null;
  if (skip.rate === 0) return <Clause>No skips.</Clause>;
  return (
    <Clause>
      Skip rate <b className="tone-warn">{room ? ROOM_PERCENT : percent(skip.rate)}</b> this epoch.
    </Clause>
  );
}

function Repair({ room }: { room: boolean }) {
  const shreds = useStore().get("summary", "shreds");
  if (!shreds) return null;
  return (
    <Clause>
      <Explain text={`Share of shreds repaired rather than received over turbine, last five minutes: ${count(shreds.repaired)} of ${count(shreds.received)}.`}>
        Repaired
      </Explain>{" "}
      <b className={shreds.repair_rate > 0.05 ? "tone-bad" : undefined}>
        {room ? ROOM_PERCENT : percent(shreds.repair_rate, 2)}
      </b>
      .
    </Clause>
  );
}

function Snapshot({ room }: { room: boolean }) {
  const store = useStore();
  const snapshots = store.get("summary", "snapshots");
  const serverTimeNanos = store.get("summary", "server_time_nanos");
  const blockHeight = store.get("summary", "block_height");
  const slotDurationNanos = store.get("summary", "estimated_slot_duration_nanos");
  if (!snapshots) return null;
  const line = snapshotLine(
    snapshots,
    serverTimeNanos === undefined ? undefined : serverTimeNanos / 1e6,
    blockHeight,
    slotDurationNanos === undefined ? undefined : slotDurationNanos / 1e6,
  );
  if (!line) return null;
  const newest = snapshots.incremental ?? snapshots.full;
  const age =
    newest?.written_millis != null && serverTimeNanos !== undefined
      ? agoLabel(Math.max(0, serverTimeNanos / 1e6 - newest.written_millis))
      : null;
  const text = line.title ? `${line.detail}. ${line.title}` : line.detail;
  return (
    <Clause>
      {/* A bubble rather than a title, which is redrawn on every change. */}
      <Explain text={text}>Snapshot</Explain>{" "}
      {age ? <b>{room ? ROOM_AGE : age}</b> : <>at slot <b>{count(newest?.slot)}</b></>}.
    </Clause>
  );
}
