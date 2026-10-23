import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { count, shortKey } from "../format";
import {
  GAP_BIN,
  MEDIAN_BIN,
  axisMax,
  binOf,
  binRange,
  foldBins,
  leadingLine,
  place,
  tally,
  stackedBins,
  trendShape,
  windowLabel,
} from "../handoff";
import type { HandoffBand, HandoffNow, HandoffSummary, HandoffTrend, LeaderFigures } from "../types";
import { useStore } from "../useStore";
import { Explain, Fold } from "./primitives";

type Tone = "plain" | "late" | "ours";

function span(band: HandoffBand, max: number): { left: string; width: string } {
  const from = place(band.p25, max);
  return { left: `${from}%`, width: `${place(band.p75, max) - from}%` };
}

/** What every strip draws behind its own marks: the cluster band, a slot, and this handoff. */
function Backdrop({
  cluster,
  slotMillis,
  max,
  gap,
  tone,
  slotLabel,
}: {
  cluster: HandoffBand | null;
  slotMillis: number | null;
  max: number;
  gap: number | null;
  tone: Tone;
  slotLabel?: boolean;
}) {
  return (
    <>
      {cluster && <i className="handoff-band" style={span(cluster, max)} />}
      {slotMillis !== null && (
        <i className="handoff-slot-line" style={{ left: `${place(slotMillis, max)}%` }}>
          {slotLabel && <span>avg slot</span>}
        </i>
      )}
      {gap !== null && (
        <i className={`handoff-cur-line${tone === "plain" ? "" : ` is-${tone}`}`} style={{ left: `${place(gap, max)}%` }} />
      )}
    </>
  );
}

function Strip({
  kind,
  caption,
  label,
  role = "img",
  children,
}: {
  kind: "hist" | "leaders" | "now";
  caption: string;
  label: string;
  role?: "img" | "group";
  children: ReactNode;
}) {
  return (
    <div className={`handoff-strip is-${kind}`} role={role} aria-label={label}>
      {children}
      <span className="handoff-strip-cap" aria-hidden="true">
        {caption}
      </span>
    </div>
  );
}

function Bars({ values, className, current }: { values: number[]; className: string; current?: number }) {
  const top = Math.max(1, ...values);
  return (
    <div className={className} aria-hidden="true">
      {values.map((value, index) => (
        <i
          key={index}
          className={index === current ? "is-current" : undefined}
          style={{ height: `${(value / top) * 100}%` }}
        />
      ))}
    </div>
  );
}

/** Settled leaders by median, late ones stacked on top in orange; the current leader's part is lit. */
function LeaderBars({
  onTime,
  late,
  current,
  currentLate,
}: {
  onTime: number[];
  late: number[];
  current?: number;
  currentLate: boolean;
}) {
  const bins = useMemo(() => stackedBins(onTime, late), [onTime, late]);
  return (
    <div className="handoff-lead-bars" aria-hidden="true">
      {bins.map((bin, index) => (
        <span key={index} className={index === current ? (currentLate ? "is-current-late" : "is-current") : undefined}>
          <i className="is-on-time" style={{ height: `${bin.onTime}%` }} />
          <i className="is-late" style={{ height: `${bin.late}%` }} />
        </span>
      ))}
    </div>
  );
}

/** A button over each bin, across the strip's height, to list that bin's leaders. */
function PickLayer({
  count: bins,
  picked,
  onPick,
}: {
  count: number;
  picked: number | null;
  onPick: (index: number) => void;
}) {
  return (
    <div className="handoff-pick">
      {Array.from({ length: bins }, (_, index) => (
        <button
          key={index}
          type="button"
          className={index === picked ? "is-picked" : undefined}
          aria-pressed={index === picked}
          aria-label={`Leaders at ${binRange(index, bins, MEDIAN_BIN).label} ms`}
          onClick={() => onPick(index)}
        />
      ))}
    </div>
  );
}

