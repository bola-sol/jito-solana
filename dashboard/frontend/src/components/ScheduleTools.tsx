import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { count, LAMPORTS_PER_SOL, percent } from "../format";
import { typedTime, type Held } from "../scheduleFilters";
import { complete, type SearchRow, type Suggestion } from "../scheduleSyntax";
import type { SavedView } from "../scheduleViews";
import {
  DEFAULT_SUMMARY_SORT,
  MIN_GROUP_SLOTS,
  sortSummaryRows,
  summaryColumns,
  summaryRows,
  type SummaryColumn,
  type SummaryGroup,
  type SummaryRow,
  type SummarySort,
} from "../summaryTable";
import { jitoShare } from "../tips";
import type { ScanFigures, ScheduleSummary, TipRates } from "../types";
import { useCopied } from "./Copyable";

/** Where the validator's history starts, in a line. */
export function heldText(held: Held): string {
  return `slot ${count(held.slot)}${held.millis === null ? "" : ` (${typedTime(held.millis)})`}`;
}

/** A filter in the search box: a comparison or list to change in place, or a range, jump or chip to remove. */
export type Pill = { key: string; label: string; onRemove: () => void } & (
  | { kind: "plain" }
  | {
      kind: "condition";
      op: string;
      value: string;
      unit: string;
      /** The value as typed, to edit. */
      draft: string;
      onCycle: () => void;
      /** Takes a typed value; why it cannot be read, or null once taken. */
      onValue: (text: string) => string | null;
    }
);

/** A list scrolled to within this of its end is at the end. */
const FADE_SLACK_PX = 2;

/** A pill's value being typed: Enter takes it, Escape or leaving it unchanged puts the old one back. */
function PillValue({
  draft,
  label,
  onValue,
  onCancel,
}: {
  draft: string;
  label: string;
  onValue: (text: string) => string | null;
  onCancel: () => void;
}): ReactElement {
  const [text, setText] = useState(draft);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className="schedule-pill-input"
      value={text}
      style={{ width: `${Math.max(text.length, 2) + 1}ch` }}
      aria-label={`${label} value`}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onValue(text);
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      // A value that cannot be read is dropped rather than left open.
      onBlur={() => {
        if (text === draft || onValue(text) !== null) onCancel();
      }}
    />
  );
}

function FilterPill({
  pill,
  editing,
  onEdit,
}: {
  pill: Pill;
  editing: boolean;
  onEdit: (key: string | null) => void;
}): ReactElement {
  const remove = (
    <button type="button" className="schedule-pill-remove" aria-label={`Remove ${pill.label}`} onClick={pill.onRemove}>
      ✕
    </button>
  );
  if (pill.kind === "plain") {
    return (
      <span className="schedule-pill">
        {pill.label}
        {remove}
      </span>
    );
  }
  return (
    <span className={`schedule-pill${editing ? " is-editing" : ""}`}>
      <span className="schedule-pill-label">{pill.label}</span>
      <button
        type="button"
        className="schedule-pill-op"
        title="Click for the next comparison"
        aria-label={`${pill.label} ${pill.op}, change the comparison`}
        onClick={pill.onCycle}
      >
        {pill.op}
      </button>
      {editing ? (
        <PillValue draft={pill.draft} label={pill.label} onValue={pill.onValue} onCancel={() => onEdit(null)} />
      ) : (
        <button
          type="button"
          className="schedule-pill-value"
          aria-label={`${pill.label} ${pill.value}, change the value`}
          onClick={() => onEdit(pill.key)}
        >
          {pill.value}
        </button>
      )}
      {pill.unit && <span className="schedule-pill-unit">{pill.unit}</span>}
      {remove}
    </span>
  );
}

/**
 * The search box, its filters as pills before the text. Words search leader names, keys and slots
 * as typed; expressions are offered as they are typed and become pills on Enter. With nothing typed
 * the box offers every expression, and one click adds it.
 */
