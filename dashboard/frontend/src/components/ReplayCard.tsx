import { count, decimal, micros, percent } from "../format";
import { cpuRows, serialRows, verifyRows, type ReplayRow } from "../replay";
import type { ReplayWindow } from "../types";
import { useStore } from "../useStore";
import { Card, Explain, Stat } from "./primitives";

/**
 * What replay spends its time on, over the last few hundred slots.
 *
 * The only panel here describing work this validator does for every slot the
 * cluster produces rather than for the handful it leads. Everything else on
 * this page watches transactions arriving; this watches the node keep up with
 * everyone else's blocks, which is the half that decides whether it skips.
 *
 * Two resources, and they fail differently. Replay's own thread is serial: if
 * one slot's worth of work there exceeds one slot of time, no number of cores
 * will help. The thread time across the workers is capacity, and is measured
 * in cores rather than in percent because that is what it buys.
 *
 * Absent rather than empty when nothing has arrived. The point behind it is
 * sent with `datapoint_info!`, so a validator configured to log less than the
 * default never sends it, and a card of noughts would read as a node doing no
 * work rather than as a dashboard being told nothing.
 */
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

  return (
    <Card title="Replay">
      <div className="stat-grid stat-grid-tight">
        <Stat
          label="Replay thread"
          value={micros(serial)}
          explain="Time replay's own thread spent on the average slot: reading the block, verifying it, dispatching it, and completing the bank. These run one after another, so this is a real duration. It is also the serial limit. If it approaches the slot time, the node falls behind however many cores it has."
        />
        <Stat
          label="Of slot time"
          value={ofSlot === null ? "—" : percent(ofSlot, 1)}
          explain="That time as a share of how long a slot is actually lasting on this cluster, rather than of the nominal four hundred milliseconds. Replay works several slots at once, so this reads true at steady state and understates the pressure while the node is catching up."
        />
        <Stat
          label="CPU per slot"
          value={micros(cpu)}
          sub={cores === null ? undefined : `${decimal(cores, 2)} cores`}
          explain="Thread time one slot costs across every worker, and what that comes to in cores held busy. Exceeding the slot time is ordinary, and is what running on many cores looks like. Watch which way it moves over days rather than reading much into any one figure."
        />
        <Stat
          label="Worst slot"
          value={micros(replay.serial_peak)}
          explain="The worst single slot in the window, taken from each slot's own total. Adding up each figure's separate worst would describe a slot that never happened, because those maxima land on different slots."
        />
      </div>

      <Section
        title="Time spent on this slot"
        total={micros(serial)}
        rows={serialRows(replay)}
        explain="Replay's own thread, split into the three spans it spends there. Measured one after another, so these add up. Wall clock from first sight of the slot is far longer, but replay works several slots at once and votes and chooses forks in between, so nothing in that gap can be charged to this slot in particular."
      />

      <Section
        title="Verifying effort"
        note="relative only"
        rows={verifyRows(replay)}
        explain="Which part of verification costs more. These are sums of asynchronous jobs that overlap one another and each run across many threads, so together they come to several times the window they happened in and cannot be split out of it. Each is measured the same way as the others, so comparing them to each other is sound. Comparing them to the figures above is not."
      />

      <Section
        title="Execution, CPU time across threads"
        total={micros(cpu)}
        rows={cpuRows(replay)}
        explain="Thread time accumulated across the worker threads, so this is CPU rather than wall clock and normally exceeds the slot. The phases are sequential within a thread, so unlike the verification figures these partition cleanly and their total is the CPU one slot costs."
      />

      <div className="card-footnote">
        {count(replay.transactions)} transactions per slot · {replay.slots} slots
      </div>
    </Card>
  );
}

function Section({
  title,
  total,
  note,
  rows,
  explain,
}: {
  title: string;
  total?: string;
  note?: string;
  rows: ReplayRow[];
  explain: string;
}) {
  return (
    <div className="replay-section">
      <div className="replay-head">
        <Explain text={explain}>
          <span className="replay-title">{title}</span>
        </Explain>
        {note && <span className="replay-note">{note}</span>}
        {total && <span className="replay-total">{total}</span>}
      </div>
      {rows.map((row) => (
        <div key={row.key} className={`replay-row is-${row.kind}`}>
          <Explain text={row.explain} className="replay-label">
            {row.label}
          </Explain>
          <span className="replay-value">{micros(row.micros)}</span>
          <span className="replay-bar" aria-hidden="true">
            {/* Floored above nought so a row that cost anything at all leaves a
                mark rather than rounding away to an empty track. */}
            <span
              className="replay-fill"
              style={{ width: `${row.micros > 0 ? Math.max(1, row.share * 100) : 0}%` }}
            />
          </span>
          <span className="replay-share">
            {row.peak === undefined ? percent(row.share, 0) : `peak ${micros(row.peak)}`}
          </span>
        </div>
      ))}
    </div>
  );
}
