import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type ReactElement } from "react";
import { blockStamp, buildLabel, count, duration, LAMPORTS_PER_SOL, percent, sol, solCompact } from "../format";
import { toggleBalancesHidden, useBalancesHidden } from "../balances";
import { identityWarning, voteRunway, voteWarning, type BalanceWarning, type VoteRunway } from "../voteCost";
import { noSeatLabel } from "../admission";
import { bootTimes, type BootTimes } from "../startup";
import { useAlpenglow } from "../consensus";
import { useStore } from "../useStore";
import { BalancesToggle } from "./BalancesToggle";
import { Copyable } from "./Copyable";
import { FoldsToggle } from "./FoldsToggle";
import { Logo } from "./Logo";
import { Explain } from "./primitives";
import { ThemeToggle } from "./ThemeToggle";

/** `folds` puts the open-all toggle beside the others, on the page whose panels it opens. */
export function Header({ folds }: { folds: boolean }): ReactElement {
  const store = useStore();
  const identity = store.get("summary", "identity_key");
  const voteKey = store.get("summary", "vote_key");
  const stake = store.get("summary", "stake");
  const commission = store.get("summary", "vote_commission");
  const identityBalance = store.get("summary", "identity_balance");
  const voteCost = store.get("summary", "vote_cost");
  // A backup identity pays no votes, so its balance carries no warning.
  const health = store.get("summary", "health");
  const voting = health === undefined ? undefined : health.vote !== "not_voting";
  const voteBalance = store.get("summary", "vote_balance");
  const runway = voteRunway(voteBalance, voteCost, store.get("epoch", "new")?.epoch);
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
  const feedLag = store.getFeedLag();

  const identityName = store.get("summary", "identity_name");
  const name = identityName ?? "Private";
  const icon = store.get("summary", "identity_icon") ?? null;
  const build = buildLabel(client, version);
  // The balances can be taken off a screen others see; remembered per host.
  const balancesHidden = useBalancesHidden();

  const upMillis = uptimeNanos === undefined ? undefined : uptimeNanos / 1e6;
  const staked = solCompact(stake?.activated_stake);
  const commissionText = commission === null || commission === undefined ? "—" : `${commission}%`;
  const identityAlarm = identityWarning(identityBalance, voteCost, voting);
  const voteAlarm = voteWarning(voteBalance, voteCost);

  return (
    <header className="header">
      <div className="who">
        <span className="who-name">
          <Logo url={icon} size={22} name={identityName} />
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
          <Connection state={connection} lagMs={feedLag} />
          {folds && <FoldsToggle />}
          <BalancesToggle hidden={balancesHidden} onToggle={toggleBalancesHidden} />
          <ThemeToggle />
        </span>
      </div>

      <div className="figures">
        <Figure
          kind="stake"
          value={
            <>
              {staked}
              <Sol />
            </>
          }
          pad={shortOf(staked, 6)}
          label={
            <span>
              staked<span className="figure-text">, {percent(stake?.share, 4)} of the cluster</span>
            </span>
          }
          detail={
            voteKey ? (
              <>
                <span className="figure-panel-label figure-tile">Share of the cluster</span>
                <span className="figure-tile">{percent(stake?.share, 4)}</span>
                <span className="figure-panel-label">Vote account</span>
                <Copyable text={voteKey} />
              </>
            ) : undefined
          }
        />
        <Figure
          kind="commission"
          value={commissionText}
          pad={shortOf(commissionText, 4)}
          label={
            <>
              <span className="figure-long">commission</span>
              <span className="figure-short" aria-hidden="true">
                comm.
              </span>
            </>
          }
        />
        {!balancesHidden && (
          <>
            <Balance kind="identity" value={identityBalance} name="identity" warning={identityAlarm} />
            <Balance
              kind="vote"
              value={voteBalance}
              name="vote"
              warning={voteAlarm}
              detail={runway && <Runway runway={runway} />}
            />
          </>
        )}
        <Bls />
        <Seat />
        <Figure
          kind="uptime"
          value={<Uptime millis={upMillis} />}
          pad={shortOf(duration(upMillis, 2), 8)}
          padShort={shortOf(duration(upMillis, 1), 4)}
          label="uptime"
          detail={boot && <Boot boot={boot} />}
        />
        {!balancesHidden &&
          [identityAlarm, voteAlarm].map(
            (alarm) =>
              alarm && (
                <span key={alarm.label} className={`figure-note tone-${alarm.tone}`} title={alarm.title}>
                  {alarm.label}
                </span>
              ),
          )}
      </div>
    </header>
  );
}

/** Hidden with the balances toggle, warning and all. As a tile, 1,000 SOL and more is compacted like the
 *  stake and the warning goes to a line of its own. */
function Balance({
  kind,
  value,
  name,
  warning,
  detail,
}: {
  kind: FigureKind;
  value: number | undefined;
  name: string;
  warning: BalanceWarning | null;
  detail?: ReactNode;
}) {
  const compact = value !== undefined && value >= 1_000 * LAMPORTS_PER_SOL;
  return (
    <Figure
      kind={kind}
      pad={shortOf(compact ? solCompact(value) : sol(value), 6)}
      value={
        <>
          {compact ? (
            <>
              <span className="figure-text">{sol(value)}</span>
              <span className="figure-tile">{solCompact(value)}</span>
            </>
          ) : (
            sol(value)
          )}
          <Sol />
        </>
      }
      label={
        warning ? (
          <>
            <span className="figure-text">{warning.label}</span>
            <span className="figure-tile">{name}</span>
          </>
        ) : (
          name
        )
      }
      tone={warning?.tone}
      title={warning?.title}
      detail={detail}
    />
  );
}

