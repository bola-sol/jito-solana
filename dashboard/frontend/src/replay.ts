/** Replay's timings arranged into the rows the panel draws. */

import type { ReplayWindow } from "./types";

export interface ReplayRow {
  key: string;
  label: string;
  /** Microseconds, a mean over the window's slots. */
  micros: number;
  /** Of the section's own total, in `[0, 1]`. */
  share: number;
  explain: string;
}

function rowsOf(
  total: number,
  rows: Array<[key: string, label: string, micros: number, explain: string]>,
): ReplayRow[] {
  return rows.map(([key, label, micros, explain]) => ({
    key,
    label,
    micros,
    share: total > 0 ? Math.min(1, micros / total) : 0,
    explain,
  }));
}

/** What replay's own thread spent on the average slot: three disjoint spans
 *  whose sum is the serial bottleneck against the slot time. */
export function serialRows(r: ReplayWindow): ReplayRow[] {
  const total = r.fetch + r.confirming + r.completing;
  return rowsOf(total, [
    [
      "confirming",
      "Verifying and dispatching",
      r.confirming,
      "Checking the block's entries and handing its transactions to the scheduler.",
    ],
    [
      "fetch",
      "Reading from disk",
      r.fetch,
      "Loading the slot's entries from the blockstore.",
    ],
    [
      "completing",
      "Completing the bank",
      r.completing,
      "Waiting for the scheduler to finish executing, then freezing the bank.",
    ],
  ]);
}

/** Which half of verification costs more. Relative only: these are sums of
 *  overlapping jobs. */
export function verifyRows(r: ReplayWindow): ReplayRow[] {
  const total = r.poh_verify + r.tx_verify + r.dispatch;
  return rowsOf(total, [
    [
      "poh",
      "Checking the hash chain",
      r.poh_verify,
      "Replaying the proof of history hashes to confirm the entries' order.",
    ],
    [
      "signatures",
      "Checking signatures",
      r.tx_verify,
      "Verifying every transaction signature and precompile in the block.",
    ],
    [
      "dispatch",
      "Dispatching to the scheduler",
      r.dispatch,
      "Turning verified entries into scheduler tasks. Execution is counted below.",
    ],
  ]);
}

/** Where the thread time went across every worker: CPU time, which
 *  partitions cleanly and normally exceeds the slot. */
export function cpuRows(r: ReplayWindow): ReplayRow[] {
  const total = r.execute + r.load + r.store + r.program_cache + r.checking + r.other;
  return rowsOf(total, [
    [
      "execute",
      "Running programs",
      r.execute,
      "Everything inside the virtual machine, including moving accounts in and out of it.",
    ],
    [
      "load",
      "Loading accounts",
      r.load,
      "Reading the accounts a transaction touches before it runs.",
    ],
    [
      "store",
      "Writing accounts back",
      r.store,
      "Committing what execution changed.",
    ],
    [
      "program_cache",
      "Loading programs",
      r.program_cache,
      "Finding the compiled form of each program the block calls.",
    ],
    [
      "checking",
      "Checking transactions",
      r.checking,
      "Age, fee payer and executable-account checks before execution.",
    ],
    [
      "other",
      "Everything else",
      r.other,
      "Stake cache updates, block limit accounting, and transaction history collection.",
    ],
  ]);
}

/** One figure that sits inside a phase rather than beside it. */
export interface ReplayPart {
  /** Lower case, because it is read inside a sentence rather than as a label. */
  label: string;
  micros: number;
  /** The worst single slot, where the spread says more than the mean. */
  peak?: number;
  explain: string;
}

export interface ReplayParts {
  bytecode: ReplayPart;
  serialising: ReplayPart;
  deserialising: ReplayPart;
  compiling: ReplayPart;
}

/** Figures already counted inside `execute` and `program_cache`, read as a
 *  sentence under the bar rather than drawn twice. */
export function parts(r: ReplayWindow): ReplayParts {
  return {
    bytecode: {
      label: "bytecode",
      micros: r.bytecode,
      explain:
        "Programs executing, with a nested call charged to the inner call alone.",
    },
    serialising: {
      label: "serialising",
      micros: r.serialising,
      explain:
        "Copying accounts into the virtual machine's memory before a program runs.",
    },
    deserialising: {
      label: "deserialising",
      micros: r.deserialising,
      explain:
        "Copying accounts back out again once the program has finished with them.",
    },
    compiling: {
      label: "compiling",
      micros: r.compiling,
      peak: r.program_cache_peak,
      explain:
        "Compiling a program that was not in the cache. Arrives in bursts, so the peak says more than the average.",
    },
  };
}
