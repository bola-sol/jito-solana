/** Where this validator's unrewarded votes fell, for the epoch card. */

import { count, shortKey } from "./format";
import type {
  LostLeader,
  MissList,
  MissPlace,
  MissValidator,
  Misses,
  VoteParticipation,
  VoteSent,
} from "./types";

/** More leader turns than this read as a band on the meter, not marks, and
 *  are left off it. */
export const MAX_TURN_MARKS = 80;

/** The places, in the order the legend lists them. */
export const MISS_PLACES: readonly MissPlace[] = ["boundary", "leader", "snapshot", "thin", "late", "lost"];

/** One sentence on what puts a miss in each place. The thin one is ended
 *  by `placeExplain`, with the cutoff. */
const PLACE_EXPLAIN: Record<MissPlace, string> = {
  boundary: "The slot is in the first 1,000 slots of the epoch.",
  leader: "The slot is one of the leader slots of this validator.",
  snapshot: "This node wrote a snapshot archive during the slot.",
  thin: "The certificate paid at least a tenth fewer validators than this epoch's typical certificate",
  late: "This node completed replay of the slot after the first shred of the certificate writer's slot arrived.",
  lost: "No other cause applies, but the certificate did not pay this validator.",
};

/** Fewer lost votes than this are not worth a line about who wrote them out. */
export const LOST_NOTE_MIN = 5;

export interface MissMark {
  /** Along the epoch, in [0, 1]. */
  at: number;
  /** The bin's misses against the busiest bin's, in (0, 1]. */
  weight: number;
}

/** The first slot of each run of consecutive leader slots. */
export function leaderTurns(slots: number[]): number[] {
  const turns: number[] = [];
  let previous: number | undefined;
  for (const slot of slots) {
    if (previous === undefined || slot !== previous + 1) turns.push(slot);
    previous = slot;
  }
  return turns;
}

/** Where each leader turn sits along the epoch. Null with too many to read
 *  as marks. */
export function turnMarks(slots: number[], startSlot: number, slotsInEpoch: number): number[] | null {
  const turns = leaderTurns(slots);
  if (turns.length > MAX_TURN_MARKS) return null;
  return turns.map((slot) => (slot - startSlot) / Math.max(1, slotsInEpoch));
}

/** One mark per bin with a miss in it. */
export function missMarks(bins: number[]): MissMark[] {
  const busiest = bins.reduce((most, count) => Math.max(most, count), 0);
  if (busiest <= 0) return [];
  return bins.flatMap((count, index) =>
    count > 0 ? [{ at: (index + 0.5) / bins.length, weight: count / busiest }] : [],
  );
}

export function missTotal(misses: Misses): number {
  return MISS_PLACES.reduce((total, place) => total + misses[place], 0);
}

/** The place's sentence, with the cutoff on the thin one once it is known. */
export function placeExplain(place: MissPlace, participation: VoteParticipation): string {
  const text = PLACE_EXPLAIN[place];
  if (place !== "thin") return text;
  const { thin_below, ranks } = participation;
  if (thin_below === null) return `${text}.`;
  return `${text}, now under ${count(thin_below)} of ${count(ranks)}.`;
}

/** A line naming how many of the lost votes a few leaders wrote out, once
 *  they hold at least half of them. Null otherwise. */
export function lostNote(participation: VoteParticipation): { text: string; leaders: LostLeader[] } | null {
  const { lost } = participation.misses;
  const leaders = participation.lost_leaders;
  if (lost < LOST_NOTE_MIN || leaders.length === 0) return null;
  const held = leaders.reduce((total, leader) => total + leader.count, 0);
  if (held * 2 < lost) return null;
  const by = leaders.length === 1 ? "one leader" : `same ${leaders.length} leaders`;
  return { text: `${count(held)} lost by ${by}`, leaders };
}

/** The leader's published name, else its key shortened. */
export function leaderLabel(leader: LostLeader): string {
  return leader.name ?? shortKey(leader.identity);
}

/** The vote this node sent and how long after its anchor, the first shred or else the parent
 *  becoming ready. `none` where votor sent neither, a dash before it reports. */
export function voteText(vote: VoteSent | null): string {
  if (!vote) return "—";
  const sent: [word: string, micros: number] | null =
    vote.notarize_us !== null ? ["notarize", vote.notarize_us] : vote.skip_us !== null ? ["skip", vote.skip_us] : null;
  if (!sent) return "none";
  const [word, at] = sent;
  const anchor: [name: string, micros: number] | null =
    vote.first_shred_us !== null
      ? ["shred", vote.first_shred_us]
      : vote.parent_ready_us !== null
        ? ["parent", vote.parent_ready_us]
        : null;
  if (!anchor) return word;
  const [name, from] = anchor;
  const millis = Math.round((at - from) / 1000);
  // A vote before its anchor is the anchor's event delivered late.
  return `${word}, ${name} ${millis < 0 ? "−" : "+"}${count(Math.abs(millis))} ms`;
}

/** Who else the certificate left out. */
export function leftOutText(others: number): string {
  return others === 0 ? "only us" : `${count(others)} others`;
}

/** The validator's published name, else its key shortened. */
export function validatorLabel(validator: MissValidator): string {
  return validator.name ?? shortKey(validator.identity);
}

/** How many validators are named as most often left out beside us. */
export const LEFT_OUT_MOST = 3;

/** The validators most often left out beside us, most first. Null where no
 *  certificate left out anybody else. */
export function leftOutMost(list: MissList): string | null {
  const counts = new Map<number, number>();
  for (const row of list.rows) for (const at of row.others) counts.set(at, (counts.get(at) ?? 0) + 1);
  if (counts.size === 0) return null;
  const top = [...counts.entries()]
    .sort(([a, aCount], [b, bCount]) => bCount - aCount || a - b)
    .slice(0, LEFT_OUT_MOST)
    .flatMap(([at, n]) => {
      const validator = list.validators[at];
      return validator ? [`${validatorLabel(validator)} in ${count(n)}`] : [];
    });
  if (top.length === 0) return null;
  return `Left out beside us most: ${top.join(", ")}.`;
}

/** The writer behind at least half the misses, and how its certificates
 *  treated everybody else. Null where no writer holds half. */
export function writerSummary(list: MissList): string | null {
  if (list.rows.length === 0 || list.writers.length === 0) return null;
  const at = list.writers.reduce(
    (best, writer, index) => (writer.misses > list.writers[best].misses ? index : best),
    0,
  );
  const top = list.writers[at];
  if (top.misses * 2 < list.rows.length) return null;
  const alone = list.rows.filter((row) => row.writer === at && row.others.length === 0).length;
  const others =
    alone === top.misses ? " Every one of them paid everybody else." : alone > 0 ? ` ${count(alone)} of them paid everybody else.` : "";
  return `${top.name ?? shortKey(top.identity)} wrote ${count(top.misses)} of the ${count(list.rows.length)} certificates that left this validator out, ${count(top.misses)} of the ${count(top.certificates)} it wrote.${others}`;
}
