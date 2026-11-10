import { beforeEach, describe, expect, it, vi } from "vitest";
import { allFoldsOpen, foldOpen, setFoldsOpen } from "./folds";
import { OPENED_STORAGE_KEY } from "./layout";
import { storage } from "./testStorage";

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: storage() });
});

describe("folds", () => {
  it("read a fold's first state from storage", () => {
    window.localStorage.setItem(OPENED_STORAGE_KEY, "first");
    expect(foldOpen("first")).toBe(true);
    expect(foldOpen("second")).toBe(false);
  });

  it("open and fold every one named, and write it down", () => {
    const ids = ["a", "b", "c"];
    setFoldsOpen(["b"], true);
    expect(allFoldsOpen(ids)).toBe(false);
    setFoldsOpen(ids, true);
    expect(allFoldsOpen(ids)).toBe(true);
    expect(window.localStorage.getItem(OPENED_STORAGE_KEY)).toBe("a,b,c");
    setFoldsOpen(ids, false);
    expect(ids.some(foldOpen)).toBe(false);
    expect(window.localStorage.getItem(OPENED_STORAGE_KEY)).toBe("");
  });
});
