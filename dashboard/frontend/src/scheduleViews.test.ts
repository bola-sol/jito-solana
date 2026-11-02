import { describe, expect, it } from "vitest";
import { startHash, withoutView, withView } from "./scheduleViews";

describe("saved views", () => {
  const view = (name: string, hash = "#/schedule?only=slow") => ({ name, hash, summary: "Slow" });

  it("puts a new view first and replaces one saved under the same name", () => {
    const views = withView([view("a"), view("b")], view("b", "#/schedule?ours"));
    expect(views.map((held) => [held.name, held.hash])).toEqual([
      ["b", "#/schedule?ours"],
      ["a", "#/schedule?only=slow"],
    ]);
    expect(withoutView(views, "a").map((held) => held.name)).toEqual(["b"]);
  });

  it("opens with a start view only while it is saved", () => {
    const views = [view("a"), view("b", "#/schedule?ours")];
    expect(startHash(views, "b")).toBe("#/schedule?ours");
    expect(startHash(views, "gone")).toBe(null);
    expect(startHash(views, null)).toBe(null);
  });
});