function NowMarks({ now, max }: { now: HandoffNow | null; max: number }) {
  if (now === null) return null;
  if (now.band !== null) {
    return <i className={`handoff-now-band${now.late ? " is-late" : ""}`} style={span(now.band, max)} />;
  }
  return (
    <>
      {now.gaps.map((gap, index) => (
        <i key={index} className="handoff-now-tick" style={{ left: `${place(gap, max)}%` }} />
      ))}
    </>
  );
}

/** A leader's name, shortened before the country code is. */
function Who({ name, country }: { name: string; country: string | null }) {
  return (
    <span className="handoff-who">
      <span className="handoff-who-name">{name}</span>
      {country && <span className="country-code">{country}</span>}
    </span>
  );
}

function Leading({
  now,
  name,
  country,
  ours,
}: {
  now: HandoffNow | null;
  name: string | null;
  country: string | null;
  ours: boolean;
}) {
  const line = leadingLine(now);
  const className = ["card", "handoff-leading", now?.late && "is-late", ours && "is-ours"].filter(Boolean).join(" ");
  return (
    <section className={className}>
      <div className="handoff-leading-label">Leading now</div>
      <div className="handoff-leading-name">
        {now === null ? "—" : <Who name={`${name}${ours ? " (ours)" : ""}`} country={country} />}
      </div>
      <div className="handoff-leading-figure">
        {now?.gap != null ? `${count(now.gap)} ms` : "—"}
        <small>this handoff</small>
      </div>
      <div className="handoff-leading-sub">
        {line.kind === "settled" ? (
          <>
            {line.usual}, <span className={line.isLate ? "tone-warn" : undefined}>{line.late}</span>
          </>
        ) : line.kind === "unjudged" ? (
          `${line.usual}, not judged`
        ) : line.kind === "few" ? (
          line.text
        ) : (
          "—"
        )}
      </div>
    </section>
  );
}

function LateRow({
  name,
  country,
  median,
  late,
  current,
  ours,
  onTime,
}: {
  name: string;
  country: string | null;
  median: string;
  late: ReactNode;
  current?: boolean;
  ours?: boolean;
  /** A median in plain text, for a leader not late. */
  onTime?: boolean;
}) {
  const className = ["handoff-late-row", current && "is-current", ours && "is-ours"].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <span className="handoff-late-name">
        <Who name={name} country={country} />
      </span>
      <span className={`handoff-late-median${onTime ? " is-on-time" : ""}`}>{median}</span>
      <span className="handoff-late-count">{late}</span>
    </div>
  );
}

/** Our own row, under either list. */
function OursRow({ summary, name, country }: { summary: HandoffSummary | null; name: string; country: string | null }) {
  const ours = summary?.ours;
  const share =
    ours === undefined
      ? "—"
      : ours.p50 === null
        ? `${count(ours.n)} only`
        : ours.judged
          ? tally(ours.over, ours.n)
          : "—";
  return (
    <LateRow
      name={`${name} (ours)`}
      country={country}
      median={ours?.p50 != null ? `${count(ours.p50)} ms` : "—"}
      late={
        <Explain text="Handoffs above the p75 of the leader's country." className="is-leftward">
          {share}
        </Explain>
      }
      ours
    />
  );
}

