import { createContext, useContext, useSyncExternalStore } from "react";
import type { Rewind, RewindState } from "./rewind";
import type { Store } from "./store";

/** The live store or the past view, whichever the page shows. */
export const StoreContext = createContext<Store | null>(null);

export const RewindContext = createContext<Rewind | null>(null);

/** The store without subscribing to its changes. */
export function useStoreInstance(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("StoreContext is missing a provider");
  return store;
}

/** Coarse on purpose; the store coalesces to one update per `RENDER_INTERVAL_MS`. */
export function useStore(): Store {
  const store = useStoreInstance();
  useSyncExternalStore(store.subscribe, store.getRevision, store.getRevision);
  return store;
}

/** Compared with `Object.is`, so `select` should return a primitive. */
export function useStoreValue<T>(select: (store: Store) => T): T {
  const store = useStoreInstance();
  const read = (): T => select(store);
  return useSyncExternalStore(store.subscribe, read, read);
}

export function useRewind(): Rewind {
  const rewind = useContext(RewindContext);
  if (!rewind) throw new Error("RewindContext is missing a provider");
  return rewind;
}

/** The live store, for requests: the same whether the page is live or past, so an effect that only
 *  asks the validator does not run again on pausing. */
export function useRequests(): Store {
  return useRewind().live;
}

export function useRewindState(): RewindState {
  const rewind = useRewind();
  return useSyncExternalStore(rewind.subscribe, rewind.getState, rewind.getState);
}

/** Moves on a settled seek backwards; a key for pages that gather rows as time moves forward. */
export function useRewindGeneration(): number {
  const rewind = useRewind();
  return useSyncExternalStore(rewind.subscribe, rewind.getGeneration, rewind.getGeneration);
}
