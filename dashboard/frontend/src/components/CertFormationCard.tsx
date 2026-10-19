import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement } from "react";
import {
  axisEnd,
  barTone,
  bars,
  geometry,
  growth,
  labelWidth,
  milestones,
  msAt,
  replayAt,
  runningPath,
  shareBy,
  ticks,
  unmeasured,
  xAt,
  type Bar,
  type Geometry,
  type Milestone,
  type MilestoneKey,
  type ReplayFrame,
} from "../certFormation";
import { count } from "../format";
import type { CertFormation } from "../types";
import { useStore } from "../useStore";
import { useWidth } from "../useWidth";
import { Explain } from "./primitives";

const HOLD_LABELS: Record<MilestoneKey, string> = {
  notarized: "notarized",
  fast: "fast final",
  second: "second round",
};

interface StatSpec {
  key: MilestoneKey;
  label: string;
  sub: string;
  tip: string;
  ms: (formation: CertFormation) => number | null;
}

const STATS: StatSpec[] = [
  {
    key: "notarized",
    label: "notarized",
    sub: "60% of stake",
    tip: "When notarize votes from 60% of stake had arrived on average.",
    ms: (formation) => formation.notarized_millis,
  },
  {
    key: "fast",
    label: "fast finalized",
    sub: "80% notarize votes",
    tip: "When notarize votes from 80% of stake had arrived on average, enough to finalize in one round.",
    ms: (formation) => formation.fast_final_millis,
  },
  {
    key: "second",
    label: "second round",
    sub: "60% finalize votes",
    tip: "When finalize votes from 60% of stake had arrived on average, the fallback when the fast path misses.",
    ms: (formation) => formation.second_round_millis,
  },
];

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Plays epoch averages at a tenth of speed; null while stopped. */
function useCertReplay(marks: readonly number[], end: number): { frame: ReplayFrame | null; toggle: () => void } {
  const [frame, setFrame] = useState<ReplayFrame | null>(null);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const toggle = useCallback(() => {
    if (raf.current !== 0) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      setFrame(null);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const next = replayAt(now - start, marks, end);
      if (next.done) {
        raf.current = 0;
        setFrame(null);
        return;
      }
      setFrame(next);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }, [marks, end]);
  return { frame, toggle };
}

function ReplayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9 M2.5 2.5v3h3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function MilestoneLabel({ g, mark, text, show }: { g: Geometry; mark: Milestone; text: string; show: boolean }) {
  const x = xAt(g, mark.ms);
  const width = labelWidth(text);
  let left: number;
  let top: number;
  if (mark.key === "notarized") {
    left = x + 5;
    top = g.top - 16;
  } else if (mark.key === "fast") {
    // Under the 80% line: the running total runs above it from here on.
    left = x + 5;
    top = g.base - mark.level * g.half + 3;
  } else {
    // Past the lower 60% line and left of the rule, where the total has not yet reached.
    left = x - 5 - width;
    top = g.base + mark.level * g.half + 3;
  }
  if (mark.key !== "second" && left + width > g.right + 2) left = x - 5 - width;
  return (
    <div className="cert-label" style={{ left, top, opacity: show ? 1 : 0 }}>
      {text}
    </div>
  );
}

