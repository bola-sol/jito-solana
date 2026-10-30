import { beforeEach, describe, expect, it, vi } from "vitest";
import { allFoldsOpen, foldOpen, setFoldsOpen } from "./folds";
import { OPENED_STORAGE_KEY } from "./layout";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    length: 0,
  };
}

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
