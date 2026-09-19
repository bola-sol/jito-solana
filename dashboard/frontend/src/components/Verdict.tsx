import type { ReactElement } from "react";
import { count, duration, percent } from "../format";
import { agoLabel, snapshotLine } from "../snapshot";
import { verdictOf } from "../verdict";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";
import { StartupPhases } from "./StartupPhases";

/** One sentence on what the validator is doing, and one on what is coming.
 *  While the validator boots, the boot sequence stands in for both. */
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
  const verdict = verdictOf(health, behindCluster);

  return (
    <>
      <h1 className="verdict">
        <span className={`verdict-dot tone-${verdict.tone}`} aria-hidden="true" />
        {verdict.headline}
      </h1>
      <p className="verdict-sub">
        <Leader />
        <Skips />
        <Repair />
        <Snapshot />
      </p>
    </>
  );
}

/** When this validator next leads, from its slot and the measured slot rate. */
function Leader() {
  const store = useStore();
  const slot = store.get("summary", "completed_slot");
  const nextLeader = store.get("summary", "next_leader_slot");
  const slotDurationNanos = store.get("summary", "estimated_slot_duration_nanos");

  if (nextLeader === null) return <>No leader slots left this epoch. </>;
  if (nextLeader === undefined || slot === undefined || !slotDurationNanos) return null;
  const untilMs = Math.max(0, (nextLeader - slot) * (slotDurationNanos / 1e6));
  if (untilMs === 0) return <>Leader now. </>;
  return (
    <>
      <Explain text={`Slot ${count(nextLeader)}.`}>Leader again</Explain> in{" "}
      <b>{duration(untilMs)}</b>.{" "}
    </>
  );
}

/** Blocks this validator was scheduled for and did not produce, this epoch. */
function Skips() {
  const skip = useStore().get("summary", "skip_rate");
  if (!skip || skip.rate === null) return null;
  if (skip.rate === 0) return <>No skips this epoch. </>;
  return (
    <>
      Skip rate <b className="tone-warn">{percent(skip.rate)}</b> this epoch.{" "}
    </>
  );
}

/** Shreds that had to be asked for rather than arriving over turbine. */
function Repair() {
  const shreds = useStore().get("summary", "shreds");
  if (!shreds) return null;
  return (
    <>
      <Explain text={`Share of shreds repaired rather than received over turbine, last five minutes: ${count(shreds.repaired)} of ${count(shreds.received)}.`}>
        Repaired shreds
      </Explain>{" "}
      <b className={shreds.repair_rate > 0.05 ? "tone-bad" : undefined}>
        {percent(shreds.repair_rate, 2)}
      </b>
      .{" "}
    </>
  );
}

/** The newest archive's age, with the slots and what is due next behind it. */
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
    <>
      {/* A bubble rather than a title, which is redrawn on every change. */}
      <Explain text={text}>Snapshot</Explain>{" "}
      {age ? <b>{age}</b> : <>at slot <b>{count(newest?.slot)}</b></>}.
    </>
  );
}
