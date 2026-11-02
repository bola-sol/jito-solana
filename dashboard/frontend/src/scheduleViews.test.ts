import { describe, expect, it } from "vitest";
import { withoutView, withView } from "./scheduleViews";

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
});
