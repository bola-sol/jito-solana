import { useSyncExternalStore } from "react";
import { readBalancesHidden, writeBalancesHidden } from "./layout";

/** Whether the balances are off the screen, shared by the header's toggle and
 *  the epoch card's earnings. Read from storage on first use. */
let hidden: boolean | null = null;
const listeners = new Set<() => void>();

export function balancesHidden(): boolean {
  if (hidden === null) hidden = readBalancesHidden();
  return hidden;
}

export function toggleBalancesHidden(): void {
  hidden = !balancesHidden();
  writeBalancesHidden(hidden);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBalancesHidden(): boolean {
  return useSyncExternalStore(subscribe, balancesHidden, balancesHidden);
}
