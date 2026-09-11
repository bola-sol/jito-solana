/** Keeps a websocket to the validator open, reconnecting with backoff. The
 *  server sends a full snapshot on connect, so nothing needs catching up. */

import type { Store } from "./store";
import type { Envelope } from "./types";

// Timers are used unqualified rather than through `window`, which is the same
// function in a browser and lets this module be tested without one.
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

/**
 * Silence before the connection counts as dead. A socket can stop delivering
 * without closing; the validator publishes its clock every second, so a
 * working one is never quiet this long. Eight seconds rides out a mobile
 * handover.
 */
const SILENCE_LIMIT_MS = 8_000;

/** How often the silence is checked. */
const WATCHDOG_INTERVAL_MS = 2_000;

export function connect(store: Store): () => void {
  let socket: WebSocket | null = null;
  let retryMs = MIN_RETRY_MS;
  let timer: number | null = null;
  let watchdog: number | null = null;
  let lastMessageAt = Date.now();
  let closed = false;

  const url = () => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/websocket`;
  };

  const stopWatchdog = () => {
    if (watchdog === null) return;
    clearInterval(watchdog);
    watchdog = null;
  };

  /** Gives up on a quiet socket and starts another. Not left to `onclose`,
   *  which an unreachable peer may never deliver. */
  const abandon = () => {
    stopWatchdog();
    const dead = socket;
    socket = null;
    if (dead) {
      dead.onopen = null;
      dead.onmessage = null;
      dead.onclose = null;
      dead.onerror = null;
      try {
        dead.close();
      } catch {
        // Already gone. Nothing here depends on it closing cleanly.
      }
    }
    store.setConnection("closed");
    schedule();
  };

  const open = () => {
    if (closed) return;
    store.setConnection("connecting");
    const ws = new WebSocket(url());
    socket = ws;
    lastMessageAt = Date.now();

    // Every handler checks it is still the current socket. An abandoned one can
    // fire late, and it must not disturb the connection that replaced it.
    ws.onopen = () => {
      if (ws !== socket) return;
      retryMs = MIN_RETRY_MS;
      lastMessageAt = Date.now();
      // Installed before the state changes, so a caller that reacts to the
      // connection opening can send straight away.
      store.setSender((frame) => ws.send(frame));
      store.setConnection("open");
      stopWatchdog();
      watchdog = setInterval(() => {
        // Wall clock rather than a monotonic one, so that a device waking from
        // sleep counts the time it was away and reconnects at once.
        if (Date.now() - lastMessageAt >= SILENCE_LIMIT_MS) abandon();
      }, WATCHDOG_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      if (ws !== socket) return;
      // Recorded before the frame is understood: anything arriving proves the
      // connection is delivering, which is all this is watching for.
      lastMessageAt = Date.now();
      if (typeof event.data !== "string") return;
      let envelope: Envelope;
      try {
        envelope = JSON.parse(event.data) as Envelope;
      } catch {
        // A malformed frame is a server bug. Dropping it beats tearing down a
        // connection that is otherwise working.
        return;
      }
      store.apply(envelope);
    };

    ws.onclose = () => {
      if (ws !== socket) return;
      stopWatchdog();
      store.setConnection("closed");
      schedule();
    };

    ws.onerror = () => {
      if (ws !== socket) return;
      ws.close();
    };
  };

  const schedule = () => {
    if (closed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };

  open();

  return () => {
    closed = true;
    stopWatchdog();
    if (timer !== null) clearTimeout(timer);
    socket?.close();
  };
}
