import type { ReactNode } from "react";

export function Card({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  // The body is a separate element so that a card can lay its content out as a
  // grid without the heading becoming one of the cells.
  return (
    <section className="card">
      {title && <h2 className="card-title">{title}</h2>}
      <div className={`card-body${className ? ` ${className}` : ""}`}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
  explain,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "good" | "bad" | "muted";
  /** Hover text for a figure whose label cannot say enough on its own. */
  explain?: string;
}) {
  return (
    <div className="stat">
      <div className={`stat-label${explain ? " has-explain" : ""}`} title={explain}>
        {label}
      </div>
      <div className={`stat-value${tone ? ` tone-${tone}` : ""}`}>{value}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

/** A labelled horizontal progress bar, as used by the epoch countdown. */
export function Meter({ fraction }: { fraction: number }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <div className="meter" role="progressbar" aria-valuenow={Math.round(clamped * 100)}>
      <div className="meter-fill" style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

/**
 * A donut showing one fraction against its complement. The Validators card uses
 * it for delinquent versus healthy stake.
 */
export function Donut({
  fraction,
  label,
  sublabel,
}: {
  fraction: number;
  label: string;
  sublabel?: string;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="donut">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="donut-track" cx="50" cy="50" r={radius} />
        <circle
          className="donut-value"
          cx="50"
          cy="50"
          r={radius}
          strokeDasharray={`${clamped * circumference} ${circumference}`}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="donut-label">
        <div className="donut-primary">{label}</div>
        {sublabel && <div className="donut-secondary">{sublabel}</div>}
      </div>
    </div>
  );
}
