import { useEffect, useState, type ReactNode } from "react";
import {
  accountsGloss,
  programGloss,
  rateTone,
  readOpenSections,
  servedFromMemory,
  writeOpenSections,
} from "../caches";
import { bytes, count, percent } from "../format";
import type { AccountsCache, ProgramCache } from "../types";
import { useStore } from "../useStore";
import { Card, Explain, Meter, Stat } from "./primitives";

/** The two caches replay waits on. Each section folds to a heading that
 *  states its health; both start folded, and the choice is remembered. */
export function CachesCard() {
  const store = useStore();
  const programs = store.get<ProgramCache | null>("summary", "program_cache");
  const accounts = store.get<AccountsCache | null>("summary", "accounts_cache");
  // Read once at the first render. Unlike the theme there is nothing to stamp
  // before the bundle runs: a section that starts closed is what an unstyled
  // page shows anyway, so there is no flash to head off.
  const [open, setOpen] = useState<string[]>(readOpenSections);
  useEffect(() => writeOpenSections(open), [open]);
  if (!programs && !accounts) return null;

  const fold = (key: string) =>
    setOpen((was) => (was.includes(key) ? was.filter((k) => k !== key) : [...was, key]));

  return (
    <Card title="Caches and storage" aside="one-minute counters · reset every bank">
      <div className="caches">
        {programs && (
          <Group
            name="Program cache"
            rate={programs.hit_rate}
            gloss={programGloss(programs)}
            open={open.includes("programs")}
            onFold={() => fold("programs")}
            explain="Share of program lookups in the last minute answered from the cache."
          >
            <ProgramBody cache={programs} />
          </Group>
        )}
        {accounts && (
          <Group
            name="Accounts"
            rate={servedFromMemory(accounts).rate}
            gloss={accountsGloss(accounts)}
            open={open.includes("accounts")}
            onFold={() => fold("accounts")}
            explain="Share of account reads in the last minute answered from memory, across both caches."
          >
            <AccountsBody accounts={accounts} />
          </Group>
        )}
      </div>
    </Card>
  );
}

/** One foldable section. The row holds a button rather than being one,
 *  since the rate's explanation is itself a button. */
function Group({
  name,
  rate,
  gloss,
  open,
  onFold,
  explain,
  children,
}: {
  name: string;
  rate: number | null;
  gloss: string[];
  open: boolean;
  onFold: () => void;
  explain: string;
  children: ReactNode;
}) {
  const tone = rateTone(rate);

  return (
    <section className="cache-group">
      {/* Not a button, so the rate can keep its explanation. Keyboard reaches
          the chevron, which is the control; this is the pointer's larger
          target. */}
      <div className="cache-head" onClick={onFold}>
        <span className="cache-name">
          <i className={`cache-dot tone-${tone}`} aria-hidden="true" />
          {name}
        </span>
        <span className={`cache-rate tone-${tone}`}>
          <Explain text={explain}>{rate === null ? "—" : percent(rate, 2)}</Explain>
        </span>
        <span className="cache-gloss">
          {gloss.map((part) => (
            <i key={part}>{part}</i>
          ))}
        </span>
        <button
          type="button"
          className="cache-fold"
          aria-expanded={open}
          aria-label={`${open ? "Fold" : "Unfold"} ${name}`}
          onClick={(event) => {
            // The row under it toggles too, and two toggles are none.
            event.stopPropagation();
            onFold();
          }}
        >
          {open ? "−" : "+"}
        </button>
      </div>
      {open && <div className="cache-open">{children}</div>}
    </section>
  );
}

/** Every figure is a minute's rate except the entry peak, a level. Size is
 *  in entries: the cache has an entry limit and no byte budget. */
