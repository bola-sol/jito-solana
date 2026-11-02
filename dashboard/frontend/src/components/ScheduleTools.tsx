import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { count } from "../format";
import { typedTime, type Held } from "../scheduleFilters";
import { complete, KEYS, keyOffered, suggest, type Key, type KeyGroup, type Offered } from "../scheduleSyntax";
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

/**
 * The search box. Words search leader names, keys and slots as typed; expressions are offered as
 * they are typed and become filters on Add or Enter.
 */
export function SyntaxSearch({
  text,
  placeholder,
  offered,
  ready,
  inputRef,
  onText,
  onAdd,
}: {
  text: string;
  placeholder: string;
  offered: Offered;
  /** Whether the text holds an expression for Add to take. */
  ready: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onText: (text: string) => void;
  onAdd: () => void;
}): ReactElement {
  // The caret while the box has focus; suggestions follow the word before it.
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const placeCaret = useRef<number | null>(null);
  const options = useMemo(
    () => (caret === null || dismissed ? [] : suggest(text.slice(0, caret), offered)),
    [text, caret, dismissed, offered],
  );
  useLayoutEffect(() => {
    const at = placeCaret.current;
    if (at === null || !inputRef.current) return;
    placeCaret.current = null;
    inputRef.current.setSelectionRange(at, at);
    setCaret(at);
  }, [text, inputRef]);
  const edit = (next: string, at: number | null) => {
    setActive(-1);
    setDismissed(false);
    setCaret(at);
    onText(next);
  };
  const pick = (insert: string) => {
    const next = complete(text, caret ?? text.length, insert);
    placeCaret.current = next.caret;
    edit(next.text, next.caret);
  };
  // The text stays for the next change; the suggestions close until it is edited.
  const add = () => {
    setDismissed(true);
    onAdd();
  };
  const choice = options[active];
  return (
    <span className="schedule-query">
      <input
        ref={inputRef}
        type="search"
        className="schedule-search"
        value={text}
        placeholder={placeholder}
        role="combobox"
        aria-label="Search by leader name, key or slot, or filter, e.g. duration>240"
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls="schedule-suggest"
        aria-activedescendant={choice ? `schedule-suggest-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => edit(event.target.value, event.target.selectionStart)}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onFocus={(event) => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setCaret(null)}
        onKeyDown={(event) => {
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) {
            event.preventDefault();
            // Past either end is none chosen.
            const last = options.length - 1;
            const down = event.key === "ArrowDown";
            setActive((was) => (down ? (was >= last ? -1 : was + 1) : was === -1 ? last : was - 1));
          } else if (event.key === "Tab" && !event.shiftKey && options.length > 0) {
            event.preventDefault();
            const taken = choice ?? options[0];
            if (taken) pick(taken.insert);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (choice) pick(choice.insert);
            else add();
          } else if (event.key === "Escape" && options.length > 0) {
            event.preventDefault();
            setDismissed(true);
          }
        }}
      />
      <button type="button" className={`schedule-add${ready ? " is-ready" : ""}`} onClick={add}>
        Add
      </button>
      {options.length > 0 && (
        <div className="schedule-suggest" id="schedule-suggest" role="listbox">
          {options.map((option, at) => (
            <div
              key={option.insert}
              id={`schedule-suggest-${at}`}
              role="option"
              aria-selected={at === active}
              className="schedule-suggest-option"
              // Keeps the focus in the box.
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
          <div className="schedule-suggest-hint">
            <kbd>Tab</kbd> completes · <kbd>Enter</kbd> or Add makes it a filter · a word on its own searches names and keys
          </div>
        </div>
      )}
    </span>
  );
}

const GROUP_TITLES: Record<KeyGroup, string> = { slot: "Slot", leader: "Leader and our vote", range: "Range and jump" };

/** An example of a key, with live slot and epoch numbers where it needs them. */
function exampleOf(key: Key, slot: number | null, epoch: number | null): string {
  if (key.kind === "range" && key.name === "slot") return `slot:${slot ?? 0}..`;
  if (key.kind === "epoch") return `epoch:${epoch ?? 0}`;
  if (key.kind === "at") return `at:${slot ?? "08:00"}`;
  return `${key.name}${key.op}${key.example}`;
}

/** Every expression the search box takes, each a button that puts it in the box. */
export function SyntaxSheet({
  offered,
  held,
  slot,
  epoch,
  onPick,
}: {
  offered: Offered;
  held: Held | null;
  /** A recent slot and the current epoch, for the examples. */
  slot: number | null;
  epoch: number | null;
  onPick: (example: string) => void;
}): ReactElement {
  return (
    <div className="schedule-advanced">
      {(Object.keys(GROUP_TITLES) as KeyGroup[]).map((group) => (
        <div key={group} className="schedule-syntax-group">
          <h4>{GROUP_TITLES[group]}</h4>
          {KEYS.filter((key) => key.group === group && keyOffered(key, offered)).map((key) => {
            const example = exampleOf(key, slot, epoch);
            return (
              <div key={key.name} className="schedule-syntax-row">
                <button type="button" onClick={() => onPick(example)}>
                  {example}
                </button>
                <span>{key.what}</span>
              </div>
            );
          })}
        </div>
      ))}
      <div className="schedule-advanced-foot">
        An example goes into the search box to edit; Add makes it a filter. Fees in SOL, times in ms and your local
        time, &quot;-&quot; before a list leaves it out.{held && ` Held from ${heldText(held)} to now.`}
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
