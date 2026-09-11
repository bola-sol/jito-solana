import type { CSSProperties } from "react";
import { count, decimal, duration, percent, solCompact } from "../format";
import { readoutMean, READOUT_SECONDS } from "../matrix";
import { STAKE_TICKS, stakeTicks } from "../stake";
import { useAlpenglow } from "../consensus";
import type {
  EpochInfo,
  Health,
  Shreds,
  SkipRate,
  StartupProgress,
  ValidatorCounts,
} from "../types";
import { useNarrow } from "../narrow";
import { useStore } from "../useStore";
import { Card, Explain, Meter, Stat } from "./primitives";
import { StartupPhases } from "./StartupPhases";
import { TpsMatrix } from "./TpsMatrix";

export function EpochCard() {
  const store = useStore();
  const epoch = store.get<EpochInfo>("epoch", "new");
  const slot = store.get<number>("summary", "completed_slot");
  // Sent by the server, which measures the slot rate and holds the answer
  // still unless it really moves.
  const remainingNanos = store.get<number>("summary", "epoch_remaining_nanos");

  if (!epoch) return <Card title="Epoch">{waiting}</Card>;

  const elapsed = Math.max(0, (slot ?? epoch.start_slot) - epoch.start_slot);
  const progress = elapsed / Math.max(1, epoch.slots_in_epoch);
  const remainingMs = remainingNanos === undefined ? undefined : remainingNanos / 1e6;

  return (
    <Card title="Epoch" className="epoch-body">
      <Stat label="Current Epoch" value={count(epoch.epoch)} />
      <Stat label="Time to Next Epoch" value={duration(remainingMs)} />
      <Meter fraction={progress} />
      <div className="card-footnote">
        slot {count(elapsed)} of {count(epoch.slots_in_epoch)} · {count(epoch.my_leader_slots.length)}{" "}
        leader slots this epoch
      </div>
    </Card>
  );
}

export function StatusCard() {
  const store = useStore();
  const slot = store.get<number>("summary", "completed_slot");
  const blockHeight = store.get<number>("summary", "block_height");
  const nextLeader = store.get<number | null>("summary", "next_leader_slot");
  const health = store.get<Health>("summary", "health");
  const behindCluster = store.get<number | null>("summary", "behind_cluster");
  const slotDurationNanos = store.get<number>("summary", "estimated_slot_duration_nanos");
  const startup = store.get<StartupProgress>("summary", "startup_progress");
  const skip = store.get<SkipRate>("summary", "skip_rate");
  const shreds = store.get<Shreds | null>("summary", "shreds");

  // The leader countdown means nothing until the validator is running, so show
  // where it has got to in its boot sequence instead.
  if (startup && !startup.running) {
    return (
      <Card title="Status" lit>
        <StartupPhases startup={startup} />
      </Card>
    );
  }

  const untilLeaderMs =
    nextLeader !== null && nextLeader !== undefined && slot !== undefined && slotDurationNanos
      ? Math.max(0, (nextLeader - slot) * (slotDurationNanos / 1e6))
      : undefined;

  return (
    <Card title="Status">
      <div className="stat-grid">
        <Stat label="Slot" value={count(slot)} />
        <Stat label="Time until leader" value={duration(untilLeaderMs)} />
        <Stat label="Block height" value={count(blockHeight)} />
        <Stat
          label="Vote Status"
          value={health?.vote === "not_voting" ? "not voting" : (health?.vote ?? "—")}
          // How far replay trails the cluster. Untoned: the status word above
          // carries the colour.
          sub={
            behindCluster === null || behindCluster === undefined
              ? undefined
              : `${count(behindCluster)} behind cluster`
          }
          // Amber rather than red. A validator on its backup identity is meant
          // to be here, so this is not a fault; it is worth noticing, which
          // grey would not manage on an operator who thinks they are voting.
          tone={
            health?.vote === "voting"
              ? "good"
              : health?.vote === "delinquent"
                ? "bad"
                : health?.vote === "not_voting"
                  ? "warn"
                  : "muted"
          }
          explain="Whether this process is voting. A node running its backup identity reads not voting."
        />
        <Stat
          label="Next leader slot"
          value={nextLeader === null || nextLeader === undefined ? "—" : count(nextLeader)}
        />
        <Stat
          label="Replay"
          value={health?.replay ?? "—"}
          tone={health?.replay === "running" ? "good" : "bad"}
        />
        <Stat label="Skip rate" value={percent(skip?.rate)} />
        <Stat
          label="Repaired shreds"
          explain="Share of shreds repaired rather than received over turbine, last five minutes."
          value={percent(shreds?.repair_rate ?? null, 2)}
          sub={shreds ? `${count(shreds.repaired)} of ${count(shreds.received)}` : undefined}
          tone={shreds && shreds.repair_rate > 0.05 ? "bad" : undefined}
        />
      </div>
    </Card>
  );
}

/** Staked SOL as fifty ticks, the delinquent share eating them from the
 *  right. Ticks show a share too small for an arc. */
