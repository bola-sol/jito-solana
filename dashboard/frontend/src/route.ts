/** Which page is on screen, kept in the URL hash, which never reaches the
 *  server. */

import { useEffect, useState } from "react";

export type Page = "overview" | "slots" | "schedule";

/** In the order the nav lists them, which is the order they are worked through:
 *  what the validator is doing now, the blocks it produced, then what is
 *  coming. */
const PAGES: Page[] = ["overview", "slots", "schedule"];

/** The page a hash names, defaulting to the overview for anything unknown. */
export function readPage(hash: string): Page {
  const name = hash.replace(/^#\/?/, "");
  return PAGES.find((page) => page === name) ?? "overview";
}

/** The hash for a page. The overview clears it rather than naming itself. */
export function pageHash(page: Page): string {
  return page === "overview" ? "#" : `#/${page}`;
}

/** The current page, following the address bar so the back button works. */
export function usePage(): [Page, (page: Page) => void] {
  const [page, setPage] = useState<Page>(() => readPage(window.location.hash));

  useEffect(() => {
    const follow = () => setPage(readPage(window.location.hash));
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  return [
    page,
    (next: Page) => {
      window.location.hash = pageHash(next);
      setPage(next);
    },
  ];
}
