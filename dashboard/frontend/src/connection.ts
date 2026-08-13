/**
 * Keeps a websocket to the validator open, reconnecting with backoff.
 *
 * The server sends a full snapshot on connect, so a reconnect needs no catch-up
 * logic. Whatever arrives overwrites the store.
 */

import type { Store } from "./store";
import type { Envelope } from "./types";

const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 10_000;

export function connect(store: Store): () => void {
  let socket: WebSocket | null = null;
  let retryMs = MIN_RETRY_MS;
  let timer: number | null = null;
  let closed = false;

  const url = () => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/websocket`;
  };

  const open = () => {
    if (closed) return;
    store.setConnection("connecting");
    socket = new WebSocket(url());

    socket.onopen = () => {
      retryMs = MIN_RETRY_MS;
      store.setConnection("open");
    };

    socket.onmessage = (event) => {
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

    socket.onclose = () => {
      store.setConnection("closed");
      schedule();
    };

    socket.onerror = () => socket?.close();
  };

  const schedule = () => {
    if (closed || timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      open();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };

  open();

  return () => {
    closed = true;
    if (timer !== null) window.clearTimeout(timer);
    socket?.close();
  };
}