export function SyntaxSearch<Row extends SearchRow>({
  text,
  placeholder,
  label,
  searches,
  suggestFor,
  rows,
  titles,
  foot,
  pills,
  editing,
  inputRef,
  onText,
  onAdd,
  onBrowse,
  onEdit,
  onClear,
}: {
  text: string;
  placeholder: string;
  label: string;
  /** What a word on its own searches, for the hint. */
  searches: string;
  /** What to offer for the text up to the caret. */
  suggestFor: (before: string) => readonly Suggestion[];
  /** Offered while nothing is typed at the caret. */
  rows: readonly Row[];
  /** Each group's heading in those rows. */
  titles: Readonly<Record<string, string>>;
  /** A last line under those rows. */
  foot: string;
  pills: readonly Pill[];
  /** The pill whose value is being typed. */
  editing: string | null;
  inputRef: RefObject<HTMLInputElement>;
  onText: (text: string) => void;
  onAdd: () => void;
  onBrowse: (row: Row) => void;
  onEdit: (key: string | null) => void;
  onClear: () => void;
}): ReactElement {
  // The caret while the box has focus; suggestions follow the word before it.
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [more, setMore] = useState(false);
  const placeCaret = useRef<readonly [from: number, to: number] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const before = caret === null || dismissed ? null : text.slice(0, caret);
  const browsing = before !== null && /(^|\s)$/.test(before);
  const options = useMemo(() => (before === null || browsing ? [] : suggestFor(before)), [before, browsing, suggestFor]);
  const shown = browsing ? rows.length : options.length;
  const list = useRef<HTMLDivElement>(null);
  const open = shown > 0;
  // A box low on the screen brings its list into view.
  useEffect(() => {
    if (open) list.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === null || !inputRef.current) return;
    placeCaret.current = null;
    inputRef.current.setSelectionRange(at[0], at[1]);
    setCaret(at[1]);
  }, [text, inputRef]);
  // The last rows fade while more lie below.
  const measure = (): void => {
    const list = scroller.current;
    setMore(!!list && list.scrollTop + list.clientHeight < list.scrollHeight - FADE_SLACK_PX);
  };
  useLayoutEffect(measure, [shown, browsing]);
  useEffect(() => {
    if (active >= 0) document.getElementById(`schedule-suggest-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const edit = (next: string, at: number | null) => {
    setActive(-1);
    setDismissed(false);
    setCaret(at);
    onText(next);
  };
  const pick = (insert: string, select = 0) => {
    const next = complete(text, caret ?? text.length, insert);
    placeCaret.current = [next.caret - select, next.caret];
    edit(next.text, next.caret);
  };
  const choose = (row: Row) => {
    const action: SearchRow["action"] = row.action;
    if (action.kind === "type") {
      pick(action.text, action.text.length - action.from);
      return;
    }
    setDismissed(true);
    onBrowse(row);
  };
  const add = () => {
    setDismissed(true);
    onAdd();
  };
  const choice = browsing ? undefined : options[active];
  const chosen = browsing ? rows[active] : undefined;
  const hint = browsing ? (
    <>
      Click to add, value ready to type over · <kbd>↑</kbd>
      <kbd>↓</kbd> to move, <kbd>Enter</kbd> to add · a word on its own searches {searches}
    </>
  ) : (
    <>
      <kbd>Tab</kbd> completes · <kbd>Enter</kbd> makes it a filter · a word on its own searches {searches}
    </>
  );
  return (
    <span className="schedule-query">
      <span
        className="schedule-field"
        // A click between the pills goes to the text.
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {pills.map((pill) => (
          <FilterPill key={pill.key} pill={pill} editing={pill.key === editing} onEdit={onEdit} />
        ))}
        <input
          ref={inputRef}
          type="search"
          className="schedule-search"
          value={text}
          placeholder={placeholder}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={shown > 0}
          aria-controls="schedule-suggest"
          aria-activedescendant={choice || chosen ? `schedule-suggest-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => edit(event.target.value, event.target.selectionStart)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onFocus={(event) => {
            setCaret(event.currentTarget.selectionStart);
            setDismissed(false);
          }}
          onClick={() => setDismissed(false)}
          onBlur={() => {
            setCaret(null);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown > 0) {
              event.preventDefault();
              // Past either end is none chosen.
              const last = shown - 1;
              const down = event.key === "ArrowDown";
              setActive((was) => (down ? (was >= last ? -1 : was + 1) : was === -1 ? last : was - 1));
            } else if (event.key === "Tab" && !event.shiftKey && options.length > 0) {
              event.preventDefault();
              const taken = choice ?? options[0];
              if (taken) pick(taken.insert);
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (chosen) choose(chosen);
              else if (choice) pick(choice.insert);
              else add();
            } else if (event.key === "Escape" && shown > 0) {
              event.preventDefault();
              setDismissed(true);
            }
          }}
        />
        {(pills.length > 0 || text !== "") && (
          <button type="button" className="schedule-clear" aria-label="Clear the search and every filter" onClick={onClear}>
            ✕
          </button>
        )}
      </span>
      {shown > 0 && (
        <div ref={list} className="schedule-suggest">
          <div className="schedule-suggest-hint">{hint}</div>
          <div
            ref={scroller}
            className={`schedule-suggest-scroll${more ? " has-more" : ""}`}
            id="schedule-suggest"
            role="listbox"
            onScroll={measure}
          >
            {browsing
              ? rows.map((row, at) => (
                  <Fragment key={row.syntax}>
                    {row.group !== rows[at - 1]?.group && <div className="schedule-suggest-group">{titles[row.group]}</div>}
                    <div
                      id={`schedule-suggest-${at}`}
                      role="option"
                      aria-selected={at === active}
                      className="schedule-suggest-option"
                      // Keeps the focus in the box.
                      onMouseDown={(event) => {
                        event.preventDefault();
                        choose(row);
                      }}
                    >
                      <code>{row.syntax}</code>
                      {row.figure !== undefined && <b>{row.figure}</b>}
                      <span>{row.what}</span>
                    </div>
                  </Fragment>
                ))
              : options.map((option, at) => (
                  <div
                    key={option.insert}
                    id={`schedule-suggest-${at}`}
                    role="option"
                    aria-selected={at === active}
                    className="schedule-suggest-option"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(option.insert);
                    }}
                  >
                    <code>
                      {option.insert}
                      <i>{option.ghost}</i>
                    </code>
                    <span>{option.what}</span>
                  </div>
                ))}
            {browsing && foot && <div className="schedule-suggest-foot">{foot}</div>}
          </div>
        </div>
      )}
    </span>
  );
}

