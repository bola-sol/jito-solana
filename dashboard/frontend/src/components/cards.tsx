import type { CSSProperties, ReactElement } from "react";
import { count, decimal, duration, percent, solCompact } from "../format";
import { readoutMean, READOUT_SECONDS } from "../matrix";
import { creditsShare } from "../credits";
import { leaderSlotsLeft } from "../schedule";
import type { EpochInfo } from "../types";
import { STAKE_TICKS, stakeTicks } from "../stake";
import { useAlpenglow } from "../consensus";
import { useNarrow } from "../narrow";
import { useStore } from "../useStore";
import { Card, Explain, Meter, Stat } from "./primitives";
import { TpsMatrix } from "./TpsMatrix";

export function EpochCard(): ReactElement {
  const store = useStore();
  const epoch = store.get("epoch", "new");
  const slot = store.get("summary", "completed_slot");
  // Sent by the server, which measures the slot rate and holds the answer
  // still unless it really moves.
  const remainingNanos = store.get("summary", "epoch_remaining_nanos");

  if (!epoch) return <Card title="This epoch">{waiting}</Card>;

  const completed = slot ?? epoch.start_slot;
  const elapsed = Math.max(0, completed - epoch.start_slot);
  const progress = elapsed / Math.max(1, epoch.slots_in_epoch);
  const remainingMs = remainingNanos === undefined ? undefined : remainingNanos / 1e6;
  const left = leaderSlotsLeft(epoch.my_leader_slots, completed);

  return (
    <Card title="This epoch" aside={count(epoch.epoch)} className="epoch-body">
      <div className="stat-grid">
        <Stat label="until the next epoch" value={duration(remainingMs)} />
        <Stat
          label={`of our leader slots left, ${count(epoch.my_leader_slots.length)} this epoch`}
          value={count(left)}
        />
        <VoteCreditsStat epoch={epoch} completed={completed} />
      </div>
      <Meter fraction={progress} />
      <div className="card-footnote">
        slot {count(elapsed)} of {count(epoch.slots_in_epoch)}
      </div>
    </Card>
  );
}

/** Vote credits this epoch. Under TowerBFT as a share of the most the slots
 *  so far could have paid; under alpenglow the count alone, whose ceiling is
 *  not known here. Absent until the vote account has been read. */
function VoteCreditsStat({ epoch, completed }: { epoch: EpochInfo; completed: number }) {
  const credits = useStore().get("summary", "vote_credits");
  const alpenglow = useAlpenglow();
  if (!credits || credits.epoch !== epoch.epoch) return null;
  const share = alpenglow
    ? null
    : creditsShare(credits.credits, completed - epoch.start_slot, credits.max_per_slot);
  if (share === null) {
    return <Stat label="vote credits this epoch" value={count(credits.credits)} />;
  }
  return (
    <Stat
      label={`of the most vote credits this epoch could pay so far, ${count(credits.credits)} earned`}
      value={percent(share, 1)}
    />
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

/** The cluster this validator is one of: its stake, and how much of it is
 *  keeping up. */
export function ClusterCard(): ReactElement {
  const store = useStore();
  const counts = store.get("summary", "validator_counts");
  if (!counts) return <Card title="Cluster">{waiting}</Card>;

  const total = counts.non_delinquent_stake + counts.delinquent_stake;
  const delinquent = total === 0 ? 0 : counts.delinquent_stake / total;

  return (
    <Card title="Cluster" className="validators-body">
      <div className="stat-grid">
        <Stat label="active stake, SOL" value={solCompact(counts.non_delinquent_stake)} />
        <Stat
          label={`delinquent, ${solCompact(counts.delinquent_stake)} SOL`}
          value={percent(delinquent)}
          tone={counts.delinquent_stake > 0 ? "bad" : undefined}
          explain="Stake of validators whose last vote is more than 128 slots behind this node's own bank."
        />
        <Stat
          label={`validators voting, ${count(counts.delinquent)} delinquent`}
          value={
            <>
              {count(counts.total - counts.delinquent)}{" "}
              <small className="stat-of">of {count(counts.total)}</small>
            </>
          }
        />
        <Stat
          label="nodes advertising RPC"
          value={count(counts.rpc_nodes)}
          explain="Peers advertising an RPC address in gossip on this shred version."
        />
      </div>
      <div className="stake-share">
        <StakeStrip delinquent={counts.delinquent_stake} total={total} />
        <div className="stake-share-key">each tick is 2% of staked SOL</div>
      </div>
    </Card>
  );
}

/** Throughput now and the shape of the last minute. The figures are the
 *  chart's key, each in its series' colour. */
export function TransactionsCard(): ReactElement {
  const store = useStore();
  const alpenglow = useAlpenglow();
  const samples = store.getTps();
  const tps = readoutMean(samples);
  const narrow = useNarrow();
  const peak = samples.length > 0 ? Math.max(...samples.map((sample) => sample.total)) : null;

  const figures = (
    <div className="tps-rows">
      {!alpenglow && <SeriesRow label="vote" series="vote" value={decimal(tps?.vote)} />}
      <SeriesRow
        label={alpenglow ? "failed" : "non-vote failed"}
        series="failed"
        value={decimal(tps?.non_vote_failed)}
      />
      <SeriesRow
        label={alpenglow ? "succeeded" : "non-vote succeeded"}
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
          <div className="tps-total-value">{decimal(tps?.total)}</div>
          <div className="tps-total-label">
            <Explain
              text={
                alpenglow
                  ? "Transactions confirmed per second, averaged over the newest samples."
                  : "Transactions confirmed per second, averaged over the newest samples, with votes as the base of each column."
              }
            >
              per second, {READOUT_SECONDS}s mean
            </Explain>
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
