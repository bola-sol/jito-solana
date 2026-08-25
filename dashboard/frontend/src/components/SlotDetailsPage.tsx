import { useMemo, useState } from "react";
import { blockStamp, blockTime, bytes, count, percent, sol, units } from "../format";
import { recurrence } from "../cost";
import { blockAverages } from "../produced";
import type { ProducedBlock, SlotCost, SlotWaterfall } from "../types";
import { useStore } from "../useStore";
import { waterfallRows } from "../waterfall";
import { Copyable } from "./Copyable";
import { Explain, Meter } from "./primitives";
import { WaterfallRows } from "./WaterfallRows";

/**
 * Every block this validator produced, and what went into each one.
 *
 * All of it is read while the block's bank is still in bank forks, since the
 * cost tracker and the collected fees go with the bank when it is dropped after
 * rooting. This is a record of what was captured as each block froze, not
 * something that can be recomputed for an arbitrary past slot, which is why the
 * list ends where the dashboard started rather than where the ledger does.
 *
 * A page rather than a card because a row opens into several hundred pixels of
 * detail. Squeezed into the overview it scrolled that through a six-row window,
 * and the waterfall inside it was most of what had to be scrolled past.
 */
export function SlotDetailsPage() {
  const store = useStore();
  const blocks = store.get<ProducedBlock[]>("summary", "produced_blocks");
  const waterfalls = store.get<SlotWaterfall[]>("summary", "slot_waterfalls");
  const costs = store.get<SlotCost[]>("summary", "slot_costs");
  const [open, setOpen] = useState<number | null>(null);

  // Joined by slot rather than nested on the block, because the two are built
  // on different threads and either can arrive first. A block whose waterfall
  // has not landed yet simply has none, and gains it on the next tick.
  const bySlot = useMemo(
    () => new Map((waterfalls ?? []).map((slot) => [slot.slot, slot])),
    [waterfalls],
  );
  const costBySlot = useMemo(
    () => new Map((costs ?? []).map((cost) => [cost.slot, cost])),
    [costs],
  );

  if (!blocks || blocks.length === 0) {
    return (
      <section className="slot-details">
        <div className="sidebar-empty">
          nothing produced yet. Blocks appear here as this validator leads.
        </div>
      </section>
    );
  }

  // Newest first: a validator wants its last block, not its oldest.
  const newest = [...blocks].reverse();

  return (
    <section className="slot-details">
      <div className="produced">
        <AveragesRow blocks={blocks} />
        {newest.map((block) => (
          <BlockRow
            key={block.slot}
            block={block}
            waterfall={bySlot.get(block.slot)}
            cost={costBySlot.get(block.slot)}
            costs={costs ?? []}
            open={open === block.slot}
            onToggle={() => setOpen(open === block.slot ? null : block.slot)}
          />
        ))}
      </div>
      <div className="card-footnote">
        Captured as each block froze. {count(blocks.length)} kept, oldest first
        to fall off.
      </div>
    </section>
  );
}

/**
 * The mean of each column, at the head of the column it averages.
 *
 * The rows below are a record rather than a series — a validator leads in
 * bursts of four and then not for an hour — so scanning them for whether a
 * block was ordinary means holding the last dozen in your head. This is that
 * comparison, on the same grid so the figures sit directly above the ones they
 * are the average of.
 *
 * Over the blocks held, which is what the page shows and what the footnote
 * counts. It is not an average over the epoch and does not claim to be.
 */
function AveragesRow({ blocks }: { blocks: ProducedBlock[] }) {
  const avg = blockAverages(blocks);
  return (
    <div className="produced-averages">
      <span className="produced-id">
        <Explain
          className="produced-avg-label"
          text={`The mean of each column over the ${count(avg.blocks)} blocks held on this page. Blocks missing a figure are left out of its average rather than counted as nought, so a column can be averaged over fewer blocks than the one beside it.`}
        >
          avg
        </Explain>
      </span>
      <span className="produced-txns">
        {avg.transactions === null ? "—" : `${count(Math.round(avg.transactions))} txns`}
      </span>
      <span className="produced-fill">
        {avg.filled === null ? "—" : `${percent(avg.filled, 1)} full`}
      </span>
      <span className="produced-fees">
        {avg.fees === null ? (
          "—"
        ) : (
          <>
            {sol(avg.fees, 5)}
            <span className="produced-fees-unit"> SOL</span>
          </>
        )}
      </span>
      <span className="produced-ms">
        {avg.durationMillis === null ? "—" : `${Math.round(avg.durationMillis)} ms`}
      </span>
    </div>
  );
}

