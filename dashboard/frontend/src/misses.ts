
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

/** More leader turns than this read as a band, not marks, and are left off. */
export const MAX_TURN_MARKS = 80;

export const MISS_PLACES: readonly MissPlace[] = ["boundary", "leader", "snapshot", "thin", "late", "lost"];

const PLACE_EXPLAIN: Record<MissPlace, string> = {
  boundary: "The slot is in the first 1,000 slots of the epoch.",
  leader: "The slot is one of the leader slots of this validator.",
  snapshot: "This node wrote a snapshot archive during the slot.",
  thin: "The certificate paid at least a tenth fewer validators than this epoch's typical certificate",
  late: "This node completed replay of the slot after the first shred of the certificate writer's slot arrived.",
  lost: "No other cause applies, but the certificate did not pay this validator.",
};

export const LOST_NOTE_MIN = 5;

export interface MissMark {
  at: number;
  weight: number;
}

export function leaderTurns(slots: number[]): number[] {
  const turns: number[] = [];
  let previous: number | undefined;
  for (const slot of slots) {
    if (previous === undefined || slot !== previous + 1) turns.push(slot);
    previous = slot;
  }
  return turns;
}

export function turnMarks(slots: number[], startSlot: number, slotsInEpoch: number): number[] | null {
  const turns = leaderTurns(slots);
  if (turns.length > MAX_TURN_MARKS) return null;
  return turns.map((slot) => (slot - startSlot) / Math.max(1, slotsInEpoch));
}

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

export function placeExplain(place: MissPlace, participation: VoteParticipation): string {
  const text = PLACE_EXPLAIN[place];
  if (place !== "thin") return text;
  const { thin_below, ranks } = participation;
  if (thin_below === null) return `${text}.`;
  return `${text}, now under ${count(thin_below)} of ${count(ranks)}.`;
}

/** Once a few leaders hold at least half the lost votes; null otherwise. */
export function lostNote(participation: VoteParticipation): { text: string; leaders: LostLeader[] } | null {
  const { lost } = participation.misses;
  const leaders = participation.lost_leaders;
  if (lost < LOST_NOTE_MIN || leaders.length === 0) return null;
  const held = leaders.reduce((total, leader) => total + leader.count, 0);
  if (held * 2 < lost) return null;
  const by = leaders.length === 1 ? "one leader" : `same ${leaders.length} leaders`;
  return { text: `${count(held)} lost by ${by}`, leaders };
}

export function leaderLabel(leader: LostLeader): string {
  return leader.name ?? shortKey(leader.identity);
}

/** The anchor is the first shred, else the parent becoming ready; `none` where votor sent neither,
 *  a dash before it reports. */
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

export function leftOutText(others: number): string {
  return others === 0 ? "only us" : `${count(others)} others`;
}

export function validatorLabel(validator: MissValidator): string {
  return validator.name ?? shortKey(validator.identity);
}

export const LEFT_OUT_MOST = 3;

/** Null where no certificate left out anybody else. */
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

/** Null where no writer holds half. */
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
