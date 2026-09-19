import type { ReactNode, ReactElement } from "react";
import { blockStamp, buildLabel, duration, percent, sol, solCompact } from "../format";
import { toggleBalancesHidden, useBalancesHidden } from "../balances";
import { identityWarning, voteWarning, type BalanceWarning } from "../voteCost";
import { bootTimes, type BootTimes } from "../startup";
import { useAlpenglow } from "../consensus";
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
  const voteCost = store.get("summary", "vote_cost");
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
  // The balances can be taken off a screen others see; remembered per host.
  const balancesHidden = useBalancesHidden();

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
          <BalancesToggle hidden={balancesHidden} onToggle={toggleBalancesHidden} />
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
            <Balance value={identityBalance} name="identity" warning={identityWarning(identityBalance, voteCost)} />
            <Balance value={voteBalance} name="vote" warning={voteWarning(voteBalance, voteCost)} />
          </>
        )}
        <Bls />
        <Figure value={up} label={upLabel} detail={boot && <Boot boot={boot} />} />
      </div>
    </header>
  );
}

/** A balance, toned and relabelled where voting is about to outrun it. Hidden
 *  with the balances toggle, warning and all. */
function Balance({
  value,
  name,
  warning,
}: {
  value: number | undefined;
  name: string;
  warning: BalanceWarning | null;
}) {
  return (
    <Figure
      value={`${sol(value)} SOL`}
      label={warning?.label ?? name}
      tone={warning?.tone}
      title={warning?.title}
    />
  );
}

/** A missing BLS key on the vote account, a warning before alpenglow and a
 *  fault after it, since it counts no vote without one. Nothing while the
 *  key is set, or until the vote account has been read. */
function Bls() {
  const set = useStore().get("summary", "bls_key");
  const alpenglow = useAlpenglow();
  if (set !== false) return null;
  return (
    <Figure
      value="none"
      label={alpenglow ? "BLS key, votes are not counted without it" : "BLS key, needed before alpenglow"}
      tone={alpenglow ? "bad" : "warn"}
    />
  );
}

/** One figure and what it is; the label opens the detail where there is one. */
function Figure({
  value,
  label,
  detail,
  tone,
  title,
}: {
  value: string;
  label: string;
  detail?: ReactNode;
  tone?: "warn" | "bad";
  title?: string;
}) {
  return (
    <span className={`figure${tone ? ` tone-${tone}` : ""}`} title={title}>
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
