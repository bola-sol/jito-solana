import { useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { bandHeights, bandOf, LOW_SHARE, minuteLabel, minuteXs, nearestMinute, trendLines } from "../finalization";
import { count, percent } from "../format";
import type { FinalizationMinute } from "../types";
import { useStore } from "../useStore";
import { Card, Stat } from "./primitives";

const BANDS = 10;

const CHART_WIDTH = 300;

const CHART_HEIGHT = 90;

function counted(n: number, noun: string): string {
  return `${count(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** Under Alpenglow, how often blocks' finalization certificates carried our vote, against the cluster. */
export function FinalizationCard(): ReactElement | null {
  const share = useStore().get("summary", "finalization_share");
  if (!share) return null;

  const heights = bandHeights(share.bands);
  const ourBand = share.ours === null ? null : bandOf(share.ours, BANDS);

  return (
    <Card title="Finalization certificates" aside="last 10 minutes">
      <div className="final-stats">
        <Stat
          label="of blocks carried our vote in their finalization certificate"
          value={percent(share.ours, 0)}
          sub={share.above === null ? undefined : `above ${percent(share.above, 0)} of validators`}
          tone={share.ours !== null && share.ours < LOW_SHARE ? "warn" : undefined}
          explain="Share of blocks over the last ten minutes whose finalization certificate included this node's vote."
        />
        <Stat
          label="cluster median"
          value={percent(share.median, 0)}
          sub={`${counted(share.validators, "validator")}, ${counted(share.blocks, "block")}`}
        />
        <Stat
          label="from a block's last shred to our vote"
          value={share.vote_micros === null ? "—" : `${Math.round(share.vote_micros / 1e3)} ms`}
          sub="median over the last minute"
          explain="Median time from receiving a block's last shred to this node's notarize vote, over the last minute."
        />
      </div>
      <div className="final-charts">
        <figure className="final-chart">
          <figcaption>Validators by share, ours highlighted</figcaption>
          <div className="final-bands" role="img" aria-label="Validators in each tenth of the share">
            {heights.map((height, band) => (
              <div
                key={band}
                className={band === ourBand ? "is-ours" : undefined}
                style={{ height: `${Math.max(2, height * 100)}%` }}
                title={`${count(share.bands[band] ?? 0)} validators at ${band * 10} to ${band * 10 + 10}%`}
              />
            ))}
          </div>
          <div className="final-axis">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
        </figure>
        <TrendChart trend={share.trend} />
      </div>
      <p className="card-footnote">
        A vote that reaches a block's certificate builder after 80% of stake has voted misses that block's
        finalization certificate. Rewards come from the reward certificate and are not affected.
      </p>
    </Card>
  );
}

/** Hover, a tap or the arrow keys pick a minute, whose share shows between the axis labels. */
function TrendChart({ trend }: { trend: FinalizationMinute[] }) {
  const [picked, setPicked] = useState<number | null>(null);
  const ours = trendLines(trend, (minute) => minute.ours, CHART_WIDTH, CHART_HEIGHT);
  const median = trendLines(trend, (minute) => minute.median, CHART_WIDTH, CHART_HEIGHT);
  const xs = minuteXs(trend);
  const newest = trend.length - 1;
  const shown = picked !== null && picked <= newest ? picked : null;
  const minute = shown === null ? undefined : trend[shown];

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) setPicked(nearestMinute(xs, (event.clientX - box.left) / box.width));
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") setPicked(Math.max(0, (shown ?? newest + 1) - 1));
    else if (event.key === "ArrowRight") setPicked(Math.min(newest, (shown ?? newest - 1) + 1));
    else if (event.key === "Escape") setPicked(null);
    else return;
    event.preventDefault();
  };

  return (
    <figure className="final-chart">
      <figcaption>Our share minute by minute, cluster median dashed</figcaption>
      <div
        className="final-plot"
        tabIndex={0}
        aria-label="Step through the minutes with the arrow keys"
        onPointerMove={(event) => event.pointerType === "mouse" && pick(event)}
        onPointerDown={pick}
        // A finger's lift also leaves, so only the mouse clears the pick.
        onPointerLeave={(event) => event.pointerType === "mouse" && setPicked(null)}
        onKeyDown={step}
        onBlur={() => setPicked(null)}
      >
        <svg
          className="final-trend"
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Our share and the cluster median for each minute of the last hour"
        >
          {median.map((points, index) => (
            <polyline key={`median-${index}`} className="final-median" points={points} />
          ))}
          {ours.map((points, index) => (
            <polyline key={`ours-${index}`} className="final-ours" points={points} />
          ))}
        </svg>
        {/* Drawn over the plot, not in it, so the stretched viewBox does not squash the dots. */}
        {shown !== null && minute && (
          <div className="final-cross" style={{ left: `${(xs[shown] ?? 1) * 100}%` }} aria-hidden="true">
            {minute.ours !== null && <i style={{ top: `${(1 - minute.ours) * 100}%` }} />}
          </div>
        )}
      </div>
      {/* The picked minute sits between the labels, in a row that is always there. */}
      <div className="final-axis">
        <span>−60 min</span>
        <span className="final-picked" aria-live="polite">
          {shown !== null && minute && (
            <>
              {minuteLabel(trend, shown)} · <b>{percent(minute.ours, 0)}</b> ours
            </>
          )}
        </span>
        <span>now</span>
      </div>
    </figure>
  );
}
