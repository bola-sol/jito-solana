
import { count, percent } from "./format";
import type { WrittenList, WrittenRow } from "./types";

export const WORSE_BY = 0.05;

export const WORSE_MIN = 10;

export const MISSING_EVERYWHERE = 0.9;

export type WrittenKind = "worse" | "missing";

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
    if (everywhere !== null && everywhere >= MISSING_EVERYWHERE) {
      figures.push({ row, ours, everywhere, kind: "missing" });
    } else if (
      ours !== null &&
      everywhere !== null &&
      row.left_out_of_ours >= WORSE_MIN &&
      ours - everywhere >= WORSE_BY
    ) {
      figures.push({ row, ours, everywhere, kind: "worse" });
    }
  }
  return figures.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "worse" ? -1 : 1;
    return a.kind === "worse" ? gap(b) - gap(a) : (b.everywhere ?? 0) - (a.everywhere ?? 0);
  });
}

export function writtenKinds(figures: WrittenFigure[]): Record<WrittenKind, number> {
  const kinds: Record<WrittenKind, number> = { worse: 0, missing: 0 };
  for (const figure of figures) kinds[figure.kind] += 1;
  return kinds;
}

/** The share that carried everyone certificates usually pay. */
export function writtenLine(list: WrittenList): string {
  const { certificates, carried_all } = list;
  if (certificates === 0) return "none written yet this epoch";
  return `${count(certificates)} written · ${percent(carried_all / certificates, 1)} carried everyone`;
}
