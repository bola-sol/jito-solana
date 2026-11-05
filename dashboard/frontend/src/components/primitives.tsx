import { memo, useId, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement } from "react";
import { setFoldsOpen, useFoldOpen } from "../folds";

const EDGE_MARGIN = 12;

export const PEAK_HEADROOM = 0.85;

/** Shared so the line and the series agree. */
export function chartY(value: number, peak: number, height: number): number {
  return height - (value / (peak / PEAK_HEADROOM)) * height;
}

export function PeakLine({ fraction, label }: { fraction: number; label: string }): ReactElement {
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

export function edgeShift(left: number, right: number, viewportWidth: number): number {
  const past = right - (viewportWidth - EDGE_MARGIN);
  const before = EDGE_MARGIN - left;
  if (past > 0) return -past;
  if (before > 0) return before;
  return 0;
}

const ANCHOR_GAP = 6;

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

/** Hover and focus are tracked apart: a tap fires both and leaves only one. */
export function Explain({
  text,
  children,
  className,
  interactive = false,
}: {
  text: ReactNode;
  children: ReactNode;
  className?: string;
  /** For the few bubbles holding something to copy; then not an ARIA tooltip. */
  interactive?: boolean;
}): ReactElement {
  const id = useId();
  const bubble = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [shift, setShift] = useState(0);
  const [above, setAbove] = useState(false);
  const open = hovered || focused;

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
      // Focus moving into the bubble stays within it, so it does not close.
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
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  lit?: boolean;
}): ReactElement {
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
  explain?: string;
}): ReactElement {
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

export function Meter({ fraction, children }: { fraction: number; children?: ReactNode }): ReactElement {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  return (
    <div
      className={`meter${children ? " has-marks" : ""}`}
      role="progressbar"
      aria-valuenow={Math.round(clamped * 100)}
    >
      <div className="meter-fill" style={{ width: `${clamped * 100}%` }} />
      {children && (
        <span className="meter-marks" aria-hidden="true">
          {children}
        </span>
      )}
    </div>
  );
}

/** A fold's head and body, always open: for a section that is the reason to visit its page. */
export function Section({
  title,
  summary,
  children,
}: {
  title: string;
  summary: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="fold is-open is-fixed">
      <div className="fold-head">
        <h2 className="fold-title">{title}</h2>
        <span className="fold-sum">{summary}</span>
      </div>
      <div className="fold-body">{children}</div>
    </section>
  );
}

/** A closed fold's top rule drawn as the bar inside it: parts sized by value, or equal meters. */
export type FoldRule =
  | { kind: "parts"; segs: { value: number; /** A CSS colour from the tokens. */ color: string }[] }
  | { kind: "meters"; segs: { pct: number }[] };

function sameRule(a: FoldRule | null, b: FoldRule | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.segs.length !== b.segs.length) return false;
  if (a.kind === "parts" && b.kind === "parts") {
    return a.segs.every((seg, index) => seg.value === b.segs[index].value && seg.color === b.segs[index].color);
  }
  if (a.kind === "meters" && b.kind === "meters") {
    return a.segs.every((seg, index) => seg.pct === b.segs[index].pct);
  }
  return false;
}

const RuleStrip = memo(
  function RuleStrip({ rule }: { rule: FoldRule | null }) {
    // A part of nothing would still leave its gap.
    const parts = rule?.kind === "parts" ? rule.segs.filter((seg) => seg.value > 0) : [];
    const meters = rule?.kind === "meters" ? rule.segs : [];
    if (parts.length === 0 && meters.length === 0) {
      return <span className="fold-rule is-empty" aria-hidden="true" />;
    }
    return (
      <span className="fold-rule" aria-hidden="true">
        {parts.map((seg, index) => (
          <i key={index} className="fold-rule-seg" style={{ flexGrow: seg.value, background: seg.color }} />
        ))}
        {meters.map((seg, index) => (
          <i key={index} className="fold-rule-seg is-meter">
            <i
              className="fold-rule-fill"
              style={{ width: `${Math.max(0, Math.min(100, Number.isFinite(seg.pct) ? seg.pct : 0))}%` }}
            />
          </i>
        ))}
      </span>
    );
  },
  (was, now) => sameRule(was.rule, now.rule),
);

/** Folded until opened, and kept open across visits unless `remember` is off. Given `rule`, the
 *  closed fold's top rule shows it, and a plain rule while it is null. */
export function Fold({
  id,
  title,
  summary,
  children,
  remember = true,
  className,
  rule,
}: {
  id: string;
  title: string;
  summary: ReactNode;
  children: ReactNode;
  remember?: boolean;
  className?: string;
  rule?: FoldRule | null;
}): ReactElement {
  const shared = useFoldOpen(id);
  const [own, setOwn] = useState(false);
  const open = remember ? shared : own;
  const toggle = () => {
    if (remember) setFoldsOpen([id], !open);
    else setOwn(!open);
  };

  const ruled = !open && rule !== undefined;

  return (
    <section className={`fold${open ? " is-open" : ""}${ruled ? " has-rule" : ""}${className ? ` ${className}` : ""}`}>
      {ruled && <RuleStrip rule={rule} />}
      <div className="fold-head" onClick={toggle}>
        <h2 className="fold-title">{title}</h2>
        <span className="fold-sum">{summary}</span>
        <button
          type="button"
          className="fold-toggle"
          aria-expanded={open}
          onClick={(event) => {
            // The row under it toggles too, and two toggles are none.
            event.stopPropagation();
            toggle();
          }}
        >
          {open ? "fold" : "open"}
        </button>
      </div>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}
