import { count, shortKey } from "../format";
import type { SlotEntry } from "../types";
import { useStore } from "../useStore";

/** Rows in the live slot list, newest first. */
const ROWS = 48;

export function Sidebar() {
  const store = useStore();
  const slots = store.getSlots().slice(-ROWS).reverse();

  return (
    <aside className="sidebar">
      <div className="sidebar-head">Slots</div>
      <div className="sidebar-rows">
        {slots.length === 0 && <div className="sidebar-empty">waiting for slots…</div>}
        {slots.map((entry) => (
          <SidebarRow key={entry.slot} entry={entry} />
        ))}
      </div>
    </aside>
  );
}

function SidebarRow({ entry }: { entry: SlotEntry }) {
  const store = useStore();
  const peer = store.getPeer(entry.leader);
  const name = peer?.name ?? (entry.leader ? shortKey(entry.leader, 4, 4) : "unknown");

  return (
    <div className={`sidebar-row level-${entry.level}${entry.mine ? " mine" : ""}`}>
      <div className="sidebar-leader" title={entry.leader ?? undefined}>
        {entry.mine && <span className="sidebar-mine-marker" aria-label="our slot" />}
        {name}
      </div>
      <div className="sidebar-slot">{count(entry.slot)}</div>
      <div className={`sidebar-level level-${entry.level}`} title={entry.level.replace(/_/g, " ")} />
    </div>
  );
}
