import { useEffect, useState, type ReactElement } from "react";
import { blockStamp, buildLabel, count, shortKey } from "../format";
import { leftOutText, MISS_PLACES, placeExplain, voteText, writerSummary } from "../misses";
import type { MissList, MissPlace, MissRow, MissWriter } from "../types";
import { useStore } from "../useStore";
import { Copyable } from "./Copyable";
import { Explain } from "./primitives";

/** Every vote of this epoch a certificate left out, one a row, newest first.
 *  Asked for when opened rather than pushed: a few kilobytes on a good node
 *  and far more on a bad one. */
export function MissesPanel({ onClose }: { onClose: () => void }): ReactElement {
  const store = useStore();
  const participation = store.get("summary", "vote_participation");
  const [list, setList] = useState<MissList | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    store.request<MissList>("summary", "misses", {}).then(
      (got) => {
        if (live) setList(got);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [store]);

  const counts = new Map<MissPlace, number>();
  for (const row of list?.rows ?? []) counts.set(row.place, (counts.get(row.place) ?? 0) + 1);
  const summary = list ? writerSummary(list) : null;

  return (
    <section className="misses-panel" aria-label="Votes not rewarded this epoch">
      <div className="misses-panel-head">
        <h2>
          Votes not rewarded this epoch
          {list && `, ${count(list.rows.length)} of ${count(list.rewarded)}`}
        </h2>
        <button type="button" className="misses-close" onClick={onClose}>
          × close
        </button>
      </div>
      {list === null && (
        <div className="misses-summary">{failed ? "The list could not be read." : "Reading the list…"}</div>
      )}
      {list && list.rows.length === 0 && <div className="misses-summary">Nothing this epoch.</div>}
      {list && list.rows.length > 0 && (
        <div className="misses misses-panel-body">
          {summary && <div className="misses-summary">{summary}</div>}
          <div className="misses-legend">
            {MISS_PLACES.filter((place) => counts.has(place)).map((place) => (
              <Explain key={place} text={participation ? placeExplain(place, participation) : place}>
                <i className={`misses-swatch is-${place}`} />
                <span>
                  <b>{count(counts.get(place) ?? 0)}</b> {place}
                </span>
              </Explain>
            ))}
          </div>
          <div className="misses-table">
            <div className="misses-row is-head">
              <span>slot</span>
              <span>when</span>
              <span>place</span>
              <span>certificate writer, leader of slot + 8</span>
              <span>ip</span>
              <span>ranks paid</span>
              <span>
                <Explain text="Validators the certificate usually pays that it left out beside this one.">
                  left out
                </Explain>
              </span>
              <span>
                <Explain text="When votor sent this node's vote, after the slot's first shred.">our vote</Explain>
              </span>
            </div>
            {[...list.rows].reverse().map((row) => (
              <Row
                key={row.slot}
                row={row}
                writer={row.writer === null ? undefined : list.writers[row.writer]}
                ranks={list.ranks}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ row, writer, ranks }: { row: MissRow; writer: MissWriter | undefined; ranks: number }) {
  const build = writer ? buildLabel(writer.client ?? undefined, writer.version ?? undefined) : "";
  return (
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
      <span className="misses-others">{leftOutText(row.others_out)}</span>
      <span className="misses-vote">{voteText(row.vote)}</span>
    </div>
  );
}