/** The leaders in a picked bin of the leaders strip, in place of the late list. */
function BinCard({
  label,
  rows,
  current,
  onBack,
  summary,
  oursName,
  oursCountry,
  nameOf,
  countryOf,
}: {
  label: string;
  rows: LeaderFigures[] | null;
  current: string | null;
  onBack: () => void;
  summary: HandoffSummary | null;
  oursName: string;
  oursCountry: string | null;
  nameOf: (key: string) => string;
  countryOf: (key: string) => string | null;
}) {
  return (
    <section className="card handoff-late-card">
      <div className="card-head">
        <h3 className="card-title">Leaders at {label} ms</h3>
        <span className="card-aside">
          {rows === null ? "—" : count(rows.length)} ·{" "}
          <button type="button" className="handoff-back" onClick={onBack}>
            back to late
          </button>
        </span>
      </div>
      <div className="handoff-late-scroll" tabIndex={0} aria-label={`Leaders at ${label} ms`}>
        <div className="handoff-late-row is-head" aria-hidden="true">
          <span>leader</span>
          <span>median</span>
          <span>p25–p75</span>
        </div>
        {rows === null ? (
          <div className="handoff-late-row is-empty">—</div>
        ) : rows.length === 0 ? (
          <div className="handoff-late-row is-empty">No settled leader here now</div>
        ) : (
          rows.map((leader) => (
            <LateRow
              key={leader.leader}
              name={nameOf(leader.leader)}
              country={leader.country ?? countryOf(leader.leader)}
              median={`${count(leader.p50)} ms`}
              late={`${leader.p25}–${leader.p75}`}
              current={leader.leader === current}
              onTime={!leader.late}
            />
          ))
        )}
      </div>
      <OursRow summary={summary} name={oursName} country={oursCountry} />
    </section>
  );
}

function LateCard({
  summary,
  current,
  oursName,
  oursCountry,
  nameOf,
  countryOf,
}: {
  summary: HandoffSummary | null;
  current: string | null;
  oursName: string;
  oursCountry: string | null;
  nameOf: (key: string) => string;
  countryOf: (key: string) => string | null;
}) {
  return (
    <section className="card handoff-late-card">
      <div className="card-head">
        <h3 className="card-title">
          <Explain text="Leaders whose p25 gap is 10 ms over the p75 of their country's leaders.">
            Late for their country
          </Explain>
        </h3>
        <span className="card-aside">
          {summary ? (
            <>
              {count(summary.late_count)} late ·{" "}
              <Explain text="Leaders whose country is unknown or has fewer than three settled leaders." className="is-leftward">
                {count(summary.unjudged)} not judged
              </Explain>
            </>
          ) : (
            "—"
          )}
        </span>
      </div>
      <div className="handoff-late-scroll" tabIndex={0} aria-label="Leaders late for their country">
        {summary === null ? (
          <div className="handoff-late-row is-empty">—</div>
        ) : summary.late.length === 0 ? (
          <div className="handoff-late-row is-empty">No leader is late for its country</div>
        ) : (
          summary.late.map((leader) => (
            <LateRow
              key={leader.leader}
              name={nameOf(leader.leader)}
              country={leader.country ?? countryOf(leader.leader)}
              median={`${count(leader.p50)} ms`}
              late={tally(leader.over, leader.n)}
              current={leader.leader === current}
            />
          ))
        )}
      </div>
      <OursRow summary={summary} name={oursName} country={oursCountry} />
    </section>
  );
}

const TREND_WIDTH = 1000;
const TREND_HEIGHT = 44;

