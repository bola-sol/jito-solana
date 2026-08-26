import { bytes, count, decimal, percent } from "../format";
import {
  availableTone,
  busyTone,
  deviceLabel,
  fullness,
  fullnessTone,
  loadTrend,
  memoryUse,
  swapTone,
  waitTone,
} from "../host";
import type { DeviceLoad, FilesystemUsage, Host } from "../types";
import { useStore } from "../useStore";
import { Card, Explain } from "./primitives";

/**
 * The machine underneath the validator.
 *
 * The one panel here describing the box rather than the software. Everything
 * else says what the validator is doing; this says whether it can keep doing
 * it, which is the first thing anyone looks at when slots start skipping and
 * the last thing the rest of the dashboard can tell them.
 *
 * Read from /proc and statvfs rather than from the metrics tap, so unlike the
 * replay panel it keeps working on a validator configured to log less than the
 * default.
 *
 * A bar means a container that can fill: memory, and each filesystem. Load
 * average has no ceiling, so a bar ending at the core count would peg full and
 * stop saying anything at exactly the moment it mattered. Device saturation is
 * a duty cycle rather than a level, and drawing it in the same shape as a
 * filesystem is what makes people read it as space.
 */
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

/**
 * A device, which is not a container, so it gets no bar of any kind.
 *
 * Two rows of figures are read by eye without help. A bar here would only start
 * earning its width on a machine with several devices, and it would cost more
 * than it bought: set beside the capacity bars above, an identical shape is
 * what makes a duty cycle read as space.
 */
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
