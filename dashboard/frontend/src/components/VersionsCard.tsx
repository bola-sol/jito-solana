import type { ReactElement } from "react";
import { count, percent, release, solCompact } from "../format";
import { useStore } from "../useStore";
import { Card } from "./primitives";

export function VersionsCard(): ReactElement {
  const store = useStore();
  const shares = store.get("summary", "versions");
  // Rows are keyed by release, so a build of 4.3.0-beta.0 belongs to the 4.3.0
  // row and has to be shortened to find it.
  const ours = release(store.get("summary", "version"));

  if (!shares || shares.length === 0) {
    return <Card title="Versions">waiting for data…</Card>;
  }

  const totalStake = shares.reduce((sum, share) => sum + share.stake, 0);

  return (
    <Card title="Versions" aside="by stake">
      <div className="versions">
        {shares.map((share, index) => {
          const fraction = totalStake === 0 ? 0 : share.stake / totalStake;
          const label = share.other ? "other" : (share.version ?? "unknown");
          const isOurs = share.version !== null && share.version === ours;

          return (
            <div className={`version-row${isOurs ? " is-ours" : ""}`} key={`${label}-${index}`}>
              <div className="version-name">
                {label}
                {isOurs && <span className="version-ours">ours</span>}
              </div>
              <div className="version-bar">
                <i style={{ width: `${Math.min(100, fraction * 100)}%` }} />
              </div>
              <div className="version-share">{percent(fraction, 1)}</div>
              <div className="version-count">
                {count(share.validators)} validators, {solCompact(share.stake)} SOL
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
