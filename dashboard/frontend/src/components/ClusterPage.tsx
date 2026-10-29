import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  bandPaths,
  binLabel,
  chartWindowStart,
  clusterVerdict,
  epochThrough,
  gridlines,
  linePath,
  niceTop,
  percentText,
  skipBaseline,
  ticks,
  txNote,
  type TxView,
} from "../cluster";
import { count, duration, percent, release, solCompact } from "../format";
import type { ChartSeries, ChartShares, ClientShare, ClusterCharts, SkipChart, StakeByCountry } from "../types";
import { useNow } from "../useNow";
import { useStore } from "../useStore";
import { useWidth } from "../useWidth";
import { useHeight } from "../useHeight";
import { useMedia } from "../useMedia";
import { HandoffCard } from "./HandoffCard";
import { Card, Explain } from "./primitives";

const POLL_MS = 15_000;
const FIRST_POLL_MS = 1_000;

const HEIGHT = 120;
const HIST = 44;
const GUTTER = 38;
const TOP = 6;

/** A stall is judged only on a feed this close to live. */
const STALL_FEED_LAG_MS = 5_000;

const clock = (millis: number) =>
  new Date(millis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function fmt(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined) return "—";
  return digits > 0 ? value.toFixed(digits) : count(Math.round(value));
}

/** What a chart card draws, from a series or from a share per bin. */
interface ChartView {
  label: string;
  explain: string;
  unit: string;
  digits: number;
  p05: (number | null)[];
  p25: (number | null)[];
  p50: (number | null)[];
  p75: (number | null)[];
  p95: (number | null)[];
  spread: { p05: number; p50: number; p95: number };
  recent: number | null;
  floor: number;
  top: number;
  hist: number[];
  /** In place of p5 and p95, where those say nothing. */
  caption?: ReactNode;
  /** Too few readings yet; the card holds its place. */
  waiting?: boolean;
}

/** A chart with too few readings yet, so the grid keeps its shape. */
function waitingView(label: string, explain: string): ChartView {
  const none: null[] = [];
  return {
    label,
    explain,
    unit: "",
    digits: 0,
    p05: none,
    p25: none,
    p50: none,
    p75: none,
    p95: none,
    spread: { p05: 0, p50: 0, p95: 0 },
    recent: null,
    floor: 0,
    top: 1,
    hist: [],
    waiting: true,
  };
}

function seriesView(
  series: ChartSeries,
  label: string,
  explain: string,
  unit: string,
  digits: number,
): ChartView {
  return { ...series, label, explain, unit, digits };
}

function sharesView(shares: ChartShares): ChartView {
  const none = shares.shares.map(() => null);
  return {
    label: "Fast Finalization",
    explain: "Share of blocks whose footer carries the fast finalization certificate.",
    unit: "%",
    digits: 1,
    p05: none,
    p25: none,
    p50: shares.shares,
    p75: none,
    p95: none,
    spread: { p05: shares.share, p50: shares.share, p95: shares.share },
    recent: shares.recent,
    floor: shares.floor,
    top: 100,
    hist: [],
    caption: (
      <>
        <b>{count(shares.count)}</b> of <b>{count(shares.total)}</b> blocks
      </>
    ),
  };
}

/** The charts, asked for while the page is open; the server gathers them only then. */
function useClusterCharts(): ClusterCharts | null {
  const store = useStore();
  const [charts, setCharts] = useState<ClusterCharts | null>(null);
  // Asked once the socket is open, and again on each new one.
  const open = store.getConnection() === "open";
  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      store.request("cluster.charts", {}).then(
        (got) => {
          if (!live) return;
          if (got) setCharts(got);
          timer = setTimeout(load, got ? POLL_MS : FIRST_POLL_MS);
        },
        () => {
          if (live) timer = setTimeout(load, FIRST_POLL_MS);
        },
      );
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [store, open]);
  return charts;
}

/** Seconds since the finalized slot last moved, judged only on a live, connected feed. */
function useFinalizedStall(): number | null {
  const store = useStore();
  const finalized = store.get("summary", "finalized_slot");
  const [movedAt, setMovedAt] = useState(() => Date.now());
  useEffect(() => {
    setMovedAt(Date.now());
  }, [finalized]);
  const now = useNow(1_000);
  const lag = store.getFeedLag();
  if (finalized === undefined || store.getConnection() !== "open" || lag === null || lag > STALL_FEED_LAG_MS) {
    return null;
  }
  return Math.max(0, (now - movedAt) / 1000);
}

