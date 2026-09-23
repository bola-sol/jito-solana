import type { ReactElement } from "react";
import { count, decimal, micros, percent } from "../format";
import { cpuRows, parts, serialRows, verifyRows, type ReplayPart, type ReplayRow } from "../replay";
import { useStore } from "../useStore";
import { Explain, Fold } from "./primitives";

/** What replay spends its time on over the last few hundred slots: its own thread, and worker time
 *  in cores. Absent where the validator logs below info. */
export function ReplayCard(): ReactElement | null {
  const store = useStore();
  const replay = store.get("summary", "replay");
  const slotNanos = store.get("summary", "observed_slot_duration_nanos");
  if (!replay) return null;

  const serial = replay.fetch + replay.confirming + replay.completing;
  const cpu =
    replay.execute + replay.load + replay.store + replay.program_cache + replay.checking + replay.other;

  // Against the slot time the cluster is keeping, which drifts from nominal under load.
  const slotMicros = slotNanos ? slotNanos / 1000 : null;
  const ofSlot = slotMicros ? serial / slotMicros : null;
  const cores = slotMicros ? cpu / slotMicros : null;

  const inside = parts(replay);

  const summary = (
    <>
      replay thread <b>{micros(serial)}</b> a slot
      {ofSlot !== null && (
        <>
          , <b>{percent(ofSlot, 1)}</b> of slot time
        </>
      )}
      , worst <b>{micros(replay.serial_peak)}</b> in the last {count(replay.slots)};{" "}
      <b>{count(replay.transactions)}</b> transactions a slot
    </>
  );

  return (
    <Fold id="replay" title="Replay" summary={summary}>
      <div className="replay-body">
      <div className="replay-figures">
        <Figure
          label="replay's own thread, per slot"
          value={micros(serial)}
          explain="Time replay's own thread spent on the average slot, which is the serial limit."
        />
        <Figure
          // Not "of 400 ms". The figure divides by what the cluster is keeping,
          // and the two part company under load, which is when it gets read.
          label="of the observed slot time"
          value={ofSlot === null ? "—" : percent(ofSlot, 1)}
          explain="That time as a share of the observed slot time on this cluster."
        />
        <Figure
          label={cores === null ? "CPU per slot, across threads" : `CPU per slot, ${decimal(cores, 2)} cores`}
          value={micros(cpu)}
          explain="Thread time one slot costs across every worker, and the cores that holds busy."
        />
        <Figure
          label={`worst slot of the last ${count(replay.slots)}`}
          value={micros(replay.serial_peak)}
          explain="The worst single slot in the window, by its own total."
        />
      </div>

      <Section
        title="Time spent on this slot"
        total={`${micros(serial)} wall clock, three spans one after another`}
        rows={serialRows(replay)}
        explain="Replay's own thread, split into three spans that run one after another."
      />

      <Section
        title="Verifying effort"
        total="relative shares only, no total"
        // Segments held apart: the three overlap and are not parts of a whole.
        broken
        rows={verifyRows(replay)}
        explain="Sums of overlapping jobs across many threads. Comparable with each other, not with the figures above."
      />

      <Section
        title="Execution"
        total={`${micros(cpu)} CPU across threads`}
        rows={cpuRows(replay)}
        explain="CPU time across the worker threads. The phases partition, so they add up to what one slot costs."
      />

      {/* The figures inside a phase are said in a sentence, since a segment would draw them twice.
          */}
      <p className="replay-parts">
        Inside running programs: <Part part={inside.bytecode} />, <Part part={inside.serialising} />,{" "}
        <Part part={inside.deserialising} />. Of program loading,{" "}
        <Part part={inside.compiling} verb="is" />.
      </p>
      </div>
    </Fold>
  );
}

/** One of the four figures across the head of the section: the value, then
 *  what it is, with an explanation of how it was measured. */
function Figure({
  label,
  value,
  explain,
}: {
  label: string;
  value: string;
  explain: string;
}) {
  return (
    <div className="replay-figure">
      <span className="replay-figure-value">{value}</span>
      <span className="replay-figure-label">
        <Explain text={explain}>{label}</Explain>
      </span>
    </div>
  );
}

/** One section: a bar cut into its phases, and the legend that names them. */
function Section({
  title,
  total,
  broken,
  rows,
  explain,
}: {
  title: string;
  total: string;
  /** Segments held apart, for figures that do not partition a whole. */
  broken?: boolean;
  rows: ReplayRow[];
  explain: string;
}) {
  return (
    <div className="replay-section">
      <div className="replay-head">
        <Explain text={explain}>
          <span className="replay-title">{title}</span>
        </Explain>
        <span className="replay-total">{total}</span>
      </div>

      <div className={`replay-bar${broken ? " is-broken" : ""}`} aria-hidden="true">
        {rows.map((row, index) => (
          <i
            key={row.key}
            className={`is-${index + 1}`}
            // Grown from nothing, so a broken bar's gaps come out of the track before the shares.
            style={{ flexGrow: row.share }}
          />
        ))}
      </div>

      <div className="replay-legend">
        {rows.map((row, index) => (
          <div key={row.key} className="replay-item">
            <i className={`replay-swatch is-${index + 1}`} aria-hidden="true" />
            <Explain text={row.explain} className="replay-name">
              {row.label}
            </Explain>
            <span className="replay-value">{micros(row.micros)}</span>
            <span className="replay-share">{percent(row.share, 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One nested figure, named in the sentence under the card. */
function Part({ part, verb }: { part: ReplayPart; verb?: string }) {
  return (
    <>
      <Explain text={part.explain}>{part.label}</Explain>
      {verb ? ` ${verb} ` : " "}
      {micros(part.micros)}
      {part.peak === undefined ? "" : `, peaking at ${micros(part.peak)}`}
    </>
  );
}
