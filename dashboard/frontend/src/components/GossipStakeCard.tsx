import { useState } from "react";
import { count, percent, shortKey, solCompact } from "../format";
import { groupsOf, majorityVersion, toLine } from "../gossipStake";
import { useNarrow } from "../narrow";
import { SUPERMAJORITY_PERCENT } from "../startup";
import type { GossipStake, GossipValidator, StartupProgress } from "../types";
import { useStore } from "../useStore";
import { Copyable } from "./Copyable";
import { Card } from "./primitives";

/** The supermajority wait per validator: who the snapshot stakes, and who
 *  gossip has seen. Only while the wait lasts. */
export function GossipStakeCard() {
  const store = useStore();
  const startup = store.get<StartupProgress>("summary", "startup_progress");
  const stake = store.get<GossipStake | null>("summary", "gossip_stake");
  const narrow = useNarrow();
  const [showSeen, setShowSeen] = useState(false);
  if (!stake || startup?.phase !== "waiting_for_supermajority") return null;

  const { seen, unseen } = groupsOf(stake);
  const aside = `slot ${count(stake.slot)} · shred${narrow ? "" : " version"} ${stake.shred_version}`;

  if (narrow) {
    return (
      <Card title="Stake in gossip" aside={aside} className="gs-card" lit>
        <Bars stake={stake} />
        <div className="gs-toggle">
          <button type="button" className={showSeen ? "" : "is-on"} onClick={() => setShowSeen(false)}>
            Not seen · {count(unseen.length)}
          </button>
          <button type="button" className={showSeen ? "is-on" : ""} onClick={() => setShowSeen(true)}>
            Seen · {count(seen.length)}
          </button>
        </div>
        <Table stake={stake} rows={showSeen ? seen : unseen} seen={showSeen} versions={false} />
        <Foot />
      </Card>
    );
  }

  return (
    <Card title="Stake in gossip" aside={aside} className="gs-card" lit>
      <div className="gs-body">
        <Columns stake={stake} />
        <Table stake={stake} rows={unseen} seen={false} versions />
        <Table stake={stake} rows={seen} seen versions />
      </div>
      <Foot />
    </Card>
  );
}

/** Two columns against the line the wait ends at. */
function Columns({ stake }: { stake: GossipStake }) {
  const seen = stake.total > 0 ? stake.seen / stake.total : 0;
  const { seen: seenRows, unseen } = groupsOf(stake);
  return (
    <div className="gs-chart">
      <div className="gs-plot">
        <div className="gs-line" style={{ bottom: `${SUPERMAJORITY_PERCENT}%` }}>
          <span>{SUPERMAJORITY_PERCENT}%</span>
        </div>
        <div className="gs-col">
          <span className="gs-col-value is-seen">{percent(seen)}</span>
          <div className="gs-bar is-seen" style={{ height: `${seen * 100}%` }} />
        </div>
        <div className="gs-col">
          <span className="gs-col-value">{percent(1 - seen)}</span>
          <div className="gs-bar is-unseen" style={{ height: `${(1 - seen) * 100}%` }} />
        </div>
        <span className="gs-zero">0</span>
      </div>
      <div className="gs-axis">
        <span>Seen</span>
        <span>Not seen</span>
      </div>
      <div className="gs-note">
        <div>{solCompact(toLine(stake))} SOL to the line</div>
        <div>
          {count(stake.validators.length)} staked · {count(seenRows.length)} seen ·{" "}
          {count(unseen.length)} not yet
        </div>
      </div>
    </div>
  );
}

/** The phone's version of the columns: two bars, the line as a tick. */
function Bars({ stake }: { stake: GossipStake }) {
  const seen = stake.total > 0 ? stake.seen / stake.total : 0;
  return (
    <div className="gs-bars">
      <div className="gs-bar-row">
        <span>Seen</span>
        <b className="is-seen">{percent(seen)}</b>
      </div>
      <div className="gs-track">
        <div className="gs-fill is-seen" style={{ width: `${seen * 100}%` }} />
        <i className="gs-tick" style={{ left: `${SUPERMAJORITY_PERCENT}%` }} />
      </div>
      <div className="gs-bar-row">
        <span>Not seen</span>
        <b>{percent(1 - seen)}</b>
      </div>
      <div className="gs-track">
        <div className="gs-fill is-unseen" style={{ width: `${(1 - seen) * 100}%` }} />
      </div>
      <div className="gs-note">
        white tick = {SUPERMAJORITY_PERCENT}% · {solCompact(toLine(stake))} SOL to go
      </div>
    </div>
  );
}

function Table({
  stake,
  rows,
  seen,
  versions,
}: {
  stake: GossipStake;
  rows: GossipValidator[];
  seen: boolean;
  versions: boolean;
}) {
  const share = rows.reduce((sum, row) => sum + row.stake, 0);
  const majority = majorityVersion(stake);
  return (
    <div className="gs-table">
      {/* Heading and group line stay put; the rows scroll under them. */}
      <div className="gs-fixed">
        <div className="gs-head">
          <span>{seen ? "Seen" : "Not seen"}</span>
          {versions && <span>Version</span>}
          <span>Stake</span>
          <span>Share</span>
        </div>
        <div className={`gs-group ${seen ? "is-seen" : "is-unseen"}`}>
          <span>
            {seen ? "Online" : "Offline"}
            <span className="gs-n">{count(rows.length)} nodes</span>
          </span>
          {versions && <span />}
          <span>{solCompact(share)}</span>
          <span>{percent(stake.total > 0 ? share / stake.total : 0)}</span>
        </div>
      </div>
      {rows.map((row) => (
        <div className="gs-row" key={row.identity}>
          <Copyable
            text={row.identity}
            label={row.name ?? shortKey(row.identity)}
            className={row.name ? "gs-name" : "gs-name gs-key"}
          />
          {versions && (
            <span className={`gs-ver${row.version && row.version !== majority ? " is-odd" : ""}`}>
              {row.version ?? "–"}
            </span>
          )}
          <span>{solCompact(row.stake)}</span>
          <span className="gs-share">{percent(stake.total > 0 ? row.stake / stake.total : 0)}</span>
        </div>
      ))}
    </div>
  );
}

function Foot() {
  return (
    <div className="card-footnote">
      Staked validators from the snapshot's vote accounts, marked seen where gossip holds a
      fresh contact for them, as the validator's own check counts. Versions as gossip reports
      them.
    </div>
  );
}
