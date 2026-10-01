import { beforeEach, describe, expect, it, vi } from "vitest";
import { balancesHidden, toggleBalancesHidden } from "./balances";
import { BALANCES_STORAGE_KEY } from "./layout";

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

describe("balancesHidden", () => {
  it("flips on each toggle and writes the choice down", () => {
    const before = balancesHidden();
    toggleBalancesHidden();
    expect(balancesHidden()).toBe(!before);
    expect(window.localStorage.getItem(BALANCES_STORAGE_KEY)).toBe(before ? "shown" : "hidden");
    toggleBalancesHidden();
    expect(balancesHidden()).toBe(before);
  });
});
