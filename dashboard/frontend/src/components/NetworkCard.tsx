import { bytes } from "../format";
import type { Network, NetworkSample } from "../types";
import { useStore } from "../useStore";
import { Card, Stat } from "./primitives";

const WIDTH = 600;
const HEIGHT = 90;

/** Matches the TPS chart, so both read on the same timebase. */
const WINDOW_SECONDS = 60;

/**
 * Host interface throughput.
 *
 * The card renders nothing at all when the validator could not read the
 * counters, rather than showing zeros that would look like an idle network.
 */
export function NetworkCard() {
  const store = useStore();
  const rates = store.get<Network>("summary", "network");
  if (!rates) return null;

  return (
    <Card title="Network" className="network-body">
      <div className="stat-grid stat-grid-tight">
        <Stat label="Ingress" value={`${bytes(rates.received_per_second)}/s`} />
        <Stat label="Egress" value={`${bytes(rates.sent_per_second)}/s`} tone="muted" />
      </div>
      <NetworkChart samples={store.getNetwork()} />
    </Card>
  );
}

function NetworkChart({ samples }: { samples: NetworkSample[] }) {
  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;
  const visible = samples.filter(
    (sample) => now - sample.timestamp_nanos / 1e6 <= windowMs,
  );

  if (visible.length < 2) {
    return <div className="chart-empty">collecting samples…</div>;
  }

  // Both directions share a scale so their relative size is readable.
  const peak = Math.max(
    ...visible.map((s) => Math.max(s.received_per_second, s.sent_per_second)),
    1,
  );
  const x = (sample: NetworkSample) =>
    WIDTH * (1 - (now - sample.timestamp_nanos / 1e6) / windowMs);
  const y = (value: number) => HEIGHT - (value / peak) * HEIGHT;

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img">
        <path className="chart-ingress" d={line(visible.map((s) => [x(s), y(s.received_per_second)]))} />
        <path className="chart-egress" d={line(visible.map((s) => [x(s), y(s.sent_per_second)]))} />
      </svg>
      <div className="chart-axis">
        <span>{WINDOW_SECONDS}s ago</span>
        <span className="chart-peak">peak {bytes(peak)}/s</span>
        <span>now</span>
      </div>
    </div>
  );
}

/** An open path rather than a filled area, so the two lines stay legible. */
function line(points: Array<[number, number]>): string {
  return points
    .map(([px, py], index) => `${index === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
}
