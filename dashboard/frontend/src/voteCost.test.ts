import { describe, expect, it } from "vitest";
import { identityWarning, voteRunway, voteWarning } from "./voteCost";
import type { VoteCost } from "./types";

const SOL = 1_000_000_000;
const fees: VoteCost = { kind: "fees", per_day: 1.08 * SOL };
const ticket: VoteCost = { kind: "ticket", lamports: 1.6 * SOL, minimum: 1.63 * SOL, pending: 0 };

describe("identityWarning", () => {
  it("is quiet with three days of votes in hand", () => {
    expect(identityWarning(4 * SOL, fees, true)).toBeNull();
  });

  it("warns under three days and faults under a day", () => {
    expect(identityWarning(2 * SOL, fees, true)?.tone).toBe("warn");
    expect(identityWarning(2 * SOL, fees, true)?.label).toBe("identity, under three days of votes");
    expect(identityWarning(0.5 * SOL, fees, true)?.tone).toBe("bad");
    expect(identityWarning(0.5 * SOL, fees, true)?.label).toBe("identity, under a day of votes");
  });

  it("says nothing on a node that is not the voter, or before that is known", () => {
    expect(identityWarning(0, fees, false)).toBeNull();
    expect(identityWarning(0, fees, undefined)).toBeNull();
  });

  it("says nothing under alpenglow, where votes are free, or before the figures arrive", () => {
    expect(identityWarning(0.5 * SOL, ticket, true)).toBeNull();
    expect(identityWarning(0.5 * SOL, { kind: "fees", per_day: 0 }, true)).toBeNull();
    expect(identityWarning(undefined, fees, true)).toBeNull();
    expect(identityWarning(0.5 * SOL, undefined, true)).toBeNull();
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

  it("holds the delegators' pending rewards on top of the minimum", () => {
    const owing: VoteCost = { ...ticket, pending: 0.5 * SOL };
    expect(voteWarning(3.3 * SOL, owing)?.tone).toBe("warn");
    expect(voteWarning(2 * SOL, owing)?.tone).toBe("bad");
  });

  it("says nothing under TowerBFT, where no ticket is burned", () => {
    expect(voteWarning(0, fees)).toBeNull();
  });
});

describe("voteRunway", () => {
  it("counts whole epochs: the next, already paid, and one per ticket above rent", () => {
    const runway = voteRunway(41.04 * SOL, ticket, 1072);
    expect(runway?.epochs).toBe(26);
    expect(runway?.lastEpoch).toBe(1072 + 26);
  });

  it("leaves only the next epoch when no whole ticket is in hand", () => {
    const runway = voteRunway(1.5 * SOL, ticket, 1072);
    expect(runway?.epochs).toBe(1);
    expect(runway?.lastEpoch).toBe(1073);
  });

  it("takes the delegators' pending rewards off the balance", () => {
    expect(voteRunway(4 * SOL, { ...ticket, pending: 1 * SOL }, 1072)?.epochs).toBe(2);
    expect(voteRunway(4 * SOL, ticket, 1072)?.epochs).toBe(3);
  });

  it("is nothing under TowerBFT or before the figures arrive", () => {
    expect(voteRunway(41 * SOL, fees, 1072)).toBeNull();
    expect(voteRunway(undefined, ticket, 1072)).toBeNull();
    expect(voteRunway(41 * SOL, ticket, undefined)).toBeNull();
  });
});
