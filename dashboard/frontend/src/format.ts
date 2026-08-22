const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Number formatters, built once and reused.
 *
 * `Number.prototype.toLocaleString` constructs an `Intl.NumberFormat` on every
 * call, and constructing one is almost all of the cost: measured against this
 * page at 12.8us a call, against 0.35us for a cached formatter, and 18.5us
 * when options are passed. The dashboard formats about eighty numbers per
 * render, several times a second.
 *
 * The output is unchanged. `x.toLocaleString(undefined, opts)` is defined as
 * `new Intl.NumberFormat(undefined, opts).format(x)`, which is what these are.
 */
const PLAIN = new Intl.NumberFormat();
const BY_DIGITS = new Map<number, Intl.NumberFormat>();

function withDigits(digits: number): Intl.NumberFormat {
  const cached = BY_DIGITS.get(digits);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  BY_DIGITS.set(digits, formatter);
  return formatter;
}

export function sol(lamports: number | undefined, digits = 2): string {
  if (lamports === undefined) return "—";
  return withDigits(digits).format(lamports / LAMPORTS_PER_SOL);
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
  return value === undefined ? "—" : PLAIN.format(value);
}

export function decimal(value: number | undefined, digits = 2): string {
  if (value === undefined || Number.isNaN(value)) return "—";
  return withDigits(digits).format(value);
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

/**
 * Wall-clock time of a block, to the millisecond, in the viewer's own zone.
 *
 * Milliseconds are appended rather than asked of `toLocaleTimeString`, which
 * has no option for them. Two blocks in a row can be under two hundred
 * milliseconds apart, so seconds alone would show them as the same instant.
 */
export function blockTime(millis: number | null | undefined): string {
  if (millis === null || millis === undefined) return "—";
  const at = new Date(millis);
  if (Number.isNaN(at.getTime())) return "—";
  const day = at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = at.toLocaleTimeString(undefined, { hour12: false });
  return `${day} ${time}.${String(at.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * The release a version belongs to, e.g. `4.3.0-beta.0` → `4.3.0`.
 *
 * Mirrors `release_of` in `collect.rs`, which is what the cluster version rows
 * are keyed by. Our own version is published in full, because the header shows
 * the exact build, so without this a validator running any pre-release never
 * matches its own row and the `ours` marker goes missing.
 */
export function release(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;
  const at = version.search(/[-+]/);
  return at === -1 ? version : version.slice(0, at);
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
