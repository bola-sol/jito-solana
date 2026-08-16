import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Gap kept between an open explanation and the edge of the window. */
const EDGE_MARGIN = 12;

/**
 * Where the highest value on screen sits, as a fraction of a chart's height.
 *
 * Charts are scaled to leave room above their peak so the peak line has
 * somewhere to be. Scaled to fill, the line would sit exactly on the top edge
 * and read as a border.
 */
export const PEAK_HEADROOM = 0.85;

/**
 * Vertical position of `value` in a chart scaled so `peak` lands on the peak
 * line.
 *
 * Shared by both charts so the line and the series it marks cannot drift apart:
 * they are drawn from opposite ends, the line from the bottom as a percentage
 * and the series from the top in viewBox units, and nothing but this would keep
 * them agreeing.
 */
export function chartY(value: number, peak: number, height: number): number {
  return height - (value / (peak / PEAK_HEADROOM)) * height;
}

/**
 * The dotted line marking the highest value on screen.
 *
 * Shared by the slot strip and both charts so that a peak is drawn and read the
 * same way wherever it appears.
 */
export function PeakLine({ fraction, label }: { fraction: number; label: string }) {
  const height = Math.max(0, Math.min(100, fraction * 100));
  return (
    <div
      // Too near the top and there is no room above the line for its label, so
      // it moves underneath.
      className={`peak-line${height > 88 ? " label-below" : ""}`}
      style={{ bottom: `${height}%` }}
    >
      <span>{label}</span>
    </div>
  );
}

/**
 * How far to slide an open explanation so it sits inside the window.
 *
 * Negative pulls it left off the right edge, positive pushes it right off the
 * left. Overflow on the right wins when a bubble is somehow wider than the
 * window, since the left edge is where reading starts.
 */
export function edgeShift(left: number, right: number, viewportWidth: number): number {
  const past = right - (viewportWidth - EDGE_MARGIN);
  const before = EDGE_MARGIN - left;
  if (past > 0) return -past;
  if (before > 0) return before;
  return 0;
}

/**
 * Wraps a label with an explanation that opens on tap as well as on hover.
 *
 * The explanations used to be `title` attributes, which a browser only reveals
 * on hover — so on a touch screen there was no way to reach any of them. The
 * trigger is a real button rather than a styled span because that is what
 * reliably takes focus from a tap on iOS, and focus is what holds it open.
 *
 * Hover and focus are tracked separately rather than leaning on CSS. A tap
 * fires both enter and focus, and moving away fires only leave, so a single
 * `:hover`-or-`:focus-within` rule would strand the bubble open on touch.
 */
export function Explain({
  text,
  children,
  className,
}: {
  text: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const bubble = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [shift, setShift] = useState(0);
  const open = hovered || focused;

  // A bubble anchored to its label runs off the side of the window when the
  // label sits near an edge — the right-hand column of a card pushed it two
  // hundred pixels past the viewport and gave the whole page a horizontal
  // scrollbar. Measured on open and slid back inside.
  useLayoutEffect(() => {
    if (!open || !bubble.current) {
      setShift(0);
      return;
    }
    const box = bubble.current.getBoundingClientRect();
    setShift(edgeShift(box.left, box.right, document.documentElement.clientWidth));
  }, [open]);

  return (
    <span
      className={`explain${className ? ` ${className}` : ""}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <button type="button" className="explain-trigger" aria-describedby={id}>
        {children}
      </button>
      {/* Outside the button so its text does not become part of the button's
          own name, and tied back to it by id instead. */}
      <span
        ref={bubble}
        className={`explain-bubble${open ? " is-open" : ""}`}
        role="tooltip"
        id={id}
        style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      >
        {text}
      </span>
    </span>
  );
}

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
  /** Explanation for a figure whose label cannot say enough on its own. */
  explain?: string;
}) {
  return (
    <div className="stat">
      <div className={`stat-label${explain ? " has-explain" : ""}`}>
        {explain ? <Explain text={explain}>{label}</Explain> : label}
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
