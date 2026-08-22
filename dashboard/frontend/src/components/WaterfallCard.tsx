import { percent } from "../format";
import type { ExecutedStage, QuicStage, VerifyStage, Waterfall } from "../types";
import { useStore } from "../useStore";
import { executedRows, quicRows, scheduledShare, verifyRows, waterfallRows } from "../waterfall";
import { Card, Explain } from "./primitives";
import { WaterfallRows } from "./WaterfallRows";

/**
 * The whole path a transaction takes through this validator, in four sections.
 *
 * Four sections rather than one flow, and that is the important thing about
 * this card. The stages are instrumented separately by parts of the validator
 * that were never meant to reconcile: they report on different cadences, split
 * votes from non-votes at different points, and one of them counts batches
 * where the rest count transactions. Run together as a single cascade the
 * numbers would look authoritative and quietly fail to add up, so each section
 * is drawn against its own total and claims nothing about the one below it.
 *
 * Where the sections join is stated rather than drawn: what QUIC hands on and
 * what verify receives are measured either side of the fetch stage's own
 * buffering, and what verify passes and what the scheduler receives likewise.
 * They should be close. They are not the same number and the card does not
 * pretend otherwise.
 *
 * Address lookup table resolution has no section of its own. Agave does it
 * inside the scheduler's receive checks and counts a failure under the same
 * counter as a malformed transaction, so it is already inside the "would not
 * parse" row and cannot be split out without a new counter upstream.
 */
export function WaterfallCard() {
  const store = useStore();
  const waterfall = store.get<Waterfall>("summary", "waterfall");
  const quic = store.get<QuicStage>("summary", "quic");
  const verify = store.get<VerifyStage>("summary", "verify");
  const executed = store.get<ExecutedStage>("summary", "executed");
  if (!waterfall && !quic && !verify && !executed) return null;

  const kept = waterfall ? scheduledShare(waterfall) : null;

  return (
    <Card title="TPU Waterfall" className="waterfall-body">
      <div className="waterfall-headline">
        <Explain text="Of the transactions this validator kept rather than forwarded, the share it managed to hand to a worker. The received count makes a poor headline on its own, being dominated by traffic the node was never going to execute. This says whether it kept up with what it did take. It is absent when the node has held nothing recently, which is the ordinary state of a validator that has not been leader.">
          <span className="waterfall-headline-label">Scheduled of held</span>
        </Explain>
        <span className="waterfall-headline-value">{kept === null ? "—" : percent(kept, 1)}</span>
      </div>

      {quic && (
        <Section
          title="QUIC"
          note="on the TPU port"
          explain="The listener that reads transactions out of QUIC streams on the TPU port. Forwards and vote have listeners of their own, under their own names, and neither feeds the scheduler this card follows."
          rows={quicRows(quic)}
        />
      )}
      {verify && (
        <Section
          title="Verify"
          note="signatures and duplicates"
          explain="Signature verification and deduplication, for everything that is not a vote. Votes are verified by a separate stage and leave by a different door, so they are left out here rather than inflating a total the sections below could never account for."
          rows={verifyRows(verify)}
        />
      )}
      {waterfall && (
        <Section
          title="Scheduler"
          note="held, queued, dispatched"
          explain="The banking stage scheduler: what it was handed, what it kept, and what it managed to give to a worker. The one section that runs across leader and non-leader slots alike, which is why most of what arrives here is forwarded rather than held."
          rows={waterfallRows(waterfall)}
        />
      )}
      {executed && (
        <Section
          title="Executed"
          note="summed across workers"
          explain="The worker threads. Each reports separately and they are added together, so this is the stage as a whole rather than any one thread."
          rows={executedRows(executed)}
        />
      )}

      <div className="card-footnote">
        Five minutes of the validator's own counters, four stages measured
        independently. Each section adds up against itself; the sections do not
        add up against each other, because nothing counts them as one flow. Rows
        reading nought are drawn rather than hidden, so the card keeps its height
        and a zero can be told from a figure nothing measures.
      </div>
    </Card>
  );
}

/**
 * One stage, with a heading naming what is being counted.
 *
 * The heading matters more here than it would in a single list: every section
 * restarts its bars at a hundred percent against its own total, and without a
 * rule and a name between them the card would read as one continuous cascade
 * that repeatedly climbs back to full.
 */
function Section({
  title,
  note,
  explain,
  rows,
}: {
  title: string;
  note: string;
  explain: string;
  rows: ReturnType<typeof waterfallRows>;
}) {
  return (
    <div className="waterfall-section">
      <div className="waterfall-section-head">
        <Explain text={explain}>
          <span className="waterfall-section-title">{title}</span>
        </Explain>
        <span className="waterfall-section-note">{note}</span>
      </div>
      <WaterfallRows rows={rows} />
    </div>
  );
}
