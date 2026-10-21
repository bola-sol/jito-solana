import { count } from "./format";
import { windowLabel } from "./handoff";
import type { ClusterFigures, Spread } from "./types";

export interface FigureColumn {
  key: string;
  label: string;
  explain: string;
  median: string;
  p05: string;
  p95: string;
}

/** Shares and percentages keep two figures below one and one below ten. */
export function share(value: number): string {
  if (value === 0) return "0";
  if (value < 1) return value.toFixed(2);
  if (value < 10) return value.toFixed(1);
  return count(Math.round(value));
}

/** Five characters at most, so a rate never widens its column. */
export function rate(value: number): string {
  if (value < 10_000) return count(Math.round(value));
  if (value < 100_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value / 1_000)}k`;
}

export function millis(value: number): string {
  return count(Math.round(value));
}

/** Under TowerBFT nothing is finalized here, so that column is left out. */
export function figureColumns(figures: ClusterFigures, alpenglow: boolean): FigureColumn[] {
  const column = (
    key: string,
    label: string,
    explain: string,
    spread: Spread | null,
    format: (value: number) => string,
    unit: string,
  ): FigureColumn => ({
    key,
    label,
    explain,
    median: spread ? `${format(spread.p50)}${unit}` : "—",
    p05: spread ? format(spread.p05) : "—",
    p95: spread ? format(spread.p95) : "—",
  });
  const columns = [
    column("cu", "CU used", "Each block's compute against the block limit.", figures.cu_used, share, "%"),
    column(
      "slot",
      "slot time",
      "Each block's time from the previous block filling to this one filling.",
      figures.slot_time_millis,
      millis,
      " ms",
    ),
    column("skip", "skip rate", "Each leader's share of its slots skipped.", figures.skip_rate, share, "%"),
    column("tps", "TPS", "Transactions per second over each run of 300 slots.", figures.tps, rate, ""),
    column(
      "failed",
      "failed TPS",
      "Failed transactions per second over each run of 300 slots.",
      figures.failed_tps,
      rate,
      "",
    ),
  ];
  if (alpenglow) {
    columns.push(
      column(
        "finality",
        "finality",
        "Each turn's first block, from its last shred to finalization here.",
        figures.finality_millis,
        millis,
        " ms",
      ),
    );
  }
  return columns;
}

/** The epoch, or where the held slots start when that was after it began. */
export function figuresWindow(sinceMillis: number | null, nowMillis: number): string {
  return sinceMillis === null ? "this epoch" : windowLabel(false, sinceMillis, nowMillis);
}

/** The widest the window gets, held in reserve so the row keeps its width. */
export const WINDOW_ROOM = "since Wed 23:59";
