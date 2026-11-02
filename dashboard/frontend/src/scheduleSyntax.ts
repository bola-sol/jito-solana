/** The schedule's search box: plain words search leader names, keys and slots, and expressions such
 *  as `duration>240`, `client:Agave,JitoLabs` or `time:08:00..09:30` become filters. */

import { FIELDS, type Condition, type Field, type Op } from "./scheduleConditions";
import { countryName } from "./format";
import { ONLY_TITLES, parseJump, type Only } from "./scheduleFilters";

type KeyKind = "number" | "list" | "is" | "range" | "epoch" | "at";

export type KeyGroup = "slot" | "leader" | "range";

export interface Key {
  name: string;
  kind: KeyKind;
  field: Field | null;
  group: KeyGroup;
  /** The comparison and value the examples use. */
  op: string;
  example: string;
  what: string;
}

export const KEYS: readonly Key[] = [
  { name: "duration", kind: "number", field: "duration", group: "slot", op: ">", example: "240", what: "slot duration, ms" },
  { name: "txs", kind: "number", field: "transactions", group: "slot", op: "<", example: "100", what: "non-vote transactions" },
  { name: "basefee", kind: "number", field: "base_fee", group: "slot", op: ">", example: "0.0025", what: "base fee, SOL" },
  { name: "priority", kind: "number", field: "priority", group: "slot", op: ">", example: "0.01", what: "priority fee, SOL" },
  { name: "tips", kind: "number", field: "tips", group: "slot", op: ">", example: "0.001", what: "tips, SOL" },
  { name: "compute", kind: "number", field: "compute", group: "slot", op: ">", example: "40000000", what: "compute units" },
  { name: "fill", kind: "number", field: "block_fill", group: "slot", op: ">", example: "80", what: "block fill, %" },
  { name: "shreds", kind: "number", field: "shreds", group: "slot", op: ">", example: "500", what: "shreds" },
  { name: "repaired", kind: "number", field: "repaired", group: "slot", op: ">", example: "0", what: "shreds repaired" },
  { name: "received", kind: "number", field: "received", group: "slot", op: ">", example: "300", what: "last shred received, ms" },
  { name: "replay", kind: "number", field: "replay", group: "slot", op: ">", example: "20", what: "replay, ms" },
  { name: "leftout", kind: "number", field: "left_out", group: "slot", op: ">", example: "0", what: "votes left out of the certificate" },
  { name: "client", kind: "list", field: "client", group: "leader", op: ":", example: "Agave,JitoLabs", what: "any of these clients" },
  { name: "geo", kind: "list", field: "country", group: "leader", op: ":", example: "DE,NL", what: "any of these countries" },
  { name: "stake", kind: "number", field: "stake", group: "leader", op: ">", example: "1000000", what: "leader's stake, SOL" },
  { name: "leader", kind: "list", field: "leader", group: "leader", op: ":", example: "delinquent", what: "not voting now, or voting" },
  { name: "voted", kind: "list", field: "voted", group: "leader", op: ":", example: "out", what: "our vote in, out or none written" },
  { name: "is", kind: "is", field: null, group: "leader", op: ":", example: "slow", what: "the chips, typed" },
  { name: "time", kind: "range", field: null, group: "range", op: ":", example: "08:00..09:30", what: "between two times, local" },
  { name: "slot", kind: "range", field: null, group: "range", op: ":", example: "", what: "from a slot, to another or now" },
  { name: "epoch", kind: "epoch", field: null, group: "range", op: ":", example: "", what: "one epoch, or several" },
  { name: "at", kind: "at", field: null, group: "range", op: ":", example: "", what: "land on a slot or time, unfiltered" },
];

const ALIASES: Readonly<Record<string, string>> = { country: "geo" };

/** The chips by their typed names. */
const IS_NAMES: Readonly<Record<string, Only>> = {
  skipped: "skipped",
  slow: "slow",
  leftout: "left_out",
  fewtxs: "few_transactions",
  notips: "no_tips",
};

