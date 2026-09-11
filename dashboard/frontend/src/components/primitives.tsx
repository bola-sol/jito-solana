import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Gap kept between an open explanation and the edge of the window. */
const EDGE_MARGIN = 12;

/** Where the highest value on screen sits, as a fraction of a chart's
 *  height, leaving room for the peak line. */
export const PEAK_HEADROOM = 0.85;

/** Vertical position of `value` in a chart scaled so `peak` lands on the peak
 *  line. Shared so the line and the series agree. */
export function chartY(value: number, peak: number, height: number): number {
  return height - (value / (peak / PEAK_HEADROOM)) * height;
}

/** The dotted line marking the highest value on screen. */
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

/** How far to slide an open explanation so it sits inside the window. */
export function edgeShift(left: number, right: number, viewportWidth: number): number {
  const past = right - (viewportWidth - EDGE_MARGIN);
  const before = EDGE_MARGIN - left;
  if (past > 0) return -past;
  if (before > 0) return before;
  return 0;
}

/** Space left between an explanation and the label it belongs to. */
const ANCHOR_GAP = 6;

/** Whether an explanation opens above its label: when it would run off the
 *  bottom and there is room above. */
export function shouldFlipAbove(
  bubbleBottom: number,
  bubbleHeight: number,
  anchorTop: number,
  viewportHeight: number,
): boolean {
  const overflowsBelow = bubbleBottom > viewportHeight - EDGE_MARGIN;
  const fitsAbove = anchorTop - bubbleHeight - ANCHOR_GAP > EDGE_MARGIN;
  return overflowsBelow && fitsAbove;
}

/** A label with an explanation that opens on tap as well as hover. Hover and
 *  focus are tracked apart: a tap fires both and leaves only one. */
export function Explain({
  text,
  children,
  className,
  interactive = false,
}: {
  text: ReactNode;
  children: ReactNode;
  className?: string;
  /** Whether the bubble takes the pointer and keyboard, for the few that
   *  hold something to copy. Then not an ARIA tooltip. */
  interactive?: boolean;
}) {
  const id = useId();
  const bubble = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [shift, setShift] = useState(0);
  const [above, setAbove] = useState(false);
  const open = hovered || focused;

  // Measured on open and slid back inside the window.
  useLayoutEffect(() => {
    if (!open || !bubble.current || !anchor.current) {
      setShift(0);
      setAbove(false);
      return;
    }
    const box = bubble.current.getBoundingClientRect();
    setShift(edgeShift(box.left, box.right, document.documentElement.clientWidth));
    // Measured while still below, which is where the flip is decided from. The
    // bubble keeps its height when it moves, so one pass settles it.
    setAbove(
      shouldFlipAbove(
        box.bottom,
        box.height,
        anchor.current.getBoundingClientRect().top,
        window.innerHeight,
      ),
    );
  }, [open]);

  return (
    <span
      ref={anchor}
      className={`explain${className ? ` ${className}` : ""}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      // Focus moving from the trigger to a control inside the bubble is focus
      // staying within this, and closing on it would take the control away in
      // the moment it was reached for.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (interactive && next instanceof Node && event.currentTarget.contains(next)) return;
        setFocused(false);
      }}
    >
      <button
        type="button"
        className="explain-trigger"
        aria-describedby={interactive ? undefined : id}
        aria-expanded={interactive ? open : undefined}
        aria-controls={interactive ? id : undefined}
      >
        {children}
      </button>
      {/* Outside the button so its text does not become part of the button's
          own name, and tied back to it by id instead. */}
      <span
        ref={bubble}
        className={`explain-bubble${open ? " is-open" : ""}${above ? " is-above" : ""}${
          interactive ? " is-interactive" : ""
        }`}
        role={interactive ? undefined : "tooltip"}
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
  aside,
  children,
  className,
  lit,
}: {
  title?: string;
  /** A figure that belongs to the card rather than any row, set beside the
   *  heading. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Kept sharp while the validator boots and every other card is blurred. */
  lit?: boolean;
}) {
  // The body is a separate element so that a card can lay its content out as a
  // grid without the heading becoming one of the cells.
  return (
    <section className={`card${lit ? " is-lit" : ""}`}>
      {(title || aside) && (
        <div className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {aside && <span className="card-aside">{aside}</span>}
        </div>
      )}
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
  tone?: "good" | "bad" | "warn" | "muted";
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
