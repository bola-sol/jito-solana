import { useEffect, useMemo, useRef, useState, type ReactNode, type ReactElement } from "react";
import { blockStamp, blockTime, bytes, count, micros, percent, shortKey, sol, units } from "../format";
import {
  blockSummary,
  certificateVerdict,
  earnedOf,
  epochTotals,
  heldShortLabel,
  leaderSlotsLabel,
  sortBlocks,
  type BlockFigures,
  type BlockHead,
  type BlockSummary,
  type Earned,
  type EpochTotals,
  type SortDir,
  type SortKey,
} from "../produced";
import { epochOf } from "../schedule";
import { jitoShare, ourShare } from "../tips";
import type {
  BlockCertificate,
  Execution,
  LeaderSlotCounts,
  ProducedBlock,
  ProducedDetail,
  Recurrence,
  SlotCost,
  SlotWaterfall,
  TipRates,
} from "../types";
import { useStore } from "../useStore";
import { useAlpenglow } from "../consensus";
import {
  bundlesValue,
  capacity,
  executionView,
  schedulerView,
  shareOfGroup,
  versionsTitle,
  versionsValue,
  type Capacity,
  type SchedulerView,
} from "../slotDetail";
import type { WaterfallRow } from "../waterfall";
import { Copyable } from "./Copyable";
import { Explain } from "./primitives";
import { Section } from "./TpuPathCard";
import { turnOf, turnRangeLabel, turnSections, turnSpanLabel } from "../turns";
import { ProducedIndex, type TurnHead } from "../producedIndex";
import { ScrollTop } from "./ScrollTop";
import { VirtualList } from "./VirtualList";

/** Guessed before a row is measured: a closed row and its gap. */
const ROW_HEIGHT_GUESS = 44;

