/**
 * Arranging replay's timings into the rows the panel draws.
 *
 * Kept out of the component for the same reason as the waterfall's rows: the
 * arithmetic here is the part worth testing, and none of it needs a DOM.
 */

import type { ReplayWindow } from "./types";

/** What a row is doing, which is what decides how it is drawn. */
export type ReplayRowKind =
  /** A span of replay's own thread, or a phase of the work across threads. */
  | "phase"
  /** A part of the phase above it, indented and drawn against the same total. */
  | "part";

export interface ReplayRow {
  key: string;
  label: string;
  kind: ReplayRowKind;
  /** Microseconds, a mean over the window's slots. */
  micros: number;
  /** Of the section's own total, in `[0, 1]`. */
  share: number;
  /** The worst single slot in the window, where a row carries one. */
  peak?: number;
  explain: string;
}

function rowsOf(
  total: number,
  rows: Array<[key: string, label: string, kind: ReplayRowKind, micros: number, explain: string]>,
): ReplayRow[] {
  return rows.map(([key, label, kind, micros, explain]) => ({
    key,
    label,
    kind,
    micros,
    share: total > 0 ? Math.min(1, micros / total) : 0,
    explain,
  }));
}

/**
 * What replay's own thread spent on the average slot.
 *
 * Three spans measured one after another, so they are disjoint and their sum is
 * a real duration, and it is the one to hold against how long a slot lasts.
 * This is the
 * serial bottleneck: however many cores a node has, if this exceeds the slot
 * time it falls behind.
 *
 * Deliberately not drawn from the wall clock between first seeing a slot and
 * finishing it. That gap is far larger, but replay works several slots at once
 * and does fork choice and voting in between, so what fills it is not
 * attributable to this slot or to anything else in particular.
 */
export function serialRows(r: ReplayWindow): ReplayRow[] {
  const total = r.fetch + r.confirming + r.completing;
  return rowsOf(total, [
    [
      "confirming",
      "Verifying and dispatching",
      "phase",
      r.confirming,
      "Wall clock replay spent checking the block's entries and handing its transactions to the scheduler. The largest call on replay's own thread, and the first thing to look at if this node ever stops keeping up.",
    ],
    [
      "fetch",
      "Reading from disk",
      "phase",
      r.fetch,
      "Loading the slot's entries out of the blockstore. Reads the disk rather than the network, so a large figure here points at storage.",
    ],
    [
      "completing",
      "Completing the bank",
      "phase",
      r.completing,
      "Waiting for the unified scheduler to finish executing, then freezing the bank. Near nothing while execution keeps up, because by the time replay asks, the scheduler has long since finished. It is the row that grows first if the scheduler starts falling behind.",
    ],
  ]);
}

/**
 * Which half of verification costs more.
 *
 * Relative only, and the panel says so. These are sums of asynchronous job
 * durations: the jobs overlap one another and each is itself spread across the
 * thread pool, so the figures routinely add to several times the window they
 * happened in. Each is measured the same way as the others, which is what makes
 * comparing them sound and comparing them to anything else unsound.
 */
export function verifyRows(r: ReplayWindow): ReplayRow[] {
  const total = r.poh_verify + r.tx_verify + r.dispatch;
  return rowsOf(total, [
    [
      "poh",
      "Checking the hash chain",
      "phase",
      r.poh_verify,
      "Replaying the proof of history hashes to confirm the block's entries are in the order the leader published. Usually the larger half, and the half that answers to single-thread speed rather than to core count.",
    ],
    [
      "signatures",
      "Checking signatures",
      "phase",
      r.tx_verify,
      "Verifying the signature on every transaction in the block, and any precompiles alongside.",
    ],
    [
      "dispatch",
      "Dispatching to the scheduler",
      "phase",
      r.dispatch,
      "Turning verified entries into tasks and handing them to the unified scheduler. This is not execution. That happens afterwards on the worker threads, and is counted below.",
    ],
  ]);
}

/**
 * Where the thread time went, across every worker.
 *
 * Accumulated per thread and summed, so this is CPU time rather than wall
 * clock and will normally exceed the slot it describes, which is what running
 * on many cores looks like. The phases are sequential within a thread, so
 * unlike the verification figures above these partition cleanly and their total
 * is a real quantity: what one slot costs the machine.
 */
export function cpuRows(r: ReplayWindow): ReplayRow[] {
  const total = r.execute + r.load + r.store + r.program_cache + r.checking + r.other;
  const rows = rowsOf(total, [
    [
      "execute",
      "Running programs",
      "phase",
      r.execute,
      "Everything inside the virtual machine: setting it up, moving accounts in and out of it, and running the bytecode. Almost always the largest figure on this panel.",
    ],
    [
      "bytecode",
      "of which, bytecode",
      "part",
      r.bytecode,
      "Programs actually executing. Time a called program spends inside another is charged to the inner call alone, so a transaction that calls three deep is counted once rather than three times.",
    ],
    [
      "serialising",
      "of which, serialising",
      "part",
      r.serialising,
      "Copying accounts into the virtual machine's memory before a program runs. Pure overhead, and on a busy validator it costs as much as the whole program cache.",
    ],
    [
      "deserialising",
      "of which, deserialising",
      "part",
      r.deserialising,
      "Copying accounts back out again once the program has finished with them.",
    ],
    [
      "load",
      "Loading accounts",
      "phase",
      r.load,
      "Reading the accounts a transaction touches before it can run. What the accounts panel below is measuring from the other end.",
    ],
    [
      "store",
      "Writing accounts back",
      "phase",
      r.store,
      "Committing what execution changed.",
    ],
    [
      "program_cache",
      "Loading programs",
      "phase",
      r.program_cache,
      "Finding the compiled form of each program a block calls. Nearly free on a hit; the row below is what a miss costs.",
    ],
    [
      "compiling",
      "of which, compiling",
      "part",
      r.compiling,
      "Reading a program's ELF, verifying its bytecode and compiling it, because it was not in the cache. The hit rate on the program cache panel cannot show you this. It arrives in bursts, so the peak beside it says more than the average.",
    ],
    [
      "checking",
      "Checking transactions",
      "phase",
      r.checking,
      "Age, fee payer and executable-account checks, before a transaction is given to a worker at all.",
    ],
    [
      "other",
      "Everything else",
      "phase",
      r.other,
      "Stake cache updates, block limit accounting, and the balance and log collection that feeds transaction history. Small here, and smaller still on a validator with history switched off, where the collectors have nothing to gather.",
    ],
  ]);
  // The one row whose spread is worth more than its average.
  const compiling = rows.find((row) => row.key === "compiling");
  if (compiling) compiling.peak = r.program_cache_peak;
  return rows;
}
