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
      "Wall clock replay spent checking the block's entries and handing its transactions to the scheduler. The largest call on replay's own thread, and the first thing to look at if this node ever stops keeping up.",
    ],
    [
      "fetch",
      "Reading from disk",
      r.fetch,
      "Loading the slot's entries out of the blockstore. Reads the disk rather than the network, so a large figure here points at storage.",
    ],
    [
      "completing",
      "Completing the bank",
      r.completing,
      "Waiting for the unified scheduler to finish executing, then freezing the bank. Near nothing while execution keeps up, because by the time replay asks, the scheduler has long since finished. It is the row that grows first if the scheduler starts falling behind.",
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
      "Replaying the proof of history hashes to confirm the block's entries are in the order the leader published. Usually the larger half, and the half that answers to single-thread speed rather than to core count.",
    ],
    [
      "signatures",
      "Checking signatures",
      r.tx_verify,
      "Verifying the signature on every transaction in the block, and any precompiles alongside.",
    ],
    [
      "dispatch",
      "Dispatching to the scheduler",
      r.dispatch,
      "Turning verified entries into tasks and handing them to the unified scheduler. This is not execution. That happens afterwards on the worker threads, and is counted below.",
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
      "Everything inside the virtual machine: setting it up, moving accounts in and out of it, and running the bytecode. Almost always the largest figure on this panel.",
    ],
    [
      "load",
      "Loading accounts",
      r.load,
      "Reading the accounts a transaction touches before it can run. What the accounts panel below is measuring from the other end.",
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
      "Finding the compiled form of each program a block calls. Nearly free on a hit; a miss is what the note under this panel is counting.",
    ],
    [
      "checking",
      "Checking transactions",
      r.checking,
      "Age, fee payer and executable-account checks, before a transaction is given to a worker at all.",
    ],
    [
      "other",
      "Everything else",
      r.other,
      "Stake cache updates, block limit accounting, and the balance and log collection that feeds transaction history. Small here, and smaller still on a validator with history switched off, where the collectors have nothing to gather.",
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
        "Programs actually executing. Time a called program spends inside another is charged to the inner call alone, so a transaction that calls three deep is counted once rather than three times.",
    },
    serialising: {
      label: "serialising",
      micros: r.serialising,
      explain:
        "Copying accounts into the virtual machine's memory before a program runs. Pure overhead, and on a busy validator it costs as much as the whole program cache.",
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
        "Reading a program's ELF, verifying its bytecode and compiling it, because it was not in the cache. The hit rate on the program cache panel cannot show you this. It arrives in bursts, so the peak beside it says more than the average.",
    },
  };
}
