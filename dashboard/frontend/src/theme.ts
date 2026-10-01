/** index.html stamps it inline first to avoid a flash. */

import { readStored, writeStored } from "./storage";

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "agave-dashboard-theme";

export function readTheme(): Theme {
  return readStored(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  writeStored(THEME_STORAGE_KEY, theme);
}