/** Our vote's verdict by its typed name. */
const VOTED_NAMES: Readonly<Record<string, string>> = { in: "paid", out: "unpaid", none: "none" };

const VOTED_TITLES: Readonly<Record<string, string>> = {
  in: "our vote in the certificate",
  out: "our vote left out",
  none: "no certificate written",
};

const LEADER_TITLES: Readonly<Record<string, string>> = { delinquent: "not voting now", voting: "voting now" };

const UNITS = /\s*(ms|sol|cu|%)$/i;

const OPS: Readonly<Record<string, Op>> = { ">": "gt", ">=": "ge", "≥": "ge", "<": "lt", "<=": "le", "≤": "le", "=": "eq", ":": "eq" };

/** An expression's start: an optional `-`, a name, then its comparison. */
const EXPRESSION = /(^|\s)(-?)([a-z]+)(>=|<=|≥|≤|>|<|=|:)/gi;

/** What the validator and this page offer to filter on. */
export interface Offered {
  fields: readonly Field[];
  only: readonly Only[];
  /** Every leader client, by slots led this epoch where known; empty from a validator too old to say. */
  clients: readonly (readonly [client: string, slots: number])[];
  countries: readonly string[];
}

export type Filter =
  | { kind: "condition"; condition: Condition }
  | { kind: "only"; only: Only }
  | { kind: "range"; since: string; until: string }
  | { kind: "at"; text: string };

export interface ReadSearch {
  /** What is left to search names, keys and slots by. */
  words: string;
  filters: Filter[];
  /** Why an expression could not be read, one line each. */
  errors: string[];
  /** Whether any expression was typed, read or not. */
  syntax: boolean;
}

export function keyNamed(name: string): Key | undefined {
  const lower = name.toLowerCase();
  const wanted = ALIASES[lower] ?? lower;
  return KEYS.find((key) => key.name === wanted);
}

/** Whether a key can be used here: its column is shown, or its chips are offered. */
export function keyOffered(key: Key, offered: Offered): boolean {
  if (key.field) return offered.fields.includes(key.field);
  return key.kind !== "is" || offered.only.length > 0;
}

function readNumber(key: Key, op: string, text: string): Filter | string {
  const value = Number(text.replace(/[,_]/g, "").replace(UNITS, ""));
  if (text === "" || !Number.isFinite(value)) return `${key.name} needs a number, e.g. ${key.name}${key.op}${key.example}.`;
  const compared = OPS[op];
  if (!compared || !key.field) return `${key.name} takes >, >=, <, <= or =.`;
  return { kind: "condition", condition: { field: key.field, op: compared, value, values: [] } };
}

/** A list key's typed values as the validator names them, or why one could not be read. */
function listValues(key: Key, typed: readonly string[], offered: Offered): string[] | string {
  const values: string[] = [];
  for (const value of typed) {
    const lower = value.toLowerCase();
    let named: string | undefined;
    switch (key.field) {
      case "client": {
        const known = offered.clients.find(([client]) => client.toLowerCase() === lower)?.[0];
        named = known ?? (offered.clients.length === 0 ? value : undefined);
        if (!named) return `No leader runs a client named ${value}.`;
        break;
      }
      case "country":
        if (!/^[a-z]{2}$/.test(lower)) return `${value} is not a country code, e.g. geo:DE.`;
        named = lower.toUpperCase();
        break;
      case "leader":
        named = lower in LEADER_TITLES ? lower : undefined;
        if (!named) return "leader takes delinquent or voting.";
        break;
      case "voted":
        named = VOTED_NAMES[lower];
        if (!named) return "voted takes in, out or none.";
        break;
      default:
        return `${key.name} takes a list.`;
    }
    if (!values.includes(named)) values.push(named);
  }
  return values;
}