/** As a tile, shown only where the stake and both balances all have room for it. */
function Sol() {
  return <span className="figure-sol"> SOL</span>;
}

/** Three units as text, two as a tile and one on the narrowest. */
function Uptime({ millis }: { millis: number | undefined }) {
  const one = duration(millis, 1);
  const two = duration(millis, 2);
  return (
    <>
      {one}
      <span className="figure-unit-2">{two.slice(one.length)}</span>
      <span className="figure-unit-3">{duration(millis).slice(two.length)}</span>
    </>
  );
}

/** The admission ticket burned each epoch and the epochs the vote account's balance keeps a seat, with no
 *  income. */
function Runway({ runway }: { runway: VoteRunway }) {
  return (
    <>
      <span className="boot-row">
        <b>VAT</b>
        <span>{sol(runway.ticket, 4)} SOL an epoch</span>
      </span>
      {runway.pending > 0 && (
        <span className="boot-row boot-sub">
          <span>held for delegators</span>
          <span>{sol(runway.pending, 4)} SOL</span>
        </span>
      )}
      <span className="boot-rule" />
      <span className="boot-row">
        <b>Runway</b>
        <span>
          {count(runway.epochs)} {runway.epochs === 1 ? "epoch" : "epochs"}
        </span>
      </span>
      <span className="boot-row boot-sub">
        <span>seated through epoch</span>
        <span>{count(runway.lastEpoch)}</span>
      </span>
    </>
  );
}

/** A warning before alpenglow and a fault after, since no vote counts without one. */
function Bls() {
  const set = useStore().get("summary", "bls_key");
  const alpenglow = useAlpenglow();
  if (set !== false) return null;
  return (
    <Figure
      kind="alert"
      value="none"
      label={alpenglow ? "BLS key, votes are not counted without it" : "BLS key, needed before alpenglow"}
      tone={alpenglow ? "bad" : "warn"}
    />
  );
}

function Seat() {
  const admission = useStore().get("summary", "admission");
  if (!admission || admission.seat) return null;
  return <Figure kind="alert" value="no seat" label={noSeatLabel(admission)} tone="warn" />;
}

type FigureKind = "stake" | "commission" | "identity" | "vote" | "uptime" | "alert";

/** The characters a tile's value is short of the widest it can be, made up after its label so the tile
 *  keeps one width. */
function shortOf(value: string, widest: number): number {
  return Math.max(0, widest - value.length);
}

/** `kind` places the figure when the header lays them out as tiles; `padShort` is `pad` on the
 *  narrowest. */
function Figure({
  kind,
  value,
  label,
  detail,
  tone,
  title,
  pad = 0,
  padShort = pad,
}: {
  kind: FigureKind;
  value: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  tone?: "warn" | "bad";
  title?: string;
  pad?: number;
  padShort?: number;
}) {
  return (
    <span className={`figure figure-${kind}${tone ? ` tone-${tone}` : ""}`} title={title}>
      <b>{value}</b>
      {detail ? (
        <Explain interactive className="figure-detail" text={detail}>
          {label}
        </Explain>
      ) : (
        label
      )}
      {(pad > 0 || padShort > 0) && (
        <span
          className="figure-pad"
          style={{ "--pad": String(pad), "--pad-short": String(padShort) } as CSSProperties}
        />
      )}
    </span>
  );
}

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

/** Lag under this is delivery jitter, not worth a word. */
const LAG_SHOWN_MS = 3_000;

function Connection({ state, lagMs }: { state: string; lagMs: number | null }) {
  const pillRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLSpanElement>(null);
  const pageWidth = useRef(0);
  const [roomy, setRoomy] = useState(true);
  const behind = state === "open" && lagMs !== null && lagMs >= LAG_SHOWN_MS;
  const seconds = Math.round((lagMs ?? 0) / 1000);

  // "page" is dropped only when it alone would push the pill onto a line of its own.
  useLayoutEffect(() => {
    const right = pillRef.current?.parentElement;
    const before = right?.previousElementSibling;
    const row = right?.parentElement;
    if (!behind || !right || !before || !row) return;
    if (pageRef.current) pageWidth.current = pageRef.current.getBoundingClientRect().width;
    const shown = pageRef.current ? 0 : pageWidth.current;
    const start = before.getBoundingClientRect().right + parseFloat(getComputedStyle(row).columnGap);
    const end = start + right.getBoundingClientRect().width + shown;
    const rowEnd = row.getBoundingClientRect().right;
    const next = end <= rowEnd || end - pageWidth.current > rowEnd;
    if (next !== roomy) setRoomy(next);
  });

  const word = behind ? (
    <span>
      {roomy && <span ref={pageRef}>page </span>}
      {seconds} s behind
    </span>
  ) : state === "open" ? (
    "live"
  ) : (
    state
  );
  return (
    <div
      ref={pillRef}
      className={`connection connection-${state}${behind ? " is-behind" : ""}`}
      title={behind ? "Updates are reaching this page late." : `websocket ${state}`}
    >
      <span className="connection-dot" />
      {word}
    </div>
  );
}
