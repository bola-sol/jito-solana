import type { ReactElement } from "react";

export function LogosToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}): ReactElement {
  const action = hidden ? "Show validator logos" : "Hide validator logos";
  return (
    <button
      type="button"
      className="logos-toggle"
      onClick={onToggle}
      aria-pressed={hidden}
      title={action}
      aria-label={action}
    >
      <PictureIcon struck={hidden} />
    </button>
  );
}

function PictureIcon({ struck }: { struck: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect
        x="1.8"
        y="2.8"
        width="12.4"
        height="10.4"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="5.6" cy="6.2" r="1.2" fill="currentColor" />
      <path
        d="M2.6 12l3.6-3.4 2.4 2.2 2.2-2 2.6 2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      {struck && (
        <path d="M2.5 14.5l11-13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      )}
    </svg>
  );
}
