import { count, percent } from "../format";
import type { WaterfallRow } from "../waterfall";
import { Explain } from "./primitives";

/**
 * The waterfall itself, drawn the same way wherever it appears.
 *
 * Takes rows rather than a stage, because the places that want it now differ in
 * more than their window: four sections of the live card, each with its own
 * counters and its own denominator, and the expanded detail of a produced block
 * over one slot. What they share is how a row looks, which is all of this.
 */
export function WaterfallRows({ rows }: { rows: WaterfallRow[] }) {
  return (
    <div className="waterfall">
      {rows.map((row) => (
        <div key={row.key} className={`waterfall-row is-${row.kind}`}>
          <Explain text={row.explain} className="waterfall-label">
            {row.label}
          </Explain>
          <span className="waterfall-count">{count(row.count)}</span>
          <span className="waterfall-bar" aria-hidden="true">
            {/* Floored above nought so a row that fired at all leaves a mark
                rather than rounding away to an empty track, which reads the
                same as not having fired. */}
            <span
              className="waterfall-fill"
              style={{ width: `${row.count > 0 ? Math.max(1, row.share * 100) : 0}%` }}
            />
          </span>
          {/* No percentage on a row whose count runs past the total it is drawn
              against. The bar is already capped, and a figure over a hundred
              percent beside it reads as a broken number rather than as the
              queue handing on work that arrived before this window. */}
          <span className="waterfall-share">
            {row.count > 0 && !row.over ? percent(row.share, 1) : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
