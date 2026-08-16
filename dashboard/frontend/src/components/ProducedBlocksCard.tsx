import { useState } from "react";
import { blockTime, count, percent, sol } from "../format";
import type { ProducedBlock } from "../types";
import { useStore } from "../useStore";
import { Copyable } from "./Copyable";
import { Card, Meter } from "./primitives";

/**
 * Detail for the blocks this validator produced.
 *
 * Everything here is read while the block's bank is still in bank forks, since
 * the cost tracker and the collected fees go with the bank when it is dropped
 * after rooting. The panel is therefore a record of what was captured, not
 * something that can be recomputed for an arbitrary past slot.
 */
export function ProducedBlocksCard() {
  const store = useStore();
  const blocks = store.get<ProducedBlock[]>("summary", "produced_blocks");
  const [open, setOpen] = useState<number | null>(null);

  if (!blocks || blocks.length === 0) return null;

  // Newest first: a validator wants its last block, not its oldest.
  const newest = [...blocks].reverse();

  return (
    <Card title="Produced Blocks" className="produced-body">
      <div className="produced">
        {newest.map((block) => (
          <BlockRow
            key={block.slot}
            block={block}
            open={open === block.slot}
            onToggle={() => setOpen(open === block.slot ? null : block.slot)}
          />
        ))}
      </div>
      <div className="card-footnote">
        Captured as each block froze. {count(blocks.length)} kept.
      </div>
    </Card>
  );
}

function BlockRow({
  block,
  open,
  onToggle,
}: {
  block: ProducedBlock;
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

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="produced-figure">
      <div className="produced-figure-label">{label}</div>
      <div className="produced-figure-value">{value}</div>
    </div>
  );
}
