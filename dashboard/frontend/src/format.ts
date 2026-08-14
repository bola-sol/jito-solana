const LAMPORTS_PER_SOL = 1_000_000_000;

export function sol(lamports: number | undefined, digits = 2): string {
  if (lamports === undefined) return "—";
  return (lamports / LAMPORTS_PER_SOL).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Large SOL amounts, abbreviated the way the header shows them. */
export function solCompact(lamports: number | undefined): string {
  if (lamports === undefined) return "—";
  const amount = lamports / LAMPORTS_PER_SOL;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(1);
}

export function count(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString();
}

export function decimal(value: number | undefined, digits = 2): string {
  if (value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function percent(fraction: number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Compact duration, e.g. `6d 23h 39m` or `2m 51s`. */
export function duration(millis: number | undefined): string {
  if (millis === undefined || millis < 0) return "—";
  const total = Math.floor(millis / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function nanosToMillis(nanos: number | undefined): number | undefined {
  return nanos === undefined ? undefined : nanos / 1_000_000;
}

/** Shortened pubkey, e.g. `J5e4xh…c8FF1`. */
export function shortKey(key: string | null | undefined, lead = 6, tail = 5): string {
  if (!key) return "—";
  if (key.length <= lead + tail + 1) return key;
  return `${key.slice(0, lead)}…${key.slice(-tail)}`;
}

export function bytes(value: number | undefined): string {
  if (value === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/** Signed delta against a reference slot, e.g. `-32` or `+1`. */
export function slotDelta(slot: number | undefined, reference: number | undefined): string {
  if (slot === undefined || reference === undefined) return "";
  const delta = slot - reference;
  return delta === 0 ? "0" : delta > 0 ? `+${delta}` : `${delta}`;
}
