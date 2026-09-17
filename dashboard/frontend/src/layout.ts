/** Whether the slot list down the side is collapsed, remembered across
 *  reloads. */

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

/** Whether the host card's thread group is folded. Null where the viewer has
 *  never chosen, so the card defaults by width. */
export const THREADS_STORAGE_KEY = "agave-dashboard-threads";

export function readThreadsCollapsed(): boolean | null {
  try {
    const held = window.localStorage.getItem(THREADS_STORAGE_KEY);
    return held === null ? null : held === "collapsed";
  } catch {
    return null;
  }
}

export function writeThreadsCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      THREADS_STORAGE_KEY,
      collapsed ? "collapsed" : "expanded",
    );
  } catch {
    // As above.
  }
}
