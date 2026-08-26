import { decimal } from "../format";
import { direction, NETWORK_WINDOW_SECONDS, sharedPeak, unitFor, type Direction } from "../network";
import type { NetworkSample } from "../types";
import { RENDER_LAG_MS, useNow, windowed } from "../useNow";
import { useStore } from "../useStore";
import { Card, chartY, Explain } from "./primitives";

const WIDTH = 300;
const HEIGHT = 38;

/**
 * Whole-host interface throughput, summed over every non-loopback interface.
 *
 * Titled and labelled as the host's, not the validator's, because that is what
 * it measures: Linux attributes bytes to an interface and not to a process, so
 * anything else running on the box is counted too. On a dedicated validator the
 * two are near enough the same, which is exactly why the distinction has to be
 * on the card rather than left to the reader to guess.
 *
 * A row each, but one scale across both. Given a band of its own, a direction
 * moving ten kilobytes a second fills it exactly as a direction moving ten
 * megabytes does, and the picture would say the two are equals. Sharing the
 * scale is the reason both are worth putting on one card.
 *
 * The card renders nothing at all when the validator could not read the
 * counters, rather than showing zeros that would look like an idle network.
 */
export function NetworkCard() {
  const store = useStore();
  const rates = store.get<{ received_per_second: number; sent_per_second: number }>(
    "summary",
    "network",
  );
  // Drawn a sample behind live, so the newest point sits past the right edge
  // and the line is continuous across it rather than ending in a notch.
  const edge = useNow() - RENDER_LAG_MS;
  if (!rates) return null;

  const windowMs = NETWORK_WINDOW_SECONDS * 1000;
  const visible = windowed(store.getNetwork(), edge, windowMs, (s) => s.timestamp_nanos);
  const received = visible.map((sample) => sample.received_per_second);
  const sent = visible.map((sample) => sample.sent_per_second);
  const peak = sharedPeak(received, sent);

  const scope =
    "Every non-loopback interface on this host, not the validator's own traffic: " +
    "Linux counts bytes per interface, not per process.";

  return (
    <Card
      title="Host Network"
      aside={`last ${NETWORK_WINDOW_SECONDS}s`}
      className="network-body"
    >
      <Row
        label="Ingress"
        kind="ingress"
        // Falls back to the live rate before a minute of samples has arrived,
        // so the figure is right from the first second and only the line and
        // the average wait for a window to average over.
        read={direction(received) ?? { current: rates.received_per_second, average: rates.received_per_second, delta: 0, trend: "flat" }}
        samples={visible}
        value={(sample) => sample.received_per_second}
        edge={edge}
        windowMs={windowMs}
        peak={peak}
        explain={scope}
      />
      <Row
        label="Egress"
        kind="egress"
        read={direction(sent) ?? { current: rates.sent_per_second, average: rates.sent_per_second, delta: 0, trend: "flat" }}
        samples={visible}
        value={(sample) => sample.sent_per_second}
        edge={edge}
        windowMs={windowMs}
        peak={peak}
        explain={scope}
      />
    </Card>
  );
}

/**
 * One direction: what it is doing now, the shape of the last minute, and what
 * it has averaged.
 *
 * Every figure on the row is printed in the unit the current reading calls for,
 * rather than each choosing its own. Sized separately, an average of 1.02 MB/s
 * prints beside a current 980 KB/s as "980" and "avg 1.02", and the larger
 * number looks like the smaller one.
 */
function Row({
  label,
  kind,
  read,
  samples,
  value,
  edge,
  windowMs,
  peak,
  explain,
}: {
  label: string;
  kind: "ingress" | "egress";
  read: Direction;
  samples: NetworkSample[];
  value: (sample: NetworkSample) => number;
  edge: number;
  windowMs: number;
  peak: number;
  explain: string;
}) {
  const { unit, divisor } = unitFor(read.current);
  const arrow = read.trend === "up" ? "▲" : read.trend === "down" ? "▼" : "·";

  return (
    <div className="net-row">
      <span className="net-label">
        <i className={`net-swatch is-${kind}`} aria-hidden="true" />
        <Explain text={explain}>{label}</Explain>
      </span>
      <span className="net-value">
        {decimal(read.current / divisor, 2)} <small>{unit}/s</small>
      </span>
      <span className="net-spark">
        <Spark
          kind={kind}
          samples={samples}
          value={value}
          edge={edge}
          windowMs={windowMs}
          peak={peak}
        />
      </span>
      <span className="net-meta">
        <b>avg {decimal(read.average / divisor, 2)}</b>
        {/* Untoned on purpose. Throughput going up is neither good nor bad on a
            validator, and a green or red arrow would read as a verdict on an
            ordinary fluctuation. */}
        <em>
          {arrow} {decimal(Math.abs(read.delta) / divisor, 2)}
        </em>
      </span>
    </div>
  );
}

function Spark({
  kind,
  samples,
  value,
  edge,
  windowMs,
  peak,
}: {
  kind: string;
  samples: NetworkSample[];
  value: (sample: NetworkSample) => number;
  edge: number;
  windowMs: number;
  peak: number;
}) {
  if (samples.length < 2) {
    return <span className="net-collecting">collecting…</span>;
  }
  // Placed by timestamp rather than by index, so a second the meter missed
  // leaves a gap of the right width instead of shifting everything after it.
  const points = samples.map((sample): [number, number] => [
    WIDTH * (1 - (edge - sample.timestamp_nanos / 1e6) / windowMs),
    chartY(value(sample), peak, HEIGHT),
  ]);
  const line = points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");

  // Closed under the samples themselves rather than across the full width. Shut
  // at the edges instead, a feed that stopped arriving would draw a long wedge
  // sloping to nothing at the right, which reads as throughput ramping down to
  // zero rather than as a chart with no news.
  const first = points[0][0];
  const last = points[points.length - 1][0];
  const area = `${line} L${last.toFixed(1)},${HEIGHT} L${first.toFixed(1)},${HEIGHT} Z`;

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img">
      <path className={`net-fill is-${kind}`} d={area} />
      <path className={`net-line is-${kind}`} d={line} />
    </svg>
  );
}
