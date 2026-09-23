import { createContext, useContext, useSyncExternalStore } from "react";
import type { Store } from "./store";

export const StoreContext = createContext<Store | null>(null);

function useStoreInstance(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("StoreContext is missing a provider");
  return store;
}

/** Coarse on purpose; the store coalesces to one update per frame. */
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
