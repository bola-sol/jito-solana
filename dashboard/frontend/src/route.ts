/** The hash never reaches the server. */

import { useCallback, useEffect, useState } from "react";
import { readOnly, type Only } from "./scheduleFilters";

export type Page = "overview" | "slots" | "schedule" | "gossip" | "cluster";

const PAGES: Page[] = ["overview", "slots", "schedule", "gossip", "cluster"];

export interface Route {
  page: Page;
  slot: number | null;
  query: string;
  ours: boolean;
  /** The schedule's jump, as typed. */
  from: string;
  /** The schedule's filters. */
  only: readonly Only[];
}

export const HOME: Route = { page: "overview", slot: null, query: "", ours: false, from: "", only: [] };

export function readRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?");
  const [name, rest] = path.split("/");
  const page = PAGES.find((page) => page === name) ?? "overview";
  const params = new URLSearchParams(search);
  return {
    page,
    slot: page === "slots" && rest !== undefined && /^\d+$/.test(rest) ? Number(rest) : null,
    // Only the pages with a search box keep one.
    query: page === "overview" || page === "cluster" ? "" : (params.get("q") ?? ""),
    ours: page === "schedule" && params.has("ours"),
    from: page === "schedule" ? (params.get("from") ?? "") : "",
    only: page === "schedule" ? readOnly(params.get("only")) : [],
  };
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case "overview":
      return "#";
    case "slots":
      return withSearch(route.slot === null ? "#/slots" : `#/slots/${route.slot}`, { q: route.query });
    case "schedule":
      return withSearch("#/schedule", {
        q: route.query,
        ours: route.ours,
        from: route.from,
        only: route.only.join(","),
      });
    case "gossip":
      return withSearch("#/gossip", { q: route.query });
    case "cluster":
      return "#/cluster";
  }
}

/** Empty and false values are left out; true is written as a bare key. */
function withSearch(path: string, values: Record<string, string | boolean>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === true) params.set(key, "");
    else if (value) params.set(key, value);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/** A page change is a history entry and anything else replaces it, so back steps between pages. */
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
