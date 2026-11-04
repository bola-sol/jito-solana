import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { count, percent } from "../format";
import { typedTime, type Held } from "../scheduleFilters";
import { complete, type SearchRow, type Suggestion } from "../scheduleSyntax";
import type { SavedView } from "../scheduleViews";
import { jitoShare } from "../tips";
import type { ScanFigures, ScheduleSummary, TipRates } from "../types";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Clients with fewer slots than this are left out of the table, their means being noise. */
const MIN_CLIENT_SLOTS = 8;

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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className={`schedule-share-tools${shown ? "" : " is-idle"}`}>
      <button
        type="button"
        className={`schedule-tool${copied ? " is-done" : ""}`}
        onClick={() => {
          void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true), () => {});
        }}
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

function ms(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
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

/** The matches summed up: this epoch's slots when nothing is filtered. */
export function SummaryLine({
  summary,
  filtered,
  since,
  rates,
  open,
  onToggle,
}: {
  summary: ScheduleSummary;
  filtered: boolean;
  /** When the held history starts within this epoch, for an epoch not yet held whole. */
  since: number | null;
  rates: TipRates | null | undefined;
  open: boolean;
  onToggle: () => void;
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
      <button type="button" className="schedule-by-client" aria-expanded={open} onClick={onToggle}>
        By client {open ? "▴" : "▾"}
      </button>
    </div>
  );
}

/** The same figures for each leader client, per slot. */
export function ClientTable({
  summary,
  rates,
}: {
  summary: ScheduleSummary;
  rates: TipRates | null | undefined;
}): ReactElement {
  const rows = summary.clients.filter((client) => client.slots >= MIN_CLIENT_SLOTS);
  return (
    <div className="schedule-clients">
      <div className="schedule-clients-scroll">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Slots</th>
              <th>Skipped</th>
              <th>Duration</th>
              <th title="Block full to replay finished, leaving out blocks from before catching up after a restart.">
                Replay
              </th>
              <th>Txs / slot</th>
              <th>Compute</th>
              <th>Base</th>
              <th>Priority</th>
              {rates && <th>Tips</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.client ?? ""}>
                <td>{row.client ?? "Not in gossip"}</td>
                <td>{count(row.slots)}</td>
                <td>
                  {count(row.skipped)}
                  <span className="schedule-clients-share">{percent(row.skipped / row.slots)}</span>
                </td>
                <td>{ms(row.duration_ms)}</td>
                <td>{ms(row.replay_ms)}</td>
                <td>{row.slots > 0 ? count(Math.round(row.transactions / row.slots)) : "—"}</td>
                <td>{units(row.compute)}</td>
                <td>{solMean(row.base_fee)}</td>
                <td>{solMean(row.priority_fee)}</td>
                {rates && <td>{tipsMean(row.tips, rates)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="schedule-clients-note">
        Means per slot, by the client each leader runs now. Clients with fewer than {MIN_CLIENT_SLOTS} slots are left out.
      </div>
    </div>
  );
}
