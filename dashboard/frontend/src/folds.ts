import { useSyncExternalStore } from "react";
import { readFoldOpen, writeFoldOpen } from "./layout";

/** The Overview's folds, which the header opens and folds together. */
export const OVERVIEW_FOLDS: readonly string[] = ["machine", "block-life", "replay", "caches", "tpu"];

/** Shared by each fold and the header's toggle. */
const held = new Map<string, boolean>();
const listeners = new Set<() => void>();

export function foldOpen(id: string): boolean {
  let open = held.get(id);
  if (open === undefined) {
    open = readFoldOpen(id);
    held.set(id, open);
  }
  return open;
}

export function setFoldsOpen(ids: readonly string[], open: boolean): void {
  for (const id of ids) {
    held.set(id, open);
    writeFoldOpen(id, open);
  }
  for (const listener of listeners) listener();
}

export function allFoldsOpen(ids: readonly string[]): boolean {
  return ids.every(foldOpen);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFoldOpen(id: string): boolean {
  const read = () => foldOpen(id);
  return useSyncExternalStore(subscribe, read, read);
}

export function useAllFoldsOpen(ids: readonly string[]): boolean {
  const read = () => allFoldsOpen(ids);
  return useSyncExternalStore(subscribe, read, read);
}
