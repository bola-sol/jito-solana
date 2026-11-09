import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type ReactElement } from "react";
import { blockStamp, buildLabel, count, countryName, duration, LAMPORTS_PER_SOL, percent, shortKey, sol, solCompact } from "../format";
import { toggleBalancesHidden, useBalancesHidden } from "../balances";
import { toggleLogosHidden, useLogosHidden } from "../logo";
import { identityWarning, voteRunway, voteWarning, type BalanceWarning, type VoteRunway } from "../voteCost";
import { noSeatLabel } from "../admission";
import { bootTimes, type BootTimes } from "../startup";
import { useAlpenglow } from "../consensus";
import { useStore } from "../useStore";
import { BalancesToggle } from "./BalancesToggle";
import { Copyable } from "./Copyable";
import { FoldsToggle } from "./FoldsToggle";
import { Logo } from "./Logo";
import { LogosToggle } from "./LogosToggle";
import { Explain } from "./primitives";
import { ThemeToggle } from "./ThemeToggle";
import { NodeVerdict } from "./Verdict";

/** `folds` puts the open-all toggle beside the others, on the page whose panels it opens; `nav` ends
 *  the figures row. */
export function Header({ folds, nav }: { folds: boolean; nav: ReactNode }): ReactElement {
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
  const logosHidden = useLogosHidden();

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
          <span className="who-name-text">{name}</span>
        </span>
        <NodeVerdict />
        <span className="who-meta">
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
          <Address />
        </span>
        <span className="who-right">
          <Connection state={connection} lagMs={feedLag} />
          {folds && <FoldsToggle />}
          <BalancesToggle hidden={balancesHidden} onToggle={toggleBalancesHidden} />
          <LogosToggle hidden={logosHidden} onToggle={toggleLogosHidden} />
          <ThemeToggle />
        </span>
      </div>

      <div className="figures-row">
        {identity ? (
          <Copyable text={identity} label={shortKey(identity)} className="who-key" />
        ) : (
          <span className="who-key">—</span>
        )}
        <div className="figures-cell">
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
              label="staked"
              detail={
                voteKey ? (
                  <>
                    <span className="figure-panel-label">Share of the cluster</span>
                    <span>{percent(stake?.share, 4)}</span>
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
              label="commission"
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
              label="uptime"
              detail={boot && <Boot boot={boot} />}
            />
            <MoreFigures
              rows={[
                { label: "commission", value: commissionText },
                { label: "uptime", value: duration(upMillis) },
                ...(balancesHidden
                  ? []
                  : [
                      { label: "identity", value: `${sol(identityBalance)} SOL`, tone: identityAlarm?.tone },
                      { label: "vote", value: `${sol(voteBalance)} SOL`, tone: voteAlarm?.tone },
                    ]),
              ]}
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
        </div>
        {nav}
      </div>
    </header>
  );
}

/** Our country, with the address behind it to copy; "IP" where no country is known. */
function Address() {
  const address = useStore().get("summary", "gossip_address");
  if (!address) return null;
  const { ip, country } = address;
  return (
    <Explain
      interactive
      className="figure-detail"
      text={
        <>
          <span className="figure-panel-label">
            Gossip address{country && `, ${countryName(country)}`}
          </span>
          <Copyable
            text={ip}
            className="who-address"
            label={
              <>
                {ip}
                <span className="who-address-copy">copy</span>
              </>
            }
          />
        </>
      }
    >
      {country ?? "IP"}
    </Explain>
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

/** Three units as text, two as a tile. */
function Uptime({ millis }: { millis: number | undefined }) {
  const two = duration(millis, 2);
  return (
    <>
      {two}
      <span className="figure-unit-3">{duration(millis).slice(two.length)}</span>
    </>
  );
}

type MoreRow = { label: string; value: string; tone?: "warn" | "bad" };

/** On a phone, the figures the row leaves out, behind one tile toned like the worst of them. */
function MoreFigures({ rows }: { rows: MoreRow[] }) {
  const tone = rows.some((row) => row.tone === "bad") ? "bad" : rows.some((row) => row.tone) ? "warn" : null;
  return (
    <Explain
      className={`figure figure-more${tone ? ` tone-${tone}` : ""}`}
      text={rows.map((row) => (
        <span key={row.label} className="boot-row">
          <span>{row.label}</span>
          <span className={row.tone ? `tone-${row.tone}` : undefined}>{row.value}</span>
        </span>
      ))}
    >
      <b>+{rows.length}</b>
      <span className="figure-more-word">more</span>
    </Explain>
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

/** `kind` places the figure when the header lays them out as tiles. */
function Figure({
  kind,
  value,
  label,
  detail,
  tone,
  title,
  pad = 0,
}: {
  kind: FigureKind;
  value: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  tone?: "warn" | "bad";
  title?: string;
  pad?: number;
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
      {pad > 0 && <span className="figure-pad" style={{ "--pad": String(pad) } as CSSProperties} />}
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

/** The nearest earlier sibling on the same line; in a stacked header it is not the previous one. */
function lineBefore(element: Element): Element | null {
  const box = element.getBoundingClientRect();
  for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    const other = sibling.getBoundingClientRect();
    if (other.top < box.bottom && other.bottom > box.top) return sibling;
  }
  return null;
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

  // "page" is shown only where it fits on the pill's line.
  useLayoutEffect(() => {
    const right = pillRef.current?.parentElement;
    const row = right?.parentElement;
    if (!behind || !right || !row) return;
    const before = lineBefore(right);
    if (!before) return;
    if (pageRef.current) pageWidth.current = pageRef.current.getBoundingClientRect().width;
    const shown = pageRef.current ? 0 : pageWidth.current;
    // A cut name counts at its full width, so "page" never cuts it.
    const cut = row.querySelector(".who-name-text");
    const hidden = cut ? cut.scrollWidth - cut.clientWidth : 0;
    const start = before.getBoundingClientRect().right + hidden + parseFloat(getComputedStyle(row).columnGap);
    const end = start + right.getBoundingClientRect().width + shown;
    const rowEnd = row.getBoundingClientRect().right;
    const next = end <= rowEnd;
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
