import { useEffect, useRef, useState, type ReactElement } from "react";
import { count, countryName } from "../format";
import {
  FIELDS,
  fresh,
  LEADER_STATES,
  LIST_OPS,
  NUMBER_OPS,
  OP_LABELS,
  VOTED,
  type Condition,
  type Field,
} from "../scheduleConditions";
import { typedTime, type Held } from "../scheduleFilters";
import type { SavedView } from "../scheduleViews";
import { jitoShare } from "../tips";
import type { ScanFigures, ScheduleSummary, TipRates } from "../types";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Clients with fewer slots than this are left out of the table, their means being noise. */
const MIN_CLIENT_SLOTS = 8;

const CALENDAR = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="2" y="3" width="12" height="11" rx="1.5" />
    <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
  </svg>
);

/** Where the validator's history starts, in a line. */
export function heldText(held: Held): string {
  return `slot ${count(held.slot)}${held.millis === null ? "" : ` (${typedTime(held.millis)})`}`;
}

/**
 * A slot or time typed, or picked from the browser's own date and time picker. What is typed is
 * kept as a draft and handed over only on Enter or on leaving the field, since every partial
 * number on the way to a slot is itself a slot.
 */
export function DateField({
  value,
  placeholder,
  title,
  label,
  className = "",
  warn = false,
  invalid = false,
  min,
  max,
  onDraft,
  onCommit,
  onFocusChange,
}: {
  value: string;
  placeholder: string;
  title?: string;
  label: string;
  className?: string;
  warn?: boolean;
  invalid?: boolean;
  /** The picker's bounds, as it takes them. */
  min?: string;
  max?: string;
  onDraft?: (text: string) => void;
  /** Answers the text as kept, which the field then shows: moved, or emptied for live. */
  onCommit: (text: string) => string | void;
  onFocusChange?: (focused: boolean) => void;
}): ReactElement {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const picker = useRef<HTMLInputElement>(null);
  const edit = (text: string) => {
    setDraft(text);
    onDraft?.(text);
  };
  const commit = (text: string) => {
    const kept = onCommit(text);
    if (typeof kept === "string") edit(kept);
  };
  return (
    <span className={`schedule-field ${className}`}>
      <input
        type="search"
        className={`schedule-field-input${value ? " is-set" : ""}${warn ? " is-warn" : ""}`}
        value={draft}
        placeholder={placeholder}
        title={title}
        aria-label={label}
        aria-invalid={invalid}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
        }}
        onFocus={() => onFocusChange?.(true)}
        onBlur={(event) => {
          onFocusChange?.(false);
          if (event.currentTarget.value !== value) commit(event.currentTarget.value);
        }}
      />
      <button
        type="button"
        className="schedule-calendar"
        title="Pick a date and time"
        aria-label={`${label}: pick a date and time`}
        onClick={() => {
          try {
            picker.current?.showPicker();
          } catch {
            picker.current?.focus();
          }
        }}
      >
        {CALENDAR}
      </button>
      <input
        ref={picker}
        type="datetime-local"
        className="schedule-picker"
        tabIndex={-1}
        aria-hidden="true"
        min={min}
        max={max}
        onChange={(event) => {
          const at = new Date(event.target.value).getTime();
          if (Number.isNaN(at)) return;
          const text = typedTime(at);
          edit(text);
          commit(text);
        }}
      />
    </span>
  );
}

/** A number typed, handed over on Enter or on leaving the field. */
function NumberField({
  value,
  label,
  onCommit,
}: {
  value: number | null;
  label: string;
  onCommit: (value: number | null) => void;
}): ReactElement {
  const shown = value === null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = (text: string) => {
    const read = Number(text.replace(/,/g, "").trim());
    onCommit(text.trim() === "" || !Number.isFinite(read) ? null : read);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      className="schedule-cond-value"
      value={draft}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
      }}
      onBlur={(event) => {
        if (event.currentTarget.value !== shown) commit(event.currentTarget.value);
      }}
    />
  );
}

