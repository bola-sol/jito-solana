/** The server sends a full snapshot on connect, so nothing needs catching up. */

import type { Store } from "./store";
import type { Envelope } from "./types";

// Timers are used unqualified rather than through `window`, which is the same
// function in a browser and lets this module be tested without one.
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

/** Silence before the connection counts as dead: a socket can stop delivering without closing, and
 *  the validator's clock arrives every second. Eight seconds rides out a mobile handover. */
const SILENCE_LIMIT_MS = 8_000;

const WATCHDOG_INTERVAL_MS = 2_000;

const DEFLATE_PROTOCOL = "deflate";

function canInflate(): boolean {
  return typeof DecompressionStream === "function";
}

async function inflate(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Response(stream).text();
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "topic" in value &&
    typeof value.topic === "string" &&
    "key" in value &&
    typeof value.key === "string"
  );
}

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

  /** Not left to `onclose`, which an unreachable peer may never deliver. */
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
      }
    }
    store.setConnection("closed");
    schedule();
  };

  const open = () => {
    if (closed) return;
    store.setConnection("connecting");
    const ws = canInflate() ? new WebSocket(url(), [DEFLATE_PROTOCOL]) : new WebSocket(url());
    ws.binaryType = "arraybuffer";
    socket = ws;
    lastMessageAt = Date.now();

    const deliver = (text: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A malformed frame is a server bug. Dropping it beats tearing down a
        // connection that is otherwise working.
        return;
      }
      if (!isEnvelope(parsed)) return;
      store.apply(parsed);
    };

    // A deflated frame inflates on a promise, so every frame behind one waits
    // on the same promise to be applied in the order it arrived.
    let queue: Promise<void> = Promise.resolve();
    let queued = 0;

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
      const data: unknown = event.data;
      if (typeof data === "string" && queued === 0) {
        deliver(data);
        return;
      }
      queued += 1;
      queue = queue
        .then(async () => {
          const text =
            typeof data === "string"
              ? data
              : data instanceof ArrayBuffer
                ? await inflate(data).catch(() => null)
                : null;
          if (ws === socket && text !== null) deliver(text);
        })
        // A frame that fails is dropped rather than stalling the ones behind it.
        .catch(() => {})
        .finally(() => {
          queued -= 1;
        });
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
