import { bytes, count } from "../format";
import type { IngestPath, IngestSummary } from "../types";
import { useStore } from "../useStore";
import { Card } from "./primitives";

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
          <span title="Bytes waiting unread at the moment of the sample. Usually empty: a healthy validator drains a socket in microseconds, so a reading here means a reader falling behind.">
            Queued
          </span>
          <span title="Drops within the window, which is what says whether packets are being lost now.">
            {windowLabel(summary.window_seconds)}
          </span>
          <span title="Drops since the sockets were opened. A burst during startup stays in this figure for the life of the process.">
            Total
          </span>
        </div>
        {summary.paths.map((path) => (
          <IngestRow key={path.name} path={path} />
        ))}
      </div>
      <div className="card-footnote">
        By UDP port. Drops happen in the kernel, before the validator sees the
        packet.
      </div>
    </Card>
  );
}

function IngestRow({ path }: { path: IngestPath }) {
  const dropping = path.drops_recent > 0;
  return (
    <div className={`ingest-row${dropping ? " is-dropping" : ""}`}>
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
