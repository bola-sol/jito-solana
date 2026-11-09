import { describe, expect, it } from "vitest";
import { asView, startAddress, withoutView, withView } from "./scheduleViews";

describe("saved views", () => {
  const view = (name: string, address = "/schedule?only=slow") => ({ name, address, summary: "Slow" });

  it("puts a new view first and replaces one saved under the same name", () => {
    const views = withView([view("a"), view("b")], view("b", "/schedule?ours"));
    expect(views.map((held) => [held.name, held.address])).toEqual([
      ["b", "/schedule?ours"],
      ["a", "/schedule?only=slow"],
    ]);
    expect(withoutView(views, "a").map((held) => held.name)).toEqual(["b"]);
  });

  it("opens with a start view only while it is saved", () => {
    const views = [view("a"), view("b", "/schedule?ours")];
    expect(startAddress(views, "b")).toBe("/schedule?ours");
    expect(startAddress(views, "gone")).toBe(null);
    expect(startAddress(views, null)).toBe(null);
  });

  it("moves a view saved under a hash to its path", () => {
    expect(asView({ name: "a", summary: "s", hash: "#/schedule?where=duration%3Agt%3A400" })).toEqual({
      name: "a",
      summary: "s",
      address: "/schedule?duration=over-400",
    });
    expect(asView(view("a"))).toEqual(view("a"));
  });

  it("drops what is not a schedule view", () => {
    expect(asView(null)).toBe(null);
    expect(asView({ name: "a", summary: "s" })).toBe(null);
    expect(asView({ name: "a", summary: "s", address: "/gossip" })).toBe(null);
    expect(asView({ name: "a", summary: "s", hash: "#/gossip" })).toBe(null);
  });
});
