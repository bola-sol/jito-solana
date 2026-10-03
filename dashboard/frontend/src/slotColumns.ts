import { entryFromRow, HAS_CLOCK, type WireRow } from "./slotHistory";
import type { EpochInfo, SlotEntry } from "./types";

/** Unsigned columns per slot: votes, non-votes, compute, replay, shreds, repaired, full, replayed. */
const SMALL = 8;
/** Columns that can pass 2^32: fees, priority fees, tips, time. */
const LARGE = 4;

/** Entries decoded and kept, a few screens of turns with the rows their certificates read. */
const DECODED_KEPT = 4096;

/** How far back a slot's duration looks for an earlier clock. */
const CLOCK_REACH = 64;

/** One fetched span as columns: some seventy bytes a slot, where an entry object is six hundred. */
class Span {
  readonly first: number;
  readonly count: number;
  private readonly present: Uint8Array;
  private readonly level: Uint8Array;
  private readonly flags: Uint16Array;
  private readonly leftOut: Uint16Array;
  private readonly small: Uint32Array;
  private readonly large: Float64Array;

  constructor(first: number, rows: readonly (WireRow | null)[]) {
    this.first = first;
    this.count = rows.length;
    this.present = new Uint8Array(rows.length);
    this.level = new Uint8Array(rows.length);
    this.flags = new Uint16Array(rows.length);
    this.leftOut = new Uint16Array(rows.length);
    this.small = new Uint32Array(rows.length * SMALL);
    this.large = new Float64Array(rows.length * LARGE);
    rows.forEach((row, index) => {
      if (row === null) return;
      // Wire order: level, flags, votes, non-votes, compute, fees, priority, tips, time, replay,
      // shreds, repaired, full, replayed, left out.
      this.present[index] = 1;
      this.level[index] = row[0];
      this.flags[index] = row[1];
      this.small.set([row[2], row[3], row[4], row[9], row[10], row[11], row[12], row[13]], index * SMALL);
      this.large.set([row[5], row[6], row[7], row[8]], index * LARGE);
      this.leftOut[index] = row[14];
    });
  }

  has(slot: number): boolean {
    return this.present[slot - this.first] === 1;
  }

  row(slot: number): WireRow | null {
    const index = slot - this.first;
    if (this.present[index] !== 1) return null;
    const small = this.small.subarray(index * SMALL, (index + 1) * SMALL);
    const large = this.large.subarray(index * LARGE, (index + 1) * LARGE);
    return [
      this.level[index] ?? 0,
      this.flags[index] ?? 0,
      small[0] ?? 0,
      small[1] ?? 0,
      small[2] ?? 0,
      large[0] ?? 0,
      large[1] ?? 0,
      large[2] ?? 0,
      large[3] ?? 0,
      small[3] ?? 0,
      small[4] ?? 0,
      small[5] ?? 0,
      small[6] ?? 0,
      small[7] ?? 0,
      this.leftOut[index] ?? 0,
    ];
  }
}

/** Decodes a row as `entriesOf` would, its duration from the nearest earlier slot with a clock, and
 *  keeps the most recent entries so a drawn turn's rows keep their objects. */
class Decoder {
  private decoded = new Map<number, SlotEntry>();

  forget(): void {
    this.decoded.clear();
  }

  entry(
    slot: number,
    rowOf: (slot: number) => WireRow | null,
    epoch: EpochInfo | undefined,
    identity: string | undefined,
  ): SlotEntry | undefined {
    const kept = this.decoded.get(slot);
    if (kept) return kept;
    const row = rowOf(slot);
    if (row === null) return undefined;
    let previousTime: number | null = null;
    for (let earlier = slot - 1; earlier >= slot - CLOCK_REACH && previousTime === null; earlier--) {
      const before = rowOf(earlier);
      if (before && (before[1] & HAS_CLOCK) !== 0) previousTime = before[8];
    }
    const entry = entryFromRow(slot, row, previousTime, epoch, identity);
    this.decoded.set(slot, entry);
    if (this.decoded.size > DECODED_KEPT) {
      const oldest = this.decoded.keys().next().value;
      if (oldest !== undefined) this.decoded.delete(oldest);
    }
    return entry;
  }
}

/** Scattered rows by slot, as a search's pages bring them, overlapping turns sharing theirs. */
export class SlotRows {
  private rows = new Map<number, WireRow>();
  private decoder = new Decoder();

  add(first: number, rows: readonly (WireRow | null)[]): void {
    rows.forEach((row, index) => {
      if (row !== null) this.rows.set(first + index, row);
    });
  }

  has(slot: number): boolean {
    return this.rows.has(slot);
  }

  entry(slot: number, epoch: EpochInfo | undefined, identity: string | undefined): SlotEntry | undefined {
    return this.decoder.entry(slot, (at) => this.rows.get(at) ?? null, epoch, identity);
  }
}

/** Fetched history as columns, decoded into entries only when a turn is drawn. */
export class SlotColumns {
  /** Ascending by first slot, none overlapping. */
  private spans: Span[] = [];
  private decoder = new Decoder();

  add(first: number, rows: readonly (WireRow | null)[]): void {
    const span = new Span(first, rows);
    const at = this.spans.findIndex((held) => held.first > first);
    if (at === -1) this.spans.push(span);
    else this.spans.splice(at, 0, span);
  }

  /** Forgets decoded entries, as when the epoch or identity they were read against changes. */
  forget(): void {
    this.decoder.forget();
  }

  has(slot: number): boolean {
    return this.spanOf(slot)?.has(slot) ?? false;
  }

  row(slot: number): WireRow | null {
    return this.spanOf(slot)?.row(slot) ?? null;
  }

  /** As `entriesOf` reads it, the duration measured from the nearest earlier slot with a clock. */
  entry(slot: number, epoch: EpochInfo | undefined, identity: string | undefined): SlotEntry | undefined {
    return this.decoder.entry(slot, (at) => this.row(at), epoch, identity);
  }

  private spanOf(slot: number): Span | undefined {
    let low = 0;
    let high = this.spans.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const span = this.spans[middle];
      if (!span) return undefined;
      if (slot < span.first) high = middle - 1;
      else if (slot >= span.first + span.count) low = middle + 1;
      else return span;
    }
    return undefined;
  }
}
