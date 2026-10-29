import type { ReactElement } from "react";
import {
  ESCALATE_RATIO,
  alertCounts,
  alertText,
  failedRatio,
  priorityLabel,
  ratioLabel,
  shareLabel,
} from "../feePayers";
import { count, shortKey } from "../format";
import type { FeePayerAlert, FeePayerEpoch, FeePayerRow, FeePayerSummary } from "../types";
import { Copyable } from "./Copyable";
import { Explain, Fold } from "./primitives";

export function FeePayersFold({ summary }: { summary: FeePayerSummary | null }): ReactElement {
  const epoch = summary?.epochs[0];
  return (
    <Fold
      id="fee-payers"
      title="Fee payers"
      summary={<FoldSummary summary={summary} />}
      startFolded
      className="fee-fold"
    >
      {summary && epoch ? (
        <FeePayersBody summary={summary} epoch={epoch} />
      ) : (
        <p className="card-footnote">No block of ours has been rooted since the dashboard started.</p>
      )}
    </Fold>
  );
}

function FoldSummary({ summary }: { summary: FeePayerSummary | null }): ReactElement {
  const epoch = summary?.epochs[0];
  if (!summary || !epoch) return <>no blocks of ours yet</>;
  const { escalated, flagged } = alertCounts(summary);
  return (
    <>
      <span className="fee-fold-rates">
        <b>{shareLabel(epoch.failed, epoch.transactions)}</b> failed in our slots
        {epoch.away_transactions > 0 && (
          <>
            , <b>{shareLabel(epoch.away_failed, epoch.away_transactions)}</b> elsewhere
          </>
        )}
        {" · "}
      </span>
      {escalated + flagged === 0 && "no alerts"}
      {escalated > 0 && (
        <>
          <b className="tone-bad">{count(escalated)}</b> escalated
        </>
      )}
      {escalated > 0 && flagged > 0 && ", "}
      {flagged > 0 && (
        <>
          <b className="tone-warn">{count(flagged)}</b> flagged
        </>
      )}
    </>
  );
}

function FeePayersBody({ summary, epoch }: { summary: FeePayerSummary; epoch: FeePayerEpoch }): ReactElement {
  const { escalated, flagged } = alertCounts(summary);
  return (
    <div className="fee-body">
      <div className="fee-stats">
        <div className="stat">
          <span className="stat-label">failed in our slots</span>
          <span className="stat-value">{shareLabel(epoch.failed, epoch.transactions)}</span>
          <span className="stat-sub">
            {count(epoch.failed)} of {count(epoch.transactions)} non-vote
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">
            <Explain text="The payers seen in our blocks this epoch, in other leaders' blocks from when each was first seen.">
              same payers, other leaders
            </Explain>
          </span>
          <span className="stat-value">{shareLabel(epoch.away_failed, epoch.away_transactions)}</span>
          <span className="stat-sub">
            {epoch.away_transactions > 0
              ? `over ${count(epoch.away_transactions)} of their txns`
              : "none seen in other leaders' blocks yet"}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">priority fees on failed</span>
          <span className="stat-value">{priorityLabel(epoch.priority_failed)}</span>
          <span className="stat-sub">in our {count(epoch.blocks)} blocks</span>
        </div>
        <div className="stat">
          <span className="stat-label">alerts this epoch</span>
          <span className={`stat-value${escalated > 0 ? " tone-bad" : flagged > 0 ? " tone-warn" : ""}`}>
            {count(escalated > 0 ? escalated : flagged)}
          </span>
          <span className="stat-sub">
            {escalated > 0 ? `escalated, ${count(flagged)} flagged` : flagged > 0 ? "flagged" : "no payer flagged"}
          </span>
        </div>
      </div>

      <div className="fee-epochs">
        <div className="fee-epoch fee-head">
          <span>Epoch</span>
          <span className="fee-wide">blocks</span>
          <span className="fee-wide">non-vote</span>
          <span>failed here</span>
          <span>elsewhere</span>
          <span>
            <span className="fee-long">priority on failed</span>
            <span className="fee-short">priority</span>
          </span>
        </div>
        {summary.epochs.map((held) => (
          <div className="fee-epoch" key={held.epoch}>
            <span>{count(held.epoch)}</span>
            <span className="fee-wide">{count(held.blocks)}</span>
            <span className="fee-wide">{count(held.transactions)}</span>
            <span>{shareLabel(held.failed, held.transactions)}</span>
            <span>{shareLabel(held.away_failed, held.away_transactions)}</span>
            <span>{priorityLabel(held.priority_failed)}</span>
          </div>
        ))}
      </div>

      <h3 className="fee-sub">Top fee payers by priority on failed</h3>
      {summary.payers.length === 0 ? (
        <p className="card-footnote">No transaction of ours has failed this epoch.</p>
      ) : (
        <div className="fee-table">
          <div className="fee-row fee-head">
            <span>Fee payer</span>
            <span>txns</span>
            <span>failed</span>
            <span>here</span>
            <span>elsewhere</span>
            <span>ratio</span>
            <span>priority on failed</span>
            <span />
          </div>
          {summary.payers.map((row) => (
            <PayerLine key={row.payer} row={row} />
          ))}
        </div>
      )}

      <h3 className="fee-sub">Alerts</h3>
      {summary.alerts.length === 0 ? (
        <p className="card-footnote">No payer met the flag this epoch or the last.</p>
      ) : (
        <ul className="fee-alerts">
          {summary.alerts.map((row) => (
            <li key={`${row.epoch}-${row.payer}`} className={row.epoch === epoch.epoch ? undefined : "is-past"}>
              {row.alert && <AlertChip alert={row.alert} />}
              <Copyable text={row.payer} label={shortKey(row.payer, 4, 4)} className="fee-key" />
              <span className="fee-what">{alertText(row, epoch.epoch)}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="card-footnote">
        Flagged at 100 txns, 10% failed and 0.05 SOL priority on failed in an epoch; escalated above 3× its rate in other
        leaders' blocks, once it has 100 txns there. Rooted blocks since the dashboard started.
      </p>
    </div>
  );
}

function PayerLine({ row }: { row: FeePayerRow }): ReactElement {
  const ratio = failedRatio(row);
  const high = ratio !== null && ratio > ESCALATE_RATIO;
  const ratioTone = high ? (row.alert === "escalated" ? "tone-bad" : "tone-warn") : "fee-dim";
  return (
    <div className={`fee-row${row.alert ? ` is-${row.alert}` : ""}`}>
      <Copyable text={row.payer} label={shortKey(row.payer, 4, 4)} className="fee-key" />
      <span className="fee-num">{count(row.transactions)}</span>
      <span className="fee-num">{count(row.failed)}</span>
      <span className="fee-num">{shareLabel(row.failed, row.transactions)}</span>
      <span className="fee-num fee-dim">{shareLabel(row.away_failed, row.away_transactions)}</span>
      <span className={`fee-num ${ratioTone}`}>{ratioLabel(row)}</span>
      <span className="fee-num fee-priority">{priorityLabel(row.priority_failed)}</span>
      <span className="fee-status">{row.alert && <AlertChip alert={row.alert} />}</span>
      <span className="fee-phone">
        {count(row.transactions)} txns · {shareLabel(row.failed, row.transactions)} here,{" "}
        {shareLabel(row.away_failed, row.away_transactions)} elsewhere · {ratioLabel(row)}
      </span>
    </div>
  );
}

function AlertChip({ alert }: { alert: FeePayerAlert }): ReactElement {
  return <span className={`fee-chip is-${alert}`}>{alert}</span>;
}
