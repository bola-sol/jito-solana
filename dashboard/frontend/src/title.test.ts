import { describe, expect, it } from "vitest";
import { pageTitle, TITLE } from "./title";

describe("pageTitle", () => {
  it("names the validator and its cluster", () => {
    expect(pageTitle("Lantern", "HLj2…", "mainnet-beta")).toBe("Agave Dashboard | Lantern · mainnet-beta");
  });

  it("calls an unnamed node private", () => {
    expect(pageTitle(undefined, "HLj2…", "testnet")).toBe("Agave Dashboard | Private · testnet");
  });

  it("holds the name until the cluster arrives, and the base until a node answers", () => {
    expect(pageTitle("Lantern", "HLj2…", undefined)).toBe("Agave Dashboard | Lantern");
    expect(pageTitle(undefined, undefined, "testnet")).toBe(TITLE);
  });
});