function readList(key: Key, op: string, text: string, not: boolean, offered: Offered): Filter[] | string {
  const typed = text.split(",").map((value) => value.trim()).filter(Boolean);
  if (op !== ":" && op !== "=") return `${key.name} takes ":", e.g. ${key.name}:${key.example}.`;
  if (typed.length === 0) return `${key.name} needs a value, e.g. ${key.name}:${key.example}.`;
  if (key.kind === "is") {
    if (not) return "is cannot be negated.";
    const chips: Filter[] = [];
    for (const name of typed) {
      const only = IS_NAMES[name.toLowerCase()];
      if (!only || !offered.only.includes(only)) return `is takes ${isNames(offered).join(", ")}.`;
      chips.push({ kind: "only", only });
    }
    return chips;
  }
  const values = listValues(key, typed, offered);
  if (typeof values === "string") return values;
  if (!key.field) return `${key.name} takes a list.`;
  return [{ kind: "condition", condition: { field: key.field, op: not ? "is_not" : "is", value: null, values } }];
}

function isNames(offered: Offered): string[] {
  return Object.entries(IS_NAMES)
    .filter(([, only]) => offered.only.includes(only))
    .map(([name]) => name);
}

/** A range's two ends, either open, each a slot or a time; null where an end cannot be read. */
function readRange(text: string, now: number): Filter | null {
  const [since = "", until = "", extra] = text.split("..").map((end) => end.trim());
  if (extra !== undefined || (!since && !until)) return null;
  if ((since && !parseJump(since, now)) || (until && !parseJump(until, now))) return null;
  return { kind: "range", since, until };
}

function readEpochs(text: string): Filter | null {
  const match = /^(\d+)(?:\.\.(\d+))?$/.exec(text);
  if (!match) return null;
  return { kind: "range", since: `epoch ${match[1]}`, until: `epoch ${match[2] ?? match[1]}` };
}

function readSpaced(key: Key, text: string, now: number): Filter | null {
  if (key.kind === "epoch") return readEpochs(text);
  if (key.kind === "range") return readRange(text, now);
  return parseJump(text, now) ? { kind: "at", text } : null;
}

const SPACED_HELP: Readonly<Record<string, string>> = {
  range: "a slot or time at each end, e.g. time:08:00..09:30 or slot:1000..",
  epoch: "an epoch number, e.g. epoch:1076 or epoch:1074..1076",
  at: "a slot or time, e.g. at:08:00 or at:Nov 2 08:00",
};

/** Reads the box: expressions become filters, the rest searches by name, key or slot. */
export function readSearch(text: string, offered: Offered, now: number): ReadSearch {
  const starts = [...text.matchAll(EXPRESSION)].map((match) => ({
    at: match.index + (match[1]?.length ?? 0),
    end: match.index + match[0].length,
    not: match[2] === "-",
    name: match[3] ?? "",
    op: match[4] ?? "",
  }));
  const words: string[] = [];
  const filters: Filter[] = [];
  const errors: string[] = [];
  let cursor = 0;
  starts.forEach((start, at) => {
    words.push(text.slice(cursor, start.at));
    const limit = starts[at + 1]?.at ?? text.length;
    const rest = text.slice(start.end, limit);
    const key = keyNamed(start.name);
    // Times hold spaces: the longest run of words that reads, the rest searched for.
    if (key && (key.kind === "range" || key.kind === "epoch" || key.kind === "at")) {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      for (let count = parts.length; count > 0; count -= 1) {
        const read = readSpaced(key, parts.slice(0, count).join(" "), now);
        if (read) {
          filters.push(read);
          words.push(parts.slice(count).join(" "));
          cursor = limit;
          return;
        }
      }
      errors.push(`${key.name} needs ${SPACED_HELP[key.kind] ?? "a value"}.`);
      cursor = limit;
      return;
    }
    const value = /^\S*/.exec(rest)?.[0] ?? "";
    cursor = start.end + value.length;
    if (!key) {
      errors.push(`No filter named ${start.name}.`);
      return;
    }
    if (!keyOffered(key, offered)) {
      errors.push(`${key.name} is not offered by this validator.`);
      return;
    }
    if (key.kind === "number") {
      if (start.not) {
        errors.push(`Only client, geo, leader and voted take a leading "-".`);
        return;
      }
      const read = readNumber(key, start.op, value);
      if (typeof read === "string") errors.push(read);
      else filters.push(read);
      return;
    }
    const read = readList(key, start.op, value, start.not, offered);
    if (typeof read === "string") errors.push(read);
    else filters.push(...read);
  });
  words.push(text.slice(cursor));
  return { words: words.join(" ").trim().replace(/\s+/g, " "), filters, errors, syntax: starts.length > 0 };
}

