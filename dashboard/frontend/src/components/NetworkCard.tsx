import { bytes } from "../format";
import type { Network, NetworkSample } from "../types";
import { RENDER_LAG_MS, useNow, windowed } from "../useNow";
import { useStore } from "../useStore";
import { Card, chartY, PEAK_HEADROOM, PeakLine, Stat } from "./primitives";

const WIDTH = 600;
const HEIGHT = 90;

/** Matches the TPS chart, so both read on the same timebase. */
const WINDOW_SECONDS = 60;

/**
 * Whole-host interface throughput, summed over every non-loopback interface.
 *
 * Titled and labelled as the host's, not the validator's, because that is what
 * it measures: Linux attributes bytes to an interface and not to a process, so
 * anything else running on the box is counted too. On a dedicated validator the
 * two are near enough the same, which is exactly why the distinction has to be
 * on the card rather than left to the reader to guess.
 *
 * The card renders nothing at all when the validator could not read the
 * counters, rather than showing zeros that would look like an idle network.
 */
export function NetworkCard() {
  const store = useStore();
  const rates = store.get<Network>("summary", "network");
  if (!rates) return null;

  const scope =
    "Every non-loopback interface on this host, not the validator's own traffic: " +
    "Linux counts bytes per interface, not per process.";

  return (
    <Card title="Host Network" className="network-body">
      <div className="stat-grid stat-grid-tight">
        <Stat
          label={<><span className="swatch swatch-ingress" />Ingress</>}
          value={`${bytes(rates.received_per_second)}/s`}
          explain={scope}
        />
        <Stat
          label={<><span className="swatch swatch-egress" />Egress</>}
          value={`${bytes(rates.sent_per_second)}/s`}
          explain={scope}
        />
      </div>
      <NetworkChart samples={store.getNetwork()} />
    </Card>
  );
}

function NetworkChart({ samples }: { samples: NetworkSample[] }) {
  // Drawn a sample behind live, so the newest point sits past the right edge
  // and the line is continuous across it rather than ending in a notch.
  const edge = useNow() - RENDER_LAG_MS;
  const windowMs = WINDOW_SECONDS * 1000;
  const visible = windowed(samples, edge, windowMs, (sample) => sample.timestamp_nanos);

  if (visible.length < 2) {
    return <div className="chart-empty">collecting samples…</div>;
  }

  // Both directions share a scale so their relative size is readable.
  const peak = Math.max(
    ...visible.map((s) => Math.max(s.received_per_second, s.sent_per_second)),
    1,
  );
  const x = (sample: NetworkSample) =>
    WIDTH * (1 - (edge - sample.timestamp_nanos / 1e6) / windowMs);
  const y = (value: number) => chartY(value, peak, HEIGHT);

  return (
    <div className="chart">
      <div className="chart-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img">
          <path className="chart-ingress" d={line(visible.map((s) => [x(s), y(s.received_per_second)]))} />
          <path className="chart-egress" d={line(visible.map((s) => [x(s), y(s.sent_per_second)]))} />
        </svg>
        <PeakLine fraction={PEAK_HEADROOM} label={`${bytes(peak)}/s peak`} />
      </div>
      <div className="chart-axis">
        <span>{WINDOW_SECONDS}s ago</span>
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
