import { describe, expect, it } from "vitest";
import {
  availableTone,
  busyTone,
  cpuTone,
  deviceLabel,
  diskAlarm,
  fullness,
  fullnessTone,
  loadTrend,
  memoryAlarm,
  memoryUse,
  residentTrend,
  slowGovernor,
  swapTone,
  validatorSplit,
  waitTone,
} from "./host";
import type { DeviceLoad, Host } from "./types";

const GB = 1024 ** 3;

function host(over: Partial<Host> = {}): Host {
  return {
    cores: 32,
    load_one: 12.4,
    load_five: 11.8,
    load_fifteen: 10.9,
    threads: 1847,
    running: 14,
    cpu: { busy: 0.31, user: 0.24, system: 0.06, iowait: 0.01, steal: 0 },
    cpu_governor: "performance",
    memory_total: 384 * GB,
    memory_available: 88 * GB,
    memory_reclaimable: 64 * GB,
    memory_free: 24 * GB,
    swap: { total: 8 * GB, used: 0 },
    process_resident: null,
    process_resident_hour_ago: null,
    process_kinds: null,
    memory_parts: { index_estimate: null, write_cache: null, read_cache: null, blockstore: null },
    snapshot_device: null,
    filesystems: [],
    devices: [],
    ...over,
  };
}

describe("validatorSplit", () => {
  const kinds = { anonymous: 150 * GB, file: 3 * GB, shared: 1 * GB };

  it("waits for the kernel's split", () => {
    expect(validatorSplit(host({ process_resident: 154 * GB }))).toBeNull();
  });

  it("takes the measured parts out of the heap and adds up to the resident figure", () => {
    const split = validatorSplit(
      host({
        process_resident: 154 * GB,
        process_kinds: kinds,
        memory_parts: { index_estimate: 90 * GB, write_cache: 2 * GB, read_cache: 3 * GB, blockstore: 5 * GB },
      }),
    )!;
    expect(split.segments.map((segment) => [segment.key, segment.bytes / GB])).toEqual([
      ["rest", 140],
      ["blockstore", 5],
      ["read", 3],
      ["write", 2],
      ["files", 3],
      ["shared", 1],
    ]);
    expect(split.segments.reduce((sum, segment) => sum + segment.bytes, 0)).toBe(154 * GB);
    expect(split.indexEstimate).toBe(90 * GB);
    expect(split.rows.map((row) => [row.key, row.depth])).toEqual([
      ["heap", 0],
      ["rest", 1],
      ["index", 2],
      ["blockstore", 1],
      ["read", 1],
      ["write", 1],
      ["files", 0],
      ["shared", 0],
    ]);
  });

  it("caps the estimate at the rest of the heap and never subtracts it", () => {
    const split = validatorSplit(
      host({
        process_resident: 154 * GB,
        process_kinds: kinds,
        memory_parts: { index_estimate: 400 * GB, write_cache: null, read_cache: null, blockstore: 10 * GB },
      }),
    )!;
    expect(split.indexEstimate).toBe(140 * GB);
    expect(split.segments[0]).toEqual({ key: "rest", bytes: 140 * GB });
    expect(split.rows.map((row) => row.key)).toEqual(["heap", "rest", "index", "blockstore", "files", "shared"]);
  });

  it("keeps the rest at zero when the parts briefly pass the heap", () => {
    const split = validatorSplit(
      host({
        process_resident: 154 * GB,
        process_kinds: kinds,
        memory_parts: { index_estimate: null, write_cache: 100 * GB, read_cache: 60 * GB, blockstore: null },
      }),
    )!;
    expect(split.segments[0]).toEqual({ key: "rest", bytes: 0 });
    expect(split.indexEstimate).toBeNull();
  });
});

describe("residentTrend", () => {
  it("names the hour's move and its direction", () => {
    const trend = residentTrend(host({ process_resident: 400 * GB, process_resident_hour_ago: 398 * GB }));
    expect(trend).toEqual({ direction: "rising", label: "up 2.00 GB this hour" });
  });

  it("is nothing without an hour of readings", () => {
    expect(residentTrend(host({ process_resident: 400 * GB }))).toBeNull();
  });

  it("calls a move within the noise steady", () => {
    expect(
      residentTrend(host({ process_resident: 400 * GB, process_resident_hour_ago: 400 * GB - 100 * 1024 ** 2 })),
    ).toEqual({ direction: "steady", label: "steady this hour" });
  });
});

function device(over: Partial<DeviceLoad> = {}): DeviceLoad {
  return {
    device: "nvme1n1",
    roles: ["accounts"],
    busy: 0.34,
    wait_ms: 0.21,
    operations_per_second: 18_200,
    read_per_second: 1_400_000_000,
    write_per_second: 240_000_000,
    ...over,
  };
}

describe("memoryUse", () => {
  it("does not count the page cache as spoken for", () => {
    // The convention most tools print is total minus free, which on this box
    // would read 360 of 384 GB and look like a machine about to die.
    const use = memoryUse(host());
    expect(use.inUse).toBe(296 * GB);
    expect(use.reclaimable).toBe(64 * GB);
    expect(use.available).toBe(88 * GB);
  });

  it("keeps the three parts inside the total", () => {
    const use = memoryUse(host());
    expect(use.inUse + use.reclaimable).toBeLessThanOrEqual(use.total);
  });

  it("does not go negative on a reading that arrived mid-change", () => {
    // Free and reclaimable are read from separate lines of one file and can
    // briefly sum past the total.
    const use = memoryUse(
      host({ memory_total: 100, memory_free: 80, memory_reclaimable: 80 }),
    );
    expect(use.inUse).toBe(0);
  });

  it("reports nothing rather than dividing by a total of nought", () => {
    const use = memoryUse(host({ memory_total: 0 }));
    expect(use.total).toBe(0);
    expect(use.inUse).toBe(0);
  });
});

