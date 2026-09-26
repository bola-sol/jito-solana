import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { count, percent, shortKey } from "../format";
import {
  ariaSort,
  entryRows,
  filterCounts,
  FIRST_SORT,
  gossipPeers,
  gossipVerdict,
  inFilter,
  ledgerText,
  matchesSearch,
  MESSAGE_LABELS,
  nextSort,
  PEER_FILTERS,
  rate,
  SILENT_MILLIS,
  snapshotText,
  sortPeers,
  span,
  stakeText,
  timeParts,
  type EntryRow,
  type GossipPeer,
  type PeerColumn,
  type PeerFilter,
  type PeerSort,
} from "../gossip";
import { useAlpenglow } from "../consensus";
import { unitFor } from "../network";
import type { Gossip, GossipPeers } from "../types";
import { useStore } from "../useStore";
import { CertificatesSection } from "./CertificatesSection";
import { Copyable } from "./Copyable";
import { Card, Meter, Stat } from "./primitives";

/** The server gathers the list on its five-second tick, and only while it is being asked for. */
const POLL_MS = 5_000;
/** Until the first list is gathered. */
const FIRST_POLL_MS = 1_000;

const ROWS_PER_PAGE = 200;

const PEER_SEARCH_ID = "gossip-peer-search";

export function GossipPage({ query, onQuery }: { query: string; onQuery: (query: string) => void }): ReactElement {
  const store = useStore();
  const gossip = store.get("summary", "gossip");
  const egress = store.get("summary", "network_egress")?.gossip_per_second ?? null;
  const ours = store.get("summary", "identity_key") ?? null;
  const slotNanos =
    store.get("summary", "observed_slot_duration_nanos") ?? store.get("summary", "estimated_slot_duration_nanos");
  // Rounded so the table redraws when the rate moves, not on every tick.
  const slotMillis = slotNanos ? Math.round(slotNanos / 1e7) * 10 : null;
  const list = useGossipPeers();
  const verdict = gossipVerdict(gossip, list);
  const alpenglow = useAlpenglow();
  const [filter, setFilter] = useState<PeerFilter>("all");
  const findInPeers = (identity: string) => {
    setFilter("all");
    onQuery(identity);
    document.getElementById(PEER_SEARCH_ID)?.closest("section")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <>
      <h1 className="verdict">
        <span className={`verdict-dot tone-${verdict.tone}`} aria-hidden="true" />
        {verdict.headline}
      </h1>
      <p className="verdict-sub">{verdict.detail}</p>
      {gossip && (
        <>
          <TableCard table={gossip.table} />
          <div className="grid">
            <MessagesCard messages={gossip.messages} egress={egress} />
            <EntriesCard entries={gossip.entries} />
            <PressureCard pressure={gossip.pressure} />
            <TimeCard time={gossip.time} />
          </div>
        </>
      )}
      {alpenglow && <CertificatesSection peers={list} onFind={findInPeers} />}
      <PeersCard
        list={list}
        query={query}
        onQuery={onQuery}
        filter={filter}
        onFilter={setFilter}
        ours={ours}
        slotMillis={slotMillis}
      />
    </>
  );
}

/** Asked for while the page is open; a closed page stops the server gathering it. */
function useGossipPeers(): GossipPeers | null {
  const store = useStore();
  const [list, setList] = useState<GossipPeers | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      store.request("peers.gossip", {}).then(
        (got) => {
          if (!live) return;
          if (got) setList(got);
          timer = setTimeout(load, got ? POLL_MS : FIRST_POLL_MS);
        },
        () => {
          if (live) timer = setTimeout(load, POLL_MS);
        },
      );
    };
    load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [store]);

  return list;
}

