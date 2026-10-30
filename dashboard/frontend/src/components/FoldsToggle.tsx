import type { ReactElement } from "react";
import { OVERVIEW_FOLDS, setFoldsOpen, useAllFoldsOpen } from "../folds";

/** Opens every Overview fold, and folds them once all are open. */
export function FoldsToggle(): ReactElement {
  const allOpen = useAllFoldsOpen(OVERVIEW_FOLDS);
  const action = allOpen ? "Fold all panels" : "Open all panels";
  return (
    <button
      type="button"
      className="folds-toggle"
      onClick={() => setFoldsOpen(OVERVIEW_FOLDS, !allOpen)}
      title={action}
      aria-label={action}
    >
      {allOpen ? <FoldIcon /> : <OpenIcon />}
    </button>
  );
}

function OpenIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M5 5.5L8 2.5L11 5.5M5 10.5L8 13.5L11 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FoldIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M5 2.5L8 5.5L11 2.5M5 13.5L8 10.5L11 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
