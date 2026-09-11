import { Fragment, useMemo, useState, type ReactNode } from "react";
import { blockStamp, blockTime, bytes, count, percent, sol, units } from "../format";
import { recurrence } from "../cost";
import { blockAverages, sortBlocks, type SortDir, type SortKey } from "../produced";
import { epochOf } from "../schedule";
import { jitoShare, ourShare } from "../tips";
import type { EpochInfo, ProducedBlock, SlotCost, SlotWaterfall, TipRates } from "../types";
import { useStore } from "../useStore";
import {
  bundlesValue,
  capacity,
  schedulerView,
  shareOfGroup,
  type Capacity,
  type SchedulerView,
} from "../slotDetail";
import type { WaterfallRow } from "../waterfall";
import { Copyable } from "./Copyable";
import { Explain } from "./primitives";

/** Every block this validator produced, captured as each froze; the list
 *  ends where the dashboard started. */
export function SlotDetailsPage() {
  const store = useStore();
  const blocks = store.get<ProducedBlock[]>("summary", "produced_blocks");
  const waterfalls = store.get<SlotWaterfall[]>("summary", "slot_waterfalls");
  const costs = store.get<SlotCost[]>("summary", "slot_costs");
  // Absent on a validator with no tip payment program, and then no tip figure
  // is drawn at all.
  const rates = store.get<TipRates>("summary", "tip_rates");
  const [open, setOpen] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);

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
  const listed = sort ? sortBlocks(blocks, sort.key, sort.dir) : [...blocks].reverse();
  const toggle = (key: SortKey) =>
    setSort(sort?.key === key ? { key, dir: sort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });

  // Dividers only in the newest-first order, where an epoch boundary is one
  // place, and only when the blocks held span more than one epoch.
  const epoch = store.get<EpochInfo>("epoch", "new");
  const numbered = listed.map((block) => ({ block, epoch: epochOf(epoch, block.slot) }));
  const divided = !sort && new Set(numbered.map((entry) => entry.epoch)).size > 1;

  return (
    <section className="slot-details">
      <div className="produced">
        <AveragesRow blocks={blocks} sort={sort} onSort={toggle} onClear={() => setSort(null)} />
        {numbered.map(({ block, epoch: at }, index) => (
          <Fragment key={block.slot}>
            {divided && at !== null && at !== numbered[index - 1]?.epoch && (
              <div className="produced-epoch">epoch {count(at)}</div>
            )}
            <BlockRow
              block={block}
              epoch={at}
              waterfall={bySlot.get(block.slot)}
              cost={costBySlot.get(block.slot)}
              costs={costs ?? []}
              rates={rates}
              open={open === block.slot}
              onToggle={() => setOpen(open === block.slot ? null : block.slot)}
            />
          </Fragment>
        ))}
      </div>
      <div className="card-footnote">
        {sort
          ? `Sorted by ${SORT_WORD[sort.key]}, ${sort.dir === "desc" ? "highest" : "lowest"} first.`
          : `Captured as each block froze. ${count(blocks.length)} kept, oldest first to fall off.`}
      </div>
    </section>
  );
}

/** An average that sorts its column. Module-level: a component made inside the
    row is a new type each render, so the buttons remounted under every click. */
function SortButton({
  column,
  className,
  sort,
  onSort,
  children,
}: {
  column: SortKey;
  className: string;
  sort: { key: SortKey; dir: SortDir } | null;
  onSort: (key: SortKey) => void;
  children: ReactNode;
}) {
  const on = sort?.key === column;
  return (
    <button
      type="button"
      className={`${className} produced-sort${on ? " is-on" : ""}`}
      title={`Sort by ${SORT_WORD[column]}`}
      onClick={() => onSort(column)}
    >
      <span className="produced-sort-arrow" aria-hidden="true">
        {on ? (sort.dir === "desc" ? "↓" : "↑") : ""}
      </span>
      {children}
    </button>
  );
}

const SORT_WORD: Record<SortKey, string> = {
  transactions: "transactions",
  filled: "fullness",
  fees: "fees",
  duration: "duration",
};

/** The mean of each column over the blocks held, at the head of the column
 *  it averages. */
