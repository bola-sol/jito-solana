/** Private browsing and some embedded webviews refuse storage outright, so a read that throws
 *  answers null. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}
