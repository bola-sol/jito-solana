
import { count } from "./format";
import type { EpochInfo, Reward, SlotEntry } from "./types";

/** Eight in a row is two turns, drawn as two cards. */
export const SLOTS_PER_TURN = 4;

export interface LeaderRef {
  key: string | null;
  name: string | null;
  icon: string | null;
}

export const NO_LEADER: LeaderRef = { key: null, name: null, icon: null };

export function leaderAt(epoch: EpochInfo | undefined, slot: number): string | null {
  if (!epoch || epoch.turns.length === 0) return null;
  if (slot < epoch.start_slot || slot > epoch.end_slot) return null;
  const turn = Math.floor((slot - epoch.start_slot) / SLOTS_PER_TURN);
  const index = epoch.turns[turn];
  if (index === undefined) return null;
  return epoch.leaders[index] ?? null;
}

/** Counted from the current epoch's start at its constant length. Null without an epoch. */
export function epochOf(epoch: EpochInfo | undefined, slot: number): number | null {
  if (!epoch || epoch.slots_in_epoch <= 0) return null;
  const at = epoch.epoch + Math.floor((slot - epoch.start_slot) / epoch.slots_in_epoch);
  return at < 0 ? null : at;
}

/** Past `completed`, the rule the progress bar uses. */
export function leaderSlotsLeft(slots: number[], completed: number): number {
  return slots.filter((slot) => slot > completed).length;
}

export interface TurnSlot {
  slot: number;
  entry: SlotEntry | null;
}

export interface Turn {
  leader: string | null;
  leader_name: string | null;
  leader_icon: string | null;
  mine: boolean;
  slots: TurnSlot[];
}

export function turnsOf(
  held: SlotEntry[],
  leaderOf: (slot: number, mine: boolean) => LeaderRef,
): Turn[] {
  const byTurn = new Map<number, SlotEntry[]>();
  for (const entry of held) {
    const turn = Math.floor(entry.slot / SLOTS_PER_TURN);
    const entries = byTurn.get(turn);
    if (entries) entries.push(entry);
    else byTurn.set(turn, [entry]);
  }

  return [...byTurn.entries()]
    .sort(([a], [b]) => b - a)
    .map(([turn, entries]) => {
      const mine = entries.some((entry) => entry.mine);
      const leader = leaderOf(turn * SLOTS_PER_TURN, mine);
      const first = Math.min(...entries.map((entry) => entry.slot));
      const slots: TurnSlot[] = [];
      for (let slot = turn * SLOTS_PER_TURN + SLOTS_PER_TURN - 1; slot >= first; slot--) {
        slots.push({ slot, entry: entries.find((entry) => entry.slot === slot) ?? null });
      }
      return {
        leader: leader.key,
        leader_icon: leader.icon,
        leader_name: leader.name,
        mine,
        slots,
      };
    });
}

export function matchesQuery(turn: Turn, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  if (turn.leader_name?.toLowerCase().includes(needle)) return true;
  if (turn.leader?.toLowerCase().includes(needle)) return true;
  return turn.slots.some((slot) => String(slot.slot).includes(needle));
}

export function turnKey(turn: Turn): string {
  return `turn:${turn.slots.at(-1)?.slot}`;
}

export function rewardTitle(reward: Reward | null | undefined): string {
  switch (reward) {
    case "paid":
      return "This node's vote is in the reward certificate.";
    case "unpaid":
      return "The reward certificate was written without this node's vote.";
    case "no_certificate":
      return "No reward certificate: the leader eight slots on produced no block.";
    default:
      return "The reward certificate is written eight slots on, and has not been seen yet.";
  }
}

export const REWARD_LAG = 8;

/** A count of usual payees, "none" without a block, null until read, undefined where the rewarded
 *  slot is not held. */
export type Certificate = number | "none" | null | undefined;

export function certificateAt(
  slot: number,
  entryOf: (slot: number) => SlotEntry | undefined,
): Certificate {
  const rewarded = entryOf(slot - REWARD_LAG);
  if (rewarded === undefined) return undefined;
  if (rewarded.reward === "no_certificate") return "none";
  if (rewarded.reward === null) return null;
  return rewarded.left_out ?? null;
}

export type CertificateTone = "all" | "out" | "none" | "unknown";

export function certificateText(certificate: Certificate): [text: string, tone: CertificateTone] {
  if (certificate === undefined || certificate === null) return ["—", "unknown"];
  if (certificate === "none") return ["none", "none"];
  if (certificate === 0) return ["all", "all"];
  return [`left out ${count(certificate)}`, "out"];
}

export function certificateTitle(certificate: Certificate): string {
  if (certificate === undefined) return "The slot this certificate rewards is not held.";
  if (certificate === null) return "The certificate written in this slot has not been read yet.";
  if (certificate === "none") return "No certificate: the leader produced no block in this slot.";
  if (certificate === 0) return "The certificate written in this slot paid everyone certificates usually pay.";
  return `The certificate written in this slot left out ${count(certificate)} of the validators certificates usually pay.`;
}