function AveragesRow({
  blocks,
  sort,
  onSort,
  onClear,
}: {
  blocks: ProducedBlock[];
  sort: { key: SortKey; dir: SortDir } | null;
  onSort: (key: SortKey) => void;
  onClear: () => void;
}) {
  const avg = blockAverages(blocks);
  return (
    <div className="produced-averages">
      <span className="produced-id">
        <Explain
          className="produced-avg-label"
          text={`Mean of each column over the ${count(avg.blocks)} blocks held. A block missing a figure is left out of that column's mean.`}
        >
          avg
        </Explain>
        {sort && (
          <button type="button" className="produced-clear" onClick={onClear} aria-label="Clear sort">
            ×<span className="produced-clear-word"> clear</span>
          </button>
        )}
      </span>
      <SortButton column="transactions" sort={sort} onSort={onSort} className="produced-txns">
        {avg.transactions === null ? "—" : `${count(Math.round(avg.transactions))} txns`}
      </SortButton>
      <SortButton column="filled" sort={sort} onSort={onSort} className="produced-fill">
        {avg.filled === null ? "—" : `${percent(avg.filled, 1)} full`}
      </SortButton>
      <SortButton column="fees" sort={sort} onSort={onSort} className="produced-fees">
        {avg.fees === null ? (
          "—"
        ) : (
          <>
            {sol(avg.fees, 5)}
            <span className="produced-fees-unit"> SOL</span>
          </>
        )}
      </SortButton>
      <SortButton column="duration" sort={sort} onSort={onSort} className="produced-ms">
        {avg.durationMillis === null ? "—" : `${Math.round(avg.durationMillis)} ms`}
      </SortButton>
    </div>
  );
}

/** One produced block: the row that names it, and what it held once opened,
 *  led by its compute. */
