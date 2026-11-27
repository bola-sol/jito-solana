import type { ReactElement, ReactNode } from "react";
import { bytes, count, duration, percent } from "../format";
import { diskAlarm, memoryAlarm } from "../host";
import { followingRun } from "../schedule";
import { agoLabel, snapshotLine } from "../snapshot";
import { catchUpClause, verdictOf } from "../verdict";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";
import { StartupPhases } from "./StartupPhases";

/** The boot sequence, in place of the Overview's panels until the validator is running. */
export function StartupCard(): ReactElement | null {
  const store = useStore();
  const startup = store.get("summary", "startup_progress");
  const gossipStake = store.get("summary", "gossip_stake");
  // The wait's own card carries the stake figure where the validator hands over its handles.
  if (!startup || startup.running) return null;
  return (
    <Card title="Starting up" lit>
      <StartupPhases startup={startup} withStake={!gossipStake} />
    </Card>
  );
}

/** The node's verdict, in the header on every page. */
export function NodeVerdict(): ReactElement {
  const store = useStore();
  const health = store.get("summary", "health");
  const behindCluster = store.get("summary", "behind_cluster");
  const verdict = verdictOf(health, behindCluster, store.get("summary", "completed_slot"));

  return (
    <div className="verdict-hero">
      <p className="verdict">
        <span className={`verdict-dot tone-${verdict.tone}`} aria-hidden="true" />
        {verdict.headline}
      </p>
      <p className="verdict-sub">
        <CatchUp />
        <HostAlarms />
        <Leader />
        <Skips />
        <Repair />
        <Snapshot />
      </p>
    </div>
  );
}

/** Kept whole, so the line breaks only between clauses. */
function Clause({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="verdict-clause">{children}</span>{" "}
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

/** Only once the Host card would show amber or red: a full ledger stops the validator. */
function HostAlarms() {
  const host = useStore().get("summary", "host");
  const disk = diskAlarm(host);
  const memory = memoryAlarm(host);
  return (
    <>
      {disk && (
        <Clause>
          <Explain text={`${disk.filesystem.path}, ${bytes(disk.filesystem.total)} in all.`}>
            {capitalise(disk.filesystem.name)} disk
          </Explain>{" "}
          <b className={`tone-${disk.tone}`}>{percent(disk.share, 0)}</b> full,{" "}
          <b>{bytes(disk.filesystem.available)}</b> left.
        </Clause>
      )}
      {memory && (
        <Clause>
          <b className={`tone-${memory.tone}`}>{percent(memory.available / memory.total, 0)}</b> of{" "}
          <Explain text={`${bytes(memory.available)} of ${bytes(memory.total)} available.`}>memory</Explain>{" "}
          left.
        </Clause>
      )}
    </>
  );
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Leader() {
  const store = useStore();
  const slot = store.get("summary", "completed_slot");
  const nextLeader = store.get("summary", "next_leader_slot");
  const slotDurationNanos = store.get("summary", "estimated_slot_duration_nanos");
  const epoch = store.get("epoch", "new");

  if (nextLeader === null) return <Clause>No leader slots left this epoch.</Clause>;
  if (nextLeader === undefined || slot === undefined || !slotDurationNanos) return null;
  const untilMs = Math.max(0, (nextLeader - slot) * (slotDurationNanos / 1e6));
  if (untilMs === 0) return <Clause>Leader now.</Clause>;
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
      <b>{duration(untilMs, 2)}</b>.
    </Clause>
  );
}

function Skips() {
  const skip = useStore().get("summary", "skip_rate");
  if (!skip || skip.rate === null) return null;
  if (skip.rate === 0) return <Clause>No skips.</Clause>;
  return (
    <Clause>
      Skip rate <b className="tone-warn">{percent(skip.rate)}</b> this epoch.
    </Clause>
  );
}

function Repair() {
  const shreds = useStore().get("summary", "shreds");
  if (!shreds) return null;
  return (
    <Clause>
      <Explain text={`Share of shreds repaired rather than received over turbine, last five minutes: ${count(shreds.repaired)} of ${count(shreds.received)}.`}>
        Repaired
      </Explain>{" "}
      <b className={shreds.repair_rate > 0.05 ? "tone-bad" : undefined}>
        {percent(shreds.repair_rate, 2)}
      </b>
      .
    </Clause>
  );
}

function Snapshot() {
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
      {age ? <b>{age}</b> : <>at slot <b>{count(newest?.slot)}</b></>}.
    </Clause>
  );
}