/** A link to the filtered schedule and a way to keep it; hidden, not removed, while nothing is searched. */
export function ShareTools({ shown, onSave }: { shown: boolean; onSave: () => void }): ReactElement {
  const [copied, copy] = useCopied();
  return (
    <span className={`schedule-share-tools${shown ? "" : " is-idle"}`}>
      <button
        type="button"
        className={`schedule-tool${copied ? " is-done" : ""}`}
        onClick={() => void copy(window.location.href)}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
      <button type="button" className="schedule-tool" onClick={onSave}>
        Save view
      </button>
    </span>
  );
}

/** Saved views, and the current one saved under a name. */
export function ViewsMenu({
  open,
  views,
  start,
  onToggle,
  onStart,
  onApply,
  onDelete,
  onSave,
}: {
  open: boolean;
  views: readonly SavedView[];
  /** The view the schedule opens with, by name. */
  start: string | null;
  onToggle: () => void;
  onStart: (name: string | null) => void;
  onApply: (view: SavedView) => void;
  onDelete: (name: string) => void;
  onSave: (name: string) => void;
}): ReactElement {
  const [name, setName] = useState("");
  return (
    <span className="schedule-views">
      <button type="button" className="schedule-fold-toggle" aria-expanded={open} onClick={onToggle}>
        Views <span className="schedule-caret">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="schedule-views-menu">
          {views.length === 0 && <div className="schedule-views-note">No saved views yet.</div>}
          {views.map((view) => (
            <div key={view.name} className="schedule-view">
              <button type="button" className="schedule-view-apply" onClick={() => onApply(view)}>
                {view.name}
                <small>{view.summary}</small>
              </button>
              <button
                type="button"
                className="schedule-view-start"
                aria-pressed={view.name === start}
                aria-label={`Open the schedule with ${view.name}`}
                title="Open the schedule with this view."
                onClick={() => onStart(view.name === start ? null : view.name)}
              >
                {view.name === start ? "★" : "☆"}
              </button>
              <button type="button" className="schedule-view-delete" aria-label={`Delete ${view.name}`} onClick={() => onDelete(view.name)}>
                ✕
              </button>
            </div>
          ))}
          <form
            className="schedule-views-save"
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              onSave(name.trim());
              setName("");
            }}
          >
            <input
              className="schedule-views-name"
              value={name}
              placeholder="Name the current view"
              aria-label="Name the current view"
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit">Save</button>
          </form>
          <div className="schedule-views-note">Kept in this browser. ★ opens the schedule with that view. Copy link to share one.</div>
        </div>
      )}
    </span>
  );
}

