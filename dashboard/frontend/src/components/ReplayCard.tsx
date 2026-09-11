import { count, decimal, micros, percent } from "../format";
import { cpuRows, parts, serialRows, verifyRows, type ReplayPart, type ReplayRow } from "../replay";
import type { ReplayWindow } from "../types";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";

/** What replay spends its time on over the last few hundred slots: its own
 *  serial thread, and worker time in cores. Absent where the point never
 *  arrives, which is a validator logging below info. */
export function ReplayCard() {
  const store = useStore();
  const replay = store.get<ReplayWindow | null>("summary", "replay");
  const slotNanos = store.get<number>("summary", "observed_slot_duration_nanos");
  if (!replay) return null;

  const serial = replay.fetch + replay.confirming + replay.completing;
  const cpu =
    replay.execute + replay.load + replay.store + replay.program_cache + replay.checking + replay.other;

  // Against the slot time this cluster is actually keeping, not the nominal
  // one. The two drift apart under load, which is exactly when the figure is
  // being read.
  const slotMicros = slotNanos ? slotNanos / 1000 : null;
  const ofSlot = slotMicros ? serial / slotMicros : null;
  const cores = slotMicros ? cpu / slotMicros : null;

  const inside = parts(replay);

  return (
    <Card
      title="Replay"
      aside={`${count(replay.transactions)} tx/slot`}
      className="replay-body"
    >
      <div className="replay-figures">
        <Figure
          label="Replay thread"
          value={micros(serial)}
          sub="per slot"
          explain="Time replay's own thread spent on the average slot, which is the serial limit."
        />
        <Figure
          label="Of slot time"
          value={ofSlot === null ? "—" : percent(ofSlot, 1)}
          // Not "of 400 ms". The figure divides by what the cluster is keeping,
          // and the two part company under load, which is when it gets read.
          sub="of observed slot"
          explain="That time as a share of the observed slot time on this cluster."
        />
        <Figure
          label="CPU per slot"
          value={micros(cpu)}
          sub={cores === null ? "across threads" : `${decimal(cores, 2)} cores`}
          explain="Thread time one slot costs across every worker, and the cores that holds busy."
        />
        <Figure
          label="Worst slot"
          value={micros(replay.serial_peak)}
          sub={`last ${count(replay.slots)} slots`}
          explain="The worst single slot in the window, by its own total."
        />
      </div>

      <Section
        title="Time spent on this slot"
        total={`${micros(serial)} wall clock`}
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

      {/* The four figures that sit inside a phase rather than beside it. A
          segment for any of them would draw the same microseconds twice, so
          they are said in a sentence, where nesting is something prose can
          carry. */}
      <p className="replay-parts">
        Inside running programs: <Part part={inside.bytecode} />, <Part part={inside.serialising} />,{" "}
        <Part part={inside.deserialising} />. Of program loading,{" "}
        <Part part={inside.compiling} verb="is" />.
      </p>
    </Card>
  );
}

/** One of the four figures across the head of the card, each with an
 *  explanation of how it was measured. */
function Figure({
  label,
  value,
  sub,
  explain,
}: {
  label: string;
  value: string;
  sub: string;
  explain: string;
}) {
  return (
    <div className="replay-figure">
      <span className="replay-figure-label">
        <Explain text={explain}>{label}</Explain>
      </span>
      <span className="replay-figure-value">{value}</span>
      <span className="replay-figure-sub">{sub}</span>
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
            // Grown from a basis of nothing rather than given a width, so that
            // the gaps in a broken bar come out of the track before the shares
            // are shared out, instead of pushing the total past its width.
            style={{ flexGrow: row.share, ...segment(index) }}
          />
        ))}
      </div>

      <div className="replay-legend">
        {rows.map((row, index) => (
          <div key={row.key} className="replay-item">
            <i className="replay-swatch" style={segment(index)} aria-hidden="true" />
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

/** How dark a segment is, by its place in the order: a ramp from the accent
 *  towards the panel, stopping where the legend swatches lose contrast. */
const SEGMENT_MIX = [100, 82, 68, 57, 48, 40];

function segment(index: number) {
  const mix = SEGMENT_MIX[Math.min(index, SEGMENT_MIX.length - 1)];
  return { background: `color-mix(in srgb, var(--accent) ${mix}%, var(--panel-raised))` };
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
