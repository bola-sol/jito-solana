import { useState, type ReactNode, type ReactElement } from "react";
import { blockStamp, buildLabel, duration, percent, sol, solCompact } from "../format";
import { readBalancesHidden, writeBalancesHidden } from "../layout";
import { bootTimes, type BootTimes } from "../startup";
import { useStore } from "../useStore";
import { BalancesToggle } from "./BalancesToggle";
import { Copyable } from "./Copyable";
import { Logo } from "./Logo";
import { Explain } from "./primitives";
import { ThemeToggle } from "./ThemeToggle";

/** Who this validator is, and what it is worth in the line under it. */
export function Header(): ReactElement {
  const store = useStore();
  const identity = store.get("summary", "identity_key");
  const voteKey = store.get("summary", "vote_key");
  const stake = store.get("summary", "stake");
  const commission = store.get("summary", "vote_commission");
  const identityBalance = store.get("summary", "identity_balance");
  const voteBalance = store.get("summary", "vote_balance");
  const uptimeNanos = store.get("summary", "uptime_nanos");
  const boot = bootTimes(
    store.get("summary", "startup_progress"),
    uptimeNanos,
    store.get("summary", "server_time_nanos"),
    store.get("summary", "caught_up_time_nanos"),
  );
  const cluster = store.get("summary", "cluster");
  const version = store.get("summary", "version");
  const client = store.get("summary", "client");
  const shredVersion = store.get("summary", "shred_version");
  const connection = store.getConnection();

  const name = store.get("summary", "identity_name") ?? "Private";
  const icon = store.get("summary", "identity_icon") ?? null;
  const build = buildLabel(client, version);
  // The two balances can be taken off a screen others see; remembered per host.
  const [balancesHidden, setBalancesHidden] = useState(readBalancesHidden);
  const toggleBalances = () => {
    const next = !balancesHidden;
    setBalancesHidden(next);
    writeBalancesHidden(next);
  };

  const up = duration(uptimeNanos === undefined ? undefined : uptimeNanos / 1e6);
  const upLabel =
    boot && boot.catchUpMillis !== null
      ? `up, caught up after ${duration(boot.catchUpMillis)}`
      : "up";

  return (
    <header className="header">
      <div className="who">
        <span className="who-name">
          <Logo url={icon} size={22} />
          {name}
        </span>
        {identity ? (
          <Copyable text={identity} className="who-key" />
        ) : (
          <span className="who-key">—</span>
        )}
        <span className={`cluster cluster-${cluster ?? "unknown"}`}>{cluster ?? "…"}</span>
        {build && (
          <Explain text="Client and version. A fork carries the version of the release it follows.">
            {build}
          </Explain>
        )}
        {shredVersion !== undefined && (
          <Explain text="Shred version. Nodes only gossip with matching versions.">
            shred {shredVersion}
          </Explain>
        )}
        <span className="who-right">
          <Connection state={connection} />
          <BalancesToggle hidden={balancesHidden} onToggle={toggleBalances} />
          <ThemeToggle />
        </span>
      </div>

      <div className="figures">
        {/* The vote account hangs off the stake delegated to it. */}
        <Figure
          value={`${solCompact(stake?.activated_stake)} SOL`}
          label={`staked, ${percent(stake?.share, 4)} of the cluster`}
          detail={
            voteKey ? (
              <>
                <span className="figure-panel-label">Vote account</span>
                <Copyable text={voteKey} />
              </>
            ) : undefined
          }
        />
        <Figure
          value={commission === null || commission === undefined ? "—" : `${commission}%`}
          label="commission"
        />
        {!balancesHidden && (
          <>
            <Figure value={`${sol(identityBalance)} SOL`} label="identity" />
            <Figure value={`${sol(voteBalance)} SOL`} label="vote" />
          </>
        )}
        <Figure value={up} label={upLabel} detail={boot && <Boot boot={boot} />} />
      </div>
    </header>
  );
}

/** One figure and what it is; the label opens the detail where there is one. */
function Figure({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail?: ReactNode;
}) {
  return (
    <span className="figure">
      <b>{value}</b>
      {detail ? (
        <Explain interactive className="figure-detail" text={detail}>
          {label}
        </Explain>
      ) : (
        label
      )}
    </span>
  );
}

/** When the validator started, what the boot took, and how long it trailed the tip. */
function Boot({ boot }: { boot: BootTimes }) {
  return (
    <>
      <span className="boot-row">
        <b>Started</b>
        <span>{blockStamp(boot.startedMillis)}</span>
      </span>
      <span className="boot-rule" />
      <span className="boot-row">
        <b>Startup</b>
        <span>{duration(boot.startupMillis)}</span>
      </span>
      {boot.phases.map((phase) => (
        <span key={phase.label} className="boot-row boot-sub">
          <span>{phase.label}</span>
          <span>{duration(phase.millis)}</span>
        </span>
      ))}
      {boot.catchUpMillis !== null && (
        <>
          <span className="boot-rule" />
          <span className="boot-row">
            <b>Caught up</b>
            <span>{duration(boot.catchUpMillis)} after running</span>
          </span>
          <span className="boot-note">
            Counted to when replay drew level with the cluster, the moment behind cluster read nought.
          </span>
        </>
      )}
    </>
  );
}

/** The websocket's state: a dot, and the word "live" while it is open. */
function Connection({ state }: { state: string }) {
  return (
    <div className={`connection connection-${state}`} title={`websocket ${state}`}>
      <span className="connection-dot" />
      {state === "open" ? "live" : state}
    </div>
  );
}