describe("fullness", () => {
  it("is what is gone, not what is left", () => {
    expect(fullness({ name: "ledger", path: "/l", total: 1000, available: 470 })).toBe(0.53);
  });

  it("is nought on a filesystem that reported no size", () => {
    expect(fullness({ name: "x", path: "/x", total: 0, available: 0 })).toBe(0);
  });
});

describe("thresholds", () => {
  it("turns a filesystem amber at four fifths and red at nine tenths", () => {
    expect(fullnessTone(0.53)).toBe("good");
    expect(fullnessTone(0.8)).toBe("warn");
    expect(fullnessTone(0.9)).toBe("bad");
  });

  it("turns a device amber at seventy percent busy and red at eighty five", () => {
    expect(busyTone(0.34)).toBe("good");
    expect(busyTone(0.7)).toBe("warn");
    expect(busyTone(0.85)).toBe("bad");
  });

  it("turns the cores amber at eighty percent busy and red at ninety", () => {
    expect(cpuTone(0.31)).toBe("good");
    expect(cpuTone(0.8)).toBe("warn");
    expect(cpuTone(0.9)).toBe("bad");
  });

  it("reads wait against what NVMe should manage", () => {
    expect(waitTone(0.21)).toBe("good");
    expect(waitTone(1)).toBe("warn");
    expect(waitTone(5)).toBe("bad");
  });

  it("says nothing about wait where the device did nothing", () => {
    expect(waitTone(null)).toBe("muted");
  });

  it("warns as memory left runs down", () => {
    expect(availableTone(88 * GB, 384 * GB)).toBe("good");
    expect(availableTone(30 * GB, 384 * GB)).toBe("warn");
    expect(availableTone(10 * GB, 384 * GB)).toBe("bad");
  });

  it("has no opinion about memory on a box that reported no total", () => {
    expect(availableTone(0, 0)).toBe("muted");
  });

  it("treats any swap at all as worth noticing", () => {
    expect(swapTone(0)).toBe("good");
    expect(swapTone(1)).toBe("warn");
  });
});

describe("loadTrend", () => {
  it("reads the one minute figure against the fifteen", () => {
    expect(loadTrend(host({ load_one: 12.4, load_fifteen: 10.9 }))).toBe("rising");
    expect(loadTrend(host({ load_one: 8.1, load_fifteen: 10.9 }))).toBe("falling");
  });

  it("calls a tenth of a core steady rather than a trend", () => {
    expect(loadTrend(host({ load_one: 10.95, load_fifteen: 10.9 }))).toBe("steady");
  });
});

describe("deviceLabel", () => {
  it("names one role", () => {
    expect(deviceLabel(device())).toBe("accounts");
  });

  it("names both where two mounts share a disk", () => {
    expect(deviceLabel(device({ roles: ["ledger", "accounts"] }))).toBe("ledger and accounts");
  });
});

describe("slowGovernor", () => {
  it("flags any governor but performance, and nothing where there is none", () => {
    expect(slowGovernor(host().cpu_governor)).toBe(false);
    expect(slowGovernor(host({ cpu_governor: "schedutil" }).cpu_governor)).toBe(true);
    expect(slowGovernor(host({ cpu_governor: "powersave" }).cpu_governor)).toBe(true);
    expect(slowGovernor(host({ cpu_governor: null }).cpu_governor)).toBe(false);
  });
});

describe("diskAlarm", () => {
  const fs = (name: string, used: number) => ({ name, path: `/${name}`, total: 1000, available: 1000 - used });

  it("is nothing while every filesystem is under four fifths", () => {
    expect(diskAlarm(host({ filesystems: [fs("ledger", 790), fs("accounts", 500)] }))).toBeNull();
  });

  it("names the fullest filesystem once one is amber", () => {
    const alarm = diskAlarm(host({ filesystems: [fs("ledger", 820), fs("accounts", 860)] }));
    expect(alarm?.filesystem.name).toBe("accounts");
    expect(alarm?.tone).toBe("warn");
  });

  it("is red from nine tenths", () => {
    expect(diskAlarm(host({ filesystems: [fs("ledger", 930)] }))?.tone).toBe("bad");
  });

  it("is nothing without a host", () => {
    expect(diskAlarm(undefined)).toBeNull();
  });
});

describe("memoryAlarm", () => {
  it("is nothing above a tenth available", () => {
    expect(memoryAlarm(host())).toBeNull();
  });

  it("is amber at a tenth and red at a twentieth", () => {
    expect(memoryAlarm(host({ memory_available: 38 * GB }))?.tone).toBe("warn");
    expect(memoryAlarm(host({ memory_available: 15 * GB }))).toEqual({ available: 15 * GB, total: 384 * GB, tone: "bad" });
  });

  it("is nothing on a host that reported no memory", () => {
    expect(memoryAlarm(host({ memory_total: 0, memory_available: 0 }))).toBeNull();
  });
});
