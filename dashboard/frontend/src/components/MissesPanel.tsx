import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
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
import { WriterName } from "./WriterName";

/** Explanations sit under the legend because a scrolling table clips bubbles. */
export function MissesPanel({ onClose }: { onClose: () => void }): ReactElement {
  const store = useStore();
  const participation = store.get("summary", "vote_participation");
  const [list, setList] = useState<MissList | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<MissPlace | null>(null);
  const [hint, setHint] = useState<string | null>(null);
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
    store.request("summary.misses", {}).then(
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

  const counts = useMemo(() => {
    const byPlace = new Map<MissPlace, number>();
    for (const row of list?.rows ?? []) byPlace.set(row.place, (byPlace.get(row.place) ?? 0) + 1);
    return byPlace;
  }, [list]);
  const summary = useMemo(() => (list ? writerSummary(list) : null), [list]);
  const leftOut = useMemo(() => (list ? leftOutMost(list) : null), [list]);
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
          {/* Keyed so a new filter starts again from the newest rows. */}
          <MissesTable key={filter ?? "all"} list={list} filter={filter} onHint={setHint} />
        </div>
      )}
    </section>
  );
}

/** Rows added each time the reader scrolls near the end of the table. */
const ROWS_PER_PAGE = 200;

/** Kept out of the panel's render, which runs on every store update; an epoch can hold thousands of rows. */
const MissesTable = memo(function MissesTable({
  list,
  filter,
  onHint,
}: {
  list: MissList;
  filter: MissPlace | null;
  onHint: (hint: string | null) => void;
}) {
  const [opened, setOpened] = useState<number | null>(null);
  const [limit, setLimit] = useState(ROWS_PER_PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const newestFirst = useMemo(
    () => list.rows.filter((row) => filter === null || row.place === filter).reverse(),
    [list.rows, filter],
  );
  const paged = newestFirst.length > ROWS_PER_PAGE;
  const more = limit < newestFirst.length;
  const toggle = useCallback((slot: number) => setOpened((was) => (was === slot ? null : slot)), []);

  // Observed again after each page, so a page that leaves the marker in view loads the next.
  useEffect(() => {
    const root = scroller.current;
    const marker = end.current;
    if (!more || !root || !marker) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setLimit((was) => was + ROWS_PER_PAGE);
      },
      { root, rootMargin: "0px 0px 400px 0px" },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [more, limit]);

  return (
    <div className={paged ? "misses-table is-paged" : "misses-table"} ref={scroller}>
      <div className="misses-row is-head">
        <span>slot</span>
        <span>when</span>
        <span>place</span>
        <span>certificate writer, leader of slot + 8</span>
        <span>ip</span>
        <span>ranks paid</span>
        <span>
          <Hinted hint="Validators the certificate usually pays that it left out beside this one." onHint={onHint}>
            left out
          </Hinted>
        </span>
        <span>
          <Hinted
            hint="When votor sent this node's vote, after the slot's first shred where votor saw it, else after the parent was ready."
            onHint={onHint}
          >
            our vote
          </Hinted>
        </span>
      </div>
      {newestFirst.slice(0, limit).map((row) => (
        <Row
          key={row.slot}
          row={row}
          writer={row.writer === null ? undefined : list.writers[row.writer]}
          validators={list.validators}
          ranks={list.ranks}
          open={opened === row.slot}
          onToggle={toggle}
        />
      ))}
      {more && <div ref={end} aria-hidden="true" />}
    </div>
  );
});

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

const Row = memo(function Row({
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
  onToggle: (slot: number) => void;
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
              <WriterName name={writer.name} identity={writer.identity} />
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
            <button type="button" className="misses-open" aria-expanded={open} onClick={() => onToggle(row.slot)}>
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
                {validator.delinquent && <span className="misses-out-delinquent">delinquent</span>}
                <Copyable text={validator.identity} label={shortKey(validator.identity, 6, 5)} />
                {validator.ip && <Copyable text={validator.ip} />}
              </span>
            );
          })}
        </div>
      )}
    </>
  );
});
