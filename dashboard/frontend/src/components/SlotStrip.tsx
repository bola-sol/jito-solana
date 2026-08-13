import { count, slotDelta } from "../format";
import type { SlotEntry } from "../types";
import { useStore } from "../useStore";

/** Slots shown in the strip. Beyond this the bars are too thin to read. */
const STRIP_LENGTH = 64;

export function SlotStrip() {
  const store = useStore();
  const processed = store.get<number>("summary", "completed_slot");
  const slots = store.getSlots().slice(-STRIP_LENGTH);

  const positions: Array<[string, number | undefined]> = [
    ["Root", store.get<number>("summary", "root_slot")],
    ["Finalized", store.get<number>("summary", "finalized_slot")],
    ["Confirmed", store.get<number>("summary", "optimistically_confirmed_slot")],
    ["Processed", processed],
    ["Estimated", store.get<number>("summary", "estimated_slot")],
  ];

  return (
    <section className="card slot-strip">
      <div className="slot-strip-head">
        <h2 className="card-title">Slots</h2>
        <div className="slot-positions">
          {positions.map(([label, slot]) => (
            <div className="slot-position" key={label}>
              <div className="slot-position-label">
                {label}
                <span className="slot-position-delta">{slotDelta(slot, processed)}</span>
              </div>
              <div className="slot-position-value">{count(slot)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="slot-bars">
        {slots.map((entry) => (
          <SlotBar key={entry.slot} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function SlotBar({ entry }: { entry: SlotEntry }) {
  // Bar height carries transaction volume and colour carries consensus level.
  // A slot that has not been replayed yet has no count, so it shows as a stub.
  const transactions = entry.transactions ?? 0;
  const height = transactions === 0 ? 6 : Math.min(100, 12 + Math.log10(1 + transactions) * 28);
  const title = [
    `slot ${entry.slot}`,
    entry.level.replace(/_/g, " "),
    entry.transactions === null ? null : `${count(entry.transactions)} txns`,
    entry.mine ? "our leader slot" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`slot-bar level-${entry.level}${entry.mine ? " mine" : ""}`} title={title}>
      <div className="slot-bar-fill" style={{ height: `${height}%` }} />
    </div>
  );
}
