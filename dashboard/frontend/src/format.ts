const LAMPORTS_PER_SOL = 1_000_000_000;

/** Number formatters built once, since `toLocaleString` builds an `Intl.NumberFormat` per call. */
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

export function solCompact(lamports: number | undefined): string {
  if (lamports === undefined) return "—";
  const amount = lamports / LAMPORTS_PER_SOL;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(1);
}

export function units(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
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

/** To the millisecond, since two blocks in a row can be under two hundred apart. */
export function blockTime(millis: number | null | undefined): string {
  if (millis === null || millis === undefined) return "—";
  const at = new Date(millis);
  if (Number.isNaN(at.getTime())) return "—";
  const day = at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = at.toLocaleTimeString(undefined, { hour12: false });
  return `${day} ${time}.${String(at.getMilliseconds()).padStart(3, "0")}`;
}

export function blockStamp(millis: number | null | undefined): string {
  if (millis === null || millis === undefined) return "—";
  const at = new Date(millis);
  if (Number.isNaN(at.getTime())) return "—";
  const day = at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = at.toLocaleTimeString(undefined, { hour12: false, timeZoneName: "short" });
  return `${day} ${time}`;
}

/** Mirrors `strip_prerelease` in `collect.rs`, which keys the version rows. */
export function release(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;
  const at = version.search(/[-+]/);
  return at === -1 ? version : version.slice(0, at);
}

export function buildLabel(
  client: string | undefined,
  version: string | undefined,
): string {
  return [client, version && `v${version}`].filter(Boolean).join(" ");
}

/** Always one decimal so a column lines up. */
export function micros(us: number | null | undefined): string {
  if (us === null || us === undefined || Number.isNaN(us)) return "—";
  return `${(us / 1000).toFixed(1)} ms`;
}

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

export function slotDelta(slot: number | undefined, reference: number | undefined): string {
  if (slot === undefined || reference === undefined) return "";
  const delta = slot - reference;
  return delta === 0 ? "0" : delta > 0 ? `+${delta}` : `${delta}`;
}
