import type { ReactElement } from "react";
import { feeShare, feesPaid, resultLabel } from "../feePayers";
import { count, shortKey, sol } from "../format";
import type { BlockFees, TopFeePayer, TopFeeTransaction } from "../types";
import { Copyable } from "./Copyable";
import { Explain } from "./primitives";

/** Who paid the most in one of our blocks: two across where both fit. */
export function BlockFeeTables({ fees, total }: { fees: BlockFees; total: number }): ReactElement | null {
  if (fees.transactions.length === 0) return null;
  return (
    <div className="sx-tops">
      <div className="sx-top">
        <div className="sx-top-head">
          <div className="sx-eyebrow">
            <Explain text="The five fee payers who paid the most in this block, failed transactions included.">
              Top fee payers
            </Explain>
          </div>
          <div className="sx-top-sum">
            {feeShare(feesPaid(fees.payers), total)} of fees, {count(fees.payer_count)} payers
          </div>
        </div>
        <div className="sx-top-table is-payers">
          <div className="sx-top-row sx-top-names">
            <span>Fee payer</span>
            <span>Txns</span>
            <span>Failed</span>
            <span className="sx-top-wide">Priority, SOL</span>
            <span>Paid, SOL</span>
            <span className="sx-top-wide">Share</span>
          </div>
          {fees.payers.map((row) => (
            <PayerRow key={row.payer} row={row} total={total} />
          ))}
        </div>
      </div>
      <div className="sx-top">
        <div className="sx-top-head">
          <div className="sx-eyebrow">
            <Explain text="The five transactions that paid the most in this block, failed ones included.">
              Top transactions
            </Explain>
          </div>
          <div className="sx-top-sum">{feeShare(feesPaid(fees.transactions), total)} of fees</div>
        </div>
        <div className="sx-top-table is-transactions">
          <div className="sx-top-row sx-top-names">
            <span>Signature</span>
            <span className="sx-top-wide sx-top-who">Fee payer</span>
            <span>Result</span>
            <span className="sx-top-wide">Priority, SOL</span>
            <span>Paid, SOL</span>
            <span className="sx-top-wide">Share</span>
          </div>
          {fees.transactions.map((row) => (
            <TransactionRow key={row.signature} row={row} total={total} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PayerRow({ row, total }: { row: TopFeePayer; total: number }): ReactElement {
  return (
    <div className="sx-top-row">
      <Copyable text={row.payer} label={shortKey(row.payer, 4, 4)} className="sx-top-key" />
      <span className="sx-top-num">{count(row.transactions)}</span>
      <span className={`sx-top-num${row.failed > 0 ? " tone-warn" : ""}`}>{count(row.failed)}</span>
      <span className="sx-top-num sx-top-wide">{sol(row.priority, 6)}</span>
      <span className="sx-top-num">{sol(row.paid, 6)}</span>
      <span className="sx-top-num sx-top-wide sx-top-dim">{feeShare(row.paid, total)}</span>
    </div>
  );
}

function TransactionRow({ row, total }: { row: TopFeeTransaction; total: number }): ReactElement {
  return (
    <div className="sx-top-row">
      <Copyable text={row.signature} label={shortKey(row.signature, 4, 4)} className="sx-top-key" />
      <Copyable
        text={row.payer}
        label={shortKey(row.payer, 4, 4)}
        className="sx-top-key sx-top-wide sx-top-who sx-top-dim"
      />
      <span className={`sx-top-num ${row.failed ? "tone-warn" : "sx-top-dim"}`}>{resultLabel(row.failed)}</span>
      <span className="sx-top-num sx-top-wide">{sol(row.priority, 6)}</span>
      <span className="sx-top-num">{sol(row.paid, 6)}</span>
      <span className="sx-top-num sx-top-wide sx-top-dim">{feeShare(row.paid, total)}</span>
    </div>
  );
}
