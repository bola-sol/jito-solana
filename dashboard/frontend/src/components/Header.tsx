import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { blockStamp, buildLabel, duration, percent, sol, solCompact } from "../format";
import { useNarrow } from "../narrow";
import { bootTimes, type BootTimes } from "../startup";
import type { StakeSummary, StartupProgress } from "../types";
import { useStore } from "../useStore";
import { Copyable } from "./Copyable";
import { Logo } from "./Logo";
import { Explain } from "./primitives";
import { ThemeToggle } from "./ThemeToggle";

/** Who this validator is, what it runs, and what it is worth. Two layouts:
 *  everything on a screen, five figures and a panel behind the name on a
 *  phone. See `useNarrow`. */
export function Header() {
  const store = useStore();
  const identity = store.get<string>("summary", "identity_key");
  const voteKey = store.get<string>("summary", "vote_key");
  const stake = store.get<StakeSummary>("summary", "stake");
  const commission = store.get<number | null>("summary", "vote_commission");
  const identityBalance = store.get<number>("summary", "identity_balance");
  const voteBalance = store.get<number>("summary", "vote_balance");
  const uptimeNanos = store.get<number>("summary", "uptime_nanos");
  const boot = bootTimes(
    store.get<StartupProgress>("summary", "startup_progress"),
    uptimeNanos,
    store.get<number>("summary", "server_time_nanos"),
    store.get<number>("summary", "caught_up_time_nanos"),
  );
  const cluster = store.get<string>("summary", "cluster");
  const version = store.get<string>("summary", "version");
  const client = store.get<string>("summary", "client");
  const shredVersion = store.get<number>("summary", "shred_version");
  const connection = store.getConnection();
  const narrow = useNarrow();

  const name = store.get<string | null>("summary", "identity_name") ?? "Private";
  const icon = store.get<string | null>("summary", "identity_icon") ?? null;
  const build = buildLabel(client, version);

  const figures = {
    stakeAmount: `${solCompact(stake?.activated_stake)} SOL`,
    share: percent(stake?.share, 4),
    commission: commission === null || commission === undefined ? "—" : `${commission} %`,
    identityBalance: `${sol(identityBalance)} SOL`,
    voteBalance: `${sol(voteBalance)} SOL`,
    uptime: duration(uptimeNanos === undefined ? undefined : uptimeNanos / 1e6),
    shred: shredVersion === undefined ? "—" : String(shredVersion),
  };

  const cluster_ = <span className={`cluster cluster-${cluster ?? "unknown"}`}>{cluster ?? "…"}</span>;
  const buildLabel_ = build && (
    <Explain
      className="version"
      text="Client and version. A fork carries the version of the release it follows."
    >
      {build}
    </Explain>
  );

  if (narrow) {
    return (
      <header className="header is-narrow">
        <div className="header-brand">
          {cluster_}
          {buildLabel_}
        </div>
        <Connection state={connection} showLabel={connection !== "open"} />
        <ThemeToggle />
        <Identity
          name={name}
          icon={icon}
          stake={figures.stakeAmount}
          identity={identity}
          voteKey={voteKey}
          figures={figures}
          boot={boot}
        />
      </header>
    );
  }

  return (
    <header className="header">
      <div className="header-brand">
        {cluster_}
        {buildLabel_}
        {shredVersion !== undefined && (
          <Explain className="version" text="Shred version. Nodes only gossip with matching versions.">
            shred {shredVersion}
          </Explain>
        )}
      </div>

      <div className="header-identity">
        <div className="header-name">
          <Logo url={icon} size={20} />
          {name}
        </div>
        {identity ? (
          <Copyable text={identity} className="header-key" />
        ) : (
          <div className="header-key">—</div>
        )}
      </div>

      <div className="header-stats">
        {/* The vote account has nowhere of its own to live and does not earn a
            column of its own, so it hangs off the figure it belongs to: the
            stake is the stake delegated to that account. */}
        <HeaderStat
          label="Stake Amount"
          value={figures.stakeAmount}
          detail={
            voteKey ? (
              <>
                <span className="header-panel-label">Vote account</span>
                <Copyable text={voteKey} />
              </>
            ) : undefined
          }
        />
        <HeaderStat label="Stake %" value={figures.share} />
        <HeaderStat label="Commission" value={figures.commission} />
        <HeaderStat label="Identity Balance" value={figures.identityBalance} />
        <HeaderStat label="Vote Balance" value={figures.voteBalance} />
        <HeaderStat label="Uptime" value={figures.uptime} detail={boot && <Boot boot={boot} />} />
      </div>

      <Connection state={connection} showLabel />
      <ThemeToggle />
    </header>
  );
}

/** The name, the stake, and everything else behind a press. Not an
 *  `Explain`: there is no hover on a phone and the key must be copyable. */
function Identity({
  name,
  icon,
  stake,
  identity,
  voteKey,
  figures,
  boot,
}: {
  name: string;
  icon: string | null;
  stake: string;
  identity: string | undefined;
  voteKey: string | undefined;
  figures: Record<string, string>;
  boot: BootTimes | null;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // Dismissed by pressing anywhere else or by Escape, which is what a panel
  // opened over the page owes whoever opened it. Copying the key closes it too,
  // since that press lands outside nothing.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className="header-identity" ref={wrapper}>
      <button
        type="button"
        className="header-name is-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
      >
        <Logo url={icon} size={20} />
        <span>{name}</span>
      </button>
      <span className="header-stake">{stake}</span>

      {open && (
        <div className="header-panel" id={panelId}>
          <div className="header-panel-key">
            <span className="header-panel-label">Identity</span>
            {identity ? <Copyable text={identity} /> : "—"}
          </div>
          {voteKey && (
            <div className="header-panel-key">
              <span className="header-panel-label">Vote account</span>
              <Copyable text={voteKey} />
            </div>
          )}
          <dl className="header-panel-rows">
            <PanelRow label="Stake share" value={figures.share} />
            <PanelRow label="Commission" value={figures.commission} />
            <PanelRow label="Identity balance" value={figures.identityBalance} />
            <PanelRow label="Vote balance" value={figures.voteBalance} />
            <PanelRow label="Uptime" value={figures.uptime} detail={boot && <Boot boot={boot} />} />
            <PanelRow label="Shred version" value={figures.shred} />
          </dl>
        </div>
      )}
    </div>
  );
}

function PanelRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {detail ? (
          <Explain interactive className="header-stat-detail" text={detail}>
            {value}
          </Explain>
        ) : (
          value
        )}
      </dd>
    </>
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

/** The websocket's state; the word is dropped while it is open. */
function Connection({ state, showLabel }: { state: string; showLabel: boolean }) {
  return (
    <div className={`connection connection-${state}`} title={`websocket ${state}`}>
      <span className="connection-dot" />
      {showLabel && state}
    </div>
  );
}

/** One figure, with an optional detail behind it. The affordance appears
 *  only where there is a detail. */
function HeaderStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
}) {
  return (
    <div className="header-stat">
      <div className="header-stat-label">{label}</div>
      <div className="header-stat-value">
        {detail === undefined ? (
          value
        ) : (
          <Explain interactive className="header-stat-detail" text={detail}>
            {value}
          </Explain>
        )}
      </div>
    </div>
  );
}
