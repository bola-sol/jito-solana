import { describe, expect, it } from "vitest";
import { NEEDLE_STEPS, type NeedleState, stepNeedle } from "./splash";

function run(state: NeedleState, reached: number, frames: number, frameMs = 16): NeedleState {
  let next = state;
  for (let i = 0; i < frames; i++) next = stepNeedle(next, reached, frameMs);
  return next;
}

describe("stepNeedle", () => {
  it("creeps while waiting but stops short of the next step", () => {
    const state = run({ shown: 0, crept: 0 }, NEEDLE_STEPS.bundleRunning, 2000);
    expect(state.shown).toBeGreaterThan(NEEDLE_STEPS.bundleRunning);
    expect(state.shown).toBeLessThan(NEEDLE_STEPS.socketOpen);
  });

  it("reaches 100 once the dashboard is ready", () => {
    const state = run({ shown: 40, crept: 40 }, NEEDLE_STEPS.ready, 60);
    expect(state.shown).toBeGreaterThan(99.5);
    expect(state.shown).toBeLessThanOrEqual(100);
  });

  it("never moves backwards as the steps are reached", () => {
    let state: NeedleState = { shown: 0, crept: 0 };
    let previous = 0;
    for (const reached of [NEEDLE_STEPS.bundleRunning, NEEDLE_STEPS.socketOpen, NEEDLE_STEPS.ready]) {
      for (let i = 0; i < 30; i++) {
        state = stepNeedle(state, reached, 16);
        expect(state.shown).toBeGreaterThanOrEqual(previous);
        previous = state.shown;
      }
    }
  });

  it("treats a long or negative frame gap as a short one", () => {
    const start: NeedleState = { shown: 0, crept: 0 };
    expect(stepNeedle(start, NEEDLE_STEPS.ready, 10_000)).toEqual(stepNeedle(start, NEEDLE_STEPS.ready, 64));
    expect(stepNeedle(start, NEEDLE_STEPS.ready, -5).shown).toBe(start.shown);
  });
});