function XAxis({ from, to }: { from: number; to: number }) {
  return (
    <div className="cl-x" aria-hidden="true">
      <span>{clock(from)}</span>
      <span>{clock(from + (to - from) / 2)}</span>
      <span>now</span>
    </div>
  );
}

function ChartCard({
  view,
  from,
  to,
  title,
  controls,
  note,
  className,
  fill,
}: {
  view: ChartView;
  from: number;
  to: number;
  /** In place of the view's own label, for a card showing one of several. */
  title?: ReactNode;
  /** Beside the title, as the tabs of a merged card. */
  controls?: ReactNode;
  /** After the spread on the figure line. */
  note?: string;
  className?: string;
  /** Takes its height from the card, as on the one-screen board. */
  fill?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box) ?? 360;
  const plot = Math.max(120, width - HIST - 8 - GUTTER);
  const measured = useHeight(box);
  const height = fill && measured !== null ? Math.max(40, Math.floor(measured - TOP)) : HEIGHT;
  const [hover, setHover] = useState<number | null>(null);
  const { floor, top, digits, unit } = view;
  const bins = view.p50.length;
  const x = (index: number) => ((index + 0.5) / bins) * plot;
  const y = (value: number) =>
    height - ((Math.min(Math.max(value, floor), top) - floor) / (top - floor || 1)) * height;
  const grid = view.waiting ? [] : gridlines(floor, top);
  const shape = useMemo(
    () => ({
      outer: bandPaths(view.p05, view.p95, x, y),
      inner: bandPaths(view.p25, view.p75, x, y),
      line: linePath(view.p50, x, y),
    }),
    // The scales follow from the view and the plot's width.
    [view, plot, height],
  );
  const histMax = Math.max(1, ...view.hist);
  const histStep = view.hist.length > 0 ? height / view.hist.length : 0;
  const at = hover === null ? null : from + ((hover + 0.5) / bins) * (to - from);

  return (
    <section className={`card cl-card${className ? ` ${className}` : ""}`}>
      <div className="card-head">
        <h2 className="card-title">{title ?? <Explain text={view.explain}>{view.label}</Explain>}</h2>
        {controls}
        <span className="card-aside">since {clock(from)}</span>
      </div>
      <div className="cl-figure">
        {view.waiting ? (
          <>
            <b>—</b>
            <span className="cl-spread">gathering readings</span>
          </>
        ) : hover !== null && at !== null ? (
          <>
            <b>
              {fmt(view.p50[hover], digits)}
              {unit}
            </b>
            <span className="cl-spread">
              {clock(at)}
              {view.p05[hover] !== null && view.p05[hover] !== undefined ? (
                <>
                  {" · "}
                  <b>
                    {fmt(view.p05[hover], digits)}–{fmt(view.p95[hover], digits)}
                  </b>{" "}
                  <span className="cl-label">p5–p95</span>
                </>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <b>
              {fmt(view.spread.p50, digits)}
              {unit}
            </b>
            <span className="cl-spread">
              {view.caption ?? (
                <>
                  <span className="cl-label cl-median-label">median ·</span>{" "}
                  <b>
                    {fmt(view.spread.p05, digits)}–{fmt(view.spread.p95, digits)}
                  </b>{" "}
                  <span className="cl-label">p5–p95</span>
                </>
              )}
            </span>
            {note && <span className="cl-note">{note}</span>}
            <span className="cl-recent">
              last 10 min{" "}
              <b>
                {fmt(view.recent, digits)}
                {view.recent !== null ? unit : ""}
              </b>
            </span>
          </>
        )}
      </div>
      <div className="cl-chart" ref={box}>
        <div className="cl-plot" style={{ width: plot }}>
          <svg
            width={plot}
            height={height}
            role="img"
            aria-label={`${view.label} since ${clock(from)}, median ${fmt(view.spread.p50, digits)}${unit}`}
            onMouseMove={(event) => {
              const left = event.currentTarget.getBoundingClientRect().left;
              setHover(Math.max(0, Math.min(bins - 1, Math.floor(((event.clientX - left) / plot) * bins))));
            }}
            onMouseLeave={() => setHover(null)}
          >
            {grid.map((tick) => (
              <line key={tick} className="cl-grid" x1={0} x2={plot} y1={y(tick)} y2={y(tick)} />
            ))}
            <line className="cl-base" x1={0} x2={plot} y1={height - 0.5} y2={height - 0.5} />
            {shape.outer.map((d, index) => (
              <path key={`o${index}`} className="cl-band-outer" d={d} />
            ))}
            {shape.inner.map((d, index) => (
              <path key={`i${index}`} className="cl-band-inner" d={d} />
            ))}
            {!view.waiting && (
              <line
                className="cl-median"
                x1={0}
                x2={plot}
                y1={y(view.spread.p50)}
                y2={y(view.spread.p50)}
              />
            )}
            <path className="cl-line" d={shape.line} />
            {hover !== null && <line className="cl-cross" x1={x(hover)} x2={x(hover)} y1={0} y2={height} />}
          </svg>
          {grid.map((tick) => (
            <span key={tick} className="cl-tick" style={{ top: y(tick) + TOP }}>
              {fmt(tick, Number.isInteger(tick) ? 0 : 1)}
            </span>
          ))}
        </div>
        <svg className="cl-hist" width={HIST} height={height} style={{ marginTop: TOP }} aria-hidden="true">
          {view.hist.map((n, index) =>
            (n / histMax) * HIST >= 1 ? (
              <rect
                key={index}
                x={0}
                y={height - (index + 1) * histStep + 0.5}
                width={(n / histMax) * HIST}
                height={Math.max(1, histStep - 1)}
              />
            ) : null,
          )}
        </svg>
      </div>
      <XAxis from={from} to={to} />
    </section>
  );
}

const TX_EXPLAIN = "Transactions per second over each run of twenty slots.";

const TX_VIEWS: { view: TxView; label: string }[] = [
  { view: "all", label: "All" },
  { view: "succeeded", label: "Succeeded" },
  { view: "failed", label: "Failed" },
];

/** All, succeeded and failed transactions as tabs of one card, each on its own scale. */
function TransactionsCard({ charts, fill }: { charts: ClusterCharts; fill?: boolean }) {
  const [view, setView] = useState<TxView>("all");
  const series = view === "all" ? charts.tps : view === "succeeded" ? charts.succeeded : charts.failed;
  const shown = useMemo(
    () => (series ? seriesView(series, "Transactions", TX_EXPLAIN, "", 0) : waitingView("Transactions", TX_EXPLAIN)),
    [series],
  );
  return (
    <ChartCard
      view={shown}
      from={charts.from_millis}
      to={charts.to_millis}
      className="cl-span-2"
      fill={fill}
      title={<Explain text={TX_EXPLAIN}>Transactions</Explain>}
      controls={
        <div className="toggle-group cl-tx-toggle" role="group" aria-label="Which transactions to show">
          {TX_VIEWS.map((entry) => (
            <button
              key={entry.view}
              type="button"
              aria-pressed={view === entry.view}
              onClick={() => setView(entry.view)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      }
      note={charts.failed_share === null || !series ? undefined : txNote(view, charts.failed_share)}
    />
  );
}

/** The board's leader rows and head, fixed in CSS so the rows that fit can be counted. */
const LEADER_ROW = 21;
const LEADER_HEAD = 20;

/** A leader's skip rate: nought plainly, else one decimal. */
const leaderShare = (value: number) => (value === 0 ? "0" : value.toFixed(1));

function SkipCard({ skips, through, fill }: { skips: SkipChart; through: number | null; fill?: boolean }) {
  const store = useStore();
  const figures = store.get("summary", "cluster_figures");
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box) ?? 360;
  const plot = Math.max(120, width - GUTTER);
  const measured = useHeight(box);
  const height = fill && measured !== null ? Math.max(40, Math.floor(measured - TOP)) : HEIGHT;
  const list = useRef<HTMLDivElement>(null);
  const listHeight = useHeight(list);
  const shown =
    fill && listHeight !== null
      ? Math.max(1, Math.floor((listHeight - LEADER_HEAD) / LEADER_ROW))
      : skips.leaders.length;
  const [hover, setHover] = useState<number | null>(null);
  const bins = skips.shares.length;
  const step = plot / Math.max(1, bins);
  const top = niceTop(Math.max(0, ...skips.shares.map((share) => share ?? 0)));
  const share = skips.slots > 0 ? (skips.skipped / skips.slots) * 100 : null;
  const y = (value: number) => height - (Math.min(value, top) / top) * height;
  const at =
    hover === null ? null : skips.from_millis + ((hover + 0.5) / bins) * (skips.to_millis - skips.from_millis);
  const spread = figures?.skip_rate ?? null;
  const hovered = hover === null ? null : (skips.shares[hover] ?? null);
  return (
    <section className="card cl-card cl-skip-card">
      <div className="card-head">
        <h2 className="card-title">
          <Explain text="The cluster's share of this epoch's settled slots skipped.">Skip Rate</Explain>
        </h2>
        <span className="card-aside">
          this epoch{through !== null ? `, ${Math.round(through * 100)}% through` : ""}
        </span>
      </div>
      <div className="cl-figure">
        {at !== null ? (
          <>
            <b>{hovered === null ? "—" : percentText(hovered)}</b>
            <span className="cl-spread">
              {clock(at)} · <span className="cl-label">of the cluster's slots</span>
            </span>
          </>
        ) : (
          <>
            <b>{share === null ? "—" : percentText(share)}</b>
            <span className="cl-spread">
              <span className="cl-label">of slots</span>
              {spread && (
                <span className="cl-per-leader">
                  {" · per leader "}
                  <b>
                    {leaderShare(spread.p05)}–{leaderShare(spread.p95)}%
                  </b>{" "}
                  <span className="cl-label">p5–p95</span>, <span className="cl-label">median</span>{" "}
                  <b>{leaderShare(spread.p50)}</b>
                </span>
              )}
            </span>
            <span className="cl-recent">
              <b>{count(skips.skipped)}</b> of {count(skips.slots)} slots
            </span>
          </>
        )}
      </div>
      <div className="cl-skip-body">
        <div className="cl-skip-main">
          <div className="cl-chart" ref={box}>
            <div className="cl-plot" style={{ width: plot }}>
              <svg
                width={plot}
                height={height}
                role="img"
                aria-label="Share of the cluster's slots skipped across the epoch"
                onMouseMove={(event) => {
                  const left = event.currentTarget.getBoundingClientRect().left;
                  setHover(Math.max(0, Math.min(bins - 1, Math.floor(((event.clientX - left) / plot) * bins))));
                }}
                onMouseLeave={() => setHover(null)}
              >
                {ticks(top).map((tick) => (
                  <line key={tick} className="cl-grid" x1={0} x2={plot} y1={y(tick)} y2={y(tick)} />
                ))}
                <line className="cl-base" x1={0} x2={plot} y1={height - 0.5} y2={height - 0.5} />
                {skips.shares.map((share, index) =>
                  share ? (
                    <rect
                      key={index}
                      className={`cl-skip${hover === index ? " is-hover" : ""}`}
                      x={index * step + 0.5}
                      y={y(share)}
                      width={Math.max(1, step - 1)}
                      height={height - y(share)}
                    />
                  ) : null,
                )}
              </svg>
              {ticks(top).map((tick) => (
                <span key={tick} className="cl-tick" style={{ top: y(tick) + TOP }}>
                  {Number.isInteger(tick) ? tick.toFixed(0) : tick.toFixed(1)}%
                </span>
              ))}
            </div>
          </div>
          <XAxis from={skips.from_millis} to={skips.to_millis} />
        </div>
        <div className="cl-leaders" ref={list}>
          <div className="cl-leaders-head">
            <span>{fill ? "most skipped, 20+ slots" : "most skipped this epoch, 20+ slots"}</span>
            <span>skipped</span>
          </div>
          {skips.leaders.length === 0 && <div className="cl-leader">none yet</div>}
          {skips.leaders.slice(0, shown).map((leader) => (
            <div key={leader.identity} className="cl-leader">
              <span className="handoff-who">
                <span className="handoff-who-name">{leader.name ?? `${leader.identity.slice(0, 4)}…${leader.identity.slice(-4)}`}</span>
                {leader.country && <span className="country-code">{leader.country}</span>}
              </span>
              <span className="cl-leader-n">
                {leader.skipped}/{leader.slots}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Where the epoch is, and the stretch of it the charts cover. */
function EpochLine({ charts }: { charts: ClusterCharts }) {
  const store = useStore();
  const epoch = store.get("epoch", "new");
  const slot = store.get("summary", "completed_slot");
  const remainingNanos = store.get("summary", "epoch_remaining_nanos");
  if (!epoch) return null;
  const through = epochThrough(slot ?? epoch.start_slot, epoch.start_slot, epoch.slots_in_epoch);
  const { skips } = charts;
  const windowStart = skips ? chartWindowStart(charts.from_millis, skips.from_millis, skips.to_millis, through) : null;
  return (
    <div className="cl-epoch">
      <span className="cl-epoch-name">
        Epoch <b>{count(epoch.epoch)}</b>
      </span>
      <div className="cl-epoch-bar" role="progressbar" aria-valuenow={Math.round(through * 100)}>
        <i className="cl-epoch-fill" style={{ width: `${through * 100}%` }} />
        {windowStart !== null && (
          <i
            className="cl-epoch-window"
            style={{ left: `${windowStart * 100}%`, width: `${Math.max(0, through - windowStart) * 100}%` }}
          />
        )}
      </div>
      <span className="cl-epoch-figures">
        <b>{Math.round(through * 100)}%</b> · <span className="cl-label">ends in</span>{" "}
        <b>{duration(remainingNanos === undefined ? undefined : remainingNanos / 1e6, 2)}</b>
      </span>
      {windowStart !== null && (
        <span className="cl-epoch-key">
          <i aria-hidden="true" />
          charts since {clock(charts.from_millis)}
        </span>
      )}
    </div>
  );
}

function Key({ bin, since }: { bin: string; since: number }) {
  return (
    <div className="cl-key">
      <span>
        <i className="cl-key-line" aria-hidden="true" />
        median of each {bin}
      </span>
      <span>
        <i className="cl-key-inner" aria-hidden="true" />
        p25–p75
      </span>
      <span>
        <i className="cl-key-outer" aria-hidden="true" />
        p5–p95
      </span>
      <span>
        <i className="cl-key-median" aria-hidden="true" />
        median since {clock(since)}
      </span>
      <span>
        <i className="cl-key-hist" aria-hidden="true" />
        distribution, at the right
      </span>
    </div>
  );
}

interface ShareRow {
  key: string;
  label: string;
  code?: string | null;
  ours: boolean;
  stake: number;
  detail: string;
}

function ShareList({
  title,
  rows,
  className,
  fill,
}: {
  title: string;
  rows: ShareRow[];
  className?: string;
  /** Scrolls within the card's height, each row's counts in its tooltip. */
  fill?: boolean;
}) {
  const total = rows.reduce((sum, row) => sum + row.stake, 0);
  return (
    <div className={`cl-share${className ? ` ${className}` : ""}`} style={fill ? { flexGrow: rows.length } : undefined}>
      <div className="cl-share-head">{title}</div>
      <div className="versions">
        {rows.map((row) => {
          const fraction = total === 0 ? 0 : row.stake / total;
          return (
            <div
              className={`version-row${row.ours ? " is-ours" : ""}`}
              key={row.key}
              title={fill ? row.detail : undefined}
            >
              <div className="version-name">
                {row.label}
                {row.code && <span className="country-code">{row.code}</span>}
                {row.ours && <span className="version-ours">ours</span>}
              </div>
              <div className="version-bar">
                <i style={{ width: `${Math.min(100, fraction * 100)}%` }} />
              </div>
              <div className="version-share">{percent(fraction, 1)}</div>
              <div className="version-count">{row.detail}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Stake by release beside the same stake by the client each node gossips. */
function VersionsCard({ clients, fill }: { clients: ClientShare[]; fill?: boolean }) {
  const store = useStore();
  const shares = store.get("summary", "versions");
  const ours = release(store.get("summary", "version"));
  const ourClient = store.get("summary", "client");
  if (!shares || shares.length === 0) return <Card title="Versions">waiting for data…</Card>;
  const byRelease: ShareRow[] = shares.map((share, index) => ({
    key: `${share.version}-${index}`,
    label: share.other ? "other" : (share.version ?? "unknown"),
    ours: share.version !== null && share.version === ours,
    stake: share.stake,
    detail: `${count(share.validators)} validators, ${solCompact(share.stake)} SOL`,
  }));
  const byClient: ShareRow[] = clients.map((share) => ({
    key: share.client,
    label: share.client,
    ours: !share.other && share.client === ourClient,
    stake: share.stake,
    detail: [`${count(share.validators)} validators`, share.releases.join(", ")].filter(Boolean).join(" · "),
  }));
  return (
    <Card title="Versions" aside="by stake">
      <div className="cl-shares">
        <ShareList title="Release" rows={byRelease} fill={fill} />
        {byClient.length > 0 && <ShareList title="Client" rows={byClient} className="is-client" fill={fill} />}
      </div>
    </Card>
  );
}

/** Fixed per continent, so a colour never moves to another as shares change. */
const CONTINENTS: Record<string, { name: string; tone: string }> = {
  EU: { name: "Europe", tone: "eu" },
  NA: { name: "North America", tone: "na" },
  AS: { name: "Asia", tone: "as" },
  SA: { name: "South America", tone: "sa" },
  OC: { name: "Oceania", tone: "oc" },
  AF: { name: "Africa", tone: "af" },
  AN: { name: "Antarctica", tone: "an" },
};

const continentOf = (code: string | null) =>
  (code !== null ? CONTINENTS[code] : undefined) ?? { name: "unknown", tone: "unknown" };

const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

function countryName(code: string): string {
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

function CountryCard({ data, fill }: { data: StakeByCountry; fill?: boolean }) {
  const share = (stake: number) => (data.stake === 0 ? 0 : stake / data.stake);
  const rows: ShareRow[] = data.rows.map((row) => ({
    key: row.code ?? "other",
    label: row.code ? countryName(row.code) : row.others ? `${count(row.others)} others` : "unknown",
    code: row.code,
    ours: row.code !== null && row.code === data.ours,
    stake: row.stake,
    detail: `${count(row.validators)} validators`,
  }));
  return (
    <Card title="Stake by Country" aside={`${count(data.countries)} countries`}>
      <div className="cl-continents">
        <div
          className="cl-continent-bar"
          role="img"
          aria-label={data.continents
            .map((continent) => `${continentOf(continent.code).name} ${percent(share(continent.stake), 1)}`)
            .join(", ")}
        >
          {data.continents.map((continent) => (
            <i
              key={continent.code ?? "unknown"}
              className={`cl-ct-${continentOf(continent.code).tone}`}
              style={{ flexGrow: continent.stake, flexBasis: 0 }}
            />
          ))}
        </div>
        <div className="cl-continent-key">
          {data.continents.map((continent) => (
            <span key={continent.code ?? "unknown"}>
              <i className={`cl-ct-${continentOf(continent.code).tone}`} aria-hidden="true" />
              {continentOf(continent.code).name} <b>{percent(share(continent.stake), 1)}</b>
              {continent.code !== null && continent.code === data.ours_continent && (
                <span className="version-ours">ours</span>
              )}
            </span>
          ))}
        </div>
      </div>
      <ShareList title="Country" rows={rows} className="cl-country-list" fill={fill} />
    </Card>
  );
}

/** The single-figure charts after Transactions, in the page's order. */
function chartViews(charts: ClusterCharts): ChartView[] {
  const cu = "Each block's compute against the block limit.";
  const slot = "Each block's time from the previous block filling to this one filling.";
  const notarized = "Each block's share of stake in its notarize reward certificate.";
  const fast = "Share of blocks whose footer carries the fast finalization certificate.";
  return [
    charts.cu ? seriesView(charts.cu, "CU Used", cu, "%", 0) : waitingView("CU Used", cu),
    charts.slot_time ? seriesView(charts.slot_time, "Slot Time", slot, " ms", 0) : waitingView("Slot Time", slot),
    charts.notarized
      ? seriesView(charts.notarized, "Notarized Stake", notarized, "%", 1)
      : waitingView("Notarized Stake", notarized),
    charts.fast ? sharesView(charts.fast) : waitingView("Fast Finalization", fast),
  ];
}

/** Wide enough for every chart, both summaries side by side and the key on one line. */
const BOARD_QUERY = "(min-width: 1200px)";
/** Kept clear under the board, as the page's own top padding. */
const BOARD_FOOT = 18;
/** Three rows of 180px cards and their gaps: a shorter screen scrolls rather than squashing the charts. */
const BOARD_MIN = 568;
/** Three rows of the stacked layout's 242px cards: a taller screen leaves the room below. */
const BOARD_MAX = 754;

/** The screen left below the board, within its bounds, kept as the window resizes. */
function useBoardHeight(ref: RefObject<HTMLElement | null>, on: boolean): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!on) return;
    const measure = () => {
      const element = ref.current;
      const main = element?.closest(".main");
      if (!element || !main) return;
      const top = element.getBoundingClientRect().top + main.scrollTop - main.getBoundingClientRect().top;
      setHeight(Math.min(BOARD_MAX, Math.max(BOARD_MIN, Math.floor(main.clientHeight - top - BOARD_FOOT))));
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [ref, on]);
  return on ? height : undefined;
}

export function ClusterPage(): ReactElement {
  const store = useStore();
  const board = useMedia(BOARD_QUERY);
  const boardRef = useRef<HTMLDivElement>(null);
  const charts = useClusterCharts();
  const boardHeight = useBoardHeight(boardRef, board && charts !== null);
  const stalledSeconds = useFinalizedStall();
  const epoch = store.get("epoch", "new");
  // Rebuilt with each reply rather than each store tick.
  const views = useMemo(() => (charts ? chartViews(charts) : []), [charts]);

  if (!charts) {
    return (
      <>
        <h1 className="verdict">
          <span className="verdict-dot tone-muted" aria-hidden="true" />
          Gathering the cluster's figures.
        </h1>
        <p className="verdict-sub">The first charts arrive within a few seconds.</p>
      </>
    );
  }

  const { skips } = charts;
  const through =
    skips && epoch && epoch.epoch === charts.epoch && epoch.slots_in_epoch > 0
      ? (skips.to_slot - epoch.start_slot + 1) / epoch.slots_in_epoch
      : null;
  const baseline = skips
    ? skipBaseline(skips.skipped, skips.slots, skips.previous, through ?? 1)
    : { share: null, label: "this epoch" };
  const verdict = clusterVerdict({
    stalledSeconds,
    slotRecent: charts.slot_time?.recent ?? null,
    slotBaseline: charts.slot_time?.spread.p50 ?? null,
    skipRecent: skips?.recent ?? null,
    skipBaseline: baseline.share,
    skipBaselineLabel: baseline.label,
    notarizedRecent: charts.notarized?.recent ?? null,
    fastRecent: charts.fast?.recent ?? null,
  });
  const figures = [
    charts.slot_time && `${count(Math.round(charts.slot_time.spread.p50))} ms slots`,
    charts.tps && `${count(Math.round(charts.tps.spread.p50))} TPS`,
    charts.fast && `${percentText(charts.fast.share)} fast finalized`,
  ].filter(Boolean);
  const from = charts.from_millis;
  const to = charts.to_millis;

  const headline = (
    <>
      <h1 className="verdict cl-verdict">
        <span className={`verdict-dot tone-${verdict.tone}`} aria-hidden="true" />
        {verdict.headline}
      </h1>
      <p className="verdict-sub cl-verdict-sub">{verdict.evidence || (figures.length > 0 ? `${figures.join(", ")}.` : "")}</p>
    </>
  );
  const chartKey = (
    <Key bin={binLabel(from, to, (charts.tps ?? charts.cu ?? charts.slot_time)?.p50.length ?? 120)} since={from} />
  );
  const [cu, slot, notarized, fast] = views;

  if (board) {
    return (
      <>
        <div className="cl-screen">
          <div className="cl-top">
            <div className="cl-top-verdict">{headline}</div>
            <div className="cl-top-meta">
              <EpochLine charts={charts} />
              {chartKey}
            </div>
          </div>
          <div className="cl-board" ref={boardRef} style={{ height: boardHeight }}>
            <div className="cl-col">
              {[slot, notarized, fast].map((view) => (
                <ChartCard key={view.label} view={view} from={from} to={to} fill />
              ))}
            </div>
            <div className="cl-col">
              <TransactionsCard charts={charts} fill />
              {skips && <SkipCard skips={skips} through={through} fill />}
              <ChartCard view={cu} from={from} to={to} fill />
            </div>
            <div className="cl-col">
              <VersionsCard clients={charts.clients} fill />
              {charts.countries && <CountryCard data={charts.countries} fill />}
            </div>
          </div>
        </div>
        <HandoffCard />
      </>
    );
  }

  return (
    <>
      {headline}
      <EpochLine charts={charts} />
      {chartKey}
      <div className="cl-charts cl-grid-row">
        <TransactionsCard charts={charts} />
        {views.map((view) => (
          <ChartCard key={view.label} view={view} from={from} to={to} />
        ))}
      </div>
      {skips && (
        <div className="cl-grid-row">
          <SkipCard skips={skips} through={through} />
        </div>
      )}
      <HandoffCard />
      <div className="cl-grid-row cl-versions">
        <VersionsCard clients={charts.clients} />
      </div>
      {charts.countries && (
        <div className="cl-grid-row cl-versions">
          <CountryCard data={charts.countries} />
        </div>
      )}
    </>
  );
}