function BlockRow({
  block,
  waterfall,
  cost,
  costs,
  open,
  onToggle,
}: {
  block: ProducedBlock;
  waterfall: SlotWaterfall | undefined;
  cost: SlotCost | undefined;
  /** Every produced block's cost, for reading this one against the rest. */
  costs: SlotCost[];
  open: boolean;
  onToggle: () => void;
}) {
  const filled = block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : 0;

  return (
    <div className={`produced-block${open ? " is-open" : ""}`}>
      <button type="button" className="produced-head" onClick={onToggle} aria-expanded={open}>
        {/* One cell, because both name the block where everything to the right
            says what was in it. Kept together rather than given a column each,
            which also leaves the grid at five columns however narrow the screen
            gets: hiding the stamp is then a `display: none` and not a count
            the media rules have to be kept in step with. */}
        <span className="produced-id">
          <span className="produced-slot">{count(block.slot)}</span>
          <span className="produced-when">{blockStamp(block.slot_time_millis)}</span>
        </span>
        <span className="produced-txns">{count(block.transactions)} txns</span>
        <span className="produced-fill">{percent(filled, 1)} full</span>
        {/* Base and priority together, which is what the block earned. The
            detail below splits them; the row wants one figure. */}
        <span className="produced-fees">
          {sol(block.total_fees, 5)}
          {/* Dropped on the narrowest screens, where the column it costs is
              the slot number's. SOL is the only unit fees are ever in here,
              and the expanded detail below states it either way. */}
          <span className="produced-fees-unit"> SOL</span>
        </span>
        <span className="produced-ms">
          {block.duration_nanos === null
            ? "—"
            : `${Math.round(block.duration_nanos / 1e6)} ms`}
        </span>
      </button>

      {open && (
        <div className="produced-detail">
          <Meter fraction={filled} />
          <div className="produced-grid">
            <Figure label="Compute units" value={count(block.block_cost)} />
            <Figure label="Of limit" value={count(block.block_cost_limit)} />
            <Figure label="Non-vote" value={count(block.non_vote_transactions)} />
            <Figure
              label="Votes"
              value={count(Math.max(0, block.transactions - block.non_vote_transactions))}
            />
            <Figure label="Failed" value={count(block.failed_transactions)} />
            <Figure label="Entries" value={count(block.entries)} />
            {/* Base is the remainder: the bank reports the two together and the
                priority half separately, never the base fee on its own. */}
            <Figure label="Base fees" value={`${sol(block.total_fees - block.priority_fees, 6)} SOL`} />
            <Figure label="Priority fees" value={`${sol(block.priority_fees, 6)} SOL`} />
          </div>
          {waterfall && <SlotWaterfallDetail waterfall={waterfall} />}
          {cost && <BlockCostDetail block={block} cost={cost} costs={costs} />}

          {/* The block's identity, together: which slot, when, and its hash.
              The slot stays in the row above as well, since that is the only
              thing naming a row while it is shut. */}
          <div className="produced-foot">
            <Copyable
              text={String(block.slot)}
              label={count(block.slot)}
              className="produced-foot-slot"
            />
            <span className="produced-time">{blockTime(block.slot_time_millis)}</span>
            {/* The blockhash, which is the hash of the block's last entry and
                not a transaction signature. Copyable because reading forty-four
                base58 characters off a screen is nobody's idea of a good time. */}
            <Copyable text={block.blockhash} className="produced-hash" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * What the scheduler did with the transactions it was offered for this slot.
 *
 * The same rows as the live waterfall on the front page, over one slot rather
 * than a rolling window — the scheduler counts each led slot separately and
 * says which slot each set belongs to, so this is that slot's own account
 * rather than a share of a longer period that happens to contain it.
 *
 * Only ever drawn under a block this validator produced, which is the only
 * place the figures exist: the counters are tagged with the bank being
 * produced, and there is no bank unless we are producing it.
 *
 * Named for whichever scheduler built the block. A stock validator has one and
 * the name never changes; a jito validator hands the slot to BAM whenever BAM
 * is connected, and which of the two built a given block is not otherwise
 * visible anywhere on the page.
 */
function SlotWaterfallDetail({ waterfall }: { waterfall: SlotWaterfall }) {
  const bam = waterfall.source === "bam";
  return (
    <div className="produced-waterfall">
      <div className="produced-waterfall-head">
        <Explain text="Every transaction the banking stage was handed during this slot, and what became of it. The indented rows are the ones that got no further, and why. Received is exactly buffered plus those first reasons; the later stages do not add up the same way, because the queue holds transactions across slots and some of what was scheduled here arrived before this slot began.">
          <span className="produced-waterfall-title">Scheduler</span>
        </Explain>
        {bam && (
          <Explain text="BAM built this block. It is sent atomic transaction batches rather than packets off the wire, so the figures below start from what parsed out of those batches.">
            <span className="produced-waterfall-source">BAM</span>
          </Explain>
        )}
      </div>
      <WaterfallRows rows={waterfallRows(waterfall)} />
    </div>
  );
}

/**
 * What limited this block, if anything did.
 *
 * A block can be half empty and still unable to take another transaction: every
 * account has its own compute ceiling within a block, and one busy account
 * reaches it long before the block limit is anywhere near. That is the
 * difference between a validator short of work and one throttled by a single
 * account, and nothing else on this page distinguishes them.
 *
 * The block's own total is deliberately not repeated here. The row above the
 * fold already carries compute units against the block limit, which is where
 * someone glancing at a list of blocks will read it.
 */
function BlockCostDetail({
  block,
  cost,
  costs,
}: {
  block: ProducedBlock;
  cost: SlotCost;
  costs: SlotCost[];
}) {
  const ofLimit =
    block.account_cost_limit > 0 ? cost.costliest_cost / block.account_cost_limit : 0;
  const ofBlock = cost.block_cost > 0 ? cost.costliest_cost / cost.block_cost : 0;
  const seen = recurrence(costs, cost.costliest_account);

  return (
    <div className="produced-waterfall">
      <div className="produced-waterfall-head">
        <Explain text="What the cost tracker made of this block. Every account has its own compute ceiling within a block, well below the block's own, so one busy account can stop a half-empty block taking any more transactions that touch it.">
          <span className="produced-waterfall-title">Block cost</span>
        </Explain>
      </div>

      <div className="cost-hot">
        <div className="cost-hot-who">
          <div className="cost-hot-label">Costliest account</div>
          <Copyable text={cost.costliest_account} className="cost-hot-key" />
        </div>
        <div className="cost-hot-value">{units(cost.costliest_cost)} CU</div>
        <div className="cost-meter">
          <span className="cost-track" aria-hidden="true">
            <span className="cost-fill" style={{ width: `${Math.min(100, ofLimit * 100)}%` }} />
          </span>
          <span className="cost-of">
            {percent(ofLimit, 0)} of the {units(block.account_cost_limit)} account limit ·{" "}
            {percent(ofBlock, 0)} of this block
          </span>
        </div>
      </div>

      {/* Only when it has topped more than this one block. On its own it says
          nothing: something has to be the largest. */}
      {seen && seen.blocks > 1 && (
        <div className="cost-again">
          Costliest in{" "}
          <b>
            {seen.blocks} of the last {seen.of} blocks
          </b>
          , peaking at {units(seen.peakCost)} CU in slot{" "}
          <Copyable
            text={String(seen.peakSlot)}
            label={count(seen.peakSlot)}
            className="cost-again-slot"
          />
        </div>
      )}

      <div className="produced-figures">
        <Figure label="Accounts written" value={count(cost.accounts)} />
        <Figure label="Contended" value={count(cost.contended)} />
        <Figure label="New account data" value={bytes(cost.new_account_data)} />
        <Figure label="In flight" value={count(cost.in_flight)} />
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="produced-figure">
      <div className="produced-figure-label">{label}</div>
      <div className="produced-figure-value">{value}</div>
    </div>
  );
}
