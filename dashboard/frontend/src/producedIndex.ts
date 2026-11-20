import { HEAD_KEYS, type BlockHead } from "./produced";
import type { FigureRow, FiguresPage, LeaderTurn, ProducedBlock, TurnHeadRow } from "./types";

const TURN_KEYS = [
  "first",
  "last",
  "produced",
  "drained_millis",
  "since_millis",
  "bundles",
] as const satisfies readonly (keyof LeaderTurn)[];

/** A turn as the list's divider shows it; the rest of the turn is fetched when it opens. */
export type TurnHead = Pick<LeaderTurn, (typeof TURN_KEYS)[number]>;

export function headOf(row: FigureRow): BlockHead {
  const [slot, slotTime, transactions, blockCost, costLimit, totalFees, priorityFees, tips, duration] = row;
  return {
    slot,
    slot_time_millis: slotTime,
    transactions,
    block_cost: blockCost,
    block_cost_limit: costLimit,
    total_fees: totalFees,
    priority_fees: priorityFees,
    tips,
    duration_nanos: duration,
  };
}

export function turnHeadOf(row: TurnHeadRow): TurnHead {
  const [first, last, produced, drained, since, bundles] = row;
  return { first, last, produced, drained_millis: drained, since_millis: since, bundles: bundles ?? null };
}

/** Only `keys` of `from`. */
function pick<T, K extends keyof T>(from: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, from[key]])) as Pick<T, K>;
}

export function headOfBlock(block: ProducedBlock): BlockHead {
  return pick(block, HEAD_KEYS);
}

export function headOfTurn(turn: LeaderTurn): TurnHead {
  return { ...pick(turn, TURN_KEYS), bundles: turn.bundles ?? null };
}

function same<T>(a: T, b: T, keys: readonly (keyof T)[]): boolean {
  return keys.every((key) => a[key] === b[key]);
}

/**
 * Every block the validator holds for the slot page: the pages read back once, and the live blocks
 * merged in as they come. `revision` moves whenever what it holds does.
 */
export class ProducedIndex {
  readonly heads = new Map<number, BlockHead>();
  readonly turns = new Map<number, TurnHead>();
  floor = 0;
  /** The validator's count as of the newest page; `null` before one has come. */
  held: number | null = null;
  complete = false;
  failed = false;
  reading = false;
  revision = 0;
  /** The newest block held when live blocks came all newer than it, until a refresh reaches it. */
  gapFrom: number | null = null;
  private generation = 0;
  private top: number | null = null;

  /** Reads every page, newest first. Ignored while a read is running or after one finished. */
  async readAll(
    request: (before: number | undefined) => Promise<FiguresPage | null>,
    onChange: () => void,
  ): Promise<void> {
    if (this.reading || this.complete) return;
    this.reading = true;
    this.failed = false;
    const generation = this.generation;
    let before: number | undefined;
    try {
      for (;;) {
        const page = await request(before);
        if (generation !== this.generation) return;
        if (page === null) {
          this.failed = true;
          break;
        }
        this.addPage(page);
        onChange();
        if (page.next === null) {
          this.complete = true;
          break;
        }
        before = page.next;
      }
    } catch {
      if (generation === this.generation) this.failed = true;
    }
    if (generation !== this.generation) return;
    this.reading = false;
    this.revision += 1;
    onChange();
  }

  /** Reads pages newest first without clearing, stopping at the page that reaches `stopAt`, or the
   *  oldest; for blocks the validator gained while the live list could not carry them all. */
  async refresh(
    request: (before: number | undefined) => Promise<FiguresPage | null>,
    onChange: () => void,
    stopAt?: number,
  ): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const generation = this.generation;
    let before: number | undefined;
    let reached = Number.POSITIVE_INFINITY;
    try {
      for (;;) {
        const page = await request(before);
        if (generation !== this.generation) return;
        if (page === null) break;
        this.addPage(page);
        onChange();
        const oldest = page.figures[page.figures.length - 1]?.[0];
        if (page.next === null) reached = Number.NEGATIVE_INFINITY;
        else if (oldest !== undefined) reached = oldest;
        if (page.next === null || (stopAt !== undefined && oldest !== undefined && oldest <= stopAt)) break;
        before = page.next;
      }
    } catch {
      // A failed refresh leaves what was held.
    }
    if (generation !== this.generation) return;
    if (this.gapFrom !== null && reached <= this.gapFrom) this.gapFrom = null;
    this.reading = false;
    this.revision += 1;
    onChange();
  }

  /** The newest slot held, or null. */
  newest(): number | null {
    return this.top;
  }

  private hold(head: BlockHead): void {
    this.heads.set(head.slot, head);
    if (this.top === null || head.slot > this.top) this.top = head.slot;
  }

  addPage(page: FiguresPage): void {
    this.setFloor(page.floor);
    for (const row of page.figures) {
      if (row[0] >= this.floor) this.hold(headOf(row));
    }
    for (const row of page.turns) {
      if (row[0] >= this.floor) this.turns.set(row[0], turnHeadOf(row));
    }
    this.held = page.held;
    this.revision += 1;
  }

  /** Idempotent: what is already held as sent is left alone. Notes a gap when, after a whole read,
   *  every block sent is newer than the newest held. */
  mergeLive(blocks: readonly ProducedBlock[], turns: readonly LeaderTurn[]): void {
    let changed = false;
    const oldestSent = blocks.reduce((low, block) => Math.min(low, block.slot), Number.POSITIVE_INFINITY);
    if (this.complete && this.top !== null && oldestSent !== Number.POSITIVE_INFINITY && oldestSent > this.top) {
      this.gapFrom = Math.min(this.gapFrom ?? this.top, this.top);
    }
    for (const block of blocks) {
      if (block.slot < this.floor) continue;
      const head = headOfBlock(block);
      const held = this.heads.get(block.slot);
      if (held && same(held, head, HEAD_KEYS)) continue;
      this.hold(head);
      changed = true;
    }
    for (const turn of turns) {
      if (turn.first < this.floor) continue;
      const head = headOfTurn(turn);
      const held = this.turns.get(turn.first);
      if (held && same(held, head, TURN_KEYS)) continue;
      this.turns.set(turn.first, head);
      changed = true;
    }
    if (changed) this.revision += 1;
  }

  /** Drops what the validator no longer holds. A floor never moves back. */
  setFloor(floor: number): void {
    if (floor <= this.floor) return;
    this.floor = floor;
    for (const slot of this.heads.keys()) if (slot < floor) this.heads.delete(slot);
    if (this.heads.size === 0) this.top = null;
    for (const first of this.turns.keys()) if (first < floor) this.turns.delete(first);
    this.revision += 1;
  }

  /** Forgets everything, and any read in flight, for a fresh read on a new connection. */
  reset(): void {
    this.heads.clear();
    this.turns.clear();
    this.floor = 0;
    this.held = null;
    this.complete = false;
    this.failed = false;
    this.reading = false;
    this.gapFrom = null;
    this.top = null;
    this.generation += 1;
    this.revision += 1;
  }
}
