import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { blockStamp, buildLabel, count, shortKey } from "../format";
import {
  leftOutMost,
  leftOutText,
  MISS_PLACES,
  placeExplain,
  validatorLabel,
  voteText,
  writerSummary,
} from "../misses";
import type { MissList, MissPlace, MissRow, MissValidator, MissWriter } from "../types";
import { useStore } from "../useStore";
import { Copyable } from "./Copyable";

/** Every vote of this epoch a certificate left out, one a row, newest first,
 *  the legend filtering to one place. Explanations go on one line under the
 *  legend rather than in bubbles, which a scrolling table would clip. Asked
 *  for when opened rather than pushed: a few kilobytes on a good node and far
 *  more on a bad one. */
export function MissesPanel({ onClose }: { onClose: () => void }): ReactElement {
  const store = useStore();
  const participation = store.get("summary", "vote_participation");
  const [list, setList] = useState<MissList | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<MissPlace | null>(null);
  /** What the pointer is on, shown on the line; the filtered place's sentence otherwise. */
  const [hint, setHint] = useState<string | null>(null);
  /** The row unfolded to name who else its certificate left out. */
  const [opened, setOpened] = useState<number | null>(null);
  const panel = useRef<HTMLElement>(null);

  // On a phone the section opens below two more cards, out of sight.
  useEffect(() => {
    panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  // Asked for on open and on the refresh control; a reply that lands after
  // the panel closed is dropped.
  const live = useRef(true);
  const load = useCallback(() => {
    setLoading(true);
    store.request<MissList>("summary", "misses", {}).then(
      (got) => {
        if (!live.current) return;
        setList(got);
        setFailed(false);
        setLoading(false);
      },
      () => {
        if (!live.current) return;
        setFailed(true);
        setLoading(false);
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

  const counts = new Map<MissPlace, number>();
  for (const row of list?.rows ?? []) counts.set(row.place, (counts.get(row.place) ?? 0) + 1);
  const summary = list ? writerSummary(list) : null;
  const leftOut = list ? leftOutMost(list) : null;
  const shown = (list?.rows ?? []).filter((row) => filter === null || row.place === filter);
  const sentence = (place: MissPlace) => (participation ? placeExplain(place, participation) : place);

  return (
    <section className="misses-panel" aria-label="Votes not rewarded this epoch" ref={panel}>
      <div className="misses-panel-head">
        <h2>
          Votes not rewarded this epoch
          {list && `, ${count(list.rows.length)} of ${count(list.rewarded)}`}
        </h2>
        <span className="misses-panel-controls">
          <button type="button" className="misses-close" onClick={load} disabled={loading}>
            {loading ? "reading…" : "↻ refresh"}
          </button>
          <button type="button" className="misses-close" onClick={onClose}>
            × close
          </button>
        </span>
      </div>
      {list === null && (
        <div className="misses-summary">{failed ? "The list could not be read." : "Reading the list…"}</div>
      )}
      {list !== null && failed && <div className="misses-summary">The list could not be refreshed.</div>}
      {list && list.rows.length === 0 && <div className="misses-summary">Nothing this epoch.</div>}
      {list && list.rows.length > 0 && (
        <div className="misses misses-panel-body">
          {summary && <div className="misses-summary">{summary}</div>}
          {leftOut && <div className="misses-summary">{leftOut}</div>}
          <div className="misses-legend">
            {MISS_PLACES.filter((place) => counts.has(place)).map((place) => (
              <Hinted
                key={place}
                className={filter === place ? "is-on" : undefined}
                hint={sentence(place)}
                onHint={setHint}
                onPress={() => setFilter(filter === place ? null : place)}
              >
                <i className={`misses-swatch is-${place}`} />
                <span>
                  <b>{count(counts.get(place) ?? 0)}</b> {place}
                </span>
              </Hinted>
            ))}
            {filter && (
              <button type="button" className="produced-clear" onClick={() => setFilter(null)} aria-label="Clear filter">
                ×<span className="produced-clear-word"> clear</span>
              </button>
            )}
          </div>
          {/* Held open at its height, so the table does not move when it fills. */}
          <div className="misses-hint">{hint ?? (filter ? sentence(filter) : "")}</div>
          <div className="misses-table">
            <div className="misses-row is-head">
              <span>slot</span>
              <span>when</span>
              <span>place</span>
              <span>certificate writer, leader of slot + 8</span>
              <span>ip</span>
              <span>ranks paid</span>
              <span>
                <Hinted hint="Validators the certificate usually pays that it left out beside this one." onHint={setHint}>
                  left out
                </Hinted>
              </span>
              <span>
                <Hinted
                  hint="When votor sent this node's vote, after the slot's first shred where votor saw it, else after the parent was ready."
                  onHint={setHint}
                >
                  our vote
                </Hinted>
              </span>
            </div>
            {[...shown].reverse().map((row) => (
              <Row
                key={row.slot}
                row={row}
                writer={row.writer === null ? undefined : list.writers[row.writer]}
                validators={list.validators}
                ranks={list.ranks}
                open={opened === row.slot}
                onToggle={() => setOpened(opened === row.slot ? null : row.slot)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** A label whose sentence goes on the panel's line while the pointer is on
 *  it, or after a tap where there is no pointer. */
function Hinted({
  hint,
  onHint,
  onPress,
  className,
  children,
}: {
  hint: string;
  onHint: (hint: string | null) => void;
  onPress?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`explain-trigger${className ? ` ${className}` : ""}`}
      onPointerEnter={() => onHint(hint)}
      onPointerLeave={() => onHint(null)}
      onFocus={() => onHint(hint)}
      onBlur={() => onHint(null)}
      onClick={() => {
        onHint(hint);
        onPress?.();
      }}
    >
      {children}
    </button>
  );
}

/** One miss, and under it, when opened, who else its certificate left out. */
function Row({
  row,
  writer,
  validators,
  ranks,
  open,
  onToggle,
}: {
  row: MissRow;
  writer: MissWriter | undefined;
  validators: MissValidator[];
  ranks: number;
  open: boolean;
  onToggle: () => void;
}) {
  const build = writer ? buildLabel(writer.client ?? undefined, writer.version ?? undefined) : "";
  return (
    <>
      <div className="misses-row">
        <span className="misses-slot">
          <Copyable text={String(row.slot)} label={count(row.slot)} />
        </span>
        <span className="misses-when">{row.time_millis === null ? "—" : blockStamp(row.time_millis)}</span>
        <span className="misses-place">
          <i className={`misses-swatch is-${row.place}`} />
          {row.place}
        </span>
        <span className="misses-writer">
          {writer ? (
            <>
              <b>{writer.name ?? shortKey(writer.identity, 6, 5)}</b>
              <span>
                <Copyable text={writer.identity} label={shortKey(writer.identity, 8, 8)} className="misses-key" />
                {build && ` · ${build}`}
              </span>
            </>
          ) : (
            "—"
          )}
        </span>
        <span className="misses-ip">{writer?.ip ? <Copyable text={writer.ip} /> : "—"}</span>
        <span className="misses-paid">
          {count(row.paid_ranks)} of {count(ranks)}
        </span>
        <span className="misses-others">
          {row.others.length === 0 ? (
            leftOutText(0)
          ) : (
            <button type="button" className="misses-open" aria-expanded={open} onClick={onToggle}>
              {leftOutText(row.others.length)}
            </button>
          )}
        </span>
        <span className="misses-vote">{voteText(row.vote)}</span>
      </div>
      {open && (
        <div className="misses-out-list">
          {row.others.map((at) => {
            const validator = validators[at];
            if (!validator) return null;
            return (
              <span className="misses-out" key={at}>
                <b>{validatorLabel(validator)}</b>
                <Copyable text={validator.identity} label={shortKey(validator.identity, 6, 5)} />
                {validator.ip && <Copyable text={validator.ip} />}
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}
