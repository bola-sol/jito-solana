import { describe, expect, it } from "vitest";
import { HOME, readRoute, routeHash, type Route } from "./route";

describe("readRoute", () => {
  it("reads a page out of the hash, with or without the slash", () => {
    expect(readRoute("#/schedule").page).toBe("schedule");
    expect(readRoute("#schedule").page).toBe("schedule");
    expect(readRoute("#/slots").page).toBe("slots");
    expect(readRoute("#/gossip").page).toBe("gossip");
  });

  it("falls back to the overview rather than showing nothing", () => {
    expect(readRoute("")).toEqual(HOME);
    expect(readRoute("#")).toEqual(HOME);
    expect(readRoute("#/nonsense")).toEqual(HOME);
  });

  it("reads an open block on the slot page", () => {
    expect(readRoute("#/slots/5539826")).toEqual({ ...HOME, page: "slots", slot: 5_539_826 });
    expect(readRoute("#/slots/abc").slot).toBeNull();
    expect(readRoute("#/schedule/5539826").slot).toBeNull();
  });

  it("reads the schedule's filter", () => {
    expect(readRoute("#/schedule?q=Mithril+Alpenglow&ours=")).toEqual({
      page: "schedule",
      slot: null,
      query: "Mithril Alpenglow",
      ours: true,
    });
    expect(readRoute("#/schedule?ours").ours).toBe(true);
    expect(readRoute("#/slots?q=826&ours")).toEqual({ ...HOME, page: "slots", query: "826" });
    expect(readRoute("#/slots/5539826?q=826").slot).toBe(5_539_826);
    expect(readRoute("#/?q=x").query).toBe("");
    expect(readRoute("#/gossip?q=Jito&ours")).toEqual({ ...HOME, page: "gossip", query: "Jito" });
  });
});

describe("routeHash", () => {
  it("round-trips every route", () => {
    const routes: Route[] = [
      HOME,
      { ...HOME, page: "slots" },
      { ...HOME, page: "slots", slot: 12 },
      { ...HOME, page: "slots", slot: 12, query: "1 2" },
      { ...HOME, page: "slots", query: "9" },
      { ...HOME, page: "schedule" },
      { ...HOME, page: "schedule", query: "a b&c", ours: true },
      { ...HOME, page: "schedule", ours: true },
      { ...HOME, page: "gossip" },
      { ...HOME, page: "gossip", query: "64.130" },
    ];
    for (const route of routes) expect(readRoute(routeHash(route))).toEqual(route);
  });

  it("clears the hash for the overview instead of naming it", () => {
    expect(routeHash(HOME)).toBe("#");
  });

  it("names nothing it does not need to", () => {
    expect(routeHash({ ...HOME, page: "slots" })).toBe("#/slots");
    expect(routeHash({ ...HOME, page: "schedule" })).toBe("#/schedule");
  });
});
