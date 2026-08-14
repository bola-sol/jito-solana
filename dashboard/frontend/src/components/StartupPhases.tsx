import type { StartupProgress } from "../types";
import { Meter } from "./primitives";

/**
 * The boot sequence in the order the validator moves through it, mirroring
 * `ValidatorStartProgress`.
 *
 * Several phases are conditional: a validator starting from a local ledger
 * downloads no snapshot, and one that is not waiting on a supermajority skips
 * that step. Rather than guess which will run, anything above the current
 * phase is shown as done or skipped, which is true either way.
 */
const PHASES: Array<[string, string]> = [
  ["initializing", "Initializing"],
  ["searching_for_rpc_service", "Searching for an RPC service"],
  ["downloading_snapshot", "Downloading a snapshot"],
  ["cleaning_blockstore", "Cleaning the blockstore"],
  ["cleaning_accounts", "Cleaning accounts"],
  ["loading_ledger", "Loading the ledger"],
  ["processing_ledger", "Replaying the ledger"],
  ["starting_services", "Starting services"],
  ["waiting_for_supermajority", "Waiting for a supermajority"],
  ["running", "Running"],
];

export function StartupPhases({ startup }: { startup: StartupProgress }) {
  const current = PHASES.findIndex(([phase]) => phase === startup.phase);

  // `Halted` sits outside the sequence: it is a terminal state reached by
  // request, not a step on the way to running.
  if (current === -1) {
    return (
      <div className="startup">
        <div className="startup-phase is-current">
          <span className="startup-marker" />
          {startup.phase.replace(/_/g, " ")}
        </div>
        {startup.detail && <div className="card-footnote">{startup.detail}</div>}
      </div>
    );
  }

  return (
    <div className="startup">
      <ol className="startup-list">
        {PHASES.map(([phase, label], index) => {
          const state = index < current ? "is-done" : index === current ? "is-current" : "is-todo";
          return (
            <li className={`startup-phase ${state}`} key={phase}>
              <span className="startup-marker" />
              <span className="startup-label">{label}</span>
              {index === current && startup.detail && (
                <span className="startup-detail">{startup.detail}</span>
              )}
            </li>
          );
        })}
      </ol>
      {startup.fraction !== null && startup.fraction !== undefined && (
        <Meter fraction={startup.fraction} />
      )}
    </div>
  );
}
