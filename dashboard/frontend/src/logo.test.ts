import { afterEach, describe, expect, it, vi } from "vitest";
import { monogram, preloadedCount, preloadLogo, upcomingIcons } from "./logo";

describe("monogram", () => {
  it("takes the first letter or digit, past emoji and symbols", () => {
    expect(monogram("Figment")).toBe("F");
    expect(monogram("🔥💃 Asymmetric Research")).toBe("A");
    expect(monogram("1dad | faucet contributor")).toBe("1");
    expect(monogram("⭐StepByStep⭐")).toBe("S");
    expect(monogram("ñandu")).toBe("Ñ");
  });

  it("is empty without a name to take it from", () => {
    expect(monogram(null)).toBe("");
    expect(monogram(undefined)).toBe("");
    expect(monogram("🚀 ✨")).toBe("");
  });
});

describe("upcomingIcons", () => {
  it("lists each leader's logo once, soonest first, and skips leaders without one", () => {
    const schedule: Record<number, string | null> = { 11: "a", 12: "a", 13: null, 14: "b", 15: "a", 16: "c" };
    expect(upcomingIcons(10, 5, (slot) => schedule[slot] ?? null)).toEqual(["a", "b"]);
  });
});

describe("preloadLogo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches each logo once and keeps a bounded number", () => {
    const made: string[] = [];
    vi.stubGlobal(
      "Image",
      class {
        referrerPolicy = "";
        decoding = "";
        set src(url: string) {
          made.push(url);
        }
      },
    );
    preloadLogo("https://example.com/a.png");
    preloadLogo("https://example.com/a.png");
    expect(made).toEqual(["https://example.com/a.png"]);
    for (let index = 0; index < 300; index += 1) preloadLogo(`https://example.com/${index}.png`);
    expect(preloadedCount()).toBe(256);
  });
});