function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${Math.round(value)} ms`;
}

function solMean(lamports: number | null): string {
  return lamports === null ? "—" : (lamports / LAMPORTS_PER_SOL).toFixed(4);
}

function tipsMean(lamports: number | null, rates: TipRates | null | undefined): string {
  return lamports === null || !rates ? "—" : solMean(jitoShare(lamports, rates));
}

function units(compute: number | null): string {
  return compute === null ? "—" : `${(compute / 1e6).toFixed(1)}M`;
}

function FeeMeans({ figures, rates }: { figures: ScanFigures; rates: TipRates | null | undefined }): ReactElement {
  return (
    <span>
      Mean fees <b>{solMean(figures.base_fee)}</b> base, <b>{solMean(figures.priority_fee)}</b> priority
      {rates && (
        <>
          , <b>{tipsMean(figures.tips, rates)}</b> tips
        </>
      )}{" "}
      SOL
    </span>
  );
}

function GroupButton({
  group,
  shown,
  onPick,
}: {
  group: SummaryGroup;
  shown: SummaryGroup | null;
  onPick: (group: SummaryGroup) => void;
}): ReactElement {
  const open = shown === group;
  return (
    <button
      type="button"
      className={`schedule-by-client${shown !== null && !open ? " is-other" : ""}`}
      aria-expanded={open}
      onClick={() => onPick(group)}
    >
      By {group} {open ? "▴" : "▾"}
    </button>
  );
}

/** The matches summed up: this epoch's slots when nothing is filtered. */
export function SummaryLine({
  summary,
  filtered,
  since,
  rates,
  shown,
  onPick,
}: {
  summary: ScheduleSummary;
  filtered: boolean;
  /** When the held history starts within this epoch, for an epoch not yet held whole. */
  since: number | null;
  rates: TipRates | null | undefined;
  /** The table open, if any. */
  shown: SummaryGroup | null;
  onPick: (group: SummaryGroup) => void;
}): ReactElement {
  const { figures } = summary;
  return (
    <div className="schedule-summary">
      <span>
        {filtered ? "" : since === null ? "This epoch: " : `This epoch, since ${typedTime(since)}: `}
        <b>{count(summary.turns)}</b> turns, <b>{count(figures.slots)}</b> slots{filtered ? " match" : ""}
      </span>
      <span>
        Mean duration <b>{ms(figures.duration_ms)}</b>, replay <b>{ms(figures.replay_ms)}</b>
      </span>
      <span>
        <b>{count(figures.transactions)}</b> transactions
      </span>
      <FeeMeans figures={figures} rates={rates} />
      <span className="schedule-by">
        <GroupButton group="client" shown={shown} onPick={onPick} />
        {summary.countries && <GroupButton group="country" shown={shown} onPick={onPick} />}
      </span>
    </div>
  );
}

const TYPICAL_SUMMARY: ScheduleSummary = {
  turns: 20_000,
  figures: {
    slots: 80_000,
    skipped: 0,
    transactions: 20_000_000,
    duration_ms: 200,
    replay_ms: 8,
    base_fee: 2_000_000,
    priority_fee: 7_000_000,
    tips: 4_000_000,
    compute: 20_000_000,
  },
  clients: [],
  countries: [],
  held_from: null,
  choices: { clients: [], countries: [], versions: [] },
  delinquent: [],
};

function noPick(): void {}

/** The line unseen with typical figures, wrapping as the real one will, so the list holds still when that arrives. */
export function SummaryHold({
  filtered,
  rates,
}: {
  filtered: boolean;
  rates: TipRates | null | undefined;
}): ReactElement {
  return (
    <div className="schedule-summary-hold" aria-hidden="true">
      <SummaryLine summary={TYPICAL_SUMMARY} filtered={filtered} since={null} rates={rates} shown={null} onPick={noPick} />
    </div>
  );
}

const COLUMN_HEADS: Record<Exclude<SummaryColumn, "name">, { label: string; title?: string }> = {
  slots: { label: "Slots" },
  validators: { label: "Validators", title: "Different leaders among these slots." },
  skipped: { label: "Skipped" },
  duration: { label: "Duration" },
  first_slot: {
    label: "First slot",
    title: "Each turn's first block, from the previous leader's last block full to this one full.",
  },
  rest_of_turn: { label: "Rest of turn", title: "Each turn's other three blocks, from the block before full to this one full." },
  replay: { label: "Replay", title: "Block full to replay finished, leaving out blocks from before catching up after a restart." },
  transactions: { label: "Txs / slot" },
  compute: { label: "Compute" },
  base_fee: { label: "Base" },
  priority_fee: { label: "Priority" },
  tips: { label: "Tips" },
};

function summaryCell(column: SummaryColumn, row: SummaryRow, rates: TipRates | null | undefined): ReactNode {
  switch (column) {
    case "name":
      return row.name;
    case "slots":
      return count(row.slots);
    case "validators":
      return row.validators === undefined ? "—" : count(row.validators);
    case "skipped":
      return (
        <>
          {count(row.skipped)}
          <span className="schedule-clients-share">{percent(row.skipped / row.slots)}</span>
        </>
      );
    case "duration":
      return ms(row.duration_ms);
    case "first_slot":
      return ms(row.first_slot_ms);
    case "rest_of_turn":
      return ms(row.rest_of_turn_ms);
    case "replay":
      return ms(row.replay_ms);
    case "transactions":
      return row.slots > 0 ? count(Math.round(row.transactions / row.slots)) : "—";
    case "compute":
      return units(row.compute);
    case "base_fee":
      return solMean(row.base_fee);
    case "priority_fee":
      return solMean(row.priority_fee);
    case "tips":
      return tipsMean(row.tips, rates);
  }
}

function SortHead({
  column,
  label,
  title,
  sort,
  onSort,
}: {
  column: SummaryColumn;
  label: string;
  title?: string;
  sort: SummarySort;
  onSort: (column: SummaryColumn) => void;
}): ReactElement {
  const sorted = sort.column === column;
  return (
    <th aria-sort={sorted ? (sort.descending ? "descending" : "ascending") : "none"}>
      <button type="button" className={`schedule-clients-sort${sorted ? " is-sorted" : ""}`} title={title} onClick={() => onSort(column)}>
        <span className="schedule-clients-arrow" aria-hidden="true">
          {sort.descending ? "▾" : "▴"}
        </span>
        <span className="schedule-clients-head">{label}</span>
      </button>
    </th>
  );
}

/** The same figures for each leader client or country, per slot. */
export function SummaryTable({
  summary,
  rates,
  group,
  sort,
  onSort,
}: {
  summary: ScheduleSummary;
  rates: TipRates | null | undefined;
  group: SummaryGroup;
  sort: SummarySort;
  onSort: (column: SummaryColumn) => void;
}): ReactElement {
  const columns = summaryColumns(group, Boolean(rates));
  const active = columns.includes(sort.column) ? sort : DEFAULT_SUMMARY_SORT;
  const rows = useMemo(() => sortSummaryRows(summaryRows(summary, group), active), [summary, group, active]);
  const byCountry = group === "country";
  return (
    <div className={`schedule-clients${byCountry ? " is-country" : ""}`}>
      <div className="schedule-clients-scroll">
        <table>
          <colgroup>
            {columns.map((column) => (
              <col key={column} className={`schedule-clients-col-${column}`} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) =>
                column === "name" ? (
                  <SortHead key={column} column={column} label={byCountry ? "Country" : "Client"} sort={active} onSort={onSort} />
                ) : (
                  <SortHead key={column} column={column} {...COLUMN_HEADS[column]} sort={active} onSort={onSort} />
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                {columns.map((column) => (
                  <td key={column} className={column === "validators" ? "is-faint" : undefined} title={column === "name" ? row.name : undefined}>
                    {summaryCell(column, row, rates)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="schedule-clients-note">
        {byCountry
          ? `Means per slot, by the country each leader is in now. Countries with fewer than ${MIN_GROUP_SLOTS} slots are left out.`
          : `Means per slot, by the client each leader runs now. Clients with fewer than ${MIN_GROUP_SLOTS} slots are left out.`}
      </div>
    </div>
  );
}
