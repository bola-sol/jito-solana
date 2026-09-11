import { useState } from "react";
import { bytes, count, decimal, percent } from "../format";
import {
  availableTone,
  busyTone,
  cpuTone,
  deviceLabel,
  fullness,
  fullnessTone,
  loadTrend,
  memoryUse,
  swapTone,
  waitTone,
} from "../host";
import { readThreadsCollapsed, writeThreadsCollapsed } from "../layout";
import { useNarrow } from "../narrow";
import {
  barLow,
  busiest,
  onCpuTone,
  pinnedLabel,
  threadRows,
  THREADS_WINDOW,
  type ThreadRow,
} from "../threads";
import type { DeviceLoad, FilesystemUsage, Host, ThreadsSample } from "../types";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";

/** The machine underneath the validator, from /proc and statvfs. A bar means
 *  a container that can fill; load and device saturation get none. */
export function HostCard() {
  const store = useStore();
  const host = store.get<Host | null>("summary", "host");
  if (!host) return null;

  const memory = memoryUse(host);
  const trend = loadTrend(host);

  return (
    <Card
      title="Host"
      aside={`${count(host.cores)} cores · ${bytes(host.memory_total)}`}
      className="host-body"
    >
      <div className="host-top">
        <div className="host-figure">
          <div className="host-label">
            <Explain text="Threads wanting a processor, averaged over the last minute, against the cores this machine has. Not a percentage and not bounded: load can and does exceed the core count, and a validator sitting above it is queueing rather than running. The three averages together say which way it is going, which is most of what the figure is worth.">
              Load average
            </Explain>
          </div>
          <div className="host-value">
            {decimal(host.load_one, 2)} <small>/ {count(host.cores)} cores</small>
          </div>
          <div className="host-sub">
            5m {decimal(host.load_five, 1)} · 15m {decimal(host.load_fifteen, 1)}{" "}
            <span className={`host-trend is-${trend}`}>{trend}</span>
            <br />
            <span className="host-faint">
              {count(host.threads)} threads, {count(host.running)} running
            </span>
          </div>
        </div>

        {/* Absent where /proc/stat could not be read; the rest of the row
            does not depend on it. */}
        {host.cpu && (
          <div className="host-figure">
            <div className="host-label">
              <Explain text="Share of the last second the cores together spent working, so a hundred percent is every core busy the whole second. Load average counts the threads that wanted to run; this counts the time they got. User is the validator and whatever else runs here, system is the kernel on their behalf, interrupts included, and iowait is cores idle with a disk request outstanding, the lighter part of the bar. Steal appears only when a hypervisor is taking time from this machine.">
                CPU busy
              </Explain>
            </div>
            <div className={`host-value tone-${cpuTone(host.cpu.busy)}`}>
              {percent(host.cpu.busy, 0)} <small>of {count(host.cores)} cores</small>
            </div>
            <div className="host-memory" aria-hidden="true">
              <i className="is-used" style={{ width: share(host.cpu.busy, 1) }} />
              <i className="is-cache" style={{ width: share(host.cpu.iowait, 1) }} />
            </div>
            <div className="host-sub">
              user {percent(host.cpu.user, 0)} · system {percent(host.cpu.system, 0)} ·{" "}
              iowait {percent(host.cpu.iowait, 0)}
              {host.cpu.steal >= 0.001 && (
                <>
                  {" "}
                  · <span className="tone-warn">steal {percent(host.cpu.steal, 1)}</span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="host-figure">
          <div className="host-label">
            <Explain text="Memory genuinely committed, which is the total less what is free and less the page cache. Most tools print total minus free instead, which counts the cache and makes a healthy validator look nearly out of memory. The lighter part of the bar is that cache, and the lighter part plus the empty part is what the available figure underneath counts: cache is in use, but handed straight back the moment something wants it.">
              Memory in use
            </Explain>
          </div>
          <div className="host-value">
            {bytes(memory.inUse)} <small>/ {bytes(memory.total)}</small>
          </div>
          <div className="host-memory" aria-hidden="true">
            <i className="is-used" style={{ width: share(memory.inUse, memory.total) }} />
            <i className="is-cache" style={{ width: share(memory.reclaimable, memory.total) }} />
          </div>
          <div className="host-sub">
            <span className={`tone-${availableTone(memory.available, memory.total)}`}>
              {bytes(memory.available)} available
            </span>{" "}
            · {bytes(memory.reclaimable)} page cache
          </div>
        </div>

        {/* Absent where the machine has no swap at all. Nothing to report and
            nothing to warn about, and a permanent nought is a row that teaches
            people to skip that corner of the card. */}
        {host.swap && (
          <div className="host-figure">
            <div className="host-label">
              <Explain text="Swap in use. There is no healthy amount: a validator that has begun swapping is already being hurt by it, because the pages going to disk are the accounts index and the program cache. Any figure above nought here wants investigating rather than tolerating.">
                Swap used
              </Explain>
            </div>
            <div className={`host-value tone-${swapTone(host.swap.used)}`}>
              {bytes(host.swap.used)} <small>/ {bytes(host.swap.total)}</small>
            </div>
            <div className="host-sub">
              {host.swap.used > 0 ? "in use, which it should not be" : "none, as it should be"}
            </div>
          </div>
        )}
      </div>

      {host.filesystems.length > 0 && (
        <>
          <div className="host-group">
            <Explain text="How much of each filesystem is gone, and how much is left. This is the figure that says the validator will stop: a full ledger partition halts it. Nothing to do with how hard the disk is working, which is the group below.">
              <span>How full</span>
            </Explain>
            <em>statvfs</em>
          </div>
          {host.filesystems.map((filesystem) => (
            <Capacity key={filesystem.path} filesystem={filesystem} />
          ))}
        </>
      )}

      {host.devices.length > 0 && (
        <>
          <div className="host-group">
            <Explain text="How hard each device is being worked. Time busy is the share of the second it had at least one request in flight, and it says nothing at all about space: a device can sit at ninety percent busy with terabytes free. Wait is the mean time a request spent queued and serviced, and on NVMe it is the first figure to move when replay starts falling behind.">
              <span>How hard worked</span>
            </Explain>
            <em>diskstats</em>
          </div>
          <div className="host-device is-head">
            <span>device</span>
            <span className="host-n">time busy</span>
            <span className="host-n is-wait">wait</span>
            <span className="host-n is-io">iops</span>
            <span className="host-n is-tp">read / write</span>
          </div>
          {host.devices.map((device) => (
            <Device key={device.device} device={device} />
          ))}
        </>
      )}

      <Threads samples={store.getThreads()} />
    </Card>
  );
}

/** A filesystem, which is a container, so it gets a bar. */
function Capacity({ filesystem }: { filesystem: FilesystemUsage }) {
  const share = fullness(filesystem);
  const tone = fullnessTone(share);
  return (
    <div className="host-capacity">
      {/* The name identifies the row and never truncates; the path is context
          and does, since a real one runs longer than any column this card can
          spare. Carried as a title so it is still recoverable. */}
      <span className="host-mount" title={filesystem.path}>
        <b>{filesystem.name}</b>
        <s>{filesystem.path}</s>
      </span>
      <span className="host-track">
        <i className={`tone-fill-${tone}`} style={{ width: `${share * 100}%` }} />
      </span>
      <span className={`host-n tone-${tone}`}>{percent(share, 0)}</span>
      <span className="host-free">{bytes(filesystem.available)} free</span>
    </div>
  );
}

/** A device, which is not a container, so no bar. */
function Device({ device }: { device: DeviceLoad }) {
  return (
    <div className="host-device">
      <span className="host-dev">
        <b>{device.device}</b>
        <s>{deviceLabel(device)}</s>
      </span>
      <span className={`host-n tone-${busyTone(device.busy)}`}>{percent(device.busy, 0)}</span>
      <span className={`host-n is-wait tone-${waitTone(device.wait_ms)}`}>
        {device.wait_ms === null ? "—" : `${decimal(device.wait_ms, 2)} ms`}
      </span>
      <span className="host-n is-io host-faint">{count(device.operations_per_second)}</span>
      <span className="host-n is-tp host-faint">
        {bytes(device.read_per_second)} / {bytes(device.write_per_second)}
      </span>
    </div>
  );
}

function share(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.min(100, (part / whole) * 100)}%`;
}

/** The validator's threads over the last minute, folded like the caches
 *  card's sections: on a phone by default, else as the viewer left it. */
function Threads({ samples }: { samples: ThreadsSample[] }) {
  const narrow = useNarrow();
  const [collapsed, setCollapsed] = useState<boolean>(() => readThreadsCollapsed() ?? narrow);
  const rows = threadRows(samples);
  const last = samples[samples.length - 1];
  if (!last || rows.length === 0) return null;

  const top = busiest(rows);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeThreadsCollapsed(next);
  };

  return (
    <section className="cache-group host-threads">
      <div className="cache-head" onClick={toggle}>
        <span className="cache-name">Validator threads</span>
        <span className="cache-rate">
          <Explain text="The busiest thread's share of the last second on a core. Each row below is a thread's minute of the same; a pool row is the mean of its threads. Waiting is the minute's worst second spent runnable with no core to run on, and sleeping is whatever the bars leave over.">
            {top ? percent(top.now, 0) : "—"}
          </Explain>
        </span>
        <span className="cache-gloss">
          {top && (
            <i>
              busiest {top.label}
              {top.cores !== null && `, ${pinnedLabel(top.cores)}`}
            </i>
          )}
          <i>{count(last.threads)} threads</i>
          <i>last 60s</i>
        </span>
        <button
          type="button"
          className="cache-fold"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Unfold" : "Fold"} validator threads`}
          onClick={(event) => {
            // The row under it toggles too, and two toggles are none.
            event.stopPropagation();
            toggle();
          }}
        >
          {collapsed ? "+" : "−"}
        </button>
      </div>
      {!collapsed && (
        <div className="cache-open">
          <div>
            <div className="host-thread is-head">
              <span>thread</span>
              <span className="host-n is-count">count</span>
              <span
                className="host-n is-cores"
                title="The cores the kernel may schedule the thread on, where that is fewer than the machine has."
              >
                pinned
              </span>
              <span className="is-spark">on cpu, each second</span>
              <span className="host-n is-now">now</span>
              <span className="host-n is-wait" title="Runnable but waiting for a core: the worst second of the minute.">
                waiting
              </span>
            </div>
            {rows.map((row) => (
              <ThreadLine key={row.other ? "other" : row.name} row={row} />
            ))}
            <div className="card-footnote">
              Fewer cores than the machine has means the thread is pinned.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** One thread, or a pool of them, with its minute of bars. */
function ThreadLine({ row }: { row: ThreadRow }) {
  const onCpu = onCpuTone(row);
  return (
    <div
      className="host-thread"
      title={
        row.poh
          ? "Hashes continuously between ticks and is meant to hold a core. Toned when it drops below 90% on cpu."
          : undefined
      }
    >
      <span className="host-dev">
        <b>{row.label}</b>
        {/* The count and the pinned cores here as well as in their columns,
            shown only where the columns are not: a phone. */}
        <span className="host-countline host-faint"> {count(row.count)}</span>
        {row.cores !== null && (
          <span className="host-pinline host-pin"> · {pinnedLabel(row.cores)}</span>
        )}
        {row.poh && <s>holds a core</s>}
      </span>
      <span className="host-n is-count host-faint">{count(row.count)}</span>
      <span className={`host-n is-cores ${row.cores === null ? "host-faint" : "host-pin"}`}>
        {pinnedLabel(row.cores)}
      </span>
      <Spark row={row} />
      <span className={`host-n is-now${onCpu ? ` tone-${onCpu}` : ""}`}>
        {percent(row.now, row.now < 0.01 ? 1 : 0)}
      </span>
      <span className="host-n is-wait">{percent(row.waiting, 1)}</span>
    </div>
  );
}

const BAR_STEP = 6;
const BAR_WIDTH = 5;
const SPARK_HEIGHT = 16;

/** A minute of one row's on-cpu share, one bar a second, right-aligned while
 *  the window fills. */
function Spark({ row }: { row: ThreadRow }) {
  const offset = THREADS_WINDOW - row.series.length;
  return (
    <svg
      className="host-spark"
      viewBox={`0 0 ${THREADS_WINDOW * BAR_STEP - 1} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {row.series.map((share, index) => {
        if (share === null) return null;
        const height = Math.max(1, Math.round(share * SPARK_HEIGHT));
        return (
          <rect
            key={index}
            x={(offset + index) * BAR_STEP}
            y={SPARK_HEIGHT - height}
            width={BAR_WIDTH}
            height={height}
            className={barLow(row, share) ? "is-low" : undefined}
          />
        );
      })}
    </svg>
  );
}
