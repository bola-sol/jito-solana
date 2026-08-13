import { decimal } from "../format";
import type { TpsSample } from "../types";

const WIDTH = 600;
const HEIGHT = 120;

/**
 * A stacked area chart of vote and non-vote throughput.
 *
 * This is hand-rolled instead of pulled from a charting library. The built
 * bundle is embedded in the validator binary, and a chart library would roughly
 * triple its size for the sake of one chart.
 */
export function TpsChart({ samples }: { samples: TpsSample[] }) {
  if (samples.length < 2) {
    return <div className="chart-empty">collecting samples…</div>;
  }

  const peak = Math.max(...samples.map((sample) => sample.total), 1);
  const step = WIDTH / (samples.length - 1);
  const y = (value: number) => HEIGHT - (value / peak) * HEIGHT;

  // Vote traffic sits underneath, non-vote stacks on top, so the upper edge is
  // total throughput.
  const votePath = area(samples.map((sample, index) => [index * step, y(sample.vote)]));
  const totalPath = area(samples.map((sample, index) => [index * step, y(sample.total)]));

  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanSeconds = Math.max(0, (last.timestamp_nanos - first.timestamp_nanos) / 1e9);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img">
        <path className="chart-total" d={totalPath} />
        <path className="chart-vote" d={votePath} />
      </svg>
      <div className="chart-axis">
        <span>{spanSeconds >= 1 ? `${Math.round(spanSeconds)}s ago` : "just now"}</span>
        <span className="chart-peak">peak {decimal(peak, 0)} TPS</span>
        <span>now</span>
      </div>
    </div>
  );
}

/** Turns a point series into a filled area path down to the baseline. */
function area(points: Array<[number, number]>): string {
  const line = points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const lastX = points[points.length - 1][0].toFixed(1);
  return `${line} L${lastX},${HEIGHT} L0,${HEIGHT} Z`;
}
