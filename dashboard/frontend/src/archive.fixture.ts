/** A fake recording for the archive and rewind tests. */

import type { ArchiveRequests, BlockReply } from "./archive";
import type { Envelope, SlotEntry } from "./types";

export function slot(number: number): Envelope {
  const entry: SlotEntry = {
    slot: number,
    level: "completed",
    block: null,
    duration_nanos: null,
    time_millis: null,
    shreds: null,
    replayed_millis: null,
    reward: null,
    left_out: null,
    mine: false,
  };
  return { topic: "slot", key: "update", value: entry } as Envelope;
}

export const value = (key: string, held: unknown): Envelope => ({ topic: "summary", key, value: held }) as Envelope;

/** A recording on the validator: each segment its blocks, served as `rewind.range` and `rewind.read`. */
export function recording(segments: { start: number; blocks: BlockReply[] }[]): ArchiveRequests & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    range: () =>
      Promise.resolve({
        enabled: true,
        segments: segments.map(({ start, blocks }) => [start, blocks.at(-1)?.last ?? start, blocks.length]),
      }),
    read: (segment, block) => {
      reads.push(`${segment}:${block}`);
      return Promise.resolve(segments.find((held) => held.start === segment)?.blocks[block] ?? null);
    },
  };
}

/** A block of one slot a second from `from`, at `start` + i seconds. */
export function slotsBlock(start: number, from: number, count: number, keyframe = false): BlockReply {
  const records: [number, Envelope][] = [];
  for (let i = 0; i < count; i += 1) records.push([start + i * 1_000, slot(from + i)]);
  return { keyframe, first: start, last: start + (count - 1) * 1_000, records };
}
