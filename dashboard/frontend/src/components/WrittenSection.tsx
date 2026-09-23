import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { buildLabel, count, percent, shortKey } from "../format";
import type { MissList } from "../types";
import { useStore } from "../useStore";
import { writtenFigures, writtenKinds, writtenLine, type WrittenFigure, type WrittenKind } from "../written";
import { Copyable } from "./Copyable";

const LINE_TITLE =
  "Everyone is every validator paid in at least nine of ten of the epoch's certificates so far.";

const KIND_WORD: Record<WrittenKind, string> = {
  worse: "fare worse in ours",
  missing: "missing everywhere",
};

const KIND_TITLE: Record<WrittenKind, string> = {
  worse: "Left out of our certificates far more often than of everyone's.",
  missing: "Left out of nearly every certificate from any writer.",
};

/** What this node's certificates carried this epoch: one line, and on request
 *  the validators they left out more than the network did. Asked for with the
 *  page, through the miss list's request. */
export function WrittenSection(): ReactElement {
  const store = useStore();
  const [list, setList] = useState<MissList | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<WrittenKind | null>(null);

  // A reply that lands after the page is gone is dropped.
  const live = useRef(true);
  const load = useCallback(() => {
    store.request<MissList>("summary", "misses", {}).then(
      (got) => {
        if (!live.current) return;
        setList(got);
        setFailed(false);
      },
      () => {
        if (!live.current) return;
        setFailed(true);
      },
    );
  }, [store]);

  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, [load]);

  const figures = list ? writtenFigures(list) : [];
  const kinds = writtenKinds(figures);
  const shown = figures.filter((figure) => filter === null || figure.kind === filter);

  return (
    <section className="misses-panel written" aria-label="Our certificates this epoch">
      <div className="written-head">
        <b>Our certificates this epoch</b>
        {list === null && <span>{failed ? "could not be read" : "reading…"}</span>}
        {list !== null && <span title={LINE_TITLE}>{writtenLine(list)}</span>}
        {list !== null && (
          <span className="misses-legend written-legend">
            {(["worse", "missing"] as const)
              .filter((kind) => kinds[kind] > 0)
              .map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`explain-trigger${filter === kind ? " is-on" : ""}`}
                  title={KIND_TITLE[kind]}
                  onClick={() => setFilter(filter === kind ? null : kind)}
                >
                  <i className={`misses-swatch is-${kind}`} />
                  <span>
                    <b>{count(kinds[kind])}</b> {KIND_WORD[kind]}
                  </span>
                </button>
              ))}
          </span>
        )}
        {figures.length > 0 && (
          <button type="button" className="stat-trigger" onClick={() => setOpen(!open)}>
            {open ? "hide the list" : "show the list"}
          </button>
        )}
        <button type="button" className="misses-close" onClick={load}>
          ↻ refresh
        </button>
      </div>
      {open && list !== null && figures.length > 0 && (
        <div className="misses-table">
          <div className="written-row is-head">
            <span>validator</span>
            <span>ip</span>
            <span title="Our certificates this epoch that did not pay it.">left out of ours</span>
            <span>share</span>
            <span title="Certificates from any writer that did not pay it, as a share of all seen.">network-wide</span>
            <span title="Its share of ours as a bar, its share network-wide as the mark.">ours against the network</span>
          </div>
          {shown.map((figure) => (
            <WrittenRowView key={figure.row.identity} figure={figure} written={list.written.certificates} />
          ))}
        </div>
      )}
    </section>
  );
}

/** One validator: who, and how often our certificates and everyone's left it
 *  out. Module-level: a component defined in the render above would remount
 *  on every store tick. */
function WrittenRowView({ figure, written }: { figure: WrittenFigure; written: number }) {
  const { row, ours, everywhere, kind } = figure;
  const build = buildLabel(row.client ?? undefined, row.version ?? undefined);
  return (
    <div className="written-row">
      <span className="misses-writer">
        <b>{row.name ?? shortKey(row.identity, 6, 5)}</b>
        <span>
          <Copyable text={row.identity} label={shortKey(row.identity, 8, 8)} className="misses-key" />
          {build && ` · ${build}`}
        </span>
      </span>
      <span className="written-ip">{row.ip ? <Copyable text={row.ip} /> : "—"}</span>
      <span className="written-ours">
        {count(row.left_out_of_ours)} of {count(written)}
      </span>
      <span className="written-share">{percent(ours, 1)}</span>
      <span className="written-all">{percent(everywhere, 1)}</span>
      <span className="written-gap" aria-hidden="true">
        <i className={kind === "missing" ? "is-down" : undefined} style={{ width: `${Math.min(100, (ours ?? 0) * 100)}%` }} />
        <b style={{ left: `${Math.min(100, (everywhere ?? 0) * 100)}%` }} />
      </span>
    </div>
  );
}
