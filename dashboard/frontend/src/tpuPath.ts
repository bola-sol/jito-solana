import type { ExecutedStage, QuicPort, VerifyStage } from "./types";
import { executedRows, verifyRows, type WaterfallRow } from "./waterfall";

/**
 * What happened to transactions on their way in, before the scheduler saw them.
 *
 * The first two sections describe the QUIC listener rather than the
 * transactions themselves, which is deliberate. Loss on the TPU port mostly
 * does not happen to transactions at all: it happens to the connections
 * carrying them, at a rate limiter or a connection table, long before anything
 * has been read. The socket card sees the floor below this, where the kernel
 * discarded a datagram outright, and nothing inside the validator sees that.
 *
 * Each section is one bar cut into what got through and what did not, rather
 * than a bar per row. A row's own bar is a sliver at these ratios: most of
 * these losses are under two percent, which across the width of a card is a
 * mark a few pixels wide that cannot be compared with the one above it. One bar
 * can be read, and the figures beside it carry the precision.
 */

/** A loss, and what it was a loss out of. */
export interface PathLoss {
  key: string;
  label: string;
  count: number;
  /** Of the section's total, in `[0, 1]`. */
  share: number;
  /**
   * Whether this one means the validator could not keep up.
   *
   * Most of these are refusals working exactly as designed, and toning them
   * would turn a healthy card into a wall of warnings. The few that are marked
   * are the ones where something had already been accepted and was then thrown
   * away for want of room.
   */
  warn: boolean;
  explain: string;
}

/**
 * A figure counted in something other than what the bar is counting.
 *
 * Drawn beside the heading with no segment and no share. There are two: the
 * datagrams the kernel discarded, against a bar counting connections, and the
 * batches sigverify evicted, against a bar counting transactions. Neither can
 * be converted into the other's unit — a batch carries however many
 * transactions were grouped into it and nothing reports that number — so a
 * segment for either would be a length with no meaning, beside a percentage of
 * a population it is not part of.
 */
export interface PathAside {
  label: string;
  count: number;
  unit: string;
  warn: boolean;
  explain: string;
}

export interface PathSection {
  key: string;
  title: string;
  note: string;
  explain: string;
  /** What the bar is drawn against. */
  total: number;
  /** What came out of the section, and what to call it. */
  through: { label: string; count: number };
  /** Losses, largest first, with the ones at nought left out. */
  losses: PathLoss[];
  /**
   * Reasons behind one of the losses above, rather than siblings of it.
   *
   * Only the executed section has any: a dozen reasons a transaction failed to
   * load, which roll up into a single row above and are almost always nought.
   * Shown only once the section is expanded, and never drawn in the bar, where
   * they would be counted twice.
   */
  detail: PathLoss[];
  /**
   * How many of the counters this section watches stayed at nought.
   *
   * Kept as a figure rather than as rows. A counter at nought is worth
   * knowing — it is the difference between "no transaction failed its fee payer
   * check" and "nothing here counts that" — but twenty rows of nought is what
   * made this card twice the height it needed. The count keeps the statement
   * and drops the rows.
   */
  zeros: number;
  aside: PathAside | null;
}

/** How many losses a section lists before the rest go behind a control. */
export const LOSSES_SHOWN = 6;
export const LOSSES_SHOWN_NARROW = 3;

function shareOf(total: number, count: number): number {
  if (total <= 0) return 0;
  return Math.min(1, count / total);
}

/**
 * Sorting the losses and counting the ones that did not fire.
 *
 * Largest first rather than in the order a transaction meets them. The bar
 * above already carries that order, and it is the one place it can be read
 * without arithmetic; the list is better spent answering which of them
 * mattered. It also keeps the card still: a counter firing for the first time
 * joins the bottom of the list rather than appearing in the middle of it.
 */
function sorted(
  total: number,
  rows: Array<[key: string, label: string, count: number, warn: boolean, explain: string]>,
): { losses: PathLoss[]; zeros: number } {
  const losses = rows
    .filter(([, , count]) => count > 0)
    .map(([key, label, count, warn, explain]) => ({
      key,
      label,
      count,
      share: shareOf(total, count),
      warn,
      explain,
    }))
    .sort((a, b) => b.count - a.count);
  return { losses, zeros: rows.length - losses.length };
}

/**
 * The connection funnel.
 *
 * Closer to a partition than anything else on the dashboard: the listener
 * checks each gate in turn and moves on when one closes, so an attempt is shed
 * once, fails its handshake, or is admitted. Not exactly, though. A connection
 * can meet the rate limiter again after its handshake, which charges it to a
 * gate it has already passed, and an accept that fails outright is counted
 * nowhere. So the segments can total slightly more or slightly less than the
 * offer, which is why the bar is drawn against the offer and clipped rather
 * than against the sum of its own parts.
 */