/** Several values, any of which matches, picked from what is offered. */
function ValueTokens({
  field,
  values,
  choices,
  onChange,
}: {
  field: Field;
  values: readonly string[];
  choices: readonly (readonly [value: string, label: string])[];
  onChange: (values: readonly string[]) => void;
}): ReactElement {
  const labelOf = (value: string) => choices.find(([held]) => held === value)?.[1] ?? value;
  const left = choices.filter(([value]) => !values.includes(value));
  return (
    <span className="schedule-tokens">
      {values.map((value) => (
        <span key={value} className="schedule-token">
          {field === "country" ? value : labelOf(value)}
          <button
            type="button"
            className="schedule-token-remove"
            aria-label={`Remove ${labelOf(value)}`}
            onClick={() => onChange(values.filter((held) => held !== value))}
          >
            ✕
          </button>
        </span>
      ))}
      {left.length > 0 && (
        <select
          className="schedule-token-add"
          value=""
          aria-label={`Add a ${FIELDS[field].label.toLowerCase()}`}
          onChange={(event) => {
            if (event.target.value) onChange([...values, event.target.value]);
          }}
        >
          <option value="">+ add</option>
          {left.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

function ConditionRow({
  condition,
  offered,
  choicesOf,
  onChange,
  onRemove,
}: {
  condition: Condition;
  offered: readonly Field[];
  choicesOf: (field: Field) => readonly (readonly [string, string])[];
  onChange: (condition: Condition) => void;
  onRemove: () => void;
}): ReactElement {
  const info = FIELDS[condition.field];
  const label = info.label;
  return (
    <div className="schedule-cond">
      <select
        className="schedule-cond-field"
        value={condition.field}
        aria-label="Column"
        onChange={(event) => onChange(fresh(event.target.value as Field))}
      >
        {offered.map((field) => (
          <option key={field} value={field}>
            {FIELDS[field].label}
          </option>
        ))}
      </select>
      <select
        className="schedule-cond-op"
        value={condition.op}
        aria-label={`${label}: comparison`}
        onChange={(event) => onChange({ ...condition, op: event.target.value as Condition["op"] })}
      >
        {(info.list ? LIST_OPS : NUMBER_OPS).map((op) => (
          <option key={op} value={op}>
            {OP_LABELS[op]}
          </option>
        ))}
      </select>
      {info.list ? (
        <ValueTokens
          field={condition.field}
          values={condition.values}
          choices={choicesOf(condition.field)}
          onChange={(values) => onChange({ ...condition, values })}
        />
      ) : (
        <NumberField value={condition.value} label={`${label}: value`} onCommit={(value) => onChange({ ...condition, value })} />
      )}
      <span className="schedule-cond-unit">{info.unit}</span>
      <button type="button" className="schedule-cond-remove" aria-label={`Remove the ${label.toLowerCase()} condition`} onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

/** A range and conditions on any column, opened from the controls. */
export function AdvancedFold({
  since,
  until,
  where,
  offered,
  choices,
  held,
  pickerMin,
  pickerMax,
  onRange,
  onWhere,
  onClear,
}: {
  since: string;
  until: string;
  where: readonly Condition[];
  offered: readonly Field[];
  choices: ScheduleSummary["choices"] | null;
  held: Held | null;
  pickerMin?: string;
  pickerMax?: string;
  /** Answers both ends as kept. */
  onRange: (since: string, until: string) => readonly [since: string, until: string];
  /** `field` is the condition just added or changed, for the column group to show. */
  onWhere: (where: readonly Condition[], field: Field | null) => void;
  onClear: () => void;
}): ReactElement {
  const choicesOf = (field: Field): readonly (readonly [string, string])[] => {
    if (field === "voted") return VOTED;
    if (field === "leader") return LEADER_STATES;
    if (field === "client") return (choices?.clients ?? []).map((client) => [client, client]);
    return (choices?.countries ?? []).map((code) => [code, `${code}, ${countryName(code)}`]);
  };
  const replace = (at: number, condition: Condition) =>
    onWhere(
      where.map((held, index) => (index === at ? condition : held)),
      condition.field,
    );
  return (
    <div className="schedule-advanced">
      <span className="schedule-advanced-label">Range</span>
      <div className="schedule-range">
        <span className="schedule-range-end">From</span>
        <DateField
          value={since}
          placeholder="Slot or time"
          label="Range from"
          min={pickerMin}
          max={pickerMax}
          onCommit={(text) => onRange(text, until)[0]}
        />
        <span className="schedule-range-end">to</span>
        <DateField
          value={until}
          placeholder="Slot or time, or now"
          label="Range to"
          min={pickerMin}
          max={pickerMax}
          onCommit={(text) => onRange(since, text)[1]}
        />
      </div>
      {held && <div className="schedule-held">Held from {heldText(held)} to now.</div>}
      <span className="schedule-advanced-label">Where</span>
      <div className="schedule-conds">
        {where.map((condition, index) => (
          <ConditionRow
            // Rows are edited in place; a removal remounts those after it.
            key={`${index}:${condition.field}`}
            condition={condition}
            offered={offered}
            choicesOf={choicesOf}
            onChange={(next) => replace(index, next)}
            onRemove={() => onWhere(where.filter((_, at) => at !== index), null)}
          />
        ))}
        <button
          type="button"
          className="schedule-cond-add"
          onClick={() => {
            const field = offered.find((candidate) => !where.some((held) => held.field === candidate) && !FIELDS[candidate].leader) ?? "duration";
            onWhere([...where, fresh(field)], field);
          }}
        >
          + Add condition
        </button>
      </div>
      <div className="schedule-advanced-foot">
        <span>Every condition, in the same slot. Fees in SOL, times in ms, your local time.</span>
        {(since || until || where.length > 0) && (
          <button type="button" onClick={onClear}>
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}

/** The active range and conditions as pills, with a link to them and a way to keep them. */
export function FilterPills({
  pills,
  shareable,
  onClearAll,
  onSave,
}: {
  pills: readonly { key: string; text: string; onRemove: () => void }[];
  /** Anything filtered at all, chips and search included. */
  shareable: boolean;
  onClearAll: () => void;
  onSave: () => void;
}): ReactElement | null {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (pills.length === 0 && !shareable) return null;
  return (
    <div className="schedule-pills">
      {pills.map((pill) => (
        <span key={pill.key} className="schedule-pill">
          {pill.text}
          <button type="button" className="schedule-pill-remove" aria-label={`Remove ${pill.text}`} onClick={pill.onRemove}>
            ✕
          </button>
        </span>
      ))}
      {pills.length > 0 && (
        <button type="button" className="schedule-pills-clear" onClick={onClearAll}>
          Clear all
        </button>
      )}
      <span className="schedule-pill-tools">
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
    </div>
  );
}

/** Saved views, and the current one saved under a name. */
export function ViewsMenu({
  open,
  views,
  onToggle,
  onApply,
  onDelete,
  onSave,
}: {
  open: boolean;
  views: readonly SavedView[];
  onToggle: () => void;
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
              <button type="button" className="schedule-cond-remove" aria-label={`Delete ${view.name}`} onClick={() => onDelete(view.name)}>
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
              className="schedule-cond-value"
              value={name}
              placeholder="Name the current view"
              aria-label="Name the current view"
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit">Save</button>
          </form>
          <div className="schedule-views-note">Kept in this browser. Copy link to share one.</div>
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
              <th>Replay</th>
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
                <td>{count(row.skipped)}</td>
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
