import { useEffect, useState } from "react";
import type { Requests } from "./store";
import { useStore } from "./useStore";

/** Until the first reply holds something, since the validator gathers it only once asked. */
const FIRST_POLL_MS = 1_000;

/** A reply asked for again every `everyMs` while mounted; the validator gathers it only while asked. */
export function usePolledRequest<R extends "peers.gossip" | "cluster.charts">(
  route: R,
  everyMs: number,
): Requests[R]["reply"] {
  const store = useStore();
  const [reply, setReply] = useState<Requests[R]["reply"]>(null);
  // Asked once the socket is open, and again on each new one.
  const open = store.getConnection() === "open";
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      store.request(route, {}).then(
        (got) => {
          if (!live) return;
          if (got) setReply(got);
          timer = setTimeout(load, got ? everyMs : FIRST_POLL_MS);
        },
        () => {
          if (live) timer = setTimeout(load, FIRST_POLL_MS);
        },
      );
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [store, open, route, everyMs]);
  return reply;
}