function Chart({
  g,
  formation,
  marks,
  frame,
  hover,
  onHover,
}: {
  g: Geometry;
  formation: CertFormation;
  marks: Milestone[];
  frame: ReplayFrame | null;
  hover: number | null;
  onHover: (ms: number | null) => void;
}) {
  const up = useMemo(() => bars(g, formation.notarize), [g, formation]);
  const down = useMemo(() => bars(g, formation.finalize), [g, formation]);
  const notarizeLine = useMemo(() => runningPath(g, formation.notarize, formation.notarize_total, -1), [g, formation]);
  const finalizeLine = useMemo(() => runningPath(g, formation.finalize, formation.finalize_total, 1), [g, formation]);
  const replayMs = frame?.ms ?? null;
  const breakAt = g.left + g.stub;
  const slotMs = formation.slot_nanos === null ? null : formation.slot_nanos / 1e6;
  const thresholds: [number, 1 | -1][] = [
    [0.6, -1],
    [0.8, -1],
    [0.6, 1],
  ];
  const formed = (mark: Milestone) => replayMs === null || replayMs >= mark.ms;
  // A rule draws in over its hold.
  const reach = (mark: Milestone, index: number) => {
    if (replayMs === null) return 1;
    if (replayMs < mark.ms) return 0;
    if (frame?.hold?.index === index) return 1 - Math.pow(1 - frame.hold.fraction, 3);
    return 1;
  };

  const point = (event: PointerEvent<HTMLDivElement>) => {
    if (frame) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    onHover(msAt(g, ((event.clientX - box.left) / box.width) * g.width));
  };

  const bar = (direction: 1 | -1) => (item: Bar) => (
    <div
      key={`${direction}-${item.from}`}
      className={`mirror-bar is-${barTone(direction, item.middle, formation, replayMs)}${
        item.capped ? (direction === 1 ? " is-capped is-down" : " is-capped") : ""
      }`}
      style={{
        left: item.left,
        width: item.width,
        height: item.height,
        top: direction === 1 ? g.base + 1 : g.base - item.height,
        transformOrigin: direction === 1 ? "top" : "bottom",
        transform: replayMs === null ? undefined : `scaleY(${growth(replayMs, item.from).toFixed(3)})`,
      }}
    />
  );

  const hoverX = hover === null ? null : xAt(g, hover);
  const bubbleWidth = g.phone ? Math.min(230, g.width - 8) : 250;
  const bubbleLeft =
    hoverX === null ? 0 : Math.max(0, hoverX + 10 + bubbleWidth > g.width ? hoverX - 10 - bubbleWidth : hoverX + 10);
  const held = frame?.hold ? marks[frame.hold.index] : undefined;
  const cursorText =
    replayMs === null
      ? ""
      : `${Math.round(replayMs)} ms · ${held ? HOLD_LABELS[held.key] : "1/10 speed"}`;
  const cursorX = replayMs === null ? 0 : xAt(g, replayMs);
  const cursorLeft =
    cursorX + 5 + labelWidth(cursorText) + 4 > g.right + 4 ? cursorX - 5 - labelWidth(cursorText) - 4 : cursorX + 5;

  return (
    <div
      className="cert-mirror"
      style={{ width: g.width, height: g.height }}
      role="img"
      aria-label="Stake whose votes had arrived, by milliseconds after the slot began"
      onPointerMove={point}
      onPointerDown={point}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") onHover(null);
      }}
    >
      {up.map(bar(-1))}
      {down.map(bar(1))}
      <svg width={g.width} height={g.height} className="cert-lines" aria-hidden="true">
        <path
          className="cert-threshold"
          d={thresholds
            .map(([level, direction]) => `M${g.left} ${(g.base + direction * level * g.half).toFixed(1)}H${g.right}`)
            .join(" ")}
        />
        {slotMs !== null && (
          <path className="cert-slot-rule" d={`M${xAt(g, slotMs).toFixed(1)} ${g.top}V${g.bottom}`} />
        )}
        <path className="cert-axis" d={`M${g.left} ${g.base}H${breakAt - 7} M${breakAt - 2} ${g.base}H${g.right}`} />
        <path
          className="cert-axis-break"
          d={`M${breakAt - 9} ${g.base + 4}L${breakAt - 5} ${g.base - 4} M${breakAt - 4} ${g.base + 4}L${breakAt} ${
            g.base - 4
          }`}
        />
        {marks.map((mark, index) => {
          const x = xAt(g, mark.ms).toFixed(1);
          const length = (mark.key === "notarized" ? g.half + 14 : g.half - 2) * reach(mark, index);
          return (
            <path
              key={mark.key}
              className={`cert-rule is-${mark.key}`}
              d={`M${x} ${g.base}V${(g.base + mark.direction * length).toFixed(1)}`}
            />
          );
        })}
        <path className="cert-total is-notarize" d={notarizeLine} />
        <path className="cert-total is-finalize" d={finalizeLine} />
      </svg>
      {slotMs !== null && (
        <div className="cert-slot-label" style={{ left: xAt(g, slotMs) + 4, top: g.base + 4 }}>
          {g.phone ? "slot" : "slot length"}
        </div>
      )}
      {thresholds.map(([level, direction]) => (
        <div
          key={`${level}${direction}`}
          className="cert-gutter"
          style={{ top: g.base + direction * level * g.half - 7 }}
        >
          {Math.round(level * 100)}%
        </div>
      ))}
      {marks.map((mark) => (
        <MilestoneLabel
          key={mark.key}
          g={g}
          mark={mark}
          show={formed(mark)}
          text={
            mark.key === "notarized"
              ? `notarized ${mark.ms}`
              : mark.key === "fast"
                ? `${g.phone ? "fast" : "fast final"} ${mark.ms}`
                : `${g.phone ? "2nd round" : "second round"} ${mark.ms}`
          }
        />
      ))}
      {!g.phone && (
        <div className="cert-half-label" style={{ left: g.left, top: g.top - 16 }}>
          notarize, stake per {g.bin} ms
        </div>
      )}
      <div className="cert-half-label" style={{ left: g.left, top: g.bottom - 14 }}>
        {g.phone ? "finalize" : `finalize, stake per ${g.bin} ms`}
      </div>
      {ticks(g).map((tick) => (
        <div
          key={tick.ms}
          className={`cert-tick is-${tick.align}`}
          style={{ left: tick.ms === 0 ? g.left : xAt(g, tick.ms), top: g.bottom + 6 }}
        >
          {tick.label}
        </div>
      ))}
      {marks.filter(formed).map((mark) => (
        <div
          key={mark.key}
          className={`cert-dot is-${mark.key}`}
          style={{ left: xAt(g, mark.ms) - 3.5, top: g.base + mark.direction * mark.level * g.half - 3.5 }}
        />
      ))}
      {held && frame?.hold && <CertPulse g={g} mark={held} fraction={frame.hold.fraction} />}
      {replayMs !== null && (
        <>
          <div
            className="cert-cover"
            style={{ left: cursorX + 1, width: Math.max(0, g.right + 3 - cursorX), height: g.bottom + 2 }}
          />
          <div className="cert-cursor" style={{ left: cursorX, top: g.top - 14, height: g.bottom - g.top + 14 }} />
          <div className="cert-cursor-label" style={{ left: cursorLeft, top: g.top - 16 }}>
            {cursorText}
          </div>
        </>
      )}
      {hover !== null && hoverX !== null && (
        <>
          <div className="cert-hover-line" style={{ left: hoverX, top: g.top, height: g.bottom - g.top }} />
          <div className="cert-bubble" style={{ left: bubbleLeft, top: g.base + 10, width: bubbleWidth }}>
            <div>
              <b>{Math.round(hover)} ms</b> after the slot began
            </div>
            <div>
              notarize <b>{(shareBy(formation.notarize, hover) * 100).toFixed(1)}%</b> · finalize{" "}
              <b>{(shareBy(formation.finalize, hover) * 100).toFixed(1)}%</b>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CertPulse({ g, mark, fraction }: { g: Geometry; mark: Milestone; fraction: number }) {
  const radius = 4 + 14 * fraction;
  return (
    <div
      className={`cert-pulse is-${mark.key}`}
      style={{
        left: xAt(g, mark.ms) - radius,
        top: g.base + mark.direction * mark.level * g.half - radius,
        width: radius * 2,
        height: radius * 2,
        opacity: 1 - fraction,
      }}
    />
  );
}

function FormationPanel({ formation }: { formation: CertFormation }): ReactElement {
  const body = useRef<HTMLDivElement>(null);
  const measured = useWidth(body);
  const [hover, setHover] = useState<number | null>(null);
  const [still] = useState(prefersReducedMotion);
  const end = axisEnd(formation);
  const marks = useMemo(() => milestones(formation, end), [formation, end]);
  const times = useMemo(() => marks.map((mark) => mark.ms), [marks]);
  const { frame, toggle } = useCertReplay(times, end);
  const width = measured === null ? null : Math.floor(measured);
  const g = useMemo(() => (width === null ? null : geometry(width, end)), [width, end]);
  const phone = g?.phone ?? false;
  const aside = <span className="card-aside">epoch {count(formation.epoch)} averages</span>;

  return (
    <section className="card cert-card">
      <div className="card-head cert-head">
        <h2 className="card-title">How certificates form</h2>
        <span className="cert-head-end">
          {!phone && aside}
          {!still && (
            <button
              type="button"
              className="cert-replay"
              aria-label={frame ? "Stop replay" : "Replay a typical slot at 1/10 speed"}
              aria-pressed={frame !== null}
              onClick={() => {
                setHover(null);
                toggle();
              }}
            >
              <ReplayIcon playing={frame !== null} />
            </button>
          )}
        </span>
      </div>
      {phone && <div className="cert-aside-below">{aside}</div>}
      <div className="card-body" ref={body}>
        <div className={`stat-grid cert-stats${phone ? " is-narrow" : ""}`}>
          {STATS.map((stat) => {
            const ms = stat.ms(formation);
            const shown = ms !== null && (frame === null || frame.ms >= ms);
            return (
              <div key={stat.key} className="stat">
                <div className="stat-label has-explain">
                  <Explain text={stat.tip}>{stat.label}</Explain>
                </div>
                <div className={`stat-value cert-value is-${stat.key}`}>{shown ? `${ms} ms` : "—"}</div>
                <div className="stat-sub">{stat.sub}</div>
              </div>
            );
          })}
          <div className="stat">
            <div className="stat-label has-explain">
              <Explain text="Stake with no vote timed here in that epoch.">no votes measured</Explain>
            </div>
            <div className="stat-value">{(unmeasured(formation) * 100).toFixed(1)}%</div>
            <div className="stat-sub">share of stake</div>
          </div>
        </div>
        {g && (
          <Chart
            g={g}
            formation={formation}
            marks={marks}
            frame={frame}
            hover={frame ? null : hover}
            onHover={setHover}
          />
        )}
      </div>
      <div className="card-footnote">
        Each validator at its average arrival after the slot began here. Bars are stake arriving per {g?.bin ?? 5} ms.
      </div>
    </section>
  );
}

/** Under Alpenglow, how the certificates typically form, from last epoch's average vote arrivals. */
export function CertFormationCard(): ReactElement | null {
  const formation = useStore().get("summary", "cert_formation");
  if (!formation) return null;
  return <FormationPanel formation={formation} />;
}