export function SlotDetailsPage({
  slot: open,
  query,
  onSlot,
  onQuery,
}: {
  slot: number | null;
  query: string;
  onSlot: (slot: number | null) => void;
  onQuery: (query: string) => void;
}): ReactElement {
  const store = useStore();
  const live = store.get("summary", "produced_blocks");
  const liveTurns = store.get("summary", "produced_turns");
  const floor = store.get("summary", "produced_floor");
  const rates = store.get("summary", "tip_rates");
  const epoch = store.get("epoch", "new");
  const slotCounts = store.get("summary", "leader_slot_counts");
  const connection = store.getConnection();
  const [openTurn, setOpenTurn] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const [index] = useState(() => new ProducedIndex());
  const [, setPages] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  // Everything held is read once per connection; the live feed keeps it current after that.
  useEffect(() => {
    if (connection !== "open") return;
    index.reset();
    void index.readAll(
      (before) => store.request("produced.figures", before === undefined ? {} : { before }),
      () => setPages((was) => was + 1),
    );
    return () => index.reset();
  }, [connection, index, store]);

  // Idempotent, so safe in a memo: the index only takes what differs.
  useMemo(() => {
    if (floor !== undefined) index.setFloor(floor);
    index.mergeLive(live ?? [], liveTurns ?? []);
  }, [index, floor, live, liveTurns]);
  const revision = index.revision;

  const heads = useMemo(() => [...index.heads.values()], [index, revision]);
  const summary = useMemo(() => blockSummary(heads, rates), [heads, rates]);
  const totals = useMemo(() => epochTotals(heads, (slot) => epochOf(epoch, slot), rates), [heads, epoch, rates]);
  const countsByEpoch = useMemo(
    () => new Map((slotCounts ?? []).map((counts) => [counts.epoch, counts])),
    [slotCounts],
  );
  const turnBySlot = useMemo(() => turnOf(index.turns.values()), [index, revision]);
  const ordered = useMemo(
    () =>
      sort
        ? sortBlocks(heads, sort.key, sort.dir, rates).map((head) => head.slot)
        : heads.map((head) => head.slot).sort((a, b) => b - a),
    [heads, sort, rates],
  );
  const needle = query.replace(/,/g, "").trim();
  const keys = useMemo(
    () => (needle ? ordered.filter((slot) => String(slot).includes(needle)) : ordered),
    [ordered, needle],
  );
  const position = useMemo(() => new Map(keys.map((slot, at) => [slot, at])), [keys]);

  // Memoised: the page redraws on every store tick, and a whole epoch of heads is walked.
  const [oldest, newest] = useMemo(() => {
    let low: number | null = null;
    let high: number | null = null;
    for (const head of heads) {
      if (low === null || head.slot < low) low = head.slot;
      if (high === null || head.slot > high) high = head.slot;
    }
    return [low, high];
  }, [heads]);
  const firstEpoch = oldest === null ? null : epochOf(epoch, oldest);
  const lastEpoch = newest === null ? null : epochOf(epoch, newest);
  // Means on an epoch's row only beside another epoch's; with one, the Mean row says the same.
  const twoEpochs = firstEpoch !== null && lastEpoch !== null && firstEpoch !== lastEpoch;
  const epochs =
    firstEpoch === null || lastEpoch === null
      ? null
      : firstEpoch === lastEpoch
        ? `epoch ${count(lastEpoch)}`
        : `epochs ${count(firstEpoch)}–${count(lastEpoch)}`;

  // What sits above a row, from its place in the list; read by the sizing and the drawing alike.
  const shape = (slot: number) => {
    const at = position.get(slot) ?? 0;
    const previous = keys[at - 1];
    const blockEpoch = epochOf(epoch, slot);
    // Newest first only: a sort scatters an epoch's blocks.
    const epochDivider =
      !sort && blockEpoch !== null && (previous === undefined || epochOf(epoch, previous) !== blockEpoch);
    const turn = sort ? undefined : turnBySlot.get(slot);
    const turnDivider = turn !== undefined && (previous === undefined || turnBySlot.get(previous) !== turn);
    return { blockEpoch, epochDivider, turn, turnDivider };
  };

  const sizeClass = (slot: number) => {
    const { epochDivider, turn, turnDivider } = shape(slot);
    return (
      (turnDivider ? 1 : 0) +
      (epochDivider ? 2 : 0) +
      (open === slot ? 4 : 0) +
      (turnDivider && turn && openTurn === turn.first ? 8 : 0)
    );
  };

  const toggle = (key: SortKey) => {
    // A sort scatters a turn's blocks, so its divider and drawer go with it.
    setOpenTurn(null);
    setSort(sort?.key === key ? { key, dir: sort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  };

  const renderRow = (slot: number) => {
    const head = index.heads.get(slot);
    if (!head) return null;
    const { blockEpoch, epochDivider, turn, turnDivider } = shape(slot);
    return (
      <>
        {epochDivider && blockEpoch !== null && (
          <EpochRow
            epoch={blockEpoch}
            totals={totals.get(blockEpoch)}
            counts={countsByEpoch.get(blockEpoch)}
            means={twoEpochs}
          />
        )}
        {turnDivider && turn && (
          <TurnDivider
            turn={turn}
            heads={index.heads}
            open={openTurn === turn.first}
            onToggle={() => setOpenTurn(openTurn === turn.first ? null : turn.first)}
          />
        )}
        <BlockRow
          head={head}
          epoch={blockEpoch}
          rates={rates}
          inTurn={turn !== undefined}
          open={open === slot}
          onToggle={() => onSlot(open === slot ? null : slot)}
        />
      </>
    );
  };

  const reading = !index.complete && !index.failed;
  if (heads.length === 0) {
    return (
      <section className="slot-details">
        <div className="sidebar-empty">
          {reading
            ? "reading the blocks this validator holds…"
            : "nothing produced yet. Blocks appear here as this validator leads."}
        </div>
      </section>
    );
  }

  const held = count(heads.length);
  const scope = reading
    ? `the ${held} blocks read so far`
    : `the ${held} blocks held${epochs === null ? "" : `, ${epochs}`}`;

  return (
    <section className="slot-details">
      <div className="schedule-controls">
        <input
          type="search"
          className="schedule-search"
          value={query}
          placeholder="Slot number"
          aria-label="Filter the blocks by slot number"
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <div className="produced">
        <SummaryRows
          summary={summary}
          scope={scope}
          sort={sort}
          onSort={toggle}
          onClear={() => setSort(null)}
        />
      </div>
      <div className="produced-list" ref={list}>
        <ScrollTop scroller={list} hold={false} />
        <VirtualList
          keys={keys}
          sizeClass={sizeClass}
          fallback={ROW_HEIGHT_GUESS}
          render={renderRow}
          scroller={list}
          reveal={open}
        />
      </div>
      <div className="card-footnote">
        {open !== null && !index.heads.has(open) && !reading && <>Slot {count(open)} is not among the blocks held. </>}
        {needle && `${count(keys.length)} of ${held} blocks match. `}
        {reading && index.held !== null && `Reading back ${held} of ${count(index.held)}. `}
        {index.failed && "The validator stopped answering before every block was read. "}
        {sort
          ? `Sorted by ${SORT_WORD[sort.key]}, ${sort.dir === "desc" ? "highest" : "lowest"} first.`
          : "This epoch's blocks, and the last epoch's until a fifth of this one has passed."}
      </div>
    </section>
  );
}

/** One request per opened span; `undefined` while it is out, `null` if nothing came back. */
function useDetail(first: number | null, last: number | null): ProducedDetail | null | undefined {
  const store = useStore();
  const [answer, setAnswer] = useState<{ span: string; detail: ProducedDetail | null } | null>(null);
  const span = first === null || last === null ? null : `${first}-${last}`;
  useEffect(() => {
    if (first === null || last === null) return;
    let current = true;
    store.request("produced.detail", { first, last }).then(
      (detail) => current && setAnswer({ span: `${first}-${last}`, detail }),
      () => current && setAnswer({ span: `${first}-${last}`, detail: null }),
    );
    return () => {
      current = false;
    };
  }, [store, first, last]);
  return answer !== null && answer.span === span ? answer.detail : undefined;
}

function TurnDivider({
  turn,
  heads,
  open,
  onToggle,
}: {
  turn: TurnHead;
  heads: ReadonlyMap<number, BlockHead>;
  open: boolean;
  onToggle: () => void;
}) {
  const slots = turn.last - turn.first + 1;
  return (
    <div className={`turn${open ? " is-open" : ""}`}>
      <button type="button" className="turn-head" onClick={onToggle} aria-expanded={open}>
        <span className="turn-name">Turn</span>
        <span className="turn-span">
          <span className="turn-range">{turnRangeLabel(turn)}</span>
          {turn.produced < slots && `, ${count(turn.produced)} of ${count(slots)} produced`}
          {", "}
          {turnSpanLabel(turn)}
        </span>
        <span className="turn-more">{open ? "TPU path ▾" : "TPU path"}</span>
      </button>
      {open && <TurnDrawer turn={turn} heads={heads} />}
    </div>
  );
}

function TurnDrawer({ turn, heads }: { turn: TurnHead; heads: ReadonlyMap<number, BlockHead> }) {
  const store = useStore();
  const liveTurn = store.get("summary", "produced_turns")?.find((held) => held.first === turn.first);
  const liveWaterfalls = store.get("summary", "slot_waterfalls");
  const detail = useDetail(turn.first, turn.last);
  const full = liveTurn ?? detail?.turns.find((held) => held.first === turn.first);
  if (!full) {
    return <div className="turn-drawer sx-loading">{detail === undefined ? "reading this turn…" : "this turn is no longer held"}</div>;
  }
  const own = (detail?.waterfalls ?? liveWaterfalls ?? []).filter((w) => w.slot >= turn.first && w.slot <= turn.last);
  let landed = 0;
  for (let slot = turn.first; slot <= turn.last; slot += 1) landed += heads.get(slot)?.transactions ?? 0;
  return (
    <div className="turn-drawer">
      {turnSections(full, own, landed).map((section) => (
        <Section key={section.key} section={section} />
      ))}
    </div>
  );
}

/** Module-level: a component made inside the row remounted under every click. */
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
  earned: "earnings",
  duration: "duration",
};

function SummaryRows({
  summary,
  scope,
  sort,
  onSort,
  onClear,
}: {
  summary: BlockSummary;
  scope: string;
  sort: { key: SortKey; dir: SortDir } | null;
  onSort: (key: SortKey) => void;
  onClear: () => void;
}) {
  const { mean } = summary;
  return (
    <>
      <div className="produced-averages">
        <span className="produced-id">
          <Explain
            className="produced-avg-label"
            text={`Mean of each column over ${scope}. A block missing a figure is left out of that column.`}
          >
            Mean
          </Explain>
          {sort && (
            <button type="button" className="produced-clear" onClick={onClear} aria-label="Clear sort">
              ×<span className="produced-clear-word"> clear</span>
            </button>
          )}
        </span>
        <SortButton column="transactions" sort={sort} onSort={onSort} className="produced-txns">
          {txns(mean.transactions)}
        </SortButton>
        <SortButton column="filled" sort={sort} onSort={onSort} className="produced-fill">
          {full(mean.filled)}
        </SortButton>
        <SortButton column="earned" sort={sort} onSort={onSort} className="produced-fees">
          {solFigure(mean.earned)}
        </SortButton>
        <SortButton column="duration" sort={sort} onSort={onSort} className="produced-ms">
          {millis(mean.durationMillis)}
        </SortButton>
      </div>
      <FiguresRow label="Median" explain={`The middle block of each column over ${scope}.`} figures={summary.median} />
      <FiguresRow
        label="Worst 5%"
        explain={`The fifth percentile of transactions, fill and earnings, and the ninety fifth of duration, over ${scope}.`}
        figures={summary.worst}
      />
    </>
  );
}

function FiguresRow({
  label,
  explain,
  figures,
}: {
  label: string;
  explain: string;
  figures: BlockFigures;
}) {
  return (
    <div className="produced-averages">
      <span className="produced-id">
        <Explain className="produced-avg-label" text={explain}>
          {label}
        </Explain>
      </span>
      <span className="produced-txns">{txns(figures.transactions)}</span>
      <span className="produced-fill">{full(figures.filled)}</span>
      <span className="produced-fees">{solFigure(figures.earned)}</span>
      <span className="produced-ms">{millis(figures.durationMillis)}</span>
    </div>
  );
}

function EpochRow({
  epoch,
  totals,
  counts,
  means,
}: {
  epoch: number;
  totals: EpochTotals | undefined;
  counts: LeaderSlotCounts | undefined;
  means: boolean;
}) {
  const short = totals ? heldShortLabel(totals.blocks, counts) : null;
  return (
    <div className="produced-epoch">
      <span className="produced-id">
        <Explain
          className="produced-epoch-name"
          text={
            means
              ? "Totals of the epoch's blocks held, with fill and duration as their means."
              : "Totals of the epoch's blocks held."
          }
        >
          Epoch {count(epoch)}
        </Explain>
        {counts && <span className="produced-epoch-slots">{leaderSlotsLabel(counts)}</span>}
        {short && <span className="produced-epoch-short">{short}</span>}
      </span>
      <span className="produced-txns is-total">
        {totals && (
          <Explain text={`Mean ${txns(totals.transactions / totals.blocks)} per block.`}>
            {txns(totals.transactions)}
          </Explain>
        )}
      </span>
      <span className="produced-fill">{totals && means ? full(totals.filled) : ""}</span>
      <span className="produced-fees is-total">
        {totals && (
          <Explain text={`Mean ${sol(totals.earned / totals.blocks, 5)} SOL per block.`}>
            {solFigure(totals.earned)}
          </Explain>
        )}
      </span>
      <span className="produced-ms">{totals && means ? millis(totals.durationMillis) : ""}</span>
    </div>
  );
}

const txns = (value: number | null) => (value === null ? "—" : `${count(Math.round(value))} txns`);
const full = (value: number | null) => (value === null ? "—" : `${percent(value, 1)} full`);
const millis = (value: number | null) => (value === null ? "—" : `${Math.round(value)} ms`);
const solFigure = (value: number | null) =>
  value === null ? (
    "—"
  ) : (
    <>
      {sol(value, 5)}
      <span className="produced-fees-unit"> SOL</span>
    </>
  );

function BlockRow({
  head,
  epoch,
  rates,
  inTurn,
  open,
  onToggle,
}: {
  head: BlockHead;
  epoch: number | null;
  rates: TipRates | undefined;
  inTurn: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const filled = head.block_cost_limit > 0 ? head.block_cost / head.block_cost_limit : 0;
  const earned = earnedOf(head, rates);

  return (
    <div
      className={`produced-block${open ? " is-open" : ""}${inTurn ? " is-in-turn" : ""}`}
      id={`block-${head.slot}`}
    >
      <button type="button" className="produced-head" onClick={onToggle} aria-expanded={open}>
        {/* One cell for slot and stamp, so the grid stays five columns and a narrow screen just
            hides the stamp. */}
        <span className="produced-id">
          <span className="produced-slot">{count(head.slot)}</span>
          <span className="produced-when">{blockStamp(head.slot_time_millis)}</span>
        </span>
        <span className="produced-txns">{count(head.transactions)} txns</span>
        <span className="produced-fill">{percent(filled, 1)} full</span>
        <span className="produced-fees" title={earnedTitle(earned)}>
          {sol(earned.total, 5)}
          <span className="produced-fees-unit"> SOL</span>
        </span>
        <span className="produced-ms">
          {head.duration_nanos === null ? "—" : `${Math.round(head.duration_nanos / 1e6)} ms`}
        </span>
      </button>

      {open && <BlockDrawer slot={head.slot} epoch={epoch} rates={rates} />}
    </div>
  );
}

/** The live block where it is still among the newest, so late figures show as they land; asked for
 *  otherwise. The costliest account's recurrence always comes from the validator, over every block. */
function BlockDrawer({ slot, epoch, rates }: { slot: number; epoch: number | null; rates: TipRates | undefined }) {
  const store = useStore();
  const detail = useDetail(slot, slot);
  const block =
    store.get("summary", "produced_blocks")?.find((held) => held.slot === slot) ??
    detail?.blocks.find((held) => held.slot === slot);
  const waterfall =
    store.get("summary", "slot_waterfalls")?.find((held) => held.slot === slot) ??
    detail?.waterfalls.find((held) => held.slot === slot);
  const asked = detail?.costs.find((held) => held.slot === slot);
  const cost = store.get("summary", "slot_costs")?.find((held) => held.slot === slot) ?? asked;
  if (!block) {
    return (
      <div className="produced-detail sx-loading">
        {detail === undefined ? "reading this block…" : "this block is no longer held"}
      </div>
    );
  }
  return (
    <div className="produced-detail">
      <BlockCompute block={block} cost={cost} rates={rates} />
      {cost && <BlockAccount block={block} cost={cost} recurrence={asked?.recurrence ?? null} />}
      {waterfall && <BlockScheduler waterfall={waterfall} />}
      {cost && <BlockFigures cost={cost} />}
      {block.certificate && <BlockCertificateStrip certificate={block.certificate} />}

      <div className="produced-foot">
        <Copyable text={String(block.slot)} label={count(block.slot)} className="produced-foot-slot" />
        <span className="produced-time">{blockTime(block.slot_time_millis)}</span>
        {epoch !== null && <span className="produced-time">epoch {count(epoch)}</span>}
        {/* The blockhash, the hash of the block's last entry, not a transaction signature. */}
        <Copyable text={block.blockhash} className="produced-hash" />
      </div>
    </div>
  );
}

function earnedTitle(earned: Earned): string {
  const tips = earned.tips === null ? "" : ` and ${sol(earned.tips, 6)} SOL our tips`;
  return `${sol(earned.base, 6)} SOL base fees after the burn, ${sol(earned.priority, 6)} SOL priority${tips}.`;
}

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

function BlockCertificateStrip({ certificate }: { certificate: BlockCertificate }) {
  const verdict = certificateVerdict(certificate);
  const leader = certificate.leader_name ?? shortKey(certificate.leader, 6, 5);
  const [listOpen, setListOpen] = useState(false);
  const leftOut = certificate.left_out.length > 0;
  return (
    <div className="sx-cert">
      <div className="sx-strip">
        <span className="sx-strip-label">
          <Explain text="The reward certificate this block wrote, for the slot eight back, against what the epoch's certificates usually pay.">
            Reward certificate
          </Explain>
        </span>
        <div className="sx-cert-figures">
          <span>
            <b>{count(certificate.paid)}</b> of {count(certificate.ranks)} votes
          </span>
          <span>
            <b>{percent(certificate.stake_paid, 1)}</b> of stake
          </span>
          <span>
            notarize <b>{count(certificate.notar)}</b>
          </span>
          <span className={certificate.notarized ? undefined : "is-out"}>
            skip <b>{count(certificate.skip)}</b>
          </span>
          <span className={certificate.ours_in ? undefined : "is-out"}>
            our vote <b>{certificate.ours_in ? "in" : "out"}</b>
          </span>
          <span className={verdict.warn ? "is-out" : undefined}>
            {leftOut ? (
              <button
                type="button"
                className="misses-open"
                aria-expanded={listOpen}
                title={listOpen ? "Hide them" : "List them"}
                onClick={() => setListOpen(!listOpen)}
              >
                {verdict.text}
              </button>
            ) : (
              verdict.text
            )}
          </span>
        </div>
        <span className="sx-strip-right">
          for slot <Copyable text={String(certificate.rewards)} label={count(certificate.rewards)} /> ·{" "}
          <b>{leader}</b> · {certificate.notarized ? "notarized" : "skipped"}
        </span>
      </div>
      {leftOut && listOpen && (
        <div className="misses-out-list">
          {certificate.left_out.map((validator) => (
            <span className="misses-out" key={validator.identity}>
              <b>{validator.name ?? shortKey(validator.identity, 6, 5)}</b>
              <Copyable text={validator.identity} label={shortKey(validator.identity, 8, 8)} />
              {validator.ip && <Copyable text={validator.ip} />}
            </span>
          ))}
        </div>
      )}
      {certificate.usual !== null && (
        <div className="sx-cert-note">
          The epoch's usual certificate pays {count(certificate.usual)} of {count(certificate.ranks)}.
        </div>
      )}
    </div>
  );
}

function BlockCompute({
  block,
  cost,
  rates,
}: {
  block: ProducedBlock;
  cost: SlotCost | undefined;
  rates: TipRates | undefined;
}) {
  const alpenglow = useAlpenglow();
  const cap = capacity(block, cost);
  const votes = Math.max(0, block.transactions - block.non_vote_transactions);
  const unused = Math.max(0, block.block_cost_limit - block.block_cost);
  const tips = rates && block.tips != null;
  // On a phone each extra takes half a row, and an odd one out the whole of the last.
  const extras = [tips, block.bundles != null, block.versions != null].filter(Boolean).length;
  const extra = (nth: number) => (extras % 2 === 1 && nth === extras ? "sx-row" : "sx-half");

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
            of {count(block.block_cost_limit)}, {count(unused)} unused
          </div>
        </div>
        <div className="sx-stats">
          {/* Half the row under alpenglow, where votes are not shown, so the label fits beside two. */}
          <Stat
            label={alpenglow ? "transactions" : "non-vote"}
            value={count(block.non_vote_transactions)}
            className={alpenglow ? "sx-half" : undefined}
          />
          {!alpenglow && <Stat label="votes" value={count(votes)} />}
          {/* Toned only when it happened: a failed transaction still landed and paid its fee. */}
          <Stat
            label="failed"
            value={count(block.failed_transactions)}
            warn={block.failed_transactions > 0}
          />
          <Stat label="entries" value={count(block.entries)} />
          {/* Base is the remainder: the bank reports the two together and the
              priority half separately, never the base fee on its own. */}
          <Stat
            label="base fees, SOL"
            value={sol(block.total_fees - block.priority_fees, 6)}
            className="sx-fee"
          />
          <Stat label="priority fees, SOL" value={sol(block.priority_fees, 6)} className="sx-fee" />
          {rates && block.tips != null && (
            <Stat
              label="our tips, SOL"
              className={extra(1)}
              value={sol(ourShare(block.tips, rates) ?? 0, 6)}
              title={`${sol(jitoShare(block.tips, rates), 6)} SOL reached the distribution account, of ${sol(block.tips, 6)} paid. Derived from the configured rates, not measured.`}
            />
          )}
          {/* Absent on a stock validator or under BAM. */}
          {block.bundles && (
            <Stat
              label="bundles"
              className={extra(tips ? 2 : 1)}
              value={bundlesValue(block.bundles)}
              title={`${count(block.bundles.sanitized)} bundles sanitised, ${count(block.bundles.executed)} executed and in the block.`}
            />
          )}
          {/* Read back from the blockstore after the freeze, so absent for a
              moment on a fresh block. */}
          {block.versions && (
            <Stat
              label="legacy, v0, v1"
              className={extra(extras)}
              value={versionsValue(block.versions)}
              title={versionsTitle(block.versions)}
            />
          )}
        </div>
      </div>
      {cap && <CapacityBar cap={cap} />}
      {block.execution && <ExecutionTime execution={block.execution} />}
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
          costliest account <b>{percent(cap.top, 1)}</b>
        </span>
        <span className="sx-key">
          <i className="sx-sw is-rest" aria-hidden="true" />
          everything else <b>{percent(cap.rest, 1)}</b>
        </span>
        <span className="sx-key">
          <i className="sx-sw is-free" aria-hidden="true" />
          unused <b>{percent(cap.free, 1)}</b>
        </span>
      </div>
    </div>
  );
}

function BlockAccount({
  block,
  cost,
  recurrence,
}: {
  block: ProducedBlock;
  cost: SlotCost;
  recurrence: Recurrence | null;
}) {
  const ofLimit =
    block.account_cost_limit > 0 ? cost.costliest_cost / block.account_cost_limit : null;
  const ofBlock = cost.block_cost > 0 ? cost.costliest_cost / cost.block_cost : null;
  const seen = recurrence;

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
          {/* The account ceiling moves with feature activation, so it comes from the bank; absent
              where it was not read. */}
          {ofLimit === null ? "" : `${percent(ofLimit, 0)} of account limit, `}
          {ofBlock === null ? "—" : `${percent(ofBlock, 0)} of block`}
        </span>
      </div>
      {/* Only when it has topped more than this one block. On its own it says
          nothing: something has to be the largest. */}
      {seen && seen.blocks > 1 && (
        <div className="sx-acct-note">
          Costliest in{" "}
          <b>
            {count(seen.blocks)} of the {count(seen.of)} blocks held
          </b>
          , peaking at {units(seen.peak_cost)} CU in slot{" "}
          <Copyable
            text={String(seen.peak_slot)}
            label={count(seen.peak_slot)}
            className="cost-again-slot"
          />
        </div>
      )}
    </div>
  );
}

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
              {", "}
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
            {count(dropped)} dropped, {count(held)} held back
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
                  {row.label}, {count(row.count)}
                </Explain>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

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

