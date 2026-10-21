import { useEffect, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { count, shortKey } from "../format";
import {
  GAP_BIN,
  MEDIAN_BIN,
  axisMax,
  binOf,
  dotBottom,
  foldBins,
  leadingLine,
  place,
  tally,
  stackLevels,
  windowLabel,
} from "../handoff";
import type { HandoffBand, HandoffNow, HandoffSummary, LateLeader } from "../types";
import { useStore } from "../useStore";
import { useWidth } from "../useWidth";
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
          {slotLabel && <span>1 slot</span>}
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
  children,
}: {
  kind: "hist" | "leaders" | "now";
  caption: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={`handoff-strip is-${kind}`} role="img" aria-label={label}>
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

function LateDots({
  late,
  max,
  width,
  current,
}: {
  late: readonly LateLeader[];
  max: number;
  width: number | null;
  current: string | null;
}) {
  const levels = useMemo(
    () => stackLevels(late.map((leader) => (place(leader.p50, max) / 100) * (width ?? 0))),
    [late, max, width],
  );
  if (width === null) return null;
  return (
    <>
      {late.map((leader, index) => (
        <i
          key={leader.leader}
          className={`handoff-dot${leader.leader === current ? " is-current" : ""}`}
          style={{ left: `${place(leader.p50, max)}%`, bottom: dotBottom(levels[index] ?? 0) }}
        />
      ))}
    </>
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
}: {
  name: string;
  country: string | null;
  median: string;
  late: ReactNode;
  current?: boolean;
  ours?: boolean;
}) {
  const className = ["handoff-late-row", current && "is-current", ours && "is-ours"].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <span className="handoff-late-name">
        <Who name={name} country={country} />
      </span>
      <span className="handoff-late-median">{median}</span>
      <span className="handoff-late-count">{late}</span>
    </div>
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
  const ours = summary?.ours;
  return (
    <section className="card handoff-late-card">
      <div className="card-head">
        <h3 className="card-title">
          <Explain text="Leaders whose p25 gap is above the cluster's p75.">Latest to arrive here</Explain>
        </h3>
        <span className="card-aside">{summary ? `${count(summary.late_count)} leaders` : "—"}</span>
      </div>
      <div className="handoff-late-scroll" tabIndex={0} aria-label="Leaders latest to arrive here">
        {summary === null ? (
          <div className="handoff-late-row is-empty">—</div>
        ) : summary.late.length === 0 ? (
          <div className="handoff-late-row is-empty">No leader usually arrives late here</div>
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
      <LateRow
        name={`${oursName} (ours)`}
        country={oursCountry}
        median={ours?.p50 != null ? `${count(ours.p50)} ms` : "—"}
        late={
          <Explain text="Handoffs with a gap above the cluster's p75." className="is-leftward">
            {ours === undefined ? "—" : ours.p50 != null ? tally(ours.over, ours.n) : `${count(ours.n)} only`}
          </Explain>
        }
        ours
      />
    </section>
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
        leader usually late here
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
  const leadersRef = useRef<HTMLDivElement>(null);
  const leadersWidth = useWidth(leadersRef);
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
  const currentBin =
    now?.band != null && !now.late ? binOf(now.band.p50, MEDIAN_BIN, Math.max(1, medians.length)) : undefined;
  const lateCount = summary?.late_count ?? null;

  const fold = (
    <>
      <b className="handoff-fig is-ms">{now?.minute_mean != null ? `${count(now.minute_mean)} ms` : "—"}</b>{" "}
      <Explain text="Mean gap over the last minute from one leader's last block filling here to the next leader's first shred arriving here.">
        between leaders
      </Explain>{" "}
      over the last minute, <b className="handoff-fig">{lateCount === null ? "—" : count(lateCount)}</b>{" "}
      {lateCount === 1 ? "leader usually arrives" : "leaders usually arrive"} late here
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
              <div ref={leadersRef}>
                <Strip
                  kind="leaders"
                  caption={summary ? `${settled} leaders by median` : "leaders by median"}
                  label={`Settled leaders by median gap, ${lateCount ?? 0} usually late here`}
                >
                  <Backdrop cluster={cluster} slotMillis={slotMillis} max={max} gap={gap} tone={tone} />
                  {summary && <Bars values={medians} className="handoff-lead-bars" current={currentBin} />}
                  {summary && <LateDots late={summary.late} max={max} width={leadersWidth} current={now?.leader ?? null} />}
                </Strip>
              </div>
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
            <LateCard
              summary={summary}
              current={now?.leader ?? null}
              oursName={oursKey ? nameOf(oursKey) : "ours"}
              oursCountry={summary?.ours.country ?? (oursKey ? countryOf(oursKey) : null)}
              nameOf={nameOf}
              countryOf={countryOf}
            />
          </div>
        </div>
      </div>
    </Fold>
  );
}
