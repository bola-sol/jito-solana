import { describe, expect, it } from "vitest";
import {
  PENDING_FEES,
  alertCounts,
  alertText,
  failedRatio,
  feeShare,
  feesPaid,
  ratioLabel,
  resultLabel,
  shareLabel,
} from "./feePayers";
import type { FeePayerRow, FeePayerSummary } from "./types";

function row(over: Partial<FeePayerRow> = {}): FeePayerRow {
  return {
    epoch: 5,
    payer: "9vQe1111111111111111111111111111111111T1kR",
    transactions: 1_912,
    failed: 1_371,
    priority_failed: 61_200_000,
    away_transactions: 10_000,
    away_failed: 1_890,
    alert: "escalated",
    flagged_slot: 462_783_540,
    ...over,
  };
}

describe("a block's top fees", () => {
  it("shares one decimal under a tenth and none above", () => {
    expect(feeShare(1_005_000, 6_286_340)).toBe("16%");
    expect(feeShare(398_000, 6_286_340)).toBe("6.3%");
    expect(feeShare(0, 6_286_340)).toBe("0.0%");
  });

  it("has no share of a block that collected nothing", () => {
    expect(feeShare(0, 0)).toBe("—");
  });

  it("holds room for five rows of each, with keys that don't repeat", () => {
    expect(new Set(PENDING_FEES.payers.map((row) => row.payer)).size).toBe(5);
    expect(new Set(PENDING_FEES.transactions.map((row) => row.signature)).size).toBe(5);
  });

  it("adds what the rows paid", () => {
    expect(feesPaid([{ paid: 5 }, { paid: 7 }])).toBe(12);
    expect(feesPaid([])).toBe(0);
  });

  it("names a transaction's result, or its absence", () => {
    expect(resultLabel(true)).toBe("failed");
    expect(resultLabel(false)).toBe("ok");
    expect(resultLabel(null)).toBe("—");
  });
});

describe("fee payers", () => {
  it("compares our failure rate with the rate elsewhere", () => {
    expect(shareLabel(1_371, 1_912)).toBe("71.7%");
    expect(shareLabel(0, 0)).toBe("—");
    expect(ratioLabel(row())).toBe("3.8×");
    expect(failedRatio(row({ away_failed: 0 }))).toBe(Infinity);
    expect(ratioLabel(row({ away_failed: 0 }))).toBe("∞");
    expect(failedRatio(row({ away_transactions: 0 }))).toBeNull();
  });

  it("counts the newest epoch's alerts", () => {
    const summary: FeePayerSummary = {
      epochs: [
        { epoch: 5, blocks: 1, transactions: 1, failed: 1, priority_failed: 0, away_transactions: 0, away_failed: 0 },
        { epoch: 4, blocks: 1, transactions: 1, failed: 1, priority_failed: 0, away_transactions: 0, away_failed: 0 },
      ],
      payers: [],
      alerts: [row(), row({ alert: "flagged" }), row({ epoch: 4 })],
    };
    expect(alertCounts(summary)).toEqual({ escalated: 1, flagged: 1 });
  });

  it("says why each alert stands", () => {
    expect(alertText(row(), 5)).toBe(
      "71.7% failed in our slots against 18.9% in other leaders' (3.8×), 0.0612 SOL priority on failed. Since slot 462,783,540.",
    );
    expect(alertText(row({ alert: "flagged", away_failed: 9_960 }), 5)).toBe(
      "71.7% failed in our slots and 99.6% elsewhere, so it is not escalated. Since slot 462,783,540.",
    );
    expect(alertText(row({ alert: "flagged", away_transactions: 40, flagged_slot: null }), 5)).toBe(
      "71.7% failed in our slots; 40 of its txns seen elsewhere, too few to compare.",
    );
    expect(alertText(row({ epoch: 4 }), 5)).toMatch(/^Epoch 4: /);
  });
});
