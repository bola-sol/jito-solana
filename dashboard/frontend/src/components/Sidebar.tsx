import { useState } from "react";
import { count, shortKey } from "../format";
import type { SlotEntry } from "../types";
import { useStore } from "../useStore";
import { Logo } from "./Logo";

/** Rows in the live slot list, newest first. */
const ROWS = 48;

/**
 * The live slot list, with a filter down to this validator's own leader slots.
 *
 * The filter is local to the sidebar on purpose. The strip in the Slots panel
 * is a picture of what the cluster is doing and stays whole whichever view is
 * chosen here.
 */
export function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const store = useStore();
  const [ownOnly, setOwnOnly] = useState(false);
  const all = store.getSlots();
  const slots = (ownOnly ? all.filter((entry) => entry.mine) : all)
    .slice(-ROWS)
    .reverse();

  const action = collapsed ? "Show the slot list" : "Hide the slot list";

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        {/* Stays put when everything else goes, or there would be nothing left
            to bring the list back with. */}
        <button
          type="button"
          className="sidebar-collapse"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls="slot-list"
          title={action}
          aria-label={action}
        >
          <Chevron collapsed={collapsed} />
        </button>
        {!collapsed && (
          <>
            <span>Slots</span>
            <div className="sidebar-filter" role="group" aria-label="Which slots to list">
              <button type="button" aria-pressed={!ownOnly} onClick={() => setOwnOnly(false)}>
                All
              </button>
              <button type="button" aria-pressed={ownOnly} onClick={() => setOwnOnly(true)}>
                Ours
              </button>
            </div>
          </>
        )}
      </div>
      {!collapsed && (
        <div className="sidebar-rows" id="slot-list">
          {slots.length === 0 && (
            <div className="sidebar-empty">
              {ownOnly ? "no leader slots seen yet" : "waiting for slots…"}
            </div>
          )}
          {slots.map((entry) => (
            <SidebarRow key={entry.slot} entry={entry} />
          ))}
        </div>
      )}
    </aside>
  );
}

/** Points the way the list will move: back in when collapsed, away when open. */
function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d={collapsed ? "M6 3l5 5-5 5" : "M10 3L5 8l5 5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SidebarRow({ entry }: { entry: SlotEntry }) {
  const name =
    entry.leader_name ?? (entry.leader ? shortKey(entry.leader, 4, 4) : "unknown");

  return (
    <div className={`sidebar-row level-${entry.level}${entry.mine ? " mine" : ""}`}>
      <div className="sidebar-leader" title={entry.leader ?? undefined}>
        {entry.mine && <span className="sidebar-mine-marker" aria-label="our slot" />}
        <Logo url={entry.leader_icon} size={14} />
        {name}
      </div>
      <div className="sidebar-slot">{count(entry.slot)}</div>
      <div className={`sidebar-level level-${entry.level}`} title={entry.level.replace(/_/g, " ")} />
    </div>
  );
}
