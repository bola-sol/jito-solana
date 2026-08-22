import { useMemo, useState } from "react";
import { blockTime, count, percent, sol } from "../format";
import type { ProducedBlock, SlotWaterfall } from "../types";
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
  const [open, setOpen] = useState<number | null>(null);

  // Joined by slot rather than nested on the block, because the two are built
  // on different threads and either can arrive first. A block whose waterfall
  // has not landed yet simply has none, and gains it on the next tick.
  const bySlot = useMemo(
    () => new Map((waterfalls ?? []).map((slot) => [slot.slot, slot])),
    [waterfalls],
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
        {newest.map((block) => (
          <BlockRow
            key={block.slot}
            block={block}
            waterfall={bySlot.get(block.slot)}
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

function BlockRow({
  block,
  waterfall,
  open,
  onToggle,
}: {
  block: ProducedBlock;
  waterfall: SlotWaterfall | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const filled = block.block_cost_limit > 0 ? block.block_cost / block.block_cost_limit : 0;

  return (
    <div className={`produced-block${open ? " is-open" : ""}`}>
      <button type="button" className="produced-head" onClick={onToggle} aria-expanded={open}>
        <span className="produced-slot">{count(block.slot)}</span>
        <span className="produced-txns">{count(block.transactions)} txns</span>
        <span className="produced-fill">{percent(filled, 1)} full</span>
        {/* Base and priority together, which is what the block earned. The
            detail below splits them; the row wants one figure. */}
        <span className="produced-fees">{sol(block.total_fees, 5)} SOL</span>
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
 */
function SlotWaterfallDetail({ waterfall }: { waterfall: SlotWaterfall }) {
  return (
    <div className="produced-waterfall">
      <Explain text="Every transaction the banking stage was handed during this slot, and what became of it. The indented rows are the ones that got no further, and why. Received is exactly buffered plus those first reasons; the later stages do not add up the same way, because the queue holds transactions across slots and some of what was scheduled here arrived before this slot began.">
        <span className="produced-waterfall-title">Scheduler</span>
      </Explain>
      <WaterfallRows rows={waterfallRows(waterfall)} />
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
