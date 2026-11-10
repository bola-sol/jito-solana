import { describe, expect, it } from "vitest";
import { SlotColumns } from "./slotColumns";
import { HAS_BLOCK, HAS_CLOCK, HAS_SHREDS, type WireRow } from "./slotHistory";

const row = (slot: number): WireRow => [
  4,
  HAS_BLOCK | HAS_CLOCK | HAS_SHREDS,
  1200,
  900,
  45_000_000,
  15_000_000_123,
  9_000_000_000,
  3_000_000,
  1_758_800_000_000 + slot * 400,
  210_000,
  1100,
  3,
  380,
  60,
  12,
  7,
  41,
];

describe("SlotColumns", () => {
  it("gives back each row as it came, fees past 2^32 included", () => {
    const columns = new SlotColumns();
    const rows = [row(100), null, row(102)];
    columns.add(100, rows);
    expect(columns.row(100)).toEqual(row(100));
    expect(columns.row(101)).toBeNull();
    expect(columns.row(102)).toEqual(row(102));
    expect(columns.row(99)).toBeNull();
    expect(columns.has(102)).toBe(true);
  });

  it("measures a block's duration from the one before it across a span's edge", () => {
    const columns = new SlotColumns();
    columns.add(200, [row(200), row(201)]);
    columns.add(196, [row(196), row(197), row(198), row(199)]);
    expect(columns.entry(200, undefined, undefined)?.duration_nanos).toBe(400_000_000);
  });

  it("hands back the same entry while it is kept", () => {
    const columns = new SlotColumns();
    columns.add(10, [row(10), row(11)]);
    expect(columns.entry(11, undefined, undefined)).toBe(columns.entry(11, undefined, undefined));
    columns.forget();
    expect(columns.entry(11, undefined, undefined)).not.toBeUndefined();
  });
});
