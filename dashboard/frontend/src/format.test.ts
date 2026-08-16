import { describe, expect, it } from "vitest";
import {
  blockTime,
  bytes,
  count,
  decimal,
  duration,
  percent,
  shortKey,
  slotDelta,
  sol,
  solCompact,
} from "./format";

// Anything going through `toLocaleString` is asserted only where the answer
// does not depend on the machine's locale. A test that expects "1,234" passes
// in en-US and fails in de-DE, which would make this suite worse than nothing.

describe("missing values", () => {
  it("all render as an em dash rather than as zero", () => {
    expect(count(undefined)).toBe("—");
    expect(decimal(undefined)).toBe("—");
    expect(decimal(Number.NaN)).toBe("—");
    expect(percent(undefined)).toBe("—");
    expect(percent(null)).toBe("—");
    expect(duration(undefined)).toBe("—");
    expect(bytes(undefined)).toBe("—");
    expect(sol(undefined)).toBe("—");
    expect(solCompact(undefined)).toBe("—");
    expect(shortKey(null)).toBe("—");
  });
});

describe("duration", () => {
  it("drops to the three largest units that apply", () => {
    expect(duration(45_000)).toBe("45s");
    expect(duration(171_000)).toBe("2m 51s");
    expect(duration(3_723_000)).toBe("1h 2m 3s");
    expect(duration(604_740_000)).toBe("6d 23h 59m");
  });

  it("refuses a negative rather than rendering a wrapped figure", () => {
    // Countdowns are derived from a slot estimate that can overshoot.
    expect(duration(-1)).toBe("—");
  });
});

describe("bytes", () => {
  it("shows whole bytes and fractions of anything larger", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(999)).toBe("999 B");
    expect(bytes(1024)).toBe("1.00 KB");
    expect(bytes(1024 * 1024 * 1.5)).toBe("1.50 MB");
  });

  it("stops at the largest unit it knows", () => {
    expect(bytes(1024 ** 6)).toContain("TB");
  });
});

describe("percent", () => {
  it("scales the fraction and keeps the requested digits", () => {
    expect(percent(0)).toBe("0.00%");
    expect(percent(0.0123)).toBe("1.23%");
    expect(percent(1)).toBe("100.00%");
    expect(percent(0.5, 0)).toBe("50%");
  });
});

describe("blockTime", () => {
  it("has nothing to show without a timestamp", () => {
    expect(blockTime(null)).toBe("—");
    expect(blockTime(undefined)).toBe("—");
    expect(blockTime(Number.NaN)).toBe("—");
  });

  it("keeps milliseconds, zero padded", () => {
    // Two blocks can be under two hundred milliseconds apart, so seconds alone
    // would show consecutive slots as the same instant.
    expect(blockTime(Date.UTC(2026, 7, 16, 9, 55, 10, 7))).toMatch(/\.007$/);
    expect(blockTime(Date.UTC(2026, 7, 16, 9, 55, 10, 626))).toMatch(/\.626$/);
  });

  it("distinguishes two blocks in the same second", () => {
    const first = Date.UTC(2026, 7, 16, 9, 55, 10, 120);
    expect(blockTime(first)).not.toBe(blockTime(first + 185));
  });
});

describe("shortKey", () => {
  it("elides the middle of a pubkey", () => {
    const key = "J5e4xhLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsc8FF1";
    expect(shortKey(key)).toBe("J5e4xh…c8FF1");
    expect(shortKey(key, 4, 4)).toBe("J5e4…8FF1");
  });

  it("leaves a key that is already short enough alone", () => {
    // Eliding here would make it longer, not shorter.
    expect(shortKey("abcdefghij")).toBe("abcdefghij");
  });
});

describe("slotDelta", () => {
  it("signs the difference so the direction is readable at a glance", () => {
    expect(slotDelta(100, 132)).toBe("-32");
    expect(slotDelta(133, 132)).toBe("+1");
    expect(slotDelta(132, 132)).toBe("0");
  });

  it("renders nothing when there is no reference to compare against", () => {
    expect(slotDelta(undefined, 132)).toBe("");
    expect(slotDelta(132, undefined)).toBe("");
  });
});

describe("solCompact", () => {
  it("abbreviates above a thousand", () => {
    expect(solCompact(1_500_000_000)).toBe("1.5");
    expect(solCompact(12_340 * 1e9)).toBe("12.3K");
    expect(solCompact(2_500_000 * 1e9)).toBe("2.5M");
  });
});
