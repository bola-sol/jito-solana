import { bytes, count } from "../format";
import type { IngestPath, IngestSummary } from "../types";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";

/**
 * Packets the kernel discarded before the validator could read them, per port.
 *
 * These are a different loss from the ones the validator counts itself, which
 * happen after a packet is already in userspace. A full receive buffer is the
 * usual way a validator loses shreds, and nothing inside the process sees it.
 *
 * Reading `/proc/net/udp` also reaches the QUIC ports, since QUIC runs over UDP
 * and the TPU's own figures are private to solana-streamer.
 *
 * Ports are matched against what this node advertises in gossip, which is a
 * heuristic: a validator behind a port forward advertises one port and binds
 * another. That case publishes nothing and the card stays absent, rather than
 * showing zeroes that would report a health it never measured.
 */
export function IngestCard() {
  const store = useStore();
  const summary = store.get<IngestSummary>("summary", "ingest_paths");
  if (!summary || summary.paths.length === 0) return null;

  return (
    <Card title="Socket Ingest" className="ingest-body">
      <div className="ingest">
        <div className="ingest-row is-head">
          <span>Socket</span>
          <Explain text="Bytes waiting unread at the moment of the sample. Usually empty, because a healthy validator drains a socket in microseconds. A reading here means the reader is falling behind.">
            Queued
          </Explain>
          <Explain text="Drops inside the window. This is the figure that says whether packets are being lost now. The heading names the period actually watched, so it reads shorter than a minute until the window fills.">
            {windowLabel(summary.window_seconds)}
          </Explain>
          <Explain text="Drops since the sockets were opened. A burst during startup stays in this figure for the life of the process, so read the window beside it to see what is happening now.">
            Total
          </Explain>
        </div>
        {summary.paths.map((path) => (
          <IngestRow key={path.name} path={path} />
        ))}
      </div>
      <div className="card-footnote">
        Dropped packets only, counted per UDP port. The kernel counts what it
        discarded but not what it delivered, so there is no received total to
        measure these against.{" "}
        <Explain text="The counts come from /proc/net/udp, which has a drop counter for every socket but no received counter. Counting what arrived would need the validator's own per-service counters, and those cannot be reached without a change to solana-streamer. So a figure here tells you packets were lost, not what share of the traffic was lost.">
          Why?
        </Explain>
      </div>
    </Card>
  );
}

/**
 * Deliberately uncoloured.
 *
 * Marking a row the moment it drops anything says a fault has occurred, and
 * nothing here can support that: without a count of what arrived there is no
 * denominator, so an absolute figure cannot be judged, and the paths differ too
 * much in consequence for one threshold to serve them. Gossip is redundant and
 * re-requests what it loses; a dropped vote is not. A healthy validator drops
 * packets steadily, so a figure that is simply non-zero is the honest signal.
 */
function IngestRow({ path }: { path: IngestPath }) {
  return (
    <div className="ingest-row">
      <span className="ingest-name" title={`udp/${path.port}`}>
        {path.name}
      </span>
      <span className="ingest-queued">
        {path.queued_bytes > 0 ? bytes(path.queued_bytes) : "—"}
      </span>
      <span className="ingest-recent">{count(path.drops_recent)}</span>
      <span className="ingest-total">{count(path.drops_total)}</span>
    </div>
  );
}

/**
 * Names the period the recent column actually covers.
 *
 * The window starts empty and fills over a minute, so for that first minute the
 * heading counts up rather than claiming a minute nobody watched. Rounded to
 * five seconds so the heading is not redrawn on every tick.
 */
export function windowLabel(seconds: number): string {
  if (seconds >= 55) return "Last min";
  return `Last ${Math.max(5, Math.round(seconds / 5) * 5)}s`;
}
