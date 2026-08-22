import { count, decimal, duration, percent, solCompact } from "../format";
import type {
  EpochInfo,
  Health,
  Shreds,
  SkipRate,
  StartupProgress,
  Tps,
  ValidatorCounts,
} from "../types";
import { useStore } from "../useStore";
import { Card, Donut, Meter, Stat } from "./primitives";
import { StartupPhases } from "./StartupPhases";
import { TpsChart } from "./TpsChart";

export function EpochCard() {
  const store = useStore();
  const epoch = store.get<EpochInfo>("epoch", "new");
  const slot = store.get<number>("summary", "completed_slot");
  // Sent by the server rather than derived here. It used to be the remaining
  // slots times the configured slot duration, which is what the cluster aims
  // at rather than what it does, and the gap between the two is an hour or
  // more across a whole epoch. The server measures the rate instead, and holds
  // the answer still unless it really moves — neither of which the client can
  // do from one duration and a slot number.
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
  const voteDistance = store.get<number | null>("summary", "vote_distance");
  const slotDurationNanos = store.get<number>("summary", "estimated_slot_duration_nanos");
  const startup = store.get<StartupProgress>("summary", "startup_progress");
  const skip = store.get<SkipRate>("summary", "skip_rate");
  const shreds = store.get<Shreds | null>("summary", "shreds");

  // The leader countdown means nothing until the validator is running, so show
  // where it has got to in its boot sequence instead.
  if (startup && !startup.running) {
    return (
      <Card title="Status">
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
          value={health?.vote ?? "—"}
          sub={voteDistance === null || voteDistance === undefined ? undefined : `${voteDistance} behind`}
          tone={health?.vote === "voting" ? "good" : health?.vote === "delinquent" ? "bad" : "muted"}
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
          explain="The share of shreds this validator had to ask another node for because turbine never delivered them, over the last five minutes. Turbine should carry nearly all of them; a rising share means the cluster is not reaching this node, which shows here before it shows in the skip rate."
          value={percent(shreds?.repair_rate ?? null, 2)}
          sub={shreds ? `${count(shreds.repaired)} of ${count(shreds.received)}` : undefined}
          tone={shreds && shreds.repair_rate > 0.05 ? "bad" : undefined}
        />
      </div>
    </Card>
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
        <Stat
          label="Active Validators"
          value={count(counts.total - counts.delinquent)}
          sub={`${count(counts.total)} staked`}
        />
        <Stat
          label="Delinquent"
          value={count(counts.delinquent)}
          sub={`${solCompact(counts.delinquent_stake)} SOL`}
          tone={counts.delinquent > 0 ? "bad" : undefined}
        />
        <Stat
          label="Active Stake"
          value={solCompact(counts.non_delinquent_stake)}
          sub="SOL"
        />
        <Stat label="RPC Nodes" value={count(counts.rpc_nodes)} />
      </div>
      <Donut
        fraction={healthy}
        label={percent(healthy)}
        sublabel={percent(1 - healthy)}
      />
    </Card>
  );
}

export function TransactionsCard() {
  const store = useStore();
  const tps = store.get<Tps>("summary", "estimated_tps");
  const samples = store.getTps();

  return (
    <Card title="Transactions" className="transactions-body">
      <div className="transactions-figures">
        <Stat label="Total TPS" value={decimal(tps?.total)} />
        <div className="stat-grid stat-grid-tight">
          <Stat label="Non-vote TPS Success" value={decimal(tps?.non_vote_success)} tone="good" />
          <Stat label="Non-vote TPS Fail" value={decimal(tps?.non_vote_failed)} tone="bad" />
          <Stat label="Vote TPS" value={decimal(tps?.vote)} tone="muted" />
        </div>
      </div>
      <TpsChart samples={samples} />
    </Card>
  );
}

const waiting = <div className="card-footnote">waiting for data…</div>;
