import { describe, expect, it } from "vitest";
import { alertCounts, alertText, failedRatio, ratioLabel, shareLabel } from "./feePayers";
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
