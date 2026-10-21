import type { ReactElement } from "react";
import { figureColumns, figuresWindow, WINDOW_ROOM } from "../clusterFigures";
import { useAlpenglow } from "../consensus";
import { useStore } from "../useStore";
import { Explain } from "./primitives";

/** Beside the verdict on wide screens: each figure's median over its 5th and 95th percentiles. */
export function ClusterRow(): ReactElement | null {
  const store = useStore();
  const alpenglow = useAlpenglow();
  const figures = store.get("summary", "cluster_figures");
  const serverTimeNanos = store.get("summary", "server_time_nanos");
  if (!figures) return null;
  const span = figuresWindow(figures.since_millis, serverTimeNanos === undefined ? Date.now() : serverTimeNanos / 1e6);
  return (
    <div className="cluster-row" role="group" aria-label={`Cluster, ${span}`}>
      <div className="cluster-keys">
        <span className="cluster-window">
          <span>{span}</span>
          <span className="cluster-window-room" aria-hidden="true">
            {WINDOW_ROOM}
          </span>
        </span>
        <span className="cluster-key-median">median</span>
        <span className="cluster-key-split">
          <span>p5</span>
          <span>p95</span>
        </span>
      </div>
      {figureColumns(figures, alpenglow).map((column) => (
        <div key={column.key} className="cluster-col">
          <span className="cluster-head">
            <Explain text={column.explain}>{column.label}</Explain>
          </span>
          <b className="cluster-median">{column.median}</b>
          <span className="cluster-tail">{column.p05}</span>
          <span className="cluster-tail">{column.p95}</span>
        </div>
      ))}
    </div>
  );
}
