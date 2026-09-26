
import { count, percent } from "./format";
import type { MissList, MissWriter, WrittenList, WrittenRow } from "./types";

export const WORSE_BY = 0.05;

export const WORSE_MIN = 10;

export const MISSING_EVERYWHERE = 0.9;

export type WrittenKind = "worse" | "missing" | "delinquent" | "no-gossip";

/** The order the kinds are listed and counted in. */
export const WRITTEN_KINDS: readonly WrittenKind[] = ["worse", "missing", "delinquent", "no-gossip"];

export interface WrittenFigure {
  row: WrittenRow;
  ours: number | null;
  everywhere: number | null;
  kind: WrittenKind;
}

function gap(figure: WrittenFigure): number {
  return (figure.ours ?? 0) - (figure.everywhere ?? 0);
}

export function writtenFigures(list: WrittenList): WrittenFigure[] {
  const written = list.certificates;
  const figures: WrittenFigure[] = [];
  for (const row of list.rows) {
    const ours = written > 0 ? row.left_out_of_ours / written : null;
    const everywhere = list.rewarded > 0 ? row.left_out_everywhere / list.rewarded : null;
    let kind: WrittenKind | null = null;
    if (everywhere !== null && everywhere >= MISSING_EVERYWHERE) {
      kind = "missing";
    } else if (
      ours !== null &&
      everywhere !== null &&
      row.left_out_of_ours >= WORSE_MIN &&
      ours - everywhere >= WORSE_BY
    ) {
      kind = "worse";
    }
    // Silence in gossip or not voting explains either, so it is named instead; the first outranks.
    if (kind === null) continue;
    if (row.no_gossip) kind = "no-gossip";
    else if (row.delinquent) kind = "delinquent";
    figures.push({ row, ours, everywhere, kind });
  }
  return figures.sort((a, b) => {
    if (a.kind !== b.kind) return WRITTEN_KINDS.indexOf(a.kind) - WRITTEN_KINDS.indexOf(b.kind);
    return a.kind === "worse" ? gap(b) - gap(a) : (b.everywhere ?? 0) - (a.everywhere ?? 0);
  });
}

export function writtenKinds(figures: WrittenFigure[]): Record<WrittenKind, number> {
  const kinds: Record<WrittenKind, number> = { worse: 0, missing: 0, delinquent: 0, "no-gossip": 0 };
  for (const figure of figures) kinds[figure.kind] += 1;
  return kinds;
}

/** The share that carried everyone certificates usually pay. */
export function writtenLine(list: WrittenList): string {
  const { certificates, carried_all } = list;
  if (certificates === 0) return "none written yet this epoch";
  return `${count(certificates)} written · ${percent(carried_all / certificates, 1)} carried everyone`;
}

/** The collector's threshold for calling a validator gone from gossip. */
export const NO_GOSSIP_AFTER_MILLIS = 5 * 60_000;

export type WriterKind = "worse" | "no-gossip";

/** The order the kinds are listed and counted in. */
export const WRITER_KINDS: readonly WriterKind[] = ["worse", "no-gossip"];

export interface WriterFigure {
  writer: MissWriter;
  /** Its certificates that left us out, over all it wrote. */
  share: number;
  /** Of those, the ones placed lost. */
  lost: number;
  kind: WriterKind;
  /** When this node last heard it over gossip; null where it is not in the table. */
  heardMillis: number | null;
}

/** Every certificate read that left us out, over all read. */
export function averageLeftOut(list: MissList): number | null {
  return list.rewarded > 0 ? list.rows.length / list.rewarded : null;
}

/** Writers whose certificates left us out far more often than the average, widest gap first.
 *  `heard` gives when gossip last heard a writer, null for absent, undefined while unknown. */
export function writerFigures(
  list: MissList,
  heard: (identity: string) => number | null | undefined,
  nowMillis: number,
): WriterFigure[] {
  const average = averageLeftOut(list);
  if (average === null) return [];
  const lost = new Map<number, number>();
  for (const row of list.rows) {
    if (row.writer !== null && row.place === "lost") lost.set(row.writer, (lost.get(row.writer) ?? 0) + 1);
  }
  const figures: WriterFigure[] = [];
  list.writers.forEach((writer, index) => {
    if (writer.certificates === 0) return;
    const share = writer.misses / writer.certificates;
    if (writer.misses < WORSE_MIN || share - average < WORSE_BY) return;
    const heardMillis = heard(writer.identity);
    const quiet = heardMillis !== undefined && (heardMillis === null || nowMillis - heardMillis > NO_GOSSIP_AFTER_MILLIS);
    figures.push({
      writer,
      share,
      lost: lost.get(index) ?? 0,
      kind: quiet ? "no-gossip" : "worse",
      heardMillis: heardMillis ?? null,
    });
  });
  return figures.sort(
    (a, b) => WRITER_KINDS.indexOf(a.kind) - WRITER_KINDS.indexOf(b.kind) || b.share - a.share,
  );
}

export function writerKinds(figures: WriterFigure[]): Record<WriterKind, number> {
  const kinds: Record<WriterKind, number> = { worse: 0, "no-gossip": 0 };
  for (const figure of figures) kinds[figure.kind] += 1;
  return kinds;
}

export function leftUsOutLine(list: MissList): string {
  const average = averageLeftOut(list);
  if (average === null) return "none read yet this epoch";
  return `${count(list.rows.length)} of ${count(list.rewarded)} left us out · ${percent(average, 1)} on average`;
}