function BlockRow({
  block,
  epoch,
  waterfall,
  cost,
  costs,
  rates,
  open,
  onToggle,
}: {
  block: ProducedBlock;
  /** The epoch the slot fell in, or null before the epoch message has arrived. */
  epoch: number | null;
  waterfall: SlotWaterfall | undefined;
  cost: SlotCost | undefined;
  /** Every produced block's cost, for reading this one against the rest. */
  costs: SlotCost[];
  /** Absent where no tip program is configured, and then no tip figure shows. */
  rates: TipRates | undefined;
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
          <BlockCompute block={block} cost={cost} rates={rates} />
          {cost && <BlockAccount block={block} cost={cost} costs={costs} />}
          {waterfall && <BlockScheduler waterfall={waterfall} />}
          {cost && <BlockFigures cost={cost} />}

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
            {epoch !== null && <span className="produced-time">epoch {count(epoch)}</span>}
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

/** A label over a figure, which is most of what this body is made of. */
function Stat({
  label,
  value,
  warn,
  title,
  className,
}: {
  label: string;
  value: string;
  warn?: boolean;
  /** Hover text, where the figure is derived and the derivation is worth a look. */
  title?: string;
  className?: string;
}) {
  return (
    <div className={`sx-stat${className ? ` ${className}` : ""}`} title={title}>
      <span className="sx-eyebrow">{label}</span>
      <span className={`sx-stat-value${warn ? " tone-warn" : ""}`}>{value}</span>
    </div>
  );
}

/** What the block cost, and what the rest of the limit did. */
function BlockCompute({
  block,
  cost,
  rates,
}: {
  block: ProducedBlock;
  cost: SlotCost | undefined;
  rates: TipRates | undefined;
}) {
  const cap = capacity(block, cost);
  const votes = Math.max(0, block.transactions - block.non_vote_transactions);
  const unused = Math.max(0, block.block_cost_limit - block.block_cost);

  return (
    <div className="sx-lead">
      <div className="sx-head">
        <div className="sx-cu">
          <div className="sx-eyebrow">
            <Explain text="Compute this block's transactions cost, against the block ceiling. Each account has a far lower ceiling of its own.">
              Compute units used
            </Explain>
          </div>
          <div className="sx-cu-value">{count(block.block_cost)}</div>
          <div className="sx-cu-of">
            of {count(block.block_cost_limit)} limit · {count(unused)} unused
          </div>
        </div>
        <div className="sx-stats">
          <Stat label="Non-vote" value={count(block.non_vote_transactions)} />
          <Stat label="Votes" value={count(votes)} />
          {/* Toned only when it happened. A failed transaction is still in the
              block and still paid its fee, so this is worth noticing and is not
              in itself a fault. */}
          <Stat
            label="Failed"
            value={count(block.failed_transactions)}
            warn={block.failed_transactions > 0}
          />
          <Stat label="Entries" value={count(block.entries)} />
          {/* Base is the remainder: the bank reports the two together and the
              priority half separately, never the base fee on its own. */}
          <Stat
            label="Base fees"
            value={`${sol(block.total_fees - block.priority_fees, 6)} SOL`}
            className="sx-fee"
          />
          <Stat label="Priority fees" value={`${sol(block.priority_fees, 6)} SOL`} className="sx-fee" />
          {/* Ours, which is the question an operator is asking of their own
              block. The wider figure it came from is on the hover rather than
              in a column of its own: it is the same number twice, and only one
              of them answers anything here. Drawn only where the tips were
              measured, so a turn the searchers passed by reads nought and a
              turn never measured is absent. */}
          {rates && block.tips != null && (
            <Stat
              label="Our tips"
              className="sx-fee"
              value={`${sol(ourShare(block.tips, rates) ?? 0, 6)} SOL`}
              title={`${sol(jitoShare(block.tips, rates), 6)} SOL reached the distribution account, of ${sol(block.tips, 6)} paid. Derived from the configured rates, not measured.`}
            />
          )}
          {/* Beside the tips, which is what they paid. Absent where no bundle
              stage reported the slot: a stock validator, or one under BAM. */}
          {block.bundles && (
            <Stat
              label="Bundles"
              value={bundlesValue(block.bundles)}
              title={`${count(block.bundles.sanitized)} bundles sanitised, ${count(block.bundles.executed)} executed and in the block.`}
            />
          )}
        </div>
      </div>
      {cap && <CapacityBar cap={cap} />}
    </div>
  );
}

/** The limit cut into the costliest account, everything else, and unused:
 *  shares of the limit, not of the block. */
function CapacityBar({ cap }: { cap: Capacity }) {
  return (
    <div className="sx-cap">
      <div className="sx-cap-bar" aria-hidden="true">
        <i className="sx-seg is-top" style={{ width: `${cap.top * 100}%` }} />
        <i className="sx-seg is-rest" style={{ width: `${cap.rest * 100}%` }} />
        <i className="sx-seg is-free" />
      </div>
      <div className="sx-legend">
        <span className="sx-key">
          <i className="sx-sw is-top" aria-hidden="true" />
          costliest account {percent(cap.top, 1)}
        </span>
        <span className="sx-key">
          <i className="sx-sw is-rest" aria-hidden="true" />
          everything else {percent(cap.rest, 1)}
        </span>
        <span className="sx-key">
          <i className="sx-sw is-free" aria-hidden="true" />
          unused {percent(cap.free, 1)}
        </span>
      </div>
    </div>
  );
}

/** The account that took the most of the block, as a share of its own
 *  ceiling and of the block. */
function BlockAccount({
  block,
  cost,
  costs,
}: {
  block: ProducedBlock;
  cost: SlotCost;
  costs: SlotCost[];
}) {
  const ofLimit =
    block.account_cost_limit > 0 ? cost.costliest_cost / block.account_cost_limit : null;
  const ofBlock = cost.block_cost > 0 ? cost.costliest_cost / cost.block_cost : null;
  const seen = recurrence(costs, cost.costliest_account);

  return (
    <div className="sx-acct">
      <div className="sx-eyebrow">
        <Explain text="The account charged the most compute in this block, against the per-account ceiling.">
          Costliest account
        </Explain>
      </div>
      <div className="sx-acct-row">
        <Copyable text={cost.costliest_account} className="sx-acct-key" />
        {/* Against the account's own ceiling, not the block's. That is the one
            this account could actually have hit. */}
        <span className="sx-acct-track" aria-hidden="true">
          <span
            className="sx-acct-fill"
            style={{ width: `${Math.min(100, (ofLimit ?? 0) * 100)}%` }}
          />
        </span>
        <span className="sx-acct-cu">{units(cost.costliest_cost)} CU</span>
        <span className="sx-acct-of">
          {/* The account ceiling moves with feature activation, so it is taken
              from the bank rather than held here. Absent on a block captured
              before it was read, and the clause goes with it. */}
          {ofLimit === null ? "" : `${percent(ofLimit, 0)} of account limit · `}
          {ofBlock === null ? "—" : `${percent(ofBlock, 0)} of block`}
        </span>
      </div>
      {/* Only when it has topped more than this one block. On its own it says
          nothing: something has to be the largest. */}
      {seen && seen.blocks > 1 && (
        <div className="sx-acct-note">
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
    </div>
  );
}

/** What the scheduler did with this slot: one line, and a drawer of the
 *  counters grouped by stage. Named for whichever scheduler built it. */
function BlockScheduler({ waterfall }: { waterfall: SlotWaterfall }) {
  const view = schedulerView(waterfall);
  const [breakdown, setBreakdown] = useState(false);
  const bam = waterfall.source === "bam";
  const held = view.groups.find((group) => group.key === "schedule")?.total ?? 0;
  const dropped = view.lost - held;

  return (
    <div className="sx-sched">
      <div className="sx-strip">
        <span className="sx-strip-label">
          <Explain text="Every transaction the banking stage was handed in this slot, and what became of it. Received equals buffered plus the intake reasons; the later stages hold work across slots and do not.">
            Scheduler
          </Explain>
          {bam && (
            <>
              {" · "}
              <Explain text="BAM built this block, so the first figure is counted in batches and the rest in transactions.">
                BAM
              </Explain>
            </>
          )}
        </span>
        <div className="sx-chain">
          {view.chain.map((link, index) => (
            <span className="sx-link" key={link.key}>
              {index > 0 && <span className="sx-arrow">→</span>}
              <span className="sx-link-pair">
                <span>{link.label}</span>
                <span>{count(link.count)}</span>
                {link.key === "finished" && view.completion !== null && (
                  <span className={`sx-pct${view.completion < 0.9 ? " tone-warn" : ""}`}>
                    {percent(view.completion, 1)}
                  </span>
                )}
              </span>
            </span>
          ))}
        </div>
        <span className="sx-strip-right">
          <span className={view.lost > 0 ? "tone-warn" : ""}>
            {count(dropped)} dropped / {count(held)} held back
          </span>
          <button
            type="button"
            className="sx-more"
            aria-expanded={breakdown}
            onClick={() => setBreakdown((was) => !was)}
          >
            breakdown{breakdown ? " ▾" : ""}
          </button>
        </span>
      </div>
      {breakdown && <Breakdown view={view} />}
    </div>
  );
}

/** The counters themselves, grouped by the stage that dropped them. */
function Breakdown({ view }: { view: SchedulerView }) {
  return (
    <div className="sx-drawer">
      <div className="sx-verdict">
        <i className={`sx-dot ${view.lost > 0 ? "is-lossy" : "is-clean"}`} aria-hidden="true" />
        {view.worst === null ? (
          <span className="sx-verdict-text">
            Nothing was lost in this slot. All {count(view.counters)} counters at nought.
          </span>
        ) : (
          <span className="sx-verdict-text">
            {count(view.lost)} transactions lost.{" "}
            <span className="sx-verdict-dim">
              Worst counter: {view.worst.label} ({count(view.worst.count)}),{" "}
              {percent(view.worst.count / view.lost, 0)} of the total.
            </span>
          </span>
        )}
        <span className="sx-verdict-aside">
          {count(view.nonZero)} of {count(view.counters)} counters non-zero
        </span>
      </div>
      <div className="sx-groups">
        {view.groups.map((group) => (
          <div className="sx-group" key={group.key}>
            <div className="sx-group-head">
              <span className="sx-group-name">{group.title}</span>
              <span className={`sx-group-total${group.total > 0 ? " tone-warn" : ""}`}>
                {count(group.total)}
              </span>
            </div>
            <div className="sx-rows">
              {group.rows.map((row, index) => (
                <CounterRow
                  key={row.key}
                  row={row}
                  share={shareOfGroup(group, row)}
                  rank={index}
                  /* Where the quiet ones begin, so the rule between the two
                     halves is drawn once and only when both halves exist. */
                  first={index === group.hits && group.hits > 0}
                />
              ))}
            </div>
            {/* Counted in batches, so it is set below the group rather than in
                it: it is neither part of that total nor a share of it. */}
            {group.aside.map((row) => (
              <div className="sx-aside" key={row.key}>
                <Explain text={row.explain}>
                  {row.label} · {count(row.count)}
                </Explain>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One counter: a bar of its share of the group, or no bar at nought. */
function CounterRow({
  row,
  share,
  rank,
  first,
}: {
  row: WaterfallRow;
  share: number;
  rank: number;
  first: boolean;
}) {
  const quiet = row.count === 0;
  return (
    <div className={`sx-counter${quiet ? " is-quiet" : ""}${first ? " is-first-quiet" : ""}`}>
      <span className="sx-counter-line">
        <Explain text={row.explain} className="sx-counter-label">
          {row.label}
        </Explain>
        <span className="sx-counter-count">{count(row.count)}</span>
      </span>
      {!quiet && (
        <span className="sx-counter-track" aria-hidden="true">
          <span
            className={`sx-counter-fill is-${Math.min(rank + 1, 3)}`}
            style={{ width: `${share * 100}%` }}
          />
        </span>
      )}
    </div>
  );
}

/** What the cost tracker saw of the block beyond its costliest account. */
function BlockFigures({ cost }: { cost: SlotCost }) {
  return (
    <div className="sx-keep">
      <Stat label="Accounts written" value={count(cost.accounts)} />
      <Stat label="Contended" value={count(cost.contended)} />
      <Stat label="New account data" value={bytes(cost.new_account_data)} />
      <Stat label="In flight" value={count(cost.in_flight)} />
    </div>
  );
}
