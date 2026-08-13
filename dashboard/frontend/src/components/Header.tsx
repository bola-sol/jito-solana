import { count, percent, sol, solCompact, duration } from "../format";
import type { StakeSummary, ValidatorCounts } from "../types";
import { useStore } from "../useStore";
import { Copyable } from "./Copyable";
import { Logo } from "./Logo";

export function Header() {
  const store = useStore();
  const identity = store.get<string>("summary", "identity_key");
  const stake = store.get<StakeSummary>("summary", "stake");
  const commission = store.get<number | null>("summary", "vote_commission");
  const identityBalance = store.get<number>("summary", "identity_balance");
  const uptimeNanos = store.get<number>("summary", "uptime_nanos");
  const cluster = store.get<string>("summary", "cluster");
  const version = store.get<string>("summary", "version");
  const counts = store.get<ValidatorCounts>("summary", "validator_counts");
  const connection = store.getConnection();

  const name = store.get<string | null>("summary", "identity_name") ?? "Private";
  const icon = store.get<string | null>("summary", "identity_icon") ?? null;

  return (
    <header className="header">
      <div className="header-brand">
        <span className={`cluster cluster-${cluster ?? "unknown"}`}>{cluster ?? "…"}</span>
        <span className="version">{version ? `v${version}` : ""}</span>
      </div>

      <div className="header-identity">
        <div className="header-name">
          <Logo url={icon} size={20} />
          {name}
        </div>
        {identity ? (
          <Copyable text={identity} className="header-key" />
        ) : (
          <div className="header-key">—</div>
        )}
      </div>

      <div className="header-stats">
        <HeaderStat label="Stake Amount" value={`${solCompact(stake?.activated_stake)} SOL`} />
        <HeaderStat label="Stake %" value={percent(stake?.share, 4)} />
        <HeaderStat
          label="Commission"
          value={commission === null || commission === undefined ? "—" : `${commission} %`}
        />
        <HeaderStat label="Identity Balance" value={`${sol(identityBalance)} SOL`} />
        <HeaderStat label="Uptime" value={duration(uptimeNanos === undefined ? undefined : uptimeNanos / 1e6)} />
        <HeaderStat
          label="Validators"
          value={count(counts && counts.total - counts.delinquent)}
        />
      </div>

      <div className={`connection connection-${connection}`} title={`websocket ${connection}`}>
        <span className="connection-dot" />
        {connection}
      </div>
    </header>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="header-stat">
      <div className="header-stat-label">{label}</div>
      <div className="header-stat-value">{value}</div>
    </div>
  );
}