function ProgramBody({ cache }: { cache: ProgramCache }) {
  const filled =
    cache.peak_entries !== null && cache.entry_limit > 0
      ? cache.peak_entries / cache.entry_limit
      : null;

  // Insertions and reloads together: insertions alone counts only keys never
  // seen before.
  const compiled = cache.insertions + cache.reloads;
  const compiledBreakdown = [
    `${count(cache.insertions)} new`,
    `${count(cache.reloads)} reloaded`,
    ...(cache.lost_insertions > 0 ? [`${count(cache.lost_insertions)} lost`] : []),
  ].join(" · ");

  return (
    <>
      <div className="cache-figures">
        <Stat
          label="Lookups"
          explain="Program cache lookups in the window, hits and misses together."
          value={count(cache.looked_up)}
          sub={`${count(cache.hits)} hits · ${count(cache.misses)} misses`}
        />
        <Stat
          label="Compiled"
          explain="Programs compiled in the window: new keys, and keys reloaded after an eviction."
          value={count(compiled)}
          sub={compiledBreakdown}
        />
        <Stat
          label="Evictions"
          explain="Compiled programs dropped to stay within the entry limit. Used once is those called a single time before being dropped."
          value={count(cache.evictions)}
          sub={`${count(cache.one_hit_wonders)} used once`}
        />
        <Stat
          label="Pruned"
          explain="Entries dropped with an abandoned fork, or not recompiled for the incoming epoch."
          value={count(cache.prunes_orphan + cache.prunes_environment)}
          sub={`${count(cache.prunes_orphan)} orphaned · ${count(cache.prunes_environment)} epoch`}
        />
      </div>

      {/* Drawn whether or not an eviction has happened, so the section keeps its
          height. The bar is empty until one has, which is honest: nothing has
          reported where the cache stood. */}
      <div className="cache-storage">
        <div className="cache-storage-head">
          <Explain text="Most entries loaded at any eviction in the last minute, against the limit. Empty until an eviction runs.">
            <span className="cache-storage-label">Peak entries</span>
          </Explain>
          <span className="cache-storage-value">
            {cache.peak_entries === null ? "—" : count(cache.peak_entries)}
            <span className="cache-storage-limit"> / {count(cache.entry_limit)}</span>
          </span>
        </div>
        <Meter fraction={filled ?? 0} />
      </div>

      {cache.replacements > 0 && (
        <p className="cache-footnote">
          <Explain text="Entries compiled a second time while already in the cache.">
            {count(cache.replacements)} recompiled needlessly.
          </Explain>
        </p>
      )}
    </>
  );
}

/** Reads in accounts and writes in bytes: the load path is not measured in
 *  bytes, and `/proc/self/io` is process-wide. */
function AccountsBody({ accounts }: { accounts: AccountsCache }) {
  const perSecond = (total: number) =>
    accounts.window_seconds > 0 ? total / accounts.window_seconds : 0;
  const disk = accounts.disk;
  const live = disk && disk.allocated > 0 ? disk.used / disk.allocated : null;

  return (
    <>
      <div className="cache-section-title">Reads answered from</div>
      <div className="cache-figures">
        <Stat
          label="Write cache"
          explain="Accounts written recently and not yet flushed to a storage file."
          value={count(accounts.from_write_cache)}
        />
        <Stat
          label="Read cache"
          explain="Accounts kept in memory after being read, with the cache's current size beneath."
          value={count(accounts.from_read_cache)}
          sub={`${bytes(accounts.cache_bytes)} · ${count(accounts.cache_entries)} accounts · ${count(accounts.evictions)} evicted`}
        />
        <Stat
          label="Storage"
          explain="Reads that missed both caches and went to a storage file."
          value={count(accounts.from_storage)}
          sub={`${count(Math.round(perSecond(accounts.from_storage)))}/s`}
        />
        <Stat
          label="Written to storage"
          explain="Accounts flushed from the cache to storage files over the window."
          value={`${bytes(Math.round(perSecond(accounts.stored_bytes)))}/s`}
          sub={`${bytes(accounts.stored_bytes)} · ${count(accounts.stored_accounts)} accounts · ${count(Math.round(perSecond(accounts.stored_accounts)))}/s`}
        />
      </div>

      {disk && (
        <>
          <div className="cache-storage">
            <div className="cache-storage-head">
              <Explain text="Space the storage files take, and how much of it live accounts still reference.">
                <span className="cache-storage-label">On disk · live of allocated</span>
              </Explain>
              <span className="cache-storage-value">
                {bytes(disk.used)}
                <span className="cache-storage-limit"> / {bytes(disk.allocated)}</span>
              </span>
            </div>
            <Meter fraction={live ?? 0} />
          </div>
          <div className="cache-figures">
            <Stat
              label="Fragmented"
              explain="Allocated bytes no longer referenced by a live account, which shrink reclaims."
              value={bytes(disk.fragmented)}
              sub={disk.allocated > 0 ? percent(disk.fragmented / disk.allocated, 1) : undefined}
            />
            <Stat
              label="Storage files"
              explain="Storage files the accounts data is spread across."
              value={count(disk.storages)}
            />
          </div>
        </>
      )}

      <p className="cache-footnote">
        Reads are counted in accounts and writes in bytes because that is how the
        database counts them. Nothing on the load path counts bytes, so there is
        no read throughput to report.
      </p>
    </>
  );
}
