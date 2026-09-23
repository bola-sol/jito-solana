/** Where the page is, kept in the URL hash so a view can be linked to. The
 *  hash never reaches the server. */

import { useCallback, useEffect, useState } from "react";

export type Page = "overview" | "slots" | "schedule";

/** In nav order: what the validator is doing now, the blocks it produced, then what is coming. */
const PAGES: Page[] = ["overview", "slots", "schedule"];

/** A page and what is open on it: `#/slots/5539826` an expanded block, `#/slots?q=826` a filtered
 *  list, `#/schedule?q=mithril&ours` a filtered schedule. */
export interface Route {
  page: Page;
  /** The open block on the slot page. */
  slot: number | null;
  /** The search text on the slot page or the schedule. */
  query: string;
  /** Whether the schedule lists our turns alone. */
  ours: boolean;
}

export const HOME: Route = { page: "overview", slot: null, query: "", ours: false };

/** The route a hash names, defaulting to the overview for anything unknown. */
export function readRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?");
  const [name, rest] = path.split("/");
  const page = PAGES.find((page) => page === name) ?? "overview";
  const params = new URLSearchParams(search);
  return {
    page,
    slot: page === "slots" && rest !== undefined && /^\d+$/.test(rest) ? Number(rest) : null,
    query: page === "overview" ? "" : (params.get("q") ?? ""),
    ours: page === "schedule" && params.has("ours"),
  };
}

/** The hash for a route. The overview clears it rather than naming itself. */
export function routeHash(route: Route): string {
  switch (route.page) {
    case "overview":
      return "#";
    case "slots":
      return withSearch(route.slot === null ? "#/slots" : `#/slots/${route.slot}`, route.query, false);
    case "schedule":
      return withSearch("#/schedule", route.query, route.ours);
  }
}

/** `path` with the search on it, where there is one. */
function withSearch(path: string, query: string, ours: boolean): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (ours) params.set("ours", "");
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** The current route, following the address bar. A page change is a history entry and anything else
 *  replaces it, so back steps between pages. */
export function useRoute(): [Route, (next: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => readRoute(window.location.hash));

  useEffect(() => {
    const follow = () => setRoute(readRoute(window.location.hash));
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  const go = useCallback((next: Route, replace = false) => {
    const hash = routeHash(next);
    if (replace) window.history.replaceState(null, "", hash);
    else window.location.hash = hash;
    setRoute(next);
  }, []);

  return [route, go];
}