export function doorSection(q: QuicPort, kernelDrops: number | null): PathSection {
  const { losses, zeros } = sorted(q.offered, [
    [
      "door_shed_address",
      "over one address's rate",
      q.shed_address,
      false,
      "Turned away without a handshake because that address was opening connections too quickly. A large figure here against a small one for the port as a whole says the pressure is coming from a few places rather than from the cluster at large.",
    ],
    [
      "door_shed_all",
      "over the port's rate",
      q.shed_all,
      false,
      "Turned away without a handshake because the port as a whole was over its connection rate. The crudest of the limits and the cheapest: nothing is read and nothing is remembered about the peer.",
    ],
    [
      "door_handshake_timeout",
      "handshake timed out",
      q.handshake_timeout,
      false,
      "Accepted for a handshake that never finished in time. Ordinary in small numbers, since a peer that goes away part-way through lands here.",
    ],
    [
      "door_refused_full",
      "no room in the table",
      q.refused_full,
      true,
      "Refused because the endpoint already held every connection it is configured to hold. Unlike the rate limits this says the port is saturated rather than that a peer is being impatient, and a peer refused here may have had nothing wrong with it.",
    ],
    [
      "door_handshake_error",
      "handshake failed",
      q.handshake_error,
      false,
      "Accepted for a handshake that ended in an error rather than a timeout: a transport fault, a certificate the listener would not take, or the peer closing it.",
    ],
    [
      "door_add_failed",
      "refused after handshake",
      q.add_failed,
      false,
      "Handshook successfully and then refused a place in the connection table, because the table was being pruned or the peer was banned. Rare, and worth asking about if it is not.",
    ],
  ]);

  return {
    key: "door",
    title: "At the door",
    note: "connections offered",
    explain:
      "Connections, not transactions. Most of what the TPU port turns away it turns away here, before a byte has been read, and a transaction lost at this stage was never seen by anything downstream. The gates are checked in order and the listener moves on at the first one that closes, so a connection is counted at one of them and not several.",
    total: q.offered,
    through: { label: "admitted", count: q.admitted_staked + q.admitted_unstaked },
    losses,
    detail: [],
    zeros,
    aside:
      kernelDrops === null
        ? null
        : {
            label: "kernel dropped",
            count: kernelDrops,
            unit: "datagrams",
            warn: false,
            explain:
              "Datagrams discarded by the kernel before the listener could read them, from the same port over the same window. Nothing inside the validator sees these, and they are counted in datagrams while the bar counts connections, so this sits beside the bar rather than in it: a datagram the kernel threw away never became a connection attempt, so it is not a share of anything here.",
          },
  };
}

/** What was opened on the connections that got in, and what became of it. */
export function streamSection(q: QuicPort): PathSection {
  const { losses, zeros } = sorted(q.streams, [
    [
      "stream_throttled_unstaked",
      "throttled, unstaked",
      q.throttled_unstaked,
      false,
      "Streams from peers without stake, held back at the much lower limit they share between them. This is the row that ordinarily carries a spam wave, and it doing so is the limiter working rather than failing.",
    ],
    [
      "stream_throttled_staked",
      "throttled, staked",
      q.throttled_staked,
      true,
      "Streams from staked peers held back because that peer was over the share of capacity its stake earns it. Marked because it is the limiter biting on the traffic it is meant to favour, which during a leader slot is worth knowing about.",
    ],
    [
      "stream_read_timeout",
      "stopped arriving",
      q.read_timeouts,
      false,
      "Opened and then left unfinished long enough to be abandoned. A sender that disappears part-way through a transaction lands here.",
    ],
    [
      "stream_read_error",
      "read error",
      q.read_errors,
      false,
      "Failed while being read, rather than merely stalling.",
    ],
    [
      "stream_invalid_size",
      "impossible size",
      q.invalid_size,
      false,
      "Refused for declaring a length that could not be a transaction. Cheap to reject and never legitimate, so this counts malformed or hostile traffic rather than anything going wrong here.",
    ],
  ]);
  const lost = losses.reduce((sum, loss) => sum + loss.count, 0);

  return {
    key: "streams",
    title: "Once connected",
    note: "streams opened",
    explain:
      "What the admitted connections sent, and what the stream limits did with it. A transaction is sent as a stream of its own, so this is the first section counting things rather than the peers sending them.",
    total: q.streams,
    through: { label: "carried", count: Math.max(0, q.streams - lost) },
    losses,
    detail: [],
    zeros,
    aside: null,
  };
}

