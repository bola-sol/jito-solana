
import type { Store } from "./store";

const MIN_VISIBLE_MS = 650;

const MAX_VISIBLE_MS = 6000;

/** Must match the #splash transition duration in index.html. */
const FADE_MS = 450;

/** Where the needle stands, out of 100, once each step of the load has happened. */
export const NEEDLE_STEPS = { bundleRunning: 30, socketOpen: 65, ready: 100 } as const;

const STEP_VALUES: readonly number[] = Object.values(NEEDLE_STEPS);

/** Share of the gap to the next step the needle may creep into while it waits. */
const CREEP_LIMIT = 0.9;

const CREEP_MS = 1200;

const EASE_MS = 80;

/** Longest frame gap counted, so a tab returning from the background does not jump. */
const MAX_FRAME_MS = 64;

export interface NeedleState {
  /** Where the needle is drawn. */
  shown: number;
  /** Where it is heading: the step reached plus any creep toward the next. */
  crept: number;
}

/** Advances the needle one frame toward `reached`, never past the step after it. */
export function stepNeedle(state: NeedleState, reached: number, elapsedMs: number): NeedleState {
  const dt = Math.min(MAX_FRAME_MS, Math.max(0, elapsedMs));
  const next = STEP_VALUES.find((value) => value > reached) ?? reached;
  const limit = reached + (next - reached) * CREEP_LIMIT;
  const from = Math.max(state.crept, reached);
  const crept = from + (limit - from) * (1 - Math.exp(-dt / CREEP_MS));
  const shown = state.shown + (crept - state.shown) * (1 - Math.exp(-dt / EASE_MS));
  return { shown, crept };
}

/** Turns the needle every frame until the returned function is called. */
function driveNeedle(needle: SVGElement, reached: () => number): () => void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let state: NeedleState = { shown: 0, crept: 0 };
  let last = performance.now();
  let frame = 0;

  const draw = (now: number): void => {
    const target = reached();
    state = reduceMotion ? { shown: target, crept: target } : stepNeedle(state, target, now - last);
    last = now;
    // Drawn pointing at 100; 0 is half a turn back.
    needle.setAttribute("transform", `rotate(${state.shown * 1.8 - 180} 800 476)`);
    frame = window.requestAnimationFrame(draw);
  };

  frame = window.requestAnimationFrame(draw);
  return () => window.cancelAnimationFrame(frame);
}

export function dismissSplashWhenReady(store: Store): void {
  const splash = document.getElementById("splash");
  if (!splash) return;

  const startedAt = performance.now();
  let unsubscribe: (() => void) | undefined;
  let hidden = false;
  let reached: number = NEEDLE_STEPS.bundleRunning;

  const needle = splash.querySelector<SVGElement>(".splash-needle");
  const stopNeedle = needle ? driveNeedle(needle, () => reached) : undefined;

  const hide = (): void => {
    if (hidden) return;
    hidden = true;
    unsubscribe?.();
    splash.classList.add("is-leaving");
    // Remove it outright afterwards: a transparent overlay left in place would
    // still swallow every click on the dashboard beneath.
    window.setTimeout(() => {
      stopNeedle?.();
      splash.remove();
    }, FADE_MS + 50);
  };

  const onChange = (): void => {
    if (hidden) return;
    if (store.getConnection() === "open") reached = Math.max(reached, NEEDLE_STEPS.socketOpen);
    if (!store.isReady()) return;
    reached = NEEDLE_STEPS.ready;
    unsubscribe?.();
    unsubscribe = undefined;
    const remaining = MIN_VISIBLE_MS - (performance.now() - startedAt);
    if (remaining > 0) window.setTimeout(hide, remaining);
    else hide();
  };

  unsubscribe = store.subscribe(onChange);
  window.setTimeout(hide, MAX_VISIBLE_MS);
  onChange();
}
