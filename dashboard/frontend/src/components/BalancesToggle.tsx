import type { ReactElement } from "react";

/** Hides the two balances in the header and the epoch's earnings, for a
 *  screen that others can see. */
export function BalancesToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}): ReactElement {
  const action = hidden ? "Show balances" : "Hide balances";
  return (
    <button
      type="button"
      className="balances-toggle"
      onClick={onToggle}
      aria-pressed={hidden}
      title={action}
      aria-label={action}
    >
      {hidden ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
