import { bytes, count, percent } from "../format";
import type { IngestPath, IngestSummary, QuicPaths } from "../types";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";

/**
 * Packets the kernel discarded before the validator could read them, per
 * port. The QUIC ports are drawn on the TPU path card when that card exists.
 * Where a port's deliveries are counted, drops over deliveries plus drops is
 * the share lost. Absent behind a port forward.
 */
export function IngestCard() {
  const store = useStore();
  const summary = store.get<IngestSummary>("summary", "ingest_paths");
  // The QUIC ports move to the TPU path card, but only where that card is
  // going to draw them: it is absent on a validator logging below info.
  const elsewhere = store.get<QuicPaths | null>("summary", "quic_paths") !== null;
  const paths = (summary?.paths ?? []).filter((path) => !path.quic || !elsewhere);
  if (!summary || paths.length === 0) return null;

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
        {paths.map((path) => (
          <IngestRow key={path.name} path={path} />
        ))}
      </div>
      <div className="card-footnote">
        Dropped packets per UDP port, shown as a share of everything that
        arrived wherever the traffic is counted in whole packets.{" "}
        {elsewhere
          ? "Serve repair is the one row without that share, and the QUIC ports are on the TPU path card instead."
          : "Serve repair and the QUIC ports have no such count, and their rows are drop figures alone."}{" "}
        <Explain text="Drops come from /proc/net/udp, which has a counter for what each socket discarded but none for what it handed over. The delivered half comes from the validator's own receivers, which report a packet count for turbine, gossip and the UDP vote port. Serve repair keeps the same counter and never reports it, so its row is a drop figure alone, and reaching it would take a change to the validator itself. The QUIC ports have no datagram count at all, since their counters count transactions pulled out of streams, which is why they are drawn beside what their listeners admitted rather than beside a share they cannot have.">
          Why?
        </Explain>
      </div>
    </Card>
  );
}

/** Uncoloured: the paths differ too much in consequence for one threshold,
 *  and some rows have no share at all. */
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

/** The share of a port's traffic lost, rendered empty rather than omitted so
 *  the rows keep their height. */
function Share({ of, received }: { of: number; received: number | null }) {
  const share = lossShare(of, received);
  return <span className="ingest-share">{share === null ? "" : shareLabel(share)}</span>;
}

/** What fraction of the packets that arrived were dropped. Null with no
 *  denominator, with nothing delivered (usually a count that never arrived),
 *  and with nothing dropped. */
export function lossShare(drops: number, received: number | null): number | null {
  if (received === null || received <= 0 || drops <= 0) return null;
  return drops / (drops + received);
}

/** A share too small to round to anything, said as such rather than as
 *  `0.00%`. */
export function shareLabel(share: number): string {
  return share < 0.0001 ? "<0.01%" : percent(share, 2);
}

/** The port, and what it delivered where that is known. */
function socketTitle(path: IngestPath): string {
  const socket = `udp/${path.port}`;
  if (path.received_recent === null) return socket;
  return `${socket} · ${count(path.received_recent)} received in the window`;
}

/** The period the recent column covers, counting up through the first minute
 *  and rounded to five seconds. */
export function windowLabel(seconds: number): string {
  if (seconds >= 55) return "Last min";
  return `Last ${Math.max(5, Math.round(seconds / 5) * 5)}s`;
}
