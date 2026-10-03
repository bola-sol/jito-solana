import { describe, expect, it } from "vitest";
import { blockSummary, certificateVerdict, earnedOf, sortBlocks } from "./produced";
import type { BlockCertificate, ProducedBlock, TipRates } from "./types";

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
    certificate: null,
    ...over,
  };
}

function certificate(over: Partial<BlockCertificate> = {}): BlockCertificate {
  return {
    rewards: 1,
    leader: null,
    leader_name: null,
    notarized: true,
    paid: 103,
    ranks: 112,
    stake_paid: 0.986,
    notar: 101,
    skip: 2,
    ours_in: true,
    usual: 103,
    left_out: [],
    ...over,
  };
}

describe("certificateVerdict", () => {
  it("is in line when nobody certificates usually pay was left out", () => {
    expect(certificateVerdict(certificate())).toEqual({ text: "in line with the cluster", warn: false });
  });

  it("counts the ones left out, in warn", () => {
    const left = [
      { identity: "a", name: null, ip: null },
      { identity: "b", name: "B", ip: "1.2.3.4" },
    ];
    expect(certificateVerdict(certificate({ left_out: left }))).toEqual({
      text: "left out 2 certificates usually pay",
      warn: true,
    });
  });
});

const RATES: TipRates = { jito_cut_bps: 600, commission_bps: 1_000 };

describe("earnedOf", () => {
  it("keeps half the base fees, floored the way the runtime burns them", () => {
    // 101 base: the runtime burns 50 and keeps 51.
    const earned = earnedOf(block({ total_fees: 101, priority_fees: 0 }), undefined);
    expect(earned.base).toBe(51);
    expect(earned.total).toBe(51);
  });

  it("keeps every priority lamport", () => {
    const earned = earnedOf(block({ total_fees: 300, priority_fees: 200 }), undefined);
    expect(earned.base).toBe(50);
    expect(earned.priority).toBe(200);
    expect(earned.total).toBe(250);
  });

  it("adds our share of the tips where they were measured and the commission is known", () => {
    // 1.4 SOL paid, 1.316 after jito, a tenth of that ours.
    const earned = earnedOf(block({ total_fees: 100, tips: 1_400_000_000 }), RATES);
    expect(earned.tips).toBe(131_600_000);
    expect(earned.total).toBe(131_600_050);
  });

  it("counts no tips without rates, without a measurement, or without a commission", () => {
    expect(earnedOf(block({ tips: 1_000 }), undefined).tips).toBeNull();
    expect(earnedOf(block({ tips: null }), RATES).tips).toBeNull();
    expect(earnedOf(block({ tips: 1_000 }), { ...RATES, commission_bps: null }).tips).toBeNull();
    expect(earnedOf(block({ total_fees: 10, tips: 1_000 }), undefined).total).toBe(5);
  });
});

describe("blockSummary", () => {
  it("averages each column over the blocks held", () => {
    const { blocks, mean } = blockSummary([
      block({ transactions: 1000, total_fees: 100, block_cost: 40, block_cost_limit: 100 }),
      block({ transactions: 2000, total_fees: 200, block_cost: 60, block_cost_limit: 100 }),
    ]);
    expect(blocks).toBe(2);
    expect(mean.transactions).toBe(1500);
    expect(mean.earned).toBe(75);
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
    expect(worst.earned).toBe(6);
    expect(worst.filled).toBeCloseTo(0.09, 10);
    expect(worst.durationMillis).toBe(490);
  });

  it("averages the blocks' own percentages, not the totals", () => {
    const { mean } = blockSummary([
      block({ block_cost: 10, block_cost_limit: 100 }),
      block({ block_cost: 10, block_cost_limit: 10 }),
    ]);
    expect(mean.filled).toBeCloseTo(0.55, 10);
  });

  it("leaves out a block with no figure rather than counting it as nought", () => {
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
        expect(figures.earned).toBeNull();
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

  it("orders by earnings with the tips counted", () => {
    const blocks = [
      block({ slot: 1, total_fees: 100, priority_fees: 0, tips: null }),
      block({ slot: 2, total_fees: 40, priority_fees: 0, tips: 1_400_000_000 }),
    ];
    expect(slots(sortBlocks(blocks, "earned", "desc", RATES))).toEqual([2, 1]);
    expect(slots(sortBlocks(blocks, "earned", "desc"))).toEqual([1, 2]);
  });

  it("leaves the list it was given alone", () => {
    sortBlocks(held, "earned", "asc");
    expect(slots(held)).toEqual([1, 2, 3]);
  });
});