function ExecutionTime({ execution }: { execution: Execution }) {
  const view = executionView(execution);
  return (
    <div className="sx-exec">
      <div className="sx-strip">
        <span className="sx-strip-label">
          <Explain text="The banking stage's time in this slot by stage, summed across its workers, so thread time rather than the slot's length.">
            Execution time
          </Explain>
        </span>
        <span className="sx-strip-right">
          <span>
            {count(execution.workers)} workers, {count(execution.window_millis)} ms slot
          </span>
        </span>
      </div>
      <div className="sx-cu">
        <div className="sx-cu-value">{micros(view.total)}</div>
        <div className="sx-cu-of">
          thread time, {micros(view.nonVote)} non-vote
          {view.votes !== null && view.votes > 0 && ` and ${micros(view.votes)} votes`}
        </div>
      </div>
      <div className="sx-cap">
        <div className="sx-cap-bar" aria-hidden="true">
          {view.segments.map((segment) => (
            <i
              key={segment.key}
              className={`sx-exec-seg is-${segment.key}`}
              style={{ width: `${segment.share * 100}%` }}
            />
          ))}
        </div>
        <div className="sx-legend">
          {view.segments.map((segment) => (
            <span className="sx-key" key={segment.key}>
              <i className={`sx-sw is-${segment.key}`} />
              {segment.explain ? (
                <Explain text={segment.explain}>{segment.label}</Explain>
              ) : (
                segment.label
              )}{" "}
              <b>{micros(segment.micros)}</b>
            </span>
          ))}
        </div>
      </div>
      <div className="sx-keep">
        <Stat
          label="thread time over the slot"
          value={view.perSlot === null ? "—" : `${view.perSlot.toFixed(2)}×`}
        />
        <Stat label="per worker" value={micros(view.perWorker)} />
        <Stat label="longest batch" value={micros(execution.longest_batch)} />
      </div>
    </div>
  );
}

function BlockFigures({ cost }: { cost: SlotCost }) {
  return (
    <div className="sx-keep">
      <Stat label="accounts written" value={count(cost.accounts)} />
      <Stat label="contended" value={count(cost.contended)} />
      <Stat label="new account data" value={bytes(cost.new_account_data)} />
      <Stat label="in flight" value={count(cost.in_flight)} />
    </div>
  );
}
