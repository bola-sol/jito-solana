import { bytes, count } from "../format";
import type { IngestPath } from "../types";
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
  const paths = store.get<IngestPath[]>("summary", "ingest_paths");
  if (!paths || paths.length === 0) return null;

  return (
    <Card title="Socket Ingest" className="ingest-body">
      <div className="ingest">
        <div className="ingest-row is-head">
          <span>Socket</span>
          <span title="Bytes waiting unread. A queue that stays deep is a reader falling behind, which is the state that precedes dropping.">
            Queued
          </span>
          <span title="Datagrams the kernel discarded, almost always because the receive buffer was full when one arrived.">
            Dropped
          </span>
        </div>
        {paths.map((path) => (
          <IngestRow key={path.name} path={path} />
        ))}
      </div>
      <div className="card-footnote">
        Totals since start, by UDP port. Drops happen in the kernel, before the
        validator sees the packet.
      </div>
    </Card>
  );
}

function IngestRow({ path }: { path: IngestPath }) {
  const dropping = path.drops_per_second > 0;
  return (
    <div className={`ingest-row${dropping ? " is-dropping" : ""}`}>
      <span className="ingest-name" title={`udp/${path.port}`}>
        {path.name}
      </span>
      <span className="ingest-queued">
        {path.queued_bytes > 0 ? bytes(path.queued_bytes) : "—"}
      </span>
      <span className="ingest-drops">
        {count(path.drops_total)}
        {dropping && <b>{dropRate(path.drops_per_second)}</b>}
      </span>
    </div>
  );
}

/**
 * A rate below one per second still rounds to a visible figure rather than to
 * zero. Losing a packet every few seconds is a fault, and printing it as `0/s`
 * next to a rising total would contradict itself on the same row.
 */
export function dropRate(perSecond: number): string {
  if (perSecond < 1) return "<1/s";
  return `${Math.round(perSecond).toLocaleString()}/s`;
}