/** The last hour of the minute's mean, under the gap axis, on its own time axis. */
function Trend({ trend, minute }: { trend: HandoffTrend | null; minute: number | null }) {
  const shape = useMemo(() => (trend ? trendShape(trend, TREND_WIDTH, TREND_HEIGHT) : null), [trend]);
  const label = shape?.range
    ? `The 60 second mean gap over the last hour, ${shape.range[0]} to ${shape.range[1]} ms`
    : "No handoffs in the last hour yet";
  return (
    <div className="handoff-trend">
      <div className="handoff-trend-head">
        <span>60 s mean, last hour</span>
        <span>
          now <b>{minute !== null ? `${count(minute)} ms` : "—"}</b> · hour{" "}
          <b>{shape?.range ? `${shape.range[0]}–${shape.range[1]}` : "—"}</b>
        </span>
      </div>
      <svg viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {shape?.bands.map((band, index) => <path key={index} className="handoff-trend-band" d={band} />)}
        {shape?.median != null && (
          <line className="handoff-trend-median" x1={0} x2={TREND_WIDTH} y1={shape.median} y2={shape.median} />
        )}
        {shape && <path className="handoff-trend-line" d={shape.line} />}
      </svg>
      <div className="handoff-trend-x" aria-hidden="true">
        <span>−60 min</span>
        <span>dashed: hour median {trend?.hour_p50 != null ? `${count(trend.hour_p50)} ms` : "—"}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function Key() {
  return (
    <div className="handoff-key">
      <span>
        <i className="handoff-key-band" aria-hidden="true" />
        cluster p25–p75
      </span>
      <span>
        <i className="handoff-key-bar" aria-hidden="true" />
        leaders by median
      </span>
      <span>
        <i className="handoff-key-dot" aria-hidden="true" />
        late for its country
      </span>
      <span>
        <i className="handoff-key-own" aria-hidden="true" />
        this leader's p25–p75
      </span>
      <span>
        <i className="handoff-key-line" aria-hidden="true" />
        this handoff
      </span>
    </div>
  );
}

export function HandoffCard(): ReactElement {
  const store = useStore();
  const summary = store.get("summary", "handoff") ?? null;
  const now = store.get("summary", "handoff_now") ?? null;
  const oursKey = store.get("summary", "identity_key") ?? null;
  const slotNanos = store.get("summary", "observed_slot_duration_nanos") ?? store.get("summary", "estimated_slot_duration_nanos");
  const slotMillis = slotNanos ? slotNanos / 1e6 : null;
  const max = axisMax(slotMillis);
  const named = summary !== null && summary.late.length > 0;
  // Late leaders are rarely in gossip's own names, so the cluster's table is fetched once.
  useEffect(() => {
    if (named) void store.loadDisplays().catch(() => {});
  }, [store, named]);

  const nameOf = (key: string) => store.nameOf(key) ?? shortKey(key, 4, 4);
  const countryOf = (key: string) => store.countryOf(key);
  const cluster = summary?.cluster ?? null;
  const ours = now !== null && now.leader === oursKey;
  const tone: Tone = ours ? "ours" : now?.late ? "late" : "plain";
  const gap = now?.gap ?? null;
  const gaps = useMemo(() => (summary ? foldBins(summary.gaps, GAP_BIN, max) : []), [summary, max]);
  const medians = useMemo(() => (summary ? foldBins(summary.medians, MEDIAN_BIN, max) : []), [summary, max]);
  const lateMedians = useMemo(
    () => (summary ? foldBins(summary.late_medians, MEDIAN_BIN, max) : []),
    [summary, max],
  );
  const currentBin = now?.band != null ? binOf(now.band.p50, MEDIAN_BIN, Math.max(1, medians.length)) : undefined;
  const lateCount = summary?.late_count ?? null;
  const [picked, setPicked] = useState<number | null>(null);
  const [binLeaders, setBinLeaders] = useState<LeaderFigures[] | null>(null);
  const pickedRange = picked === null ? null : binRange(picked, Math.max(1, medians.length), MEDIAN_BIN);
  const from = pickedRange?.from ?? null;
  const to = pickedRange?.to ?? null;
  // Asked again with each summary, every ten seconds, while a bin stays picked.
  useEffect(() => {
    if (picked === null) {
      setBinLeaders(null);
      return;
    }
    let live = true;
    store
      .request("handoff.bin", { from, to })
      .then((rows) => {
        if (live) setBinLeaders(rows ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [store, picked, from, to, summary]);

  const fold = (
    <>
      <b className="handoff-fig is-ms">{now?.minute_mean != null ? `${count(now.minute_mean)} ms` : "—"}</b>{" "}
      <Explain text="Mean gap over the last minute from one leader's last block filling here to the next leader's first shred arriving here.">
        between leaders
      </Explain>{" "}
      over the last minute, <b className="handoff-fig">{lateCount === null ? "—" : count(lateCount)}</b>{" "}
      {lateCount === 1 ? "leader late for its country" : "leaders late for their country"}
    </>
  );
  const bandText = cluster ? `, cluster p25 ${cluster.p25} ms to p75 ${cluster.p75} ms` : "";
  const settled = summary ? count(summary.settled) : "—";

  return (
    <Fold id="handoff" title="Leader handoff" summary={fold}>
      <div className="handoff-wrap">
        <div className="handoff-body">
          <section className="card handoff-chart">
            <div className="card-head">
              <h3 className="card-title">
                Gap before each turn{summary ? `, ${windowLabel(summary.full, summary.since_millis, Date.now())}` : ""}
              </h3>
              <span className="card-aside">{settled} leaders with 10+ handoffs</span>
            </div>
            <div className="handoff-axis">
              <Strip kind="hist" caption="all handoffs" label={`Histogram of handoff gaps${bandText}`}>
                <Backdrop cluster={cluster} slotMillis={slotMillis} max={max} gap={gap} tone={tone} slotLabel />
                {summary && <Bars values={gaps} className="handoff-hist" />}
              </Strip>
              <Strip
                kind="leaders"
                caption={summary ? `${settled} leaders by median` : "leaders by median"}
                label={`Settled leaders by median gap, ${lateCount ?? 0} late for their country; pick a bin to list its leaders`}
                role="group"
              >
                <Backdrop cluster={cluster} slotMillis={slotMillis} max={max} gap={gap} tone={tone} />
                {summary && (
                  <LeaderBars onTime={medians} late={lateMedians} current={currentBin} currentLate={now?.late ?? false} />
                )}
                {summary && (
                  <PickLayer
                    count={medians.length}
                    picked={picked}
                    onPick={(index) => setPicked((was) => (was === index ? null : index))}
                  />
                )}
              </Strip>
              <Strip
                kind="now"
                caption="leading now"
                label={now === null ? "No leader yet" : `This leader's handoffs, ${leadingLine(now).kind === "settled" ? "its own band" : "each one"}`}
              >
                <Backdrop cluster={cluster} slotMillis={slotMillis} max={max} gap={gap} tone={tone} />
                <NowMarks now={now} max={max} />
              </Strip>
              <div className="handoff-x" aria-hidden="true">
                <span style={{ left: 0, transform: "none" }}>0</span>
                <span style={{ left: `${place(100, max)}%` }}>100</span>
                <span style={{ left: `${place(200, max)}%` }}>200</span>
                <span style={{ left: "100%", transform: "translateX(-100%)" }}>{max} ms</span>
              </div>
            </div>
            <Trend trend={summary?.trend ?? null} minute={now?.minute_mean ?? null} />
            <Key />
            <div className="handoff-foot">
              Each gap runs from the previous block filling here to the next leader's first shred arriving here, so it
              includes the leader's distance from us.
            </div>
          </section>
          <div className="handoff-side">
            <Leading
              now={now}
              name={now === null ? null : nameOf(now.leader)}
              country={now === null ? null : (now.country ?? countryOf(now.leader))}
              ours={ours}
            />
            {pickedRange ? (
              <BinCard
                label={pickedRange.label}
                rows={binLeaders}
                current={now?.leader ?? null}
                onBack={() => setPicked(null)}
                summary={summary}
                oursName={oursKey ? nameOf(oursKey) : "ours"}
                oursCountry={summary?.ours.country ?? (oursKey ? countryOf(oursKey) : null)}
                nameOf={nameOf}
                countryOf={countryOf}
              />
            ) : (
              <LateCard
                summary={summary}
                current={now?.leader ?? null}
                oursName={oursKey ? nameOf(oursKey) : "ours"}
                oursCountry={summary?.ours.country ?? (oursKey ? countryOf(oursKey) : null)}
                nameOf={nameOf}
                countryOf={countryOf}
              />
            )}
          </div>
        </div>
      </div>
    </Fold>
  );
}
