/**
 * Whether the slot list down the side is collapsed.
 *
 * Remembered so that a viewer who has hidden it does not have to hide it again
 * on every reload. Read synchronously at the first render, so unlike the theme
 * there is nothing to stamp before the bundle runs and nothing to flash.
 */

export const SIDEBAR_STORAGE_KEY = "agave-dashboard-sidebar";

export function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed";
  } catch {
    // Private browsing and some embedded webviews refuse storage outright.
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_STORAGE_KEY,
      collapsed ? "collapsed" : "expanded",
    );
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}
