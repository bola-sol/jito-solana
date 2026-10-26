import type { BlockHead } from "./produced";
import type { FigureRow, FiguresPage, LeaderTurn, ProducedBlock, TurnHeadRow } from "./types";

/** A turn as the list's divider shows it; the rest of the turn is fetched when it opens. */
export type TurnHead = Pick<LeaderTurn, "first" | "last" | "produced" | "drained_millis" | "since_millis">;

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
  const [first, last, produced, drained, since] = row;
  return { first, last, produced, drained_millis: drained, since_millis: since };
}

function headOfBlock(block: ProducedBlock): BlockHead {
  return {
    slot: block.slot,
    slot_time_millis: block.slot_time_millis,
    transactions: block.transactions,
    block_cost: block.block_cost,
    block_cost_limit: block.block_cost_limit,
    total_fees: block.total_fees,
    priority_fees: block.priority_fees,
    tips: block.tips,
    duration_nanos: block.duration_nanos,
  };
}

function sameHead(a: BlockHead, b: BlockHead): boolean {
  return (
    a.slot_time_millis === b.slot_time_millis &&
    a.transactions === b.transactions &&
    a.block_cost === b.block_cost &&
    a.block_cost_limit === b.block_cost_limit &&
    a.total_fees === b.total_fees &&
    a.priority_fees === b.priority_fees &&
    a.tips === b.tips &&
    a.duration_nanos === b.duration_nanos
  );
}

function sameTurn(a: TurnHead, b: TurnHead): boolean {
  return (
    a.last === b.last &&
    a.produced === b.produced &&
    a.drained_millis === b.drained_millis &&
    a.since_millis === b.since_millis
  );
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
  private generation = 0;

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

  addPage(page: FiguresPage): void {
    this.setFloor(page.floor);
    for (const row of page.figures) {
      if (row[0] >= this.floor) this.heads.set(row[0], headOf(row));
    }
    for (const row of page.turns) {
      if (row[0] >= this.floor) this.turns.set(row[0], turnHeadOf(row));
    }
    this.held = page.held;
    this.revision += 1;
  }

  /** Idempotent: what is already held as sent is left alone. */
  mergeLive(blocks: readonly ProducedBlock[], turns: readonly LeaderTurn[]): void {
    let changed = false;
    for (const block of blocks) {
      if (block.slot < this.floor) continue;
      const head = headOfBlock(block);
      const held = this.heads.get(block.slot);
      if (held && sameHead(held, head)) continue;
      this.heads.set(block.slot, head);
      changed = true;
    }
    for (const turn of turns) {
      if (turn.first < this.floor) continue;
      const head: TurnHead = {
        first: turn.first,
        last: turn.last,
        produced: turn.produced,
        drained_millis: turn.drained_millis,
        since_millis: turn.since_millis,
      };
      const held = this.turns.get(turn.first);
      if (held && sameTurn(held, head)) continue;
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
    this.generation += 1;
    this.revision += 1;
  }
}
