import type { ReactElement } from "react";

export function PauseIcon(): ReactElement {
  return (
    <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
      <rect width="3" height="10" fill="currentColor" />
      <rect x="5" width="3" height="10" fill="currentColor" />
    </svg>
  );
}

export function PlayIcon(): ReactElement {
  return (
    <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
      <path d="M0 0l8 5-8 5z" fill="currentColor" />
    </svg>
  );
}
