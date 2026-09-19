import { describe, expect, it } from "vitest";
import { identityWarning, voteWarning } from "./voteCost";
import type { VoteCost } from "./types";

const SOL = 1_000_000_000;
const fees: VoteCost = { kind: "fees", per_day: 1.08 * SOL };
const ticket: VoteCost = { kind: "ticket", lamports: 1.6 * SOL, minimum: 1.63 * SOL };

describe("identityWarning", () => {
  it("is quiet with a week of votes in hand", () => {
    expect(identityWarning(8 * SOL, fees)).toBeNull();
  });

  it("warns under a week and faults under a day", () => {
    expect(identityWarning(3 * SOL, fees)?.tone).toBe("warn");
    expect(identityWarning(3 * SOL, fees)?.label).toBe("identity, under a week of votes");
    expect(identityWarning(0.5 * SOL, fees)?.tone).toBe("bad");
    expect(identityWarning(0.5 * SOL, fees)?.label).toBe("identity, under a day of votes");
  });

  it("says nothing under alpenglow, where votes are free, or before the figures arrive", () => {
    expect(identityWarning(0.5 * SOL, ticket)).toBeNull();
    expect(identityWarning(0.5 * SOL, { kind: "fees", per_day: 0 })).toBeNull();
    expect(identityWarning(undefined, fees)).toBeNull();
    expect(identityWarning(0.5 * SOL, undefined)).toBeNull();
  });
});

describe("voteWarning", () => {
  it("is quiet with two tickets above the minimum", () => {
    expect(voteWarning(3.3 * SOL, ticket)).toBeNull();
  });

  it("warns with one ticket left and faults below the minimum", () => {
    expect(voteWarning(2 * SOL, ticket)?.label).toBe("vote, one admission ticket left");
    expect(voteWarning(2 * SOL, ticket)?.tone).toBe("warn");
    expect(voteWarning(1.5 * SOL, ticket)?.label).toBe("vote, below the admission ticket");
    expect(voteWarning(1.5 * SOL, ticket)?.tone).toBe("bad");
  });

  it("says nothing under TowerBFT, where no ticket is burned", () => {
    expect(voteWarning(0, fees)).toBeNull();
  });
});
