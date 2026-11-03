import { useSyncExternalStore } from "react";
import { readLogosHidden, writeLogosHidden } from "./layout";

/** The first letter or digit of a name, for a logo's stand-in; empty where there is none. */
export function monogram(name: string | null | undefined): string {
  const first = name?.match(/[\p{L}\p{N}]/u)?.[0];
  return first ? first.toLocaleUpperCase() : "";
}

/** The distinct logos of the leaders of the `slots` slots after `slot`, soonest first. */
export function upcomingIcons(
  slot: number,
  slots: number,
  iconOf: (slot: number) => string | null,
): string[] {
  const icons = new Set<string>();
  for (let next = slot + 1; next <= slot + slots; next += 1) {
    const icon = iconOf(next);
    if (icon) icons.add(icon);
  }
  return [...icons];
}

const PRELOADED_KEPT = 256;
const preloaded = new Map<string, HTMLImageElement>();

/** Fetches a logo ahead of its leader's turn, so the browser has it cached when it is shown. The
 *  same referrer policy as the shown image, so the cached copy is the one used. */
export function preloadLogo(url: string): void {
  if (logosHidden() || preloaded.has(url)) return;
  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.decoding = "async";
  image.src = url;
  preloaded.set(url, image);
  if (preloaded.size > PRELOADED_KEPT) {
    const oldest = preloaded.keys().next().value;
    if (oldest !== undefined) preloaded.delete(oldest);
  }
}

/** Hidden logos are never requested, since each one tells its host the viewer's address. */
let hidden: boolean | null = null;
const listeners = new Set<() => void>();

export function logosHidden(): boolean {
  if (hidden === null) hidden = readLogosHidden();
  return hidden;
}

export function toggleLogosHidden(): void {
  hidden = !logosHidden();
  writeLogosHidden(hidden);
  if (hidden) {
    // Cancels the fetches still in flight.
    for (const image of preloaded.values()) image.removeAttribute("src");
    preloaded.clear();
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLogosHidden(): boolean {
  return useSyncExternalStore(subscribe, logosHidden, logosHidden);
}

/** How many logos are held; for tests. */
export function preloadedCount(): number {
  return preloaded.size;
}
