import { decimal } from "../format";
import type { TpsSample } from "../types";
import { RENDER_LAG_MS, useNow, windowed } from "../useNow";
import { chartY, PEAK_HEADROOM, PeakLine } from "./primitives";

const WIDTH = 600;
const HEIGHT = 120;

/** How much history the chart shows. Older samples scroll off the left. */
const WINDOW_SECONDS = 60;

/**
 * A stacked area chart of vote and non-vote throughput over a fixed window.
 *
 * Points are placed by timestamp rather than by index, so the series scrolls
 * leftward at a constant rate. Plotting by index spread whatever history
 * existed across the full width, which made the line compress as it grew and
 * kept old spikes on screen setting the vertical scale.
 *
 * The window carries one sample past its left edge and the viewBox clips it, so
 * the series slides out of view rather than the leftmost segment vanishing when
 * its older end expires.
 *
 * Hand-rolled rather than pulled from a charting library: the built bundle is
 * embedded in the validator binary, and a chart library would roughly triple
 * its size for the sake of one chart.
 */
export function TpsChart({ samples }: { samples: TpsSample[] }) {
  // Drawn a sample behind live, so the newest point sits past the right edge
  // and the line is continuous across it rather than ending in a notch.
  const edge = useNow() - RENDER_LAG_MS;
  const windowMs = WINDOW_SECONDS * 1000;
  const visible = windowed(samples, edge, windowMs, (sample) => sample.timestamp_nanos);

  if (visible.length < 2) {
    return <div className="chart-empty">collecting samples…</div>;
  }

  const peak = Math.max(...visible.map((sample) => sample.total), 1);
  const x = (sample: TpsSample) =>
    WIDTH * (1 - (edge - sample.timestamp_nanos / 1e6) / windowMs);
  const y = (value: number) => chartY(value, peak, HEIGHT);

  // Vote traffic sits underneath and non-vote stacks on top, so the upper edge
  // is total throughput.
  const votePath = area(visible.map((s) => [x(s), y(s.vote)]));
  const totalPath = area(visible.map((s) => [x(s), y(s.total)]));

  return (
    <div className="chart">
      <div className="chart-plot">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img">
          <path className="chart-total" d={totalPath} />
          <path className="chart-vote" d={votePath} />
        </svg>
        <PeakLine fraction={PEAK_HEADROOM} label={`${decimal(peak, 0)} tps peak`} />
      </div>
      <div className="chart-axis">
        <span>{WINDOW_SECONDS}s ago</span>
        <span>now</span>
      </div>
    </div>
  );
}

/** Turns a point series into a filled area path down to the baseline. */
function area(points: Array<[number, number]>): string {
  const line = points
    .map(([px, py], index) => `${index === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`)
    .join(" ");
  const firstX = points[0][0].toFixed(1);
  const lastX = points[points.length - 1][0].toFixed(1);
  return `${line} L${lastX},${HEIGHT} L${firstX},${HEIGHT} Z`;
}
