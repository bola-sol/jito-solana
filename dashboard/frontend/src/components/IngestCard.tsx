import { bytes, count, percent } from "../format";
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
 * and the TPU's own figures count transactions rather than datagrams.
 *
 * Where the validator does count a port's traffic in datagrams, that count is
 * sent alongside and the row shows a share as well as a figure. Drops and
 * deliveries are disjoint — a datagram the kernel discarded never reached the
 * reader — so the two added together are everything that arrived at the socket,
 * which is the denominator an absolute drop count has always lacked.
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
          <Explain text="Drops inside the window, and beside them the share of everything that arrived on the port in the same window. This is the figure that says whether packets are being lost now. The heading names the period actually watched, so it reads shorter than a minute until the window fills.">
            {windowLabel(summary.window_seconds)}
          </Explain>
          <Explain text="Drops since the validator finished starting, and their share of what arrived over the same stretch. Counted from there rather than from when the sockets opened, because most of a validator's drops happen during startup, when gossip's first view of the cluster arrives faster than it can be read. That burst says nothing about how the validator is running now.">
            Total
          </Explain>
        </div>
        {summary.paths.map((path) => (
          <IngestRow key={path.name} path={path} />
        ))}
      </div>
      <div className="card-footnote">
        Dropped packets per UDP port, shown as a share of everything that
        arrived wherever the traffic is counted in whole packets. The two QUIC
        ports and serve repair have no such count, and their rows are drop
        figures alone.{" "}
        <Explain text="Drops come from /proc/net/udp, which has a counter for what each socket discarded but none for what it handed over. The delivered half comes from the validator's own receivers, which report a packet count for turbine, gossip and TPU vote. The QUIC ports count transactions pulled out of streams rather than datagrams off the wire, so there is nothing there to add to a drop count. Serve repair keeps the right counter and never reports it, which would take a change to the validator itself to fix.">
          Why?
        </Explain>
      </div>
    </Card>
  );
}

/**
 * Deliberately uncoloured, even now there is a denominator for some of it.
 *
 * The share answers half of what stopped this being marked before — an absolute
 * figure could not be judged — but not the other half: the paths differ too much
 * in consequence for one threshold to serve them. Gossip is redundant and
 * re-requests what it loses; a dropped vote is not. And three rows still have no
 * share at all, so a colour scale would mark half the card and leave the rest
 * looking healthy for want of a measurement rather than for want of a fault.
 */
function IngestRow({ path }: { path: IngestPath }) {
  return (
    <div className="ingest-row">
      <span className="ingest-name" title={socketTitle(path)}>
        {path.name}
      </span>
      <span className="ingest-queued">
        {path.queued_bytes > 0 ? bytes(path.queued_bytes) : "—"}
      </span>
      <span className="ingest-recent">
        {count(path.drops_recent)}
        <Share of={path.drops_recent} received={path.received_recent} />
      </span>
      <span className="ingest-total">
        {count(path.drops_total)}
        <Share of={path.drops_total} received={path.received_total} />
      </span>
    </div>
  );
}

/**
 * The share of a port's traffic that was lost, where there is one to show.
 *
 * Rendered empty rather than omitted when there is not. Three rows never have a
 * share and the others lose theirs each time the window clears, and a line that
 * came and went would leave the six rows changing height against each other.
 */
function Share({ of, received }: { of: number; received: number | null }) {
  const share = lossShare(of, received);
  return <span className="ingest-share">{share === null ? "" : shareLabel(share)}</span>;
}

/**
 * What fraction of the packets that arrived at a socket were dropped.
 *
 * Null wherever the figure would mislead rather than inform:
 *
 * - Nothing counted what the port delivered, so there is no denominator.
 * - Nothing was delivered. That reads as total loss, but it is far more often a
 *   port whose count never arrived — the validator's counters travel as metrics
 *   points, and points are only submitted while info logging is on for the crate
 *   submitting them, so a quieter-than-default validator leaves them at nought.
 *   Reporting 100% lost on that basis would be a false alarm on a healthy node.
 * - Nothing was dropped, where a share is nought by construction and the zero
 *   already beside it says so more plainly.
 */
export function lossShare(drops: number, received: number | null): number | null {
  if (received === null || received <= 0 || drops <= 0) return null;
  return drops / (drops + received);
}

/**
 * A share small enough to round to nothing, said as such.
 *
 * Losing one packet in fifty thousand is a real reading and `0.00%` denies it,
 * which is the wrong direction to err in for a figure whose whole purpose is to
 * show that something is being lost.
 */
export function shareLabel(share: number): string {
  return share < 0.0001 ? "<0.01%" : percent(share, 2);
}

/** The port, and what it delivered where that is known. */
function socketTitle(path: IngestPath): string {
  const socket = `udp/${path.port}`;
  if (path.received_recent === null) return socket;
  return `${socket} · ${count(path.received_recent)} received in the window`;
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