/**
 * What came out of the listener towards verification.
 *
 * Drawn against the three outcomes added together, because the listener keeps
 * no total of what it finished reading.
 */
export function listenerSection(q: QuicPort): PathSection {
  const read = q.handed_on + q.queue_full + q.disconnected;
  const { losses, zeros } = sorted(read, [
    [
      "handed_queue_full",
      "fetch queue full",
      q.queue_full,
      true,
      "Read successfully and then dropped, because the queue towards signature verification had no room. This is the row that means the validator could not keep up with what it had already let in.",
    ],
    [
      "handed_disconnected",
      "queue closed",
      q.disconnected,
      true,
      "Dropped because the queue onward had been closed rather than merely full. In practice this is a validator shutting down, and a figure here at any other time is worth asking about.",
    ],
  ]);

  return {
    key: "listener",
    title: "Out of the listener",
    note: "transactions read",
    explain:
      "Transactions the listener finished assembling out of its streams, and what became of them. Not a count of packets, and not comparable with the datagram figures on the socket card: one transaction arrives across however many datagrams it needs. The total is the outcomes added together, because the listener keeps no count of what it finished reading.",
    total: read,
    through: { label: "passed to verify", count: q.handed_on },
    losses,
    detail: [],
    zeros,
    aside: null,
  };
}

/** One row out of a built list, for the two sections adapted from them. */
function pick(rows: WaterfallRow[], key: string): number {
  return rows.find((row) => row.key === key)?.count ?? 0;
}

/**
 * Signature verification, reshaped from the rows the old card drew.
 *
 * Built through `verifyRows` rather than from the payload directly, because the
 * count of bad signatures is not reported and has to be worked out from what is
 * left once the other outcomes are taken off. That arithmetic is tested where
 * it lives and is not worth a second copy here.
 */
export function verifySection(v: VerifyStage): PathSection {
  const rows = verifyRows(v);
  const { losses, zeros } = sorted(v.received, [
    [
      "verify_duplicate",
      "duplicate",
      pick(rows, "verify_duplicate"),
      false,
      "Seen before. The network sends the same transaction more than once as a matter of course, so a large figure here is ordinary rather than a fault.",
    ],
    [
      "verify_bad",
      "bad signature",
      pick(rows, "verify_bad"),
      false,
      "Failed verification. Not reported directly: sigverify discards at one step and returns, so a packet is deduplicated, or dropped below the floor, or verified, or bad, and what is left once the other three are taken off is exactly the bad.",
    ],
    [
      "verify_below_floor",
      "below priority floor",
      pick(rows, "verify_below_floor"),
      false,
      "Dropped for paying too little, where a priority floor is configured. Nought on a validator that has not set one.",
    ],
  ]);

  return {
    key: "verify",
    title: "Verify",
    note: "signatures and duplicates",
    explain:
      "Signature verification and deduplication, for everything that is not a vote. Votes are verified by a separate stage and leave by a different door, so they are left out here rather than inflating a total the section below could never account for.",
    total: v.received,
    through: { label: "verified", count: v.verified },
    losses,
    detail: [],
    zeros,
    aside:
      v.evicted_batches > 0
        ? {
            label: "dropped",
            count: v.evicted_batches,
            unit: "batches, not transactions",
            warn: true,
            explain:
              "Batches thrown away because the queue onward to the banking stage was full. Beside the bar rather than in it, because a batch carries however many transactions were grouped into it and nothing reports that number, so this can be neither added to nor subtracted from the counts here. It is the same kind of loss as the fetch queue filling above: something already accepted, thrown away for want of room. Counted by the sigverify stage itself, so it does not depend on which scheduler is running.",
          }
        : null,
  };
}

/** Reasons a transaction failed to load, which sit behind the row above them. */
const LOAD_REASONS: Array<[key: string, label: string]> = [
  ["exec_blockhash_missing", "blockhash not found"],
  ["exec_blockhash_old", "blockhash too old"],
  ["exec_already_processed", "already processed"],
  ["exec_fee_payer_broke", "fee payer could not pay"],
  ["exec_fee_payer_invalid", "fee payer not usable"],
  ["exec_account_missing", "account not found"],
  ["exec_too_many_locks", "too many account locks"],
  ["exec_bad_compute_budget", "compute budget"],
  ["exec_account_data_too_large", "account data too large"],
  ["exec_program_not_executable", "program not executable"],
  ["exec_program_restricted", "program restricted"],
  ["exec_other_reasons", "other reasons"],
];