export interface Suggestion {
  /** Replaces the word being typed. */
  insert: string;
  /** The value shown faint after it, as an example. */
  ghost: string;
  what: string;
}

const MAX_SUGGESTIONS = 6;

/** What to offer for the word being typed, the text up to the caret: names, then their values. */
export function suggest(before: string, offered: Offered): Suggestion[] {
  const word = /(?:^|\s)(\S*)$/.exec(before)?.[1] ?? "";
  const bare = /^(-?)([a-z]+)$/i.exec(word);
  if (bare) {
    const [, not = "", typed = ""] = bare;
    const lower = typed.toLowerCase();
    return KEYS.filter(
      (key) => key.name.startsWith(lower) && keyOffered(key, offered) && (!not || key.kind === "list"),
    )
      .flatMap((key): Suggestion[] => {
        const unit = key.field ? FIELDS[key.field].unit : "";
        const ghost = `${key.example}${unit ? ` ${unit}` : ""}`;
        return key.kind === "number"
          ? [
              { insert: `${key.name}>`, ghost, what: key.what },
              { insert: `${key.name}<`, ghost, what: key.what },
            ]
          : [{ insert: `${not}${key.name}:`, ghost: key.example, what: key.what }];
      })
      .slice(0, MAX_SUGGESTIONS);
  }
  const listed = /^(-?)([a-z]+):((?:[^,\s]*,)*)([^,\s]*)$/i.exec(word);
  if (!listed) return [];
  const [, not = "", name = "", done = "", typing = ""] = listed;
  const key = keyNamed(name);
  if (!key || (key.kind !== "list" && key.kind !== "is") || !keyOffered(key, offered)) return [];
  const already = new Set(done.split(",").map((value) => value.toLowerCase()));
  const lower = typing.toLowerCase();
  return valuesOf(key, offered)
    .filter(([value]) => value.toLowerCase().startsWith(lower) && !already.has(value.toLowerCase()))
    .slice(0, MAX_SUGGESTIONS)
    .map(([value, what]) => ({ insert: `${not}${name}:${done}${value}`, ghost: "", what }));
}

function valuesOf(key: Key, offered: Offered): (readonly [value: string, what: string])[] {
  if (key.kind === "is") return isNames(offered).map((name) => [name, chipTitle(IS_NAMES[name])]);
  switch (key.field) {
    case "client":
      return offered.clients.map(([client, slots]) => [client, slots > 0 ? `${slots.toLocaleString("en-US")} slots this epoch` : ""]);
    case "country":
      return offered.countries.map((code) => [code, countryName(code)]);
    case "leader":
      return Object.entries(LEADER_TITLES);
    case "voted":
      return Object.entries(VOTED_TITLES);
    default:
      return [];
  }
}

function chipTitle(only: Only | undefined): string {
  return only ? ONLY_TITLES[only] : "";
}

/** The word up to the caret replaced by a suggestion, and where the caret then goes. */
export function complete(text: string, caret: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const start = before.length - (/\S*$/.exec(before)?.[0].length ?? 0);
  const after = text.slice(caret);
  const joined = `${before.slice(0, start)}${insert}`;
  return { text: `${joined}${after}`, caret: joined.length };
}
