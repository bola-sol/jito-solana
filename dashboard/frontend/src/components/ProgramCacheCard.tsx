import { count, percent } from "../format";
import type { ProgramCache } from "../types";
import { useStore } from "../useStore";
import { Card, Explain, Meter, Stat } from "./primitives";

/**
 * How the program cache is faring, over the last minute.
 *
 * Every figure here is a rate rather than a standing total. The cache resets
 * its counters each time a bank is made from a parent — two or three times a
 * second — and reports them as it does, so what is summed is a minute of real
 * work rather than anything the cache is holding.
 *
 * The one exception is the entry peak, which is a level and is treated as one:
 * it is written only when an eviction runs, so the highest reading across the
 * window is taken rather than the latest.
 *
 * Compiled and evicted are drawn as a pair and want reading as one. The cache
 * counts a key it has never seen as an insertion and a key whose compiled code
 * it threw away as a reload, and only the two together are what it built. Shown
 * apart, the smaller half sits beside a much larger eviction count and reads as
 * a cache losing entries it is in fact replacing.
 *
 * Size is shown in entries rather than in bytes. This cache is a map on the
 * heap, bounded by how many entries it may hold and given no byte budget at
 * all, so entries against that limit is the only fill figure it can honestly
 * report.
 */
export function ProgramCacheCard() {
  const store = useStore();
  const cache = store.get<ProgramCache | null>("summary", "program_cache");
  if (!cache) return null;

  const filled =
    cache.peak_entries !== null && cache.entry_limit > 0
      ? cache.peak_entries / cache.entry_limit
      : null;

  // Both halves of the same figure. Insertions alone counts only keys the cache
  // had never seen, so shown on its own beside a much larger eviction count it
  // reads as a cache collapsing when it is holding its size: the reloads make
  // up the difference, and they belong here rather than under evictions.
  const compiled = cache.insertions + cache.reloads;
  const compiledBreakdown = [
    `${count(cache.insertions)} new`,
    `${count(cache.reloads)} reloaded`,
    ...(cache.lost_insertions > 0 ? [`${count(cache.lost_insertions)} lost`] : []),
  ].join(" · ");

  return (
    <Card title="Program Cache" className="cache-body">
      <div className="stat-grid">
        <Stat
          label="Hit rate"
          explain="How often replay found a program already compiled rather than having to build it, over the last minute. A low rate means replay spends its time compiling, which slows a block down and leaves less room to pack the next one. Evictions are the usual cause."
          value={percent(cache.hit_rate, 2)}
          tone={cache.hit_rate >= 0.98 ? "good" : cache.hit_rate >= 0.9 ? undefined : "bad"}
          sub={`${count(cache.hits)} hits · ${count(cache.misses)} misses`}
        />
        <Stat
          label="Lookups"
          explain="Every time replay asked the cache for a program in the window, hits and misses together. Not the same as loads: a hit is the cache answering without building anything, and only a miss turns into a compile. Small numbers are ordinary, since a block touches few distinct programs, which is why this is summed over a minute rather than read off a single slot."
          value={count(cache.looked_up)}
        />
      </div>

      {/* Drawn whether or not an eviction has happened, so the card keeps its
          height. The bar is empty until one has, which is honest: nothing has
          reported where the cache stood. */}
      <div className="cache-storage">
        <div className="cache-storage-head">
          <Explain text="The most entries seen loaded at any eviction in the last minute, against the limit eviction keeps them under. Only measured when an eviction runs, so it is a high-water mark rather than a live reading, and it is empty on a validator that has not had to evict anything. Approaching the limit is what precedes a falling hit rate.">
            <span className="cache-storage-label">Peak entries</span>
          </Explain>
          <span className="cache-storage-value">
            {cache.peak_entries === null ? "—" : count(cache.peak_entries)}
            <span className="cache-storage-limit"> / {count(cache.entry_limit)}</span>
          </span>
        </div>
        <Meter fraction={filled ?? 0} />
      </div>

      <div className="stat-grid">
        <Stat
          label="Compiled"
          explain="Every program the cache had to build in the window, which is the work a hit avoids. New ones are keys the cache had not seen. Reloaded ones are keys it already had and had thrown the compiled code away for, so they are the cost of an eviction coming back. Compare this against evictions beside it: a cache in steady state compiles about as many as it drops."
          value={count(compiled)}
          sub={compiledBreakdown}
        />
        <Stat
          label="Evictions"
          explain="Compiled programs dropped to keep the cache within its entry limit. Set this against what was compiled beside it. Roughly equal figures mean a cache holding its size, and evictions running well ahead mean it is shedding programs faster than they are wanted."
          value={count(cache.evictions)}
        />
        <Stat
          label="Used once"
          explain="Programs compiled, used a single time, and then evicted. Compilation time and cache space spent for one transaction. A steady figure here alongside a healthy hit rate is ordinary, because the network has a long tail of programs almost nobody calls."
          value={count(cache.one_hit_wonders)}
        />
        <Stat
          label="Pruned"
          explain="Entries dropped because the fork they belonged to was abandoned, or because they had not been recompiled for the incoming epoch. Neither is a fault; both are the cache keeping up with the chain. The epoch figure rises sharply around an epoch boundary and is expected to."
          value={count(cache.prunes_orphan + cache.prunes_environment)}
          sub={`${count(cache.prunes_orphan)} orphaned · ${count(cache.prunes_environment)} epoch`}
        />
      </div>

      <div className="card-footnote">
        One minute of the cache's own counters, which it resets and reports at
        every bank.{" "}
        {cache.replacements > 0 && (
          <Explain text="An entry already in the cache compiled a second time. Not harmful, but it is work that need not have happened, and a persistent figure here is worth reporting upstream.">
            {count(cache.replacements)} recompiled needlessly.
          </Explain>
        )}
      </div>
    </Card>
  );
}
