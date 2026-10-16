import { describe, expect, it } from "vitest";
import { catchUpClause, IN_STEP_SLOTS, verdictOf } from "./verdict";

describe("verdictOf", () => {
  it("waits without health", () => {
    expect(verdictOf(undefined, 0)).toEqual({
      tone: "muted",
      headline: "Waiting for the validator.",
    });
  });

  it("reads in step while voting close to the tip", () => {
    expect(verdictOf({ replay: "running", vote: "voting" }, IN_STEP_SLOTS)).toEqual({
      tone: "good",
      headline: "Voting, in step with the cluster.",
    });
  });

  it("says how far behind once past the allowance", () => {
    expect(verdictOf({ replay: "running", vote: "voting" }, 1_200)).toEqual({
      tone: "warn",
      headline: "Voting, 1,200 slots behind the cluster.",
    });
  });

  it("puts a stalled replay before the vote", () => {
    expect(verdictOf({ replay: "stalled", vote: "voting" }, 0).tone).toBe("bad");
  });

  it("names delinquency with the distance where there is one", () => {
    expect(verdictOf({ replay: "running", vote: "delinquent" }, 300).headline).toBe(
      "Delinquent, 300 slots behind the cluster.",
    );
    expect(verdictOf({ replay: "running", vote: "delinquent" }, null).headline).toBe(
      "Delinquent.",
    );
  });

  it("tones a backup identity amber", () => {
    expect(verdictOf({ replay: "running", vote: "not_voting" }, 0).tone).toBe("warn");
  });

  it("keeps the distance on the branches a restart passes through", () => {
    expect(verdictOf({ replay: "stalled", vote: "not_started" }, 5_212, 448_419_378).headline).toBe(
      "Replay has stalled at slot 448,419,378, 5,212 slots behind the cluster.",
    );
    expect(verdictOf({ replay: "stalled", vote: "voting" }, 0).headline).toBe("Replay has stalled.");
    expect(verdictOf({ replay: "running", vote: "not_started" }, 4_180).headline).toBe(
      "Running, not voting yet, 4,180 slots behind the cluster.",
    );
    expect(verdictOf({ replay: "running", vote: "not_voting" }, 90).headline).toBe(
      "Running without voting, 90 slots behind the cluster.",
    );
    expect(verdictOf({ replay: "running", vote: "not_voting" }, IN_STEP_SLOTS).headline).toBe(
      "Running without voting.",
    );
  });
});

describe("catchUpClause", () => {
  const slot400ms = 400_000_000;

  it("says the rate and the time to close the gap", () => {
    // 38 a second against the cluster's 2.5: a net 35.5, so 4,180 slots take 117 seconds.
    expect(catchUpClause(4_180, 38, slot400ms)).toBe("Catching up at 38 slots/s, about 1m 57s to go.");
  });

  it("says so when replay is no faster than the cluster", () => {
    expect(catchUpClause(5_212, 0, slot400ms)).toBe("Not gaining on the cluster.");
    expect(catchUpClause(5_212, 2.5, slot400ms)).toBe("Not gaining on the cluster.");
  });

  it("is quiet in step, and until both rates are known", () => {
    expect(catchUpClause(IN_STEP_SLOTS, 38, slot400ms)).toBeNull();
    expect(catchUpClause(null, 38, slot400ms)).toBeNull();
    expect(catchUpClause(4_180, null, slot400ms)).toBeNull();
    expect(catchUpClause(4_180, 38, undefined)).toBeNull();
  });
});