function TableCard({ table }: { table: Gossip["table"] }) {
  return (
    <Card title="Gossip table" className="stat-grid gossip-stats">
      <Stat
        label="entries held"
        value={count(table.entries)}
        sub={`from ${count(table.nodes)} nodes, ${count(table.staked_nodes)} staked`}
      />
      <Stat
        label={`distinct pubkeys, of ${count(table.pubkey_capacity)}`}
        explain="Past this many, gossip trims its table and keeps the staked nodes."
        value={count(table.pubkeys)}
        sub={<Meter fraction={table.pubkeys / table.pubkey_capacity} />}
      />
      <Stat label="entries expired per second" value={rate(table.expired_per_second)} sub="aged out after their timeout" />
      <Stat
        label="entries evicted by trimming"
        value={count(table.evicted_last_minute)}
        sub="last minute"
        tone={table.evicted_last_minute > 0 ? "warn" : undefined}
      />
    </Card>
  );
}

function MessagesCard({ messages, egress }: { messages: Gossip["messages"]; egress: number | null }) {
  const peak = Math.max(1, ...messages.flatMap((message) => [message.received, message.sent]));
  const unit = egress === null ? null : unitFor(egress);
  return (
    <Card title="Messages" aside="packets per second" className="gossip-card">
      <div className="gossip-scroll">
        <table className="gossip-table is-messages">
          <thead>
            <tr>
              <th>Type</th>
              <th className="is-num">In</th>
              <th aria-hidden="true" />
              <th className="is-num">Out</th>
              <th aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {messages.map((message) => (
              <tr key={message.kind}>
                <td>{MESSAGE_LABELS[message.kind]}</td>
                <td className="is-num">{rate(message.received)}</td>
                <td className="gossip-bar-cell" aria-hidden="true">
                  {message.received > 0 && <i className="gossip-bar" style={{ width: `${(message.received / peak) * 100}%` }} />}
                </td>
                <td className="is-num">{rate(message.sent)}</td>
                <td className="gossip-bar-cell" aria-hidden="true">
                  {message.sent > 0 && <i className="gossip-bar is-out" style={{ width: `${(message.sent / peak) * 100}%` }} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {egress !== null && unit && (
        <div className="card-footnote">
          Gossip egress {(egress / unit.divisor).toFixed(1)} {unit.unit}/s
        </div>
      )}
    </Card>
  );
}

function EntriesCard({ entries }: { entries: Gossip["entries"] }) {
  const { shown, others } = entryRows(entries.types);
  return (
    <Card title="Entries" aside="per second" className="gossip-card">
      <div className="stat-grid gossip-entry-stats">
        <Stat label="accepted by push" value={rate(entries.accepted_push)} sub={`${rate(entries.accepted_pull)} by pull`} />
        <Stat
          label="duplicates by push"
          value={rate(entries.duplicate_push)}
          sub={`${rate(entries.redundant_pull)} redundant by pull`}
        />
        <Stat
          label="rejected by push"
          value={rate(entries.rejected_push)}
          sub={`${rate(entries.rejected_pull)} by pull`}
        />
      </div>
      <div className="gossip-scroll">
        <table className="gossip-table">
          <thead>
            <tr>
              <th>Entry type</th>
              <th className="is-num">Push</th>
              <th className="is-num">Pull</th>
              <th className="is-num">Rejected</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <EntryLine key={row.label} row={row} />
            ))}
            {others && <EntryLine row={others} dim />}
            {shown.length === 0 && (
              <tr>
                <td colSpan={4} className="gossip-none">
                  No entries in the window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function EntryLine({ row, dim }: { row: EntryRow; dim?: boolean }) {
  return (
    <tr className={dim ? "is-dim" : undefined}>
      <td>{row.label}</td>
      <td className="is-num">{rate(row.push)}</td>
      <td className="is-num">{rate(row.pull)}</td>
      <td className="is-num">{rate(row.rejected)}</td>
    </tr>
  );
}

const PRESSURE_ROWS: { key: keyof Gossip["pressure"]; label: string; warn: boolean }[] = [
  { key: "dropped_in", label: "Packets dropped coming in", warn: true },
  { key: "dropped_out", label: "Packets dropped going out", warn: true },
  { key: "pull_no_budget", label: "Pull requests refused, no budget", warn: true },
  { key: "pull_scan_exhausted", label: "Pull scans cut short", warn: true },
  { key: "other_shred_version", label: "From another shred version", warn: false },
  { key: "ping_check_failed", label: "Failed ping checks", warn: false },
  { key: "unverified_addresses", label: "Contact records from unverified addresses", warn: false },
  { key: "bad_prune_destination", label: "Prunes to a bad destination", warn: false },
];

function PressureCard({ pressure }: { pressure: Gossip["pressure"] }) {
  return (
    <Card title="Pressure and rejects" aside="per second" className="gossip-rows">
      {PRESSURE_ROWS.map((row) => (
        <div key={row.key} className="gossip-row">
          <span>{row.label}</span>
          <span className={`gossip-row-value${row.warn && pressure[row.key] > 0 ? " tone-warn" : ""}`}>
            {rate(pressure[row.key])}
          </span>
        </div>
      ))}
    </Card>
  );
}

function TimeCard({ time }: { time: Gossip["time"] }) {
  const { parts, total } = timeParts(time);
  return (
    <Card title="Where gossip spends its time" aside={`${count(Math.round(total))} ms per second`}>
      <div className="replay-bar" aria-hidden="true">
        {parts.map((part, index) => (
          <i key={part.key} className={`is-${index + 1}`} style={{ flexGrow: part.share }} />
        ))}
      </div>
      <div className="replay-legend">
        {parts.map((part, index) => (
          <div key={part.key} className="replay-item">
            <i className={`replay-swatch is-${index + 1}`} aria-hidden="true" />
            <span className="replay-name">{part.label}</span>
            <span className="replay-value">{count(Math.round(part.millis))} ms</span>
            <span className="replay-share">{percent(part.share, 0)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

const HEADINGS: { column: PeerColumn; label: string; numeric: boolean }[] = [
  { column: "stake", label: "Stake, SOL", numeric: true },
  { column: "name", label: "Validator", numeric: false },
  { column: "client", label: "Client", numeric: false },
  { column: "ip", label: "IP", numeric: false },
  { column: "rpc", label: "RPC", numeric: true },
  { column: "heard", label: "Last heard", numeric: true },
  { column: "up", label: "Up for", numeric: true },
  { column: "snapshot", label: "Snapshot", numeric: true },
  { column: "ledger", label: "Ledger from", numeric: true },
];

function PeersCard({
  list,
  query,
  onQuery,
  filter,
  onFilter,
  ours,
  slotMillis,
}: {
  list: GossipPeers | null;
  query: string;
  onQuery: (query: string) => void;
  filter: PeerFilter;
  onFilter: (filter: PeerFilter) => void;
  ours: string | null;
  slotMillis: number | null;
}) {
  const [sort, setSort] = useState<PeerSort>(FIRST_SORT);
  const onSort = useCallback((column: PeerColumn) => setSort((was) => nextSort(was, column)), []);
  // Read when the list arrives, so the filters and the table agree until the next one.
  const { peers, now } = useMemo(() => ({ peers: list ? gossipPeers(list) : [], now: Date.now() }), [list]);
  const counts = useMemo(() => filterCounts(peers, now), [peers, now]);
  const rows = useMemo(
    () =>
      sortPeers(
        peers.filter((peer) => inFilter(peer, filter, now) && matchesSearch(peer, query)),
        sort,
        now,
      ),
    [peers, filter, query, sort, now],
  );

  return (
    <Card
      title="Peers"
      aside={
        <span aria-live="polite">
          {list ? `${count(rows.length)} ${rows.length === 1 ? "node" : "nodes"}` : ""}
        </span>
      }
      className="gossip-peers"
    >
      <div className="gossip-tools">
        <div className="gossip-chips" role="group" aria-label="Which peers to list">
          {PEER_FILTERS.map((entry) => (
            <button
              key={entry.filter}
              type="button"
              className="gossip-chip"
              aria-pressed={filter === entry.filter}
              onClick={() => onFilter(entry.filter)}
            >
              {entry.label}
              <b>{list ? count(counts[entry.filter]) : "—"}</b>
            </button>
          ))}
        </div>
        <input
          id={PEER_SEARCH_ID}
          type="search"
          className="schedule-search"
          value={query}
          placeholder="Search name, client, IP or identity"
          aria-label="Search peers by name, client, IP or identity"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      {list === null ? (
        <div className="gossip-empty">Gathering the peer list…</div>
      ) : (
        // Keyed so a new filter, search or order starts again from the top.
        <PeersTable
          key={`${filter}|${query}|${sort.column}|${sort.reversed}`}
          rows={rows}
          sort={sort}
          onSort={onSort}
          ours={ours}
          now={now}
          slotMillis={slotMillis}
          searched={query.trim() !== ""}
        />
      )}
      <div className="card-footnote">
        Snapshot: slots behind our root. Ledger from: how far back the peer can serve repair.
      </div>
    </Card>
  );
}

/** Kept out of the page's render, which runs on every store update; mainnet has thousands of rows. */
const PeersTable = memo(function PeersTable({
  rows,
  sort,
  onSort,
  ours,
  now,
  slotMillis,
  searched,
}: {
  rows: GossipPeer[];
  sort: PeerSort;
  onSort: (column: PeerColumn) => void;
  ours: string | null;
  now: number;
  slotMillis: number | null;
  searched: boolean;
}) {
  const [limit, setLimit] = useState(ROWS_PER_PAGE);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLTableRowElement>(null);
  const more = limit < rows.length;

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
    <div className="gossip-peers-scroll" ref={scroller}>
      <table className="gossip-table is-peers">
        <thead>
          <tr>
            {HEADINGS.map((heading) => {
              const order = ariaSort(sort, heading.column);
              return (
                <th
                  key={heading.column}
                  className={heading.numeric ? "is-num" : undefined}
                  aria-sort={order}
                >
                  <button type="button" className="gossip-sort" onClick={() => onSort(heading.column)}>
                    {heading.label}
                    {/* Out of the button's name; `aria-sort` says the same. */}
                    {order && <span aria-hidden="true">{order === "ascending" ? " ↑" : " ↓"}</span>}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((peer) => (
            <PeerLine
              key={peer.identity}
              peer={peer}
              ours={peer.identity === ours}
              now={now}
              slotMillis={slotMillis}
            />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={HEADINGS.length} className="gossip-none">
                {searched ? "No peer matches that name, client, IP or identity." : "No peer in this group."}
              </td>
            </tr>
          )}
          {more && <tr ref={end} aria-hidden="true" />}
        </tbody>
      </table>
    </div>
  );
});

const PeerLine = memo(function PeerLine({
  peer,
  ours,
  now,
  slotMillis,
}: {
  peer: GossipPeer;
  ours: boolean;
  now: number;
  slotMillis: number | null;
}) {
  return (
    <tr className={ours ? "is-ours" : undefined}>
      <td className="is-num">{stakeText(peer.stake)}</td>
      <td>
        <div className="gossip-who">
          <span className={peer.name ? undefined : "is-dim"}>
            {peer.name ?? "unnamed"}
            {ours && <span className="gossip-ours">ours</span>}
          </span>
          <Copyable text={peer.identity} label={shortKey(peer.identity, 4, 4)} className="gossip-key" />
        </div>
      </td>
      <td>{peer.client || "—"}</td>
      <td className="is-mono">{peer.ip ? <Copyable text={peer.ip} /> : "—"}</td>
      <td className="is-num">{peer.rpc ?? "—"}</td>
      <td className={`is-num${peer.heardAgo > SILENT_MILLIS ? " tone-warn" : ""}`}>{span(peer.heardAgo)}</td>
      <td className="is-num">{peer.started > 0 ? span(now - peer.started) : "—"}</td>
      <td className="is-num">{snapshotText(peer)}</td>
      <td className="is-num">{ledgerText(peer.ledger, slotMillis)}</td>
    </tr>
  );
});
