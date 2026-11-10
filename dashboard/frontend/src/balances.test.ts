import { beforeEach, describe, expect, it, vi } from "vitest";
import { balancesHidden, toggleBalancesHidden } from "./balances";
import { BALANCES_STORAGE_KEY } from "./layout";
import { storage } from "./testStorage";

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
