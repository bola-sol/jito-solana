import { describe, expect, it } from "vitest";
import { blockSummary, sortBlocks } from "./produced";
import type { ProducedBlock } from "./types";

/** A produced block, to be overridden a field at a time. */
function block(over: Partial<ProducedBlock> = {}): ProducedBlock {
  return {
    slot: 1,
    slot_time_millis: null,
    blockhash: "hash",
    duration_nanos: null,
    transactions: 0,
    non_vote_transactions: 0,
    failed_transactions: 0,
    entries: 0,
    block_cost: 0,
    block_cost_limit: 0,
    account_cost_limit: 0,
    total_fees: 0,
    priority_fees: 0,
    tips: null,
    bundles: null,
    versions: null,
    execution: null,
    ...over,
  };
}

describe("blockSummary", () => {
  it("averages each column over the blocks held", () => {
    const { blocks, mean } = blockSummary([
      block({ transactions: 1000, total_fees: 100, block_cost: 40, block_cost_limit: 100 }),
      block({ transactions: 2000, total_fees: 200, block_cost: 60, block_cost_limit: 100 }),
    ]);
    expect(blocks).toBe(2);
    expect(mean.transactions).toBe(1500);
    expect(mean.fees).toBe(150);
    expect(mean.filled).toBeCloseTo(0.5, 10);
  });

  it("takes the median between the middle pair, unmoved by one outlier", () => {
    const { mean, median } = blockSummary([
      block({ transactions: 1000 }),
      block({ transactions: 1100 }),
      block({ transactions: 1200 }),
      block({ transactions: 9000 }),
    ]);
    expect(median.transactions).toBe(1150);
    expect(mean.transactions).toBe(3075);
  });

  it("reads the poor tail from the low end, except duration from the high end", () => {
    // Twenty one blocks, so the fifth and ninety fifth percentiles land on the
    // second lowest and second highest without interpolation.
    const blocks = Array.from({ length: 21 }, (_, i) =>
      block({
        transactions: 1000 + i * 100,
        total_fees: 10 + i,
        block_cost: 5 + i * 4,
        block_cost_limit: 100,
        duration_nanos: (300 + i * 10) * 1e6,
      }),
    );
    const { worst } = blockSummary(blocks);
    expect(worst.transactions).toBe(1100);
    expect(worst.fees).toBe(11);
    expect(worst.filled).toBeCloseTo(0.09, 10);
    expect(worst.durationMillis).toBe(490);
  });

  it("averages the blocks' own percentages, not the totals", () => {
    // A block with a larger limit should not count for more in a column of
    // percentages: the figure at the head of the column has to be the mean of
    // what is under it. Totalled instead this would read 20/110, not 55%.
    const { mean } = blockSummary([
      block({ block_cost: 10, block_cost_limit: 100 }),
      block({ block_cost: 10, block_cost_limit: 10 }),
    ]);
    expect(mean.filled).toBeCloseTo(0.55, 10);
  });

  it("leaves out a block with no figure rather than counting it as nought", () => {
    // One slot never timed, and one with no cost limit read. Counted as noughts
    // they would drag both averages down and describe blocks that never were.
    const summary = blockSummary([
      block({ duration_nanos: 400e6, block_cost: 50, block_cost_limit: 100 }),
      block({ duration_nanos: null, block_cost: 0, block_cost_limit: 0 }),
    ]);
    expect(summary.mean.durationMillis).toBe(400);
    expect(summary.worst.durationMillis).toBe(400);
    expect(summary.mean.filled).toBeCloseTo(0.5, 10);
    expect(summary.blocks).toBe(2);
  });

  it("says nothing rather than nought when there is nothing to average", () => {
    for (const empty of [blockSummary([]), blockSummary(undefined)]) {
      expect(empty.blocks).toBe(0);
      for (const figures of [empty.mean, empty.median, empty.worst]) {
        expect(figures.transactions).toBeNull();
        expect(figures.filled).toBeNull();
        expect(figures.fees).toBeNull();
        expect(figures.durationMillis).toBeNull();
      }
    }
  });
});

describe("sortBlocks", () => {
  const held = [
    block({ slot: 1, transactions: 990, duration_nanos: 302e6 }),
    block({ slot: 2, transactions: 1_214, duration_nanos: null }),
    block({ slot: 3, transactions: 1_063, duration_nanos: 337e6 }),
  ];
  const slots = (blocks: ProducedBlock[]) => blocks.map((b) => b.slot);

  it("orders by the column, highest first by default", () => {
    expect(slots(sortBlocks(held, "transactions", "desc"))).toEqual([2, 3, 1]);
    expect(slots(sortBlocks(held, "transactions", "asc"))).toEqual([1, 3, 2]);
  });

  it("puts a block with no figure last, whichever way round", () => {
    expect(slots(sortBlocks(held, "duration", "desc"))).toEqual([3, 1, 2]);
    expect(slots(sortBlocks(held, "duration", "asc"))).toEqual([1, 3, 2]);
  });

  it("leaves the list it was given alone", () => {
    sortBlocks(held, "fees", "asc");
    expect(slots(held)).toEqual([1, 2, 3]);
  });
});
