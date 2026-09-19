import { describe, expect, it } from "vitest";
import { IN_STEP_SLOTS, verdictOf } from "./verdict";

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
});