function StakeStrip({ delinquent, total }: { delinquent: number; total: number }) {
  const { full, partial } = stakeTicks(delinquent, total);

  return (
    <div className="stake-strip" aria-hidden="true">
      {Array.from({ length: STAKE_TICKS }, (_unused, index) => {
        const fromRight = STAKE_TICKS - 1 - index;
        if (fromRight < full) return <i key={index} className="is-delinquent" />;
        if (fromRight === full && partial > 0) {
          return (
            <i
              key={index}
              className="is-part"
              // Filled upwards: a fraction of a tick's width is a smudge, of
              // its height a mark.
              style={{ "--fill": `${partial * 100}%` } as CSSProperties}
            />
          );
        }
        return <i key={index} />;
      })}
    </div>
  );
}

export function ValidatorsCard() {
  const store = useStore();
  const counts = store.get<ValidatorCounts>("summary", "validator_counts");
  if (!counts) return <Card title="Validators">{waiting}</Card>;

  const total = counts.non_delinquent_stake + counts.delinquent_stake;
  const healthy = total === 0 ? 0 : counts.non_delinquent_stake / total;

  return (
    <Card title="Validators" className="validators-body">
      <div className="stat-grid">
        <Stat label="Active Stake" value={solCompact(counts.non_delinquent_stake)} sub="SOL" />
        <Stat
          label="Delinquent Stake"
          value={solCompact(counts.delinquent_stake)}
          sub="SOL"
          tone={counts.delinquent_stake > 0 ? "bad" : undefined}
          explain="Stake of validators whose last vote is more than 128 slots behind this node's own bank."
        />
        <Stat
          label="Validators"
          value={
            <>
              {count(counts.total - counts.delinquent)}{" "}
              <small className="stat-of">/ {count(counts.total)}</small>
            </>
          }
          sub={`${count(counts.delinquent)} delinquent`}
        />
        <Stat
          label="RPC Nodes"
          value={count(counts.rpc_nodes)}
          sub="advertising RPC"
          explain="Peers advertising an RPC address in gossip on this shred version."
        />
      </div>
      <div className="stake-share">
        <div className="stake-share-head">
          <span>Stake active</span>
          <b>{percent(healthy)}</b>
        </div>
        <StakeStrip delinquent={counts.delinquent_stake} total={total} />
        <div className="stake-share-key">
          Each tick 2% of staked SOL
          {counts.delinquent_stake > 0 && (
            <>
              {" · "}
              <em>{percent(1 - healthy)} delinquent</em>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Throughput now and the shape of the last minute. The figures are the
 *  chart's key, each in its series' colour. */
export function TransactionsCard() {
  const store = useStore();
  const alpenglow = useAlpenglow();
  const samples = store.getTps();
  const tps = readoutMean(samples);
  const narrow = useNarrow();
  const peak = samples.length > 0 ? Math.max(...samples.map((sample) => sample.total)) : null;

  const figures = (
    <div className="tps-rows">
      {!alpenglow && <SeriesRow label="Vote" series="vote" value={decimal(tps?.vote)} />}
      <SeriesRow
        label={alpenglow ? "Failed" : "Non-vote failed"}
        series="failed"
        value={decimal(tps?.non_vote_failed)}
      />
      <SeriesRow
        label={alpenglow ? "Succeeded" : "Non-vote ok"}
        series="success"
        value={decimal(tps?.non_vote_success)}
      />
      <div className="tps-row is-peak">
        <span className="tps-name">
          <Explain text="The busiest second in the window, which sets the top of the grid.">
            60s peak
          </Explain>
        </span>
        <span className="tps-value">{peak === null ? "—" : decimal(peak, 0)}</span>
      </div>
    </div>
  );

  return (
    <Card title="Transactions" aside="last 60s" className="transactions-body">
      <div className="tps-readout">
        <div className="tps-total">
          <div className="tps-total-label">
            <Explain
              text={
                alpenglow
                  ? "Transactions confirmed per second, averaged over the newest samples."
                  : "Transactions confirmed per second, averaged over the newest samples, with votes as the base of each column."
              }
            >
              Total TPS
            </Explain>
          </div>
          <div className="tps-total-value">
            {decimal(tps?.total)}
            <span className="tps-total-unit">{READOUT_SECONDS}s mean</span>
          </div>
        </div>
        {!narrow && figures}
      </div>
      <div className="tps-plot">
        <TpsMatrix samples={samples} short={narrow} />
      </div>
      {narrow && figures}
    </Card>
  );
}

/** One series, named in the colour it is lit in. */
function SeriesRow({
  label,
  series,
  value,
}: {
  label: string;
  series: "vote" | "failed" | "success";
  value: string;
}) {
  return (
    <div className="tps-row">
      <span className="tps-name">
        <i className={`tps-swatch is-${series}`} aria-hidden="true" />
        {label}
      </span>
      <span className={`tps-value is-${series}`}>{value}</span>
    </div>
  );
}

const waiting = <div className="card-footnote">waiting for data…</div>;
