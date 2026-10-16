import { useEffect, type ReactElement } from "react";
import {
  lifeAt,
  lifeMarks,
  lifeSegments,
  lifeTicks,
  lifeWindow,
  replayedAt,
  slowNote,
  type LifePart,
} from "../blockLife";
import { useAlpenglow } from "../consensus";
import { count, shortKey } from "../format";
import type { BlockLifeStages } from "../types";
import { useStore } from "../useStore";
import { Explain, Fold } from "./primitives";

const PARTS: { part: LifePart; label: string }[] = [
  { part: "building", label: "arriving while the leader builds" },
  { part: "reaching", label: "reaching us" },
  { part: "replay", label: "replay" },
  { part: "vote", label: "our vote" },
  { part: "finalize", label: "to finalized" },
];

const TICKS = lifeTicks();

const CLOSE = `${lifeAt(0)}%`;

function ms(value: number | null): string {
  return value === null ? "—" : count(value);
}

function Track({ stages, marks, median }: { stages: BlockLifeStages; marks: number[]; median?: boolean }) {
  return (
    <span className={`life-track${median ? " is-median" : ""}`} aria-hidden="true">
      <span className="life-close" style={{ left: CLOSE }} />
      {lifeSegments(stages).map((segment) => (
        <i
          key={segment.part}
          className={`life-seg is-${segment.part}`}
          style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
        />
      ))}
      {!median && marks.map((left, index) => <b key={index} className="life-mark" style={{ left: `${left}%` }} />)}
    </span>
  );
}

function Axis() {
  return (
    <>
      <span className="life-axis life-gap" />
      <span className="life-axis life-side" />
      <span className="life-axis life-ticks" aria-hidden="true">
        {TICKS.map((tick) => (
          <span
            key={tick.label}
            className={[tick.minor && "is-minor", tick.before && "is-before"].filter(Boolean).join(" ") || undefined}
            style={{ left: `${tick.left}%` }}
          >
            {tick.label}
          </span>
        ))}
      </span>
      <span className="life-axis life-num life-replayed">replayed</span>
      <span className="life-axis life-num">final</span>
      <span className="life-axis life-note life-side" />
    </>
  );
}

export function BlockLifeCard(): ReactElement | null {
  const store = useStore();
  const alpenglow = useAlpenglow();
  const life = store.get("summary", "block_life");
  const epoch = store.get("epoch", "new");
  const earliest = life?.slowest.reduce((low, block) => Math.min(low, block.slot), Infinity) ?? Infinity;
  // The slowest reach ten minutes back, so just after a boundary their leaders are last epoch's.
  const before = epoch !== undefined && earliest < epoch.start_slot ? epoch.epoch - 1 : null;
  useEffect(() => {
    if (before !== null) void store.loadEpoch(before);
  }, [store, before]);
  if (!alpenglow || !life) return null;

  const { median } = life;
  const marks = lifeMarks(median);
  const span = lifeWindow(life.minutes);
  const replayed = replayedAt(median);
  const summary =
    life.total !== null ? (
      <>
        <b>{count(life.total)} ms</b> from the leader to finalized, median over {span}
      </>
    ) : (
      <>
        <b>{ms(replayed)} ms</b> from the leader to replayed, median over {span}
      </>
    );

  return (
    <Fold id="block-life" title="Block life" summary={summary}>
      <div className="life-body">
        <div className="life-legend">
          {PARTS.filter(({ part }) => median[part] !== null).map(({ part, label }) => (
            <span key={part} className="life-key">
              <i className={`life-swatch is-${part}`} aria-hidden="true" />
              {label}
              <b>{ms(median[part])}</b>
            </span>
          ))}
        </div>
        <div className="life-grid">
          <Axis />
          <span className="life-slot life-dim">
            <Explain text="Each stage's own median over the window, so the stages need not add up to the total.">
              Median
            </Explain>
          </span>
          <span className="life-leader" />
          <Track stages={median} marks={marks} median />
          <span className="life-num life-replayed life-dim">{ms(replayed)}</span>
          <span className="life-num life-final life-dim">{ms(life.total)}</span>
          <span className="life-note" />
        </div>
        {life.slowest.length > 0 ? (
          <>
            <div className="life-sub">Slowest of the last ten minutes, with the median marked</div>
            <div className="life-grid">
              {life.slowest.map((block) => {
                const leader = store.leaderOf(block.slot, false);
                const name = leader.name ?? (leader.key ? shortKey(leader.key, 4, 4) : "unknown");
                const blockReplayed = replayedAt(block.stages);
                const lateReplay = replayed !== null && blockReplayed !== null && blockReplayed > replayed * 1.15;
                const lateFinal = life.total !== null && block.total !== null && block.total > life.total * 1.15;
                return (
                  <div key={block.slot} className="life-row">
                    <span className="life-slot">
                      {count(block.slot)}
                      <em className="life-leader-in" title={leader.key ?? undefined}>
                        {name}
                      </em>
                    </span>
                    <span className="life-leader" title={leader.key ?? undefined}>
                      {name}
                    </span>
                    <Track stages={block.stages} marks={marks} />
                    <span className={`life-num life-replayed${lateReplay ? " tone-warn" : ""}`}>{ms(blockReplayed)}</span>
                    <span className={`life-num life-final${block.total === null ? " life-faint" : lateFinal ? " tone-warn" : ""}`}>
                      {ms(block.total)}
                    </span>
                    <span className="life-note">{slowNote(block)}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="life-sub">No block in the last ten minutes ran 10 ms past a median.</div>
        )}
        <div className="life-foot">Our vote and finality are timed only for a leader window's first slot.</div>
      </div>
    </Fold>
  );
}