/**
 * The worker threads, reshaped from the rows the old card drew.
 *
 * Two levels rather than one. The top level is what became of a transaction the
 * workers took up; the dozen reasons a load failed sit beneath one of those
 * rows rather than beside it, and are kept out of the bar, where they would be
 * counted a second time.
 */
export function executedSection(e: ExecutedStage): PathSection {
  const rows = executedRows(e);
  const attempted = pick(rows, "exec_attempted");
  const { losses, zeros } = sorted(attempted, [
    [
      "exec_failed",
      "failed, but still in the block",
      pick(rows, "exec_failed"),
      false,
      "Executed, failed, and committed anyway. A failing transaction still pays its fee and still takes room in the block, so this is ordinary traffic rather than a fault of this validator.",
    ],
    [
      "exec_dropped",
      "failed to load",
      pick(rows, "exec_dropped"),
      false,
      "Never executed, because the accounts or the blockhash it named could not be loaded. The reasons are counted separately and sit behind the control below.",
    ],
    [
      "exec_cost_throttled",
      "no room in the block",
      pick(rows, "exec_cost_throttled"),
      true,
      "Held back by the cost model rather than executed: the block had no room left. Marked because it says the block filled, which is a limit being reached rather than a transaction being wrong.",
    ],
    [
      "exec_retryable",
      "sent back to retry",
      pick(rows, "exec_retryable"),
      false,
      "Handed back to be tried again, usually because the accounts it wanted were locked by something else in flight.",
    ],
    [
      "exec_expired_bank",
      "bank had gone",
      pick(rows, "exec_expired_bank"),
      false,
      "Handed back because the slot they were meant for had already been frozen.",
    ],
  ]);

  const failedToLoad = pick(rows, "exec_dropped");
  const detail = LOAD_REASONS.map(([key, label]) => ({
    key,
    label,
    count: pick(rows, key),
    share: shareOf(failedToLoad, pick(rows, key)),
    warn: false,
    explain:
      "One of the reasons a transaction could not be loaded, as a share of the transactions that failed to load rather than of everything the workers attempted.",
  })).filter((reason) => reason.count > 0);

  return {
    key: "executed",
    title: "Executed",
    note: "taken up by workers",
    explain:
      "The worker threads, added together rather than shown one by one. This is the only section here that needs the validator to have been leader recently, so between slots it is absent rather than drawn as a column of noughts.",
    total: attempted,
    through: { label: "succeeded", count: pick(rows, "exec_succeeded") },
    losses,
    detail,
    zeros: zeros + (LOAD_REASONS.length - detail.length),
    aside: null,
  };
}

/**
 * The share of connection attempts that were let in.
 *
 * The card's headline, because the offer on its own says more about the cluster
 * than about this node. What the node decides is how much of it to take.
 *
 * Null before anything has been offered, which is a port nothing is using
 * rather than a port refusing everything.
 */
export function admittedShare(q: QuicPort): number | null {
  if (q.offered <= 0) return null;
  return Math.min(1, (q.admitted_staked + q.admitted_unstaked) / q.offered);
}

/** The staked share of what was admitted, or null where nothing was. */
export function stakedShare(q: QuicPort): number | null {
  const admitted = q.admitted_staked + q.admitted_unstaked;
  if (admitted <= 0) return null;
  return q.admitted_staked / admitted;
}

/** The port a section is about, or null where the validator has no such port. */
export function portNamed(ports: QuicPort[], name: string): QuicPort | null {
  return ports.find((port) => port.name === name) ?? null;
}

/**
 * Which of the quieter ports the reader last left unfolded, remembered per host.
 *
 * The same key shape and the same reasoning as the caches panel and the sidebar
 * collapse: someone who opened a port to watch it wants it open on the next
 * reload rather than having to open it again. Names rather than a count, so a
 * port appearing or going away cannot silently unfold a different one.
 */
export const TPU_PATH_STORAGE_KEY = "agave-dashboard-tpu-path-open";

export function readOpenPorts(): string[] {
  try {
    const stored = window.localStorage.getItem(TPU_PATH_STORAGE_KEY);
    return stored ? stored.split(",").filter(Boolean) : [];
  } catch {
    // Private browsing and some embedded webviews refuse storage outright.
    return [];
  }
}

export function writeOpenPorts(open: string[]): void {
  try {
    window.localStorage.setItem(TPU_PATH_STORAGE_KEY, open.join(","));
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}
