/** The hash never reaches the server. */

import { useCallback, useEffect, useState } from "react";

export type Page = "overview" | "slots" | "schedule";

const PAGES: Page[] = ["overview", "slots", "schedule"];

export interface Route {
  page: Page;
  slot: number | null;
  query: string;
  ours: boolean;
}

export const HOME: Route = { page: "overview", slot: null, query: "", ours: false };

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

function withSearch(path: string, query: string, ours: boolean): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (ours) params.set("ours", "");
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
